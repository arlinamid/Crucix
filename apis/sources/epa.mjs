// EPA RadNet — Radiation Monitoring Network
// No auth required. The near-real-time gamma monitors of RadNet's own data service (radnet.epa.gov/cdx-radnet-rest): one CSV a year per
// fixed monitor, an hourly dose equivalent rate (nSv/h) and the gamma count rates of eight energy ranges.
// Since 2.51.1. Before it the source read the analytical laboratory results of Envirofacts (enviro.epa.gov / data.epa.gov), whose web
// application firewall answers HTTP 403 to this server ("Request blocked by the EPA data services web application firewall"); those
// lab results also lagged by days to weeks. The monitors report every hour.
//   - Each monitor: the latest dose rate, the median of the 30 days before the last day (its own background: rock, altitude and radon
//     make Denver's twice Seattle's), the highest of the last 24 hours, and the ratio latest / median. A monitor that reports no dose
//     rate (Denver and Las Vegas in October 2026) is judged by its summed gamma count rate (CPM) the same way.
//   - A ratio of 1.5 or more is a signal. Rain raises the dose rate for a few hours (radon progeny washed out of the air), so a single
//     high hour is reported as such, never as a release.
//   - A monitor without a reading for 48 hours is offline (shown, not an error); the source fails only when no monitor answers.
//   - A file is ~600 KB (no compression offered), so the result is cached for 3 hours: ~50 MB a day for the ten monitors.
//   - HTTP 403 from the service is not retried for 6 hours.

import { safeFetch } from '../utils/fetch.mjs';
import { readQuota, writeQuota, clearQuota } from '../utils/quota-cache.mjs';

const BASE = 'https://radnet.epa.gov/cdx-radnet-rest/api/rest/csv';
const HOUR = 3600000;
const CACHE_MS = 3 * HOUR;
const BLOCK_MS = 6 * HOUR;
const OFFLINE_MS = 48 * HOUR;
const BASELINE_MS = 30 * 24 * HOUR;
const ELEVATED_RATIO = 1.5;
const MAX_BYTES = 4 * 1024 * 1024;
const CONCURRENCY = 3;

// Monitors with a current CSV (checked 2026-10-17: New York has none under that name, Chicago has been silent since mid-September).
export const MONITORS = Object.freeze([
  { label: 'Washington, DC', state: 'DC', city: 'WASHINGTON', lat: 38.9, lon: -77.0 },
  { label: 'Los Angeles, CA', state: 'CA', city: 'LOS ANGELES', lat: 34.05, lon: -118.24 },
  { label: 'San Francisco, CA', state: 'CA', city: 'SAN FRANCISCO', lat: 37.77, lon: -122.42 },
  { label: 'Seattle, WA', state: 'WA', city: 'SEATTLE', lat: 47.61, lon: -122.33 },
  { label: 'Denver, CO', state: 'CO', city: 'DENVER', lat: 39.74, lon: -104.99 },
  { label: 'Las Vegas, NV', state: 'NV', city: 'LAS VEGAS', lat: 36.17, lon: -115.14 },
  { label: 'Houston, TX', state: 'TX', city: 'HOUSTON', lat: 29.76, lon: -95.37 },
  { label: 'Miami, FL', state: 'FL', city: 'MIAMI', lat: 25.76, lon: -80.19 },
  { label: 'Honolulu, HI', state: 'HI', city: 'HONOLULU', lat: 21.31, lon: -157.86 },
  { label: 'Anchorage, AK', state: 'AK', city: 'ANCHORAGE', lat: 61.22, lon: -149.9 },
]);

let blockedUntil = 0;
let lastGood = null; // { at, result }
let hydrated = false;

function hydrateQuota() {
  if (hydrated) return;
  hydrated = true;
  const saved = readQuota('epa');
  if (Number(saved?.blockedUntil) > 0) blockedUntil = Number(saved.blockedUntil);
  if (Number(saved?.lastGood?.at) > 0 && saved.lastGood.result) lastGood = saved.lastGood;
}

function persistQuota() {
  writeQuota('epa', { blockedUntil, lastGood });
}

export function resetState({ disk = true } = {}) {
  blockedUntil = 0;
  lastGood = null;
  hydrated = false;
  if (disk) clearQuota('epa');
}

const monitorUrl = (monitor, year) => `${BASE}/${year}/fixed/${encodeURIComponent(monitor.state)}/${encodeURIComponent(monitor.city)}`;

// "10/17/2026 13:29:00" (UTC) -> ms, or NaN.
function timeOf(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(value || '').trim());
  return match ? Date.UTC(+match[3], +match[1] - 1, +match[2], +match[4], +match[5], +match[6]) : NaN;
}

const reading = value => { const number = value === '' || value === undefined ? NaN : Number(value); return Number.isFinite(number) && number >= 0 && number < 1e7 ? number : null; };

/** The hourly readings of one monitor's CSV: [{ at, dose, cpm }] in time order: the dose rate (nSv/h) and the summed gamma count rate of
 * the eight energy ranges (CPM), each null when the row has none; rows with neither are skipped. */
