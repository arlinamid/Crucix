// OpenSky Network — Real-time flight tracking
// Free for research. Tracks all aircraft with ADS-B transponders including many military.
// API credits per day: 400 anonymous, 4,000 with an account, 8,000 for active feeders.
// A /states/all box costs 1-4 credits by area; the global vector one round now asks for costs 4 (it was 28 for the ten boxes).
// Authentication is OAuth2 client credentials only (basic auth was removed on 2026-03-18):
// https://opensky-network.org/my-opensky/account -> "Create a new API client" -> the
// clientId/clientSecret of credentials.json go into OPENSKY_CLIENT_ID/OPENSKY_CLIENT_SECRET.

import { safeFetch, readBoundedText } from '../utils/fetch.mjs';
import { readQuota, writeQuota, clearQuota } from '../utils/quota-cache.mjs';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crucixHome } from '../../lib/user-paths.mjs';
import { AIRLINE_CALLSIGN, lookupRoutes, routeOf } from './air-routes.mjs';
import '../utils/env.mjs';

const BASE = 'https://opensky-network.org/api';
const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const MINUTE = 60000;
const TOKEN_MARGIN_MS = 30000; // refresh a token 30 s before it expires
// Minimum time between rounds, less INTERVAL_SLACK_MS so a sweep timer firing a little early still refreshes.
// With the 15-minute sweep: 96 rounds = 384 credits/day (of 4,000) and anonymous 12 rounds = 48 (of 400);
// even back-to-back at interval - slack: at most 103 rounds = 412 and 13 rounds = 52.
const MIN_INTERVAL_MS = { authenticated: 15 * MINUTE, anonymous: 120 * MINUTE };
const INTERVAL_SLACK_MS = MINUTE;
const MAX_STALE_MS = 180 * MINUTE; // oldest result served as stale while requests are blocked
const MAX_BLOCK_MS = 24 * 60 * MINUTE; // credits reset daily; a larger retry header is not trusted
// A round must end before the orchestrator's 30 s source race.
const ROUND_BUDGET_MS = 25000;
const TOKEN_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 20000;
// The global state vector: ~10-15k aircraft, a few MB of JSON.
const GLOBAL_MAX_BYTES = 25 * 1024 * 1024;
// The density grid of the map: airborne aircraft per GRID_DEGREES cell, the busiest MAX_CELLS cells.
const GRID_DEGREES = 2;
const MAX_CELLS = 1500;
// Emergency transponder codes: unlawful interference, radio failure, general emergency.
const SQUAWKS = Object.freeze({ '7500': 'hijack', '7600': 'radio', '7700': 'emergency' });
const MAX_ALERTS = 50;
// Aircraft worth a marker of their own (summarizeStates notable), by kind, at most MAX_NOTABLE in all.
const NOTABLE_CAPS = Object.freeze({ squawk: 50, military: 300, high: 80, nocallsign: 120 });
const MAX_NOTABLE = 500;
const HIGH_ALTITUDE_M = 13700; // above FL450: business jets, military and research aircraft, rarely airliners
// Callsign prefixes air forces and military transport fly under (US AMC "Reach", US Navy "Convoy", RQ-4 "Forte", P-8 "Homer", NATO AWACS,
// the RAF, French, German, Italian, Belgian, Dutch, Greek, Polish, Canadian, Australian, New Zealand, Swiss, Spanish and Turkish air
// forces …), each followed by a digit. A heuristic: a match is a military-pattern callsign, not a confirmed military flight.
const MILITARY_CALLSIGN = /^(RCH|CNV|PAT|SAM|SPAR|FORTE|HOMER|JAKE|NATO|MMF|RRR|ASCOT|CTM|FAF|GAF|IAM|BAF|NAF|HAF|PLF|CFC|ASY|KIWI|SUI|AME|TUAF|DUKE|KING|EVAC|NAVY|ARMY)\d/;
// Route arcs: the busiest airport pairs among the airborne aircraft with a known route.
const MAX_FLOWS = 80;
const MIN_FLOW = 2;
// The full aircraft list for the map's detail views (GET /api/air), written each good round; never part of the source result.
const AIRCRAFT_FILE = 'opensky-aircraft.json';
const AIRCRAFT_MAX_BYTES = 8 * 1024 * 1024;
const ROUTE_BUDGET_MS = 15000;
const MIN_REQUEST_MS = 2000; // a request is not started with less time than this left

