// Who an aircraft of an air-watch incident is: its registration, type and operator by its ICAO 24-bit address, and the airline, flight number
// and route of its callsign, from adsbdb.com (free, no key). Asked only for the aircraft of an incident (a few a day), cached 30 days in
// CRUCIX_HOME/cache/air-identity.json (an unknown answer 3 days). Provider text is never used as written: codes must match strict patterns,
// names are cut to plain text, coordinates must be on the globe. Never throws; an answer it could not get is null.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeFetch } from '../../apis/utils/fetch.mjs';
import { crucixHome } from '../user-paths.mjs';

const BASE = 'https://api.adsbdb.com/v0';
const DAY = 24 * 3600000;
const TTL_MS = 30 * DAY;
const UNKNOWN_TTL_MS = 3 * DAY;
const MAX_ENTRIES = 5000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const HEX = /^[0-9a-f]{6}$/;
const CALLSIGN = /^[A-Z0-9]{2,8}$/;

let cache = null; // { aircraft: Map, callsigns: Map } key -> { at, value }

const cachePath = options => join(crucixHome(options), 'cache', 'air-identity.json');
const plain = (value, max = 80) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max) : '';
const code = (value, pattern) => typeof value === 'string' && pattern.test(value.trim().toUpperCase()) ? value.trim().toUpperCase() : null;
const coordinate = (value, limit) => Number.isFinite(Number(value)) && Math.abs(Number(value)) <= limit ? Math.round(Number(value) * 1e4) / 1e4 : null;

function load(options) {
  if (cache) return cache;
  cache = { aircraft: new Map(), callsigns: new Map() };
  try {
    const raw = readFileSync(cachePath(options), 'utf8');
    if (raw.length <= MAX_FILE_BYTES) {
      const data = JSON.parse(raw);
      for (const name of ['aircraft', 'callsigns']) for (const row of Array.isArray(data?.[name]) ? data[name] : []) {
        if (Array.isArray(row) && typeof row[0] === 'string' && Number.isFinite(row[1])) cache[name].set(row[0], { at: row[1], value: row[2] ?? null });
      }
    }
  } catch { /* no cache yet */ }
  return cache;
}

function save(options) {
  try {
    mkdirSync(join(crucixHome(options), 'cache'), { recursive: true });
    const rows = map => [...map.entries()].slice(-MAX_ENTRIES).map(([key, entry]) => [key, entry.at, entry.value]);
    const file = cachePath(options), tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ aircraft: rows(cache.aircraft), callsigns: rows(cache.callsigns) }));
    renameSync(tmp, file);
  } catch { /* the cache saves requests only */ }
}

/** Forget the in-memory cache (tests). */
export function resetIdentity() { cache = null; }

export function parseAircraft(body) {
  const raw = body?.response?.aircraft;
  if (!raw || typeof raw !== 'object') return null;
  const registration = code(raw.registration, /^[A-Z0-9][A-Z0-9-]{1,9}$/);
  if (!registration) return null;
  return {
    registration, type: plain(raw.type, 40) || null, icaoType: code(raw.icao_type, /^[A-Z0-9]{2,4}$/), manufacturer: plain(raw.manufacturer, 60) || null,
    owner: plain(raw.registered_owner, 80) || null, ownerCountry: code(raw.registered_owner_country_iso_name, /^[A-Z]{2}$/),
    operator: code(raw.registered_owner_operator_flag_code, /^[A-Z]{3}$/),
  };
}

function airport(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const iata = code(raw.iata_code, /^[A-Z0-9]{3}$/), icao = code(raw.icao_code, /^[A-Z0-9]{4}$/);
  if (!iata && !icao) return null;
  return { iata, icao, name: plain(raw.name, 80) || null, city: plain(raw.municipality, 60) || null, country: code(raw.country_iso_name, /^[A-Z]{2}$/),
    lat: coordinate(raw.latitude, 90), lon: coordinate(raw.longitude, 180) };
}

export function parseRoute(body) {
  const raw = body?.response?.flightroute;
  if (!raw || typeof raw !== 'object') return null;
  const airline = raw.airline && typeof raw.airline === 'object' ? {
    name: plain(raw.airline.name, 80) || null, icao: code(raw.airline.icao, /^[A-Z]{3}$/), iata: code(raw.airline.iata, /^[A-Z0-9]{2}$/),
  } : null;
  return {
    flight: code(raw.callsign_iata, /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/), callsign: code(raw.callsign_icao || raw.callsign, CALLSIGN),
    airline: airline && (airline.name || airline.icao) ? airline : null, origin: airport(raw.origin), destination: airport(raw.destination),
  };
}

async function ask(map, key, url, parse, { now, timeoutMs, fetcher }) {
  const known = map.get(key);
  if (known && now - known.at < (known.value ? TTL_MS : UNKNOWN_TTL_MS)) return { value: known.value, asked: false };
  const body = await fetcher(url, { timeout: timeoutMs, retries: 0, maxBytes: 64 * 1024 });
  // A 404 is an answer (the database does not know it); any other failure is asked again next time.
  if (body?.error && body.status !== 404) return { value: known?.value ?? null, asked: true, error: body.error };
  const value = body?.error ? null : parse(body);
  map.delete(key);
  map.set(key, { at: now, value });
  return { value, asked: true };
}

/**
 * The identity of one aircraft: `{ aircraft, route }` (each null when unknown or unavailable). `icao24`: the 24-bit address (hex);
 * `callsign`: as transmitted.
 */
export async function identify({ icao24, callsign } = {}, { now = Date.now(), timeoutMs = 5000, options, fetcher = safeFetch } = {}) {
  const known = load(options);
  const hex = typeof icao24 === 'string' && HEX.test(icao24.trim().toLowerCase()) ? icao24.trim().toLowerCase() : null;
  const sign = typeof callsign === 'string' && CALLSIGN.test(callsign.trim().toUpperCase()) ? callsign.trim().toUpperCase() : null;
  const settings = { now, timeoutMs, fetcher };
  const [aircraft, route] = await Promise.all([
    hex ? ask(known.aircraft, hex, `${BASE}/aircraft/${hex.toUpperCase()}`, parseAircraft, settings) : { value: null, asked: false },
    sign ? ask(known.callsigns, sign, `${BASE}/callsign/${sign}`, parseRoute, settings) : { value: null, asked: false },
  ]);
  if (aircraft.asked || route.asked) save(options);
  return { aircraft: aircraft.value, route: route.value };
}
