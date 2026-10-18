// Space/CelesTrak — Satellite Activity Monitoring
// No API key required. Uses CelesTrak for public TLE data and launch info.
// Tracks: Recent launches, ISS position, satellite decay alerts, space debris.

import { Agent } from 'undici';
import { safeFetch } from '../utils/fetch.mjs';
import { readQuota, writeQuota, clearQuota } from '../utils/quota-cache.mjs';

const CELESTRAK_BASE = 'https://celestrak.org';
const CACHE_MS = 2 * 60 * 60 * 1000; // GP data updates about every two hours
const LAST_GOOD_MS = 24 * 60 * 60 * 1000;
// The mega-constellation lists are large (Starlink ~3.7 MB), so they are counted at most once a day.
const CONSTELLATION_MS = 24 * 60 * 60 * 1000;
const celestrakAgent = new Agent({ connect: { timeout: 20000, family: 4 }, connections: 3 });

let lastGood = { at: 0, result: null };
let hydrated = false;

function hydrateQuota() {
  if (hydrated) return;
  hydrated = true;
  const saved = readQuota('celestrak');
  if (Number(saved?.at) > 0 && saved.result) lastGood = { at: saved.at, result: saved.result };
}

export function resetState({ disk = true } = {}) {
  lastGood = { at: 0, result: null };
  hydrated = false;
  if (disk) {
    clearQuota('celestrak');
    clearQuota('celestrak-constellations');
  }
}

// The GP (OMM) records carry orbital elements only: no owner, launch date, period, apogee or perigee. Those come from the
// satellite catalogue (SATCAT), whose OWNER is CelesTrak's code (US, PRC, CIS, UK, SKOR, TBD …). Station positions need
// the GP epoch, so stations stay on GP and their period and altitudes are derived from the mean motion.
const GP = group => `/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`;
const SATCAT = group => `/satcat/records.php?GROUP=${group}&FORMAT=json`;
const EARTH_RADIUS_KM = 6378.137;
const MU_KM3_S2 = 398600.4418;

async function celestrak(path, options = {}) {
  return safeFetch(`${CELESTRAK_BASE}${path}`, { timeout: 25000, retries: 0, dispatcher: celestrakAgent, ...options });
}

const finite = value => (value === '' || value === null || value === undefined || !Number.isFinite(Number(value)) ? undefined : Number(value));

/** Period (min), apogee and perigee (km above the equatorial radius) of a GP record, from its mean motion and eccentricity. */
export function orbitOf(gp) {
  const meanMotion = finite(gp?.MEAN_MOTION);
  const eccentricity = finite(gp?.ECCENTRICITY) ?? 0;
  if (!meanMotion || meanMotion <= 0 || eccentricity < 0 || eccentricity >= 1) return {};
  const n = meanMotion * 2 * Math.PI / 86400;
  const a = Math.cbrt(MU_KM3_S2 / (n * n));
  return {
    period: +(1440 / meanMotion).toFixed(2),
    apogee: Math.round(a * (1 + eccentricity) - EARTH_RADIUS_KM),
    perigee: Math.round(a * (1 - eccentricity) - EARTH_RADIUS_KM),
  };
}

// Get recent launches (objects catalogued in the last 30 days)
async function getRecentLaunches() {
  const data = await celestrak(SATCAT('last-30-days'));
  if (data.error || !Array.isArray(data)) {
    return { error: data.error || 'Failed to fetch launch data' };
  }

  const launches = data.map(sat => ({
    name: sat.OBJECT_NAME,
    noradId: sat.NORAD_CAT_ID,
    intlDes: sat.OBJECT_ID,
    launchDate: sat.LAUNCH_DATE,
    decayDate: sat.DECAY_DATE || undefined,
    period: finite(sat.PERIOD),
    inclination: finite(sat.INCLINATION),
    apogee: finite(sat.APOGEE),
    perigee: finite(sat.PERIGEE),
    country: sat.OWNER || undefined,
    objectType: sat.OBJECT_TYPE,
  })).filter(s => s.name && s.noradId);

  launches.sort((a, b) => String(b.launchDate || '').localeCompare(String(a.launchDate || '')) || b.noradId - a.noradId);

  const byCountry = {};
  launches.forEach(l => {
    const country = l.country || 'TBD';
    byCountry[country] = (byCountry[country] || 0) + 1;
  });

  return { totalObjects: launches.length, recentLaunches: launches.slice(0, 25), byCountry };
}

// Get space station data
async function getStationData() {
  const data = await celestrak(GP('stations'));
  if (data.error || !Array.isArray(data)) {
    return { error: data.error || 'Failed to fetch station data' };
  }

  const stations = data.map(sat => ({
    name: sat.OBJECT_NAME,
    noradId: sat.NORAD_CAT_ID,
    inclination: sat.INCLINATION,
    epoch: sat.EPOCH,
    ...orbitOf(sat),
  })).filter(s => s.name);

  const iss = stations.find(s => s.name.includes('ISS') || s.noradId === 25544);

  return { totalStations: stations.length, stations: stations.slice(0, 10), iss };
}