let tokenCache = { token: null, expiresAt: 0 };
let tokenRequest = null;                  // in-flight token request, shared by concurrent callers
let lastRound = { at: 0, result: null };  // last round that got data (and so spent credits)
let blockedUntil = 0;                     // set by HTTP 429 from X-Rate-Limit-Retry-After-Seconds
let hydrated = false;

function persistQuota() {
  if (writeQuota('opensky', { blockedUntil, lastRound })) return;
  // Over the quota cache's size limit: the block and the interval matter more than the cached map grid.
  const result = lastRound.result ? { ...lastRound.result, grid: [], notable: (lastRound.result.notable || []).slice(0, 100) } : null;
  writeQuota('opensky', { blockedUntil, lastRound: { at: lastRound.at, result } });
}

function hydrateQuota() {
  if (hydrated) return;
  hydrated = true;
  const saved = readQuota('opensky');
  if (!saved) return;
  if (Number(saved.blockedUntil) > 0) blockedUntil = Number(saved.blockedUntil);
  if (Number(saved.lastRound?.at) > 0 && saved.lastRound.result) lastRound = saved.lastRound;
}

export function resetState({ disk = true } = {}) {
  tokenCache = { token: null, expiresAt: 0 };
  tokenRequest = null;
  lastRound = { at: 0, result: null };
  blockedUntil = 0;
  hydrated = false;
  if (disk) clearQuota('opensky');
}

function credentials() {
  const id = process.env.OPENSKY_CLIENT_ID, secret = process.env.OPENSKY_CLIENT_SECRET;
  if (id && secret) return { id, secret };
  if (id || secret) return { warning: 'Only one of OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET is set; using anonymous access' };
  return {};
}

// Never returns the response body or the exception text: either could echo the client secret.
async function requestToken({ id, secret }, now, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout); // covers the body read too
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Crucix/2.2' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
      redirect: 'error', // never replay the client secret to a redirect target
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { error: `HTTP ${res.status}` };
    }
    let data = null;
    const text = await readBoundedText(res, 64 * 1024);
    try { data = JSON.parse(text); } catch { /* reported below */ }
    // Printable ASCII only: anything else must never reach an Authorization header.
    if (typeof data?.access_token !== 'string' || !/^[\x21-\x7e]+$/.test(data.access_token)) return { error: 'response without access_token' };
    const lifetime = Number(data.expires_in) > 0 ? Math.min(86400, Math.max(60, Number(data.expires_in))) : 1800;
    tokenCache = { token: data.access_token, expiresAt: now + lifetime * 1000 - TOKEN_MARGIN_MS };
    return { token: data.access_token };
  } catch {
    return { error: controller.signal.aborted ? 'token request timed out' : 'token request failed' };
  } finally { clearTimeout(timer); }
}

function getToken(creds, now, timeout) {
  if (tokenCache.token && now < tokenCache.expiresAt) return Promise.resolve({ token: tokenCache.token });
  tokenRequest ??= requestToken(creds, now, timeout).finally(() => { tokenRequest = null; });
  return tokenRequest;
}

// Get all current flights (global state vector); one request costs 4 credits whatever the hour.
export async function getAllFlights(opts = {}) {
  return safeFetch(`${BASE}/states/all`, { timeout: 30000, maxBytes: GLOBAL_MAX_BYTES, ...opts });
}

// Get flights in a bounding box (lat/lon)
export async function getFlightsInArea(lamin, lomin, lamax, lomax, opts = {}) {
  const params = new URLSearchParams({
    lamin: String(lamin),
    lomin: String(lomin),
    lamax: String(lamax),
    lomax: String(lomax),
  });
  return safeFetch(`${BASE}/states/all?${params}`, { timeout: 20000, ...opts });
}

// Get flights by specific aircraft (ICAO24 hex codes)
export async function getFlightsByIcao(icao24List) {
  const icao = Array.isArray(icao24List) ? icao24List : [icao24List];
  const params = icao.map(i => `icao24=${i}`).join('&');
  return safeFetch(`${BASE}/states/all?${params}`, { timeout: 20000 });
}

// Get departures from an airport in a time range
export async function getDepartures(airportIcao, begin, end) {
  const params = new URLSearchParams({
    airport: airportIcao,
    begin: String(Math.floor(begin / 1000)),
    end: String(Math.floor(end / 1000)),
  });
  return safeFetch(`${BASE}/flights/departure?${params}`);
}

// Get arrivals at an airport
export async function getArrivals(airportIcao, begin, end) {
  const params = new URLSearchParams({
    airport: airportIcao,
    begin: String(Math.floor(begin / 1000)),
    end: String(Math.floor(end / 1000)),
  });
  return safeFetch(`${BASE}/flights/arrival?${params}`);
}

