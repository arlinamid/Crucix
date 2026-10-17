// Flight routes for the air layer: callsign -> origin and destination airport, from the routeset API of adsb.im (the standing data of
// the tar1090/VRS route database). One POST takes up to 100 callsigns with their positions and answers, per callsign, the airports
// of the route with their coordinates and a `plausible` flag (the aircraft's position fits the route). Measured on 2026-10-14 from
// Hungary: 100 live airline callsigns, 92 with a route, 86 of them plausible, 1.4 s, 75 KB.
//   - Only plausible two-airport answers are kept: a multi-leg or implausible route would draw a wrong arc.
//   - A route is cached per callsign for 24 hours (a flight number keeps its route through the day), an unknown callsign for 6 hours,
//     in CRUCIX_HOME/cache/air-routes.json, so a round asks only for the callsigns it has not seen: at most MAX_BATCHES requests (1,000
//     callsigns) a round, so the ~8,000 airline flights in the air are covered after a few 15-minute rounds.
//   - Provider text is never used as written: codes and names must match strict patterns, coordinates must be finite and on the globe.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeFetch } from '../utils/fetch.mjs';
import { crucixHome } from '../../lib/user-paths.mjs';

const ROUTESET_URL = 'https://adsb.im/api/0/routeset';
const BATCH = 100;
const MAX_BATCHES = 10;
const REQUEST_TIMEOUT_MS = 6000;
const MIN_REQUEST_MS = 2500;   // a batch is not started with less time than this left
const ROUTE_TTL_MS = 24 * 3600000;
const UNKNOWN_TTL_MS = 6 * 3600000;
const MAX_ENTRIES = 30000;
const MAX_FILE_BYTES = 6 * 1024 * 1024;
// An airline flight: a three-letter ICAO airline designator and a flight number (private and military callsigns have no route data).
export const AIRLINE_CALLSIGN = /^[A-Z]{3}[0-9][0-9A-Z]{0,4}$/;
const IATA = /^[A-Z0-9]{3}$/;
const ICAO = /^[A-Z0-9]{4}$/;
const ISO2 = /^[A-Z]{2}$/;

let cache = null; // Map callsign -> { at, route: { o, d } | null }

const cachePath = options => join(crucixHome(options), 'cache', 'air-routes.json');

function load(options) {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = readFileSync(cachePath(options), 'utf8');
    if (raw.length > MAX_FILE_BYTES) return cache;
    const rows = JSON.parse(raw)?.routes;
    if (Array.isArray(rows)) for (const [callsign, at, route] of rows) {
      if (typeof callsign === 'string' && AIRLINE_CALLSIGN.test(callsign) && Number.isFinite(at)) cache.set(callsign, { at, route: validRoute(route) });
    }
  } catch { /* no cache yet, or a broken one: start empty */ }
  return cache;
}

function save(options) {
  try {
    const dir = join(crucixHome(options), 'cache');
    mkdirSync(dir, { recursive: true });
    const rows = [...cache.entries()].slice(-MAX_ENTRIES).map(([callsign, entry]) => [callsign, entry.at, entry.route]);
    const file = cachePath(options), tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ routes: rows }));
    renameSync(tmp, file);
  } catch { /* the cache is an optimisation: a failed write costs a few requests next round */ }
}

/** Forget the in-memory cache, and with disk: true the cache file too (tests). */
export function resetRoutes({ disk = false, options } = {}) {
  cache = null;
  if (disk) try { unlinkSync(cachePath(options)); } catch { /* none yet */ }
}

// An airport as stored: [iata, lat, lon, iso2, icao].
function airportOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat), lon = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const iata = typeof raw.iata === 'string' && IATA.test(raw.iata) ? raw.iata : null;
  const icao = typeof raw.icao === 'string' && ICAO.test(raw.icao) ? raw.icao : null;
  if (!iata && !icao) return null;
  return [iata ?? icao, Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4, typeof raw.countryiso2 === 'string' && ISO2.test(raw.countryiso2) ? raw.countryiso2 : null, icao];
}
function validAirport(row) {
  return Array.isArray(row) && typeof row[0] === 'string' && /^[A-Z0-9]{3,4}$/.test(row[0]) && Number.isFinite(row[1]) && Number.isFinite(row[2])
    && Math.abs(row[1]) <= 90 && Math.abs(row[2]) <= 180 ? [row[0], row[1], row[2], typeof row[3] === 'string' && ISO2.test(row[3]) ? row[3] : null, typeof row[4] === 'string' && ICAO.test(row[4]) ? row[4] : null] : null;
}
function validRoute(route) {
  if (!route || typeof route !== 'object') return null;
  const o = validAirport(route.o), d = validAirport(route.d);
  return o && d && o[0] !== d[0] ? { o, d } : null;
}