// Get military satellite count (CelesTrak's miscellaneous military group)
async function getMilitaryCount() {
  const data = await celestrak(SATCAT('military'));
  if (data.error || !Array.isArray(data)) {
    return { count: 0, error: data.error };
  }

  const byCountry = {};
  data.forEach(sat => {
    const country = sat.OWNER || 'TBD';
    byCountry[country] = (byCountry[country] || 0) + 1;
  });

  return { count: data.length, byCountry };
}

// Mega-lists (Starlink especially) trip CelesTrak's usage limits, so the 2-hour briefing reuses the last count and reads the
// catalogue lists again only after CONSTELLATION_MS. A count never made is null (the panel shows "--"), not 0.
async function getConstellationStats(now) {
  const saved = readQuota('celestrak-constellations');
  const savedAt = Number(saved?.at) > 0 ? Number(saved.at) : 0;
  const known = {
    starlink: Number(saved?.starlink) > 0 ? Number(saved.starlink) : null,
    oneweb: Number(saved?.oneweb) > 0 ? Number(saved.oneweb) : null,
    ...(savedAt ? { countedAt: new Date(savedAt).toISOString() } : {}),
  };
  if (savedAt && now >= savedAt && now - savedAt < CONSTELLATION_MS) return known;
  const count = list => (Array.isArray(list) && list.length ? list.filter(sat => !sat.DECAY_DATE).length : null);
  const [starlink, oneweb] = (await Promise.all(['starlink', 'oneweb'].map(group =>
    celestrak(SATCAT(group), { timeout: 60000, maxBytes: 16 * 1024 * 1024 })))).map(count);
  // A failed list keeps its last count and is retried at the next briefing (2 h); a complete count waits a day.
  if (starlink === null || oneweb === null) return { ...known, starlink: starlink ?? known.starlink, oneweb: oneweb ?? known.oneweb };
  writeQuota('celestrak-constellations', { at: now, starlink, oneweb });
  return { starlink, oneweb, countedAt: new Date(now).toISOString() };
}

// Generate signals
function generateSignals(data) {
  const signals = [];

  if (data.launches?.totalObjects > 50) {
    signals.push(`HIGH LAUNCH TEMPO: ${data.launches.totalObjects} new objects tracked in last 30 days`);
  }

  const byCountry = data.launches?.byCountry || {};
  const cnLaunches = byCountry['PRC'] || byCountry['CN'] || 0;
  const ruLaunches = byCountry['CIS'] || byCountry['RU'] || 0;

  if (cnLaunches > 10) {
    signals.push(`CHINA SPACE ACTIVITY: ${cnLaunches} objects launched recently`);
  }
  if (ruLaunches > 5) {
    signals.push(`RUSSIA SPACE ACTIVITY: ${ruLaunches} objects launched recently`);
  }
  if (data.military?.count > 500) {
    signals.push(`MILITARY CONSTELLATION: ${data.military.count} tracked military satellites`);
  }
  if (data.constellations?.starlink > 6000) {
    signals.push(`STARLINK MEGA-CONSTELLATION: ${data.constellations.starlink} active satellites`);
  }

  return signals;
}

// Briefing export
export async function briefing({ now = Date.now() } = {}) {
  hydrateQuota();
  if (lastGood.result && now >= lastGood.at && now - lastGood.at < CACHE_MS) {
    // Within its planned interval the cached result is current (`cached`); only a fallback after a failure is stale.
    return { ...lastGood.result, cached: true, message: `Cached CelesTrak result; next request after ${new Date(lastGood.at + CACHE_MS).toISOString()}` };
  }
  try {
    const [launches, stations, military, constellations] = await Promise.all([
      getRecentLaunches(),
      getStationData(),
      getMilitaryCount(),
      getConstellationStats(now),
    ]);

    const hasData = !launches.error || !stations.error;

    if (!hasData) {
      if (lastGood.result && now - lastGood.at < LAST_GOOD_MS) {
        return { ...lastGood.result, stale: true, message: launches.error || stations.error || 'Failed to fetch space data' };
      }
      return {
        source: 'Space/CelesTrak',
        timestamp: new Date(now).toISOString(),
        status: 'error',
        error: launches.error || stations.error || 'Failed to fetch space data',
      };
    }

    const data = { launches, stations, military, constellations };
    const signals = generateSignals(data);

    const result = {
      source: 'Space/CelesTrak',
      timestamp: new Date(now).toISOString(),
      status: 'active',
      recentLaunches: launches.recentLaunches || [],
      totalNewObjects: launches.totalObjects || 0,
      launchByCountry: launches.byCountry || {},
      spaceStations: stations.stations || [],
      iss: stations.iss || null,
      militarySatellites: military.count || 0,
      militaryByCountry: military.byCountry || {},
      constellations: constellations || {},
      signals,
    };
    lastGood = { at: now, result };
    writeQuota('celestrak', lastGood);
    return result;
  } catch (e) {
    if (lastGood.result && now - lastGood.at < LAST_GOOD_MS) {
      return { ...lastGood.result, stale: true, message: e.message };
    }
    return {
      source: 'Space/CelesTrak',
      timestamp: new Date(now).toISOString(),
      status: 'error',
      error: e.message,
    };
  }
}

if (process.argv[1]?.endsWith('space.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