// Key hotspot regions for monitoring
const HOTSPOTS = {
  middleEast: { lamin: 12, lomin: 30, lamax: 42, lomax: 65, label: 'Middle East' },
  taiwan: { lamin: 20, lomin: 115, lamax: 28, lomax: 125, label: 'Taiwan Strait' },
  ukraine: { lamin: 44, lomin: 22, lamax: 53, lomax: 41, label: 'Ukraine Region' },
  baltics: { lamin: 53, lomin: 19, lamax: 60, lomax: 29, label: 'Baltic Region' },
  southChinaSea: { lamin: 5, lomin: 105, lamax: 23, lomax: 122, label: 'South China Sea' },
  koreanPeninsula: { lamin: 33, lomin: 124, lamax: 43, lomax: 132, label: 'Korean Peninsula' },
  caribbean: { lamin: 18, lomin: -90, lamax: 30, lomax: -72, label: 'Caribbean' },
  gulfOfGuinea: { lamin: -2, lomin: -5, lamax: 8, lomax: 10, label: 'Gulf of Guinea' },
  capeRoute: { lamin: -38, lomin: 12, lamax: -28, lomax: 24, label: 'Cape Route' },
  hornOfAfrica: { lamin: 5, lomin: 40, lamax: 15, lomax: 55, label: 'Horn of Africa' },
};

// The global state vector; on HTTP 401 the token is replaced once and the request retried once, if the round's remaining time allows
// it. No request may run past the deadline.
async function fetchGlobal(creds, token, now, deadline) {
  const remaining = () => deadline - Date.now();
  const get = bearer => getAllFlights({
    timeout: Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remaining())), retries: 0, retryAfterHeader: 'x-rate-limit-retry-after-seconds',
    ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
  });
  const data = await get(token);
  if (!token || data?.status !== 401) return data;
  if (tokenCache.token === token) tokenCache = { token: null, expiresAt: 0 };
  const noTime = { error: 'HTTP 401; no time left in this round to refresh the token' };
  if (remaining() < TOKEN_TIMEOUT_MS + MIN_REQUEST_MS) return noTime;
  const session = await getToken(creds, now, TOKEN_TIMEOUT_MS);
  if (session.error) return { error: `HTTP 401; token refresh failed: ${session.error}` };
  return remaining() < MIN_REQUEST_MS ? noTime : get(session.token);
}

// What the global state vector says (OpenSky state vector fields: 0 icao24, 1 callsign, 2 origin country, 5 longitude, 6 latitude,
// 7 barometric altitude m, 8 on ground, 9 velocity m/s, 10 track, 13 geometric altitude, 14 squawk):
//   hotspots  the legacy theatre boxes, counted from the same vector (the air panel, the delta engine and memory keep their shape)
//   grid      airborne aircraft per 2° cell, the busiest 1,500 cells: the map's density layer
//   alerts    aircraft squawking 7500/7600/7700
export function summarizeStates(states) {
  const list = Array.isArray(states) ? states.filter(Array.isArray) : [];
  const positioned = list.filter(s => Number.isFinite(s[5]) && Number.isFinite(s[6]));
  const airborne = positioned.filter(s => !s[8]);
  // The boxes count aircraft on the ground too, as the per-box requests before 2.45 did: the delta engine's air_total stays comparable.
  const hotspots = Object.entries(HOTSPOTS).map(([key, box]) => {
    const inside = positioned.filter(s => s[6] >= box.lamin && s[6] <= box.lamax && s[5] >= box.lomin && s[5] <= box.lomax);
    return {
      region: box.label, key, totalAircraft: inside.length,
      byCountry: inside.reduce((acc, s) => { const country = s[2] || 'Unknown'; acc[country] = (acc[country] || 0) + 1; return acc; }, {}),
      noCallsign: inside.filter(s => !String(s[1] || '').trim()).length,
      highAltitude: inside.filter(s => s[7] > 12000).length,
    };
  });
  const cells = new Map();
  for (const s of airborne) {
    const y = Math.floor(s[6] / GRID_DEGREES), x = Math.floor(s[5] / GRID_DEGREES);
    const key = `${y}|${x}`;
    let cell = cells.get(key);
    if (!cell) { cell = { lat: (y + 0.5) * GRID_DEGREES, lon: (x + 0.5) * GRID_DEGREES, count: 0, noCallsign: 0, highAlt: 0, countries: {} }; cells.set(key, cell); }
    cell.count++;
    if (!String(s[1] || '').trim()) cell.noCallsign++;
    if (s[7] > 12000) cell.highAlt++;
    const country = s[2] || 'Unknown';
    cell.countries[country] = (cell.countries[country] || 0) + 1;
  }
  const grid = [...cells.values()].sort((a, b) => b.count - a.count).slice(0, MAX_CELLS).map(cell => ({
    lat: cell.lat, lon: cell.lon, count: cell.count, noCallsign: cell.noCallsign, highAlt: cell.highAlt,
    top: Object.entries(cell.countries).sort((a, b) => b[1] - a[1]).slice(0, 3),
  }));
  const alerts = airborne.filter(s => Object.hasOwn(SQUAWKS, String(s[14] || ''))).slice(0, MAX_ALERTS).map(s => ({
    icao24: String(s[0] || '').slice(0, 6), callsign: String(s[1] || '').trim().slice(0, 8), country: String(s[2] || '').slice(0, 60),
    lat: s[6], lon: s[5], altitude: Number.isFinite(s[7]) ? Math.round(s[7]) : null, squawk: String(s[14]), kind: SQUAWKS[String(s[14])],
  }));
  const notable = notableOf(airborne);
  const aircraft = airborne.map(aircraftRow);
  return { total: list.length, airborne: airborne.length, onGround: list.filter(s => s[8]).length, hotspots, grid, gridDegrees: GRID_DEGREES, alerts, notable, aircraft };
}