/** The parsed answer of one routeset request: Map callsign -> route | null (null: answered, but no plausible two-airport route). */
export function parseRouteset(body, asked) {
  const out = new Map();
  for (const callsign of asked) out.set(callsign, null);
  for (const row of Array.isArray(body) ? body.slice(0, BATCH * 2) : []) {
    const callsign = typeof row?.callsign === 'string' ? row.callsign.trim().toUpperCase() : '';
    if (!out.has(callsign)) continue;
    const airports = Array.isArray(row._airports) ? row._airports : [];
    if (airports.length !== 2 || !(row.plausible === true || row.plausible === 1)) continue;
    const o = airportOf(airports[0]), d = airportOf(airports[1]);
    if (o && d && o[0] !== d[0]) out.set(callsign, { o, d });
  }
  return out;
}

/** Every airport of the cached routes ([code, lat, lon], one per code): the airports airline flights use, about 1,800 after a day. */
export function knownAirports({ options } = {}) {
  const out = new Map();
  for (const { route } of load(options).values()) for (const airport of route ? [route.o, route.d] : []) out.set(airport[0], [airport[0], airport[1], airport[2]]);
  return [...out.values()];
}

/** The cached route of a callsign ({ o, d } airports as [code, lat, lon, iso2, icao]), or null. */
export function routeOf(callsign, { now = Date.now(), options } = {}) {
  const entry = load(options).get(callsign);
  return entry?.route && now - entry.at < ROUTE_TTL_MS ? entry.route : null;
}

/**
 * Asks for the routes of the airline callsigns (planes: [{ callsign, lat, lon }]) not cached yet, in batches of 100, until the deadline
 * or MAX_BATCHES. Never throws; returns { asked, found, error? }.
 */
export async function lookupRoutes(planes, { deadline = Date.now() + 10000, now = Date.now(), options, maxBatches = MAX_BATCHES } = {}) {
  const known = load(options);
  const fresh = entry => entry && now - entry.at < (entry.route ? ROUTE_TTL_MS : UNKNOWN_TTL_MS);
  const seen = new Set();
  const todo = [];
  for (const plane of planes) {
    const callsign = plane?.callsign;
    if (typeof callsign !== 'string' || !AIRLINE_CALLSIGN.test(callsign) || seen.has(callsign) || fresh(known.get(callsign))) continue;
    if (!Number.isFinite(plane.lat) || !Number.isFinite(plane.lon)) continue;
    seen.add(callsign);
    todo.push({ callsign, lat: Math.round(plane.lat * 1e3) / 1e3, lng: Math.round(plane.lon * 1e3) / 1e3 });
    if (todo.length >= BATCH * maxBatches) break;
  }
  let asked = 0, found = 0, error;
  for (let i = 0; i < todo.length; i += BATCH) {
    const left = deadline - Date.now();
    if (left < MIN_REQUEST_MS) break;
    const batch = todo.slice(i, i + BATCH);
    const data = await safeFetch(ROUTESET_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planes: batch }),
      timeout: Math.min(REQUEST_TIMEOUT_MS, left), retries: 0, maxBytes: 2 * 1024 * 1024,
    });
    if (!Array.isArray(data)) { error = data?.error || 'routeset answered without a list'; break; }
    const parsed = parseRouteset(data, batch.map(plane => plane.callsign));
    for (const [callsign, route] of parsed) { known.delete(callsign); known.set(callsign, { at: now, route }); if (route) found++; }
    asked += batch.length;
  }
  if (asked) {
    while (known.size > MAX_ENTRIES) known.delete(known.keys().next().value);
    save(options);
  }
  return { asked, found, ...(error ? { error } : {}) };
}