export function parseRadnetCsv(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/).slice(1)) {
    const cells = line.split(',');
    if (cells.length < 3) continue;
    const at = timeOf(cells[1]);
    if (!Number.isFinite(at)) continue;
    const dose = reading(cells[2]);
    const counts = cells.slice(3, 11).map(reading);
    const cpm = counts.length === 8 && counts.every(value => value !== null) ? counts.reduce((sum, value) => sum + value, 0) : null;
    if (dose !== null || cpm !== null) out.push({ at, dose, cpm });
  }
  return out.sort((a, b) => a.at - b.at);
}

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** One monitor's state from its readings: the latest, its 30-day median background, the 24-hour maximum, the ratio, online or not. */
export function monitorState(monitor, readings, now) {
  // The dose rate while the monitor reports one; otherwise the gamma count rate.
  const doses = readings.filter(r => r.dose !== null), counts = readings.filter(r => r.cpm !== null);
  const useDose = doses.length && !(counts.length && counts.at(-1).at - doses.at(-1).at > OFFLINE_MS);
  const series = (useDose ? doses : counts).map(r => ({ at: r.at, value: useDose ? r.dose : r.cpm }));
  const base = { location: monitor.label, state: monitor.state, lat: monitor.lat, lon: monitor.lon, analyte: useDose ? 'Gamma dose rate' : 'Gamma count rate',
    unit: useDose ? 'nSv/h' : 'CPM' };
  const latest = series.at(-1) ?? null;
  if (!latest) return { ...base, status: 'no-data', result: null, collectDate: null };
  const lastDay = latest.at - 24 * HOUR;
  const background = median(series.filter(r => r.at < lastDay && r.at >= latest.at - BASELINE_MS).map(r => r.value));
  const max24 = Math.max(...series.filter(r => r.at >= lastDay).map(r => r.value));
  const ratio = background ? Math.round(latest.value / background * 100) / 100 : null;
  return {
    ...base, status: now - latest.at > OFFLINE_MS ? 'offline' : 'online', result: latest.value, collectDate: new Date(latest.at).toISOString(),
    baseline: background, max24h: Number.isFinite(max24) ? max24 : null, ratio,
  };
}

function denied(now, error) {
  return lastGood
    ? { ...lastGood.result, stale: true, message: error }
    : { source: 'EPA RadNet', timestamp: new Date(now).toISOString(), error, readings: [], signals: ['Radiation readings unavailable'] };
}

async function fetchMonitor(monitor, now) {
  const year = new Date(now).getUTCFullYear();
  const data = await safeFetch(monitorUrl(monitor, year), { format: 'text', timeout: 20000, retries: 0, maxBytes: MAX_BYTES });
  if (data.error) return { monitor, error: data.error, status: data.status };
  let readings = parseRadnetCsv(data.rawText);
  // Early January: the background comes from the end of last year's file too.
  if (readings.length < 30 * 24) {
    const previous = await safeFetch(monitorUrl(monitor, year - 1), { format: 'text', timeout: 20000, retries: 0, maxBytes: MAX_BYTES });
    if (!previous.error) readings = [...parseRadnetCsv(previous.rawText), ...readings];
  }
  return { monitor, readings };
}

// Briefing — the latest gamma dose rate of each monitor against its own 30-day background
export async function briefing({ now = Date.now() } = {}) {
  hydrateQuota();
  if (lastGood?.result && now >= lastGood.at && now - lastGood.at < CACHE_MS) {
    return { ...lastGood.result, cached: true, message: `Cached RadNet result; next request after ${new Date(lastGood.at + CACHE_MS).toISOString()}` };
  }
  if (now < blockedUntil) return denied(now, `EPA RadNet provider access denied (HTTP 403); retry after ${new Date(blockedUntil).toISOString()}`);

  // The first monitor alone: a refusal (403) stops the round before nine more requests.
  const answers = [await fetchMonitor(MONITORS[0], now)];
  if (answers[0].status === 403) {
    blockedUntil = now + BLOCK_MS;
    persistQuota();
    return denied(now, 'EPA RadNet provider access denied (HTTP 403)');
  }
  for (let i = 1; i < MONITORS.length; i += CONCURRENCY) {
    answers.push(...await Promise.all(MONITORS.slice(i, i + CONCURRENCY).map(monitor => fetchMonitor(monitor, now))));
  }
  const failed = answers.filter(answer => answer.error);
  const stations = answers.filter(answer => !answer.error).map(answer => monitorState(answer.monitor, answer.readings, now));
  const online = stations.filter(station => station.status === 'online');
  if (!online.length) {
    const error = failed.length ? `No RadNet monitor answered (${failed.length} failed: ${failed[0].error})` : 'No RadNet monitor has a reading in the last 48 hours';
    return denied(now, error);
  }

  const signals = [];
  for (const station of online) {
    if (station.ratio !== null && station.ratio >= ELEVATED_RATIO) {
      signals.push(`ELEVATED ${station.analyte.toLowerCase()} at ${station.location}: ${station.result} ${station.unit}, ${station.ratio}x its 30-day median of ${station.baseline} ${station.unit} `
        + `[${station.collectDate}]. Rain raises it for a few hours (radon washout); a release would show at several monitors and persist.`);
    }
  }
  const offline = stations.filter(station => station.status !== 'online').map(station => station.location);
  if (!signals.length) signals.push(`All ${online.length} reporting RadNet monitors are below ${ELEVATED_RATIO}x their 30-day median`);

  const result = {
    source: 'EPA RadNet',
    timestamp: new Date(now).toISOString(),
    totalReadings: online.length,
    readings: stations,
    stations,
    signals,
    ...(failed.length || offline.length ? { message: [failed.length ? `${failed.length} monitor(s) did not answer: ${failed.map(f => f.monitor.label).join(', ')}` : '',
      offline.length ? `offline (no reading for 48 h): ${offline.join(', ')}` : ''].filter(Boolean).join('; ') } : {}),
    note: 'RadNet near-real-time gamma monitors: the hourly dose equivalent rate (nSv/h), or the gamma count rate (CPM) where no dose rate is reported, against each monitor\'s own 30-day median.',
  };
  lastGood = { at: now, result };
  persistQuota();
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('epa.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify({ ...data, readings: undefined }, null, 2));
}