const callsignOf = s => String(s[1] || '').trim().toUpperCase().slice(0, 8);
const num = (value, digits = 0) => Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
/** Why an airborne state vector is notable ('squawk' | 'military' | 'high' | 'nocallsign'), or null. */
export function notableKind(s) {
  if (Object.hasOwn(SQUAWKS, String(s[14] || ''))) return 'squawk';
  const callsign = callsignOf(s);
  if (MILITARY_CALLSIGN.test(callsign)) return 'military';
  if (s[7] > HIGH_ALTITUDE_M) return 'high';
  if (!callsign) return 'nocallsign';
  return null;
}
function notableOf(airborne) {
  const taken = { squawk: 0, military: 0, high: 0, nocallsign: 0 };
  const out = [];
  for (const kind of Object.keys(NOTABLE_CAPS)) for (const s of airborne) {
    if (out.length >= MAX_NOTABLE || taken[kind] >= NOTABLE_CAPS[kind]) break;
    if (notableKind(s) !== kind) continue;
    taken[kind]++;
    out.push({ icao24: String(s[0] || '').slice(0, 6), callsign: callsignOf(s), country: String(s[2] || '').slice(0, 60), lat: num(s[6], 3), lon: num(s[5], 3),
      altitude: num(s[7]), speed: num(s[9]), track: num(s[10]), squawk: String(s[14] || '').slice(0, 4), kind });
  }
  return out;
}
// A compact row of the aircraft list: [icao24, callsign, country, lat, lon, altitude m, speed m/s, track °, vertical rate m/s, squawk, kind].
export const AIRCRAFT_FIELDS = Object.freeze(['icao24', 'callsign', 'country', 'lat', 'lon', 'altitude', 'speed', 'track', 'vrate', 'squawk', 'kind', 'from', 'to']);
const aircraftRow = s => [String(s[0] || '').slice(0, 6), callsignOf(s), String(s[2] || '').slice(0, 60), num(s[6], 3), num(s[5], 3), num(s[7]), num(s[9]),
  num(s[10]), num(s[11], 1), String(s[14] || '').slice(0, 4), notableKind(s) || ''];

/** The busiest origin -> destination airport pairs of the aircraft rows that have a route ([..., from, to] airports). */
export function flowsOf(rows) {
  const pairs = new Map();
  for (const row of rows) {
    const from = row[11], to = row[12];
    if (!from || !to) continue;
    const key = `${from[0]}>${to[0]}`;
    const pair = pairs.get(key) ?? { from: from.slice(0, 4), to: to.slice(0, 4), count: 0 };
    pair.count++;
    pairs.set(key, pair);
  }
  return [...pairs.values()].filter(pair => pair.count >= MIN_FLOW).sort((a, b) => b.count - a.count || (a.from[0] + a.to[0]).localeCompare(b.from[0] + b.to[0])).slice(0, MAX_FLOWS);
}

