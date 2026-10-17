// Space/CelesTrak — Satellite Activity Monitoring
// No API key required. Uses CelesTrak for public TLE data and launch info.
// Tracks: Recent launches, ISS position, satellite decay alerts, space debris.

import { Agent } from 'undici';
import { safeFetch } from '../utils/fetch.mjs';
import { readQuota, writeQuota, clearQuota } from '../utils/quota-cache.mjs';

const CELESTRAK_BASE = 'https://celestrak.org';
const CACHE_MS = 2 * 60 * 60 * 1000; // GP data updates about every two hours
const LAST_GOOD_MS = 24 * 60 * 60 * 1000;
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
  if (disk) clearQuota('celestrak');
}

// Satellite categories for monitoring
const SAT_CATEGORIES = {
  stations: '/NORAD/elements/gp.php?GROUP=stations&FORMAT=json',
  lastDay: '/NORAD/elements/gp.php?GROUP=last-30-days&FORMAT=json',
  military: '/NORAD/elements/gp.php?GROUP=military&FORMAT=json',
  gps: '/NORAD/elements/gp.php?GROUP=gps-ops&FORMAT=json',
  starlink: '/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json',
  oneweb: '/NORAD/elements/gp.php?GROUP=oneweb&FORMAT=json',
};

// Get TLE data for a category
async function getTLEs(category) {
  const path = SAT_CATEGORIES[category];
  if (!path) return { error: 'Invalid category' };
  const data = await safeFetch(`${CELESTRAK_BASE}${path}`, {
    timeout: 25000, retries: 0, dispatcher: celestrakAgent,
  });
  return data;
}

// Get recent launches (from last 30 days TLEs)
async function getRecentLaunches() {
  const data = await getTLEs('lastDay');
  if (data.error || !Array.isArray(data)) {
    return { error: data.error || 'Failed to fetch launch data' };
  }

  const launches = data.map(sat => ({
    name: sat.OBJECT_NAME,
    noradId: sat.NORAD_CAT_ID,
    classification: sat.CLASSIFICATION_TYPE,
    launchDate: sat.LAUNCH_DATE,
    decayDate: sat.DECAY_DATE,
    period: sat.PERIOD,
    inclination: sat.INCLINATION,
    apogee: sat.APOAPSIS,
    perigee: sat.PERIAPSIS,
    epoch: sat.EPOCH,
    country: sat.COUNTRY_CODE,
    objectType: sat.OBJECT_TYPE,
  })).filter(s => s.name && s.noradId);

  launches.sort((a, b) => new Date(b.epoch || 0) - new Date(a.epoch || 0));

  const byCountry = {};
  launches.forEach(l => {
    const country = l.country || 'UNK';
    byCountry[country] = (byCountry[country] || 0) + 1;
  });

  return { totalObjects: launches.length, recentLaunches: launches.slice(0, 25), byCountry };
}

// Get space station data
async function getStationData() {
  const data = await getTLEs('stations');
  if (data.error || !Array.isArray(data)) {
    return { error: data.error || 'Failed to fetch station data' };
  }

  const stations = data.map(sat => ({
    name: sat.OBJECT_NAME,
    noradId: sat.NORAD_CAT_ID,
    apogee: sat.APOAPSIS,
    perigee: sat.PERIAPSIS,
    inclination: sat.INCLINATION,
    period: sat.PERIOD,
    epoch: sat.EPOCH,
  })).filter(s => s.name);

  const iss = stations.find(s => s.name.includes('ISS') || s.noradId === 25544);

  return { totalStations: stations.length, stations: stations.slice(0, 10), iss };
}

// Get military satellite count
async function getMilitaryCount() {
  const data = await getTLEs('military');
  if (data.error || !Array.isArray(data)) {
    return { count: 0, error: data.error };
  }

  const byCountry = {};
  data.forEach(sat => {
    const country = sat.COUNTRY_CODE || 'UNK';
    byCountry[country] = (byCountry[country] || 0) + 1;
  });

  return { count: data.length, byCountry };
}

// Mega-lists (Starlink especially) trip CelesTrak's usage limits. Reuse the last counted totals.
function getConstellationStats() {
  const saved = readQuota('celestrak-constellations');
  return {
    starlink: Number(saved?.starlink) || 0,
    oneweb: Number(saved?.oneweb) || 0,
  };
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
    const [launches, stations, military] = await Promise.all([
      getRecentLaunches(),
      getStationData(),
      getMilitaryCount(),
    ]);
    const constellations = getConstellationStats();

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