const aircraftPath = options => join(crucixHome(options), 'cache', AIRCRAFT_FILE);
function writeAircraft(value, options) {
  try {
    mkdirSync(join(crucixHome(options), 'cache'), { recursive: true });
    const file = aircraftPath(options), tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, file);
  } catch { /* the detail list is optional: the map keeps its markers and arcs */ }
}
/** The aircraft list of the last good round ({ observedAt, at, fields, rows }), or null. */
export function readAircraft(options) {
  try {
    const raw = readFileSync(aircraftPath(options), 'utf8');
    if (raw.length > AIRCRAFT_MAX_BYTES) return null;
    const data = JSON.parse(raw);
    return data && Array.isArray(data.rows) ? data : null;
  } catch { return null; }
}

// A result for the whole source without any request.
function failure(error, now) {
  const hotspots = Object.entries(HOTSPOTS).map(([key, box]) => ({
    region: box.label, key, totalAircraft: 0, byCountry: {}, noCallsign: 0, highAltitude: 0, error,
  }));
  return { source: 'OpenSky', timestamp: new Date(now).toISOString(), hotspots, error,
    hotspotErrors: hotspots.map(h => ({ region: h.region, error })) };
}

function cached(message) {
  const { warning } = credentials();
  return { ...lastRound.result, stale: true, message: warning ? `${message}; ${warning}` : message };
}

function blocked(now) {
  const message = `OpenSky credit limit reached; retry after ${new Date(blockedUntil).toISOString()}`;
  const age = now - lastRound.at;
  return lastRound.result && age >= 0 && age <= MAX_STALE_MS ? cached(message) : failure(message, now);
}

// Briefing — the global flight picture: density grid, emergency squawks and the legacy hotspot counts
export async function briefing({ now = Date.now() } = {}) {
  hydrateQuota();
  if (now < blockedUntil) return blocked(now);
  const deadline = Date.now() + ROUND_BUDGET_MS;
  const creds = credentials();
  const interval = creds.secret ? MIN_INTERVAL_MS.authenticated : MIN_INTERVAL_MS.anonymous;
  const nextRound = lastRound.at + interval - INTERVAL_SLACK_MS; // always within MAX_STALE_MS of lastRound
  if (lastRound.result && now >= lastRound.at && now < nextRound) {
    return cached(`Cached OpenSky result; next request after ${new Date(nextRound).toISOString()}`);
  }
  let token = null;
  if (creds.secret) {
    const session = await getToken(creds, now, TOKEN_TIMEOUT_MS);
    if (session.error) {
      return failure(`OpenSky authentication failed (${session.error}); no anonymous fallback, check OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET`, now);
    }
    token = session.token;
  }

  // One global state vector per round (4 credits) instead of a request per theatre box: every aircraft, not ten boxes.
  const data = await fetchGlobal(creds, token, now, deadline);
  if (data?.status === 429) {
    blockedUntil = now + Math.min(MAX_BLOCK_MS, data.retryAfterMs ?? interval);
    persistQuota();
    return blocked(now);
  }
  const error = data?.error || (!Array.isArray(data?.states) ? 'OpenSky answered without a state vector' : null);
  if (error) return failure(`OpenSky unavailable: ${error}`, now);
  const { aircraft, ...summary } = summarizeStates(data.states);
  // Routes of the airline callsigns (cached a day; a few hundred new ones a round), then the arcs: the busiest airport pairs.
  const routeDeadline = Math.min(deadline - 1000, Date.now() + ROUTE_BUDGET_MS);
  // Military-pattern callsigns look like airline ones (RCH871) but have no route data: they are not asked for.
  const lookup = await lookupRoutes(aircraft.filter(row => row[10] !== 'military').map(row => ({ callsign: row[1], lat: row[3], lon: row[4] })), { deadline: routeDeadline, now });
  let routed = 0, airline = 0;
  for (const row of aircraft) {
    if (!AIRLINE_CALLSIGN.test(row[1]) || row[10] === 'military') continue;
    airline++;
    const route = routeOf(row[1], { now });
    if (route) { row.push(route.o, route.d); routed++; }
  }
  const flows = flowsOf(aircraft);
  const result = {
    source: 'OpenSky',
    timestamp: new Date(now).toISOString(),
    ...(Number.isFinite(data.time) ? { observedAt: new Date(data.time * 1000).toISOString() } : {}),
    ...summary,
    flows,
    routes: { airline, known: routed, asked: lookup.asked, ...(lookup.error ? { error: String(lookup.error).slice(0, 200) } : {}) },
    ...(creds.warning ? { message: creds.warning } : {}),
  };
  writeAircraft({ observedAt: result.observedAt ?? result.timestamp, at: result.timestamp, fields: AIRCRAFT_FIELDS, rows: aircraft });
  lastRound = { at: now, result };
  persistQuota();
  return result;
}

if (process.argv[1]?.endsWith('opensky.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
