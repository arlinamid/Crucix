// Current NOAA space-weather scales only. Other keys contain past maxima or forecasts.
import { safeFetch } from '../utils/fetch.mjs';
import { providerTime, freshResult, unavailableResult } from '../utils/freshness.mjs';

const SOURCE = 'NOAA-SWPC';
const FEED_URL = 'https://services.swpc.noaa.gov/products/noaa-scales.json';
const SOURCE_URL = 'https://www.swpc.noaa.gov/noaa-scales-explanation';
const LEVELS = ['none', 'minor', 'moderate', 'strong', 'severe', 'extreme'];
const SEVERITIES = ['monitor', 'low', 'moderate', 'high', 'high', 'critical'];
const SCALES = [
  ['R', 'radioBlackouts', 'radio blackouts'],
  ['S', 'solarRadiationStorms', 'solar radiation storms'],
  ['G', 'geomagneticStorms', 'geomagnetic storms'],
];
const META = { url:SOURCE_URL, feedUrl:FEED_URL, attribution:'NOAA / NWS Space Weather Prediction Center' };

export function parseSWPC(data, { now = Date.now() } = {}) {
  const current = data?.['0'];
  if (!current || typeof current !== 'object') return unavailableResult(SOURCE, 'Invalid NOAA scales: missing current conditions', {...META,metrics:{}}, now);
  const observedAt = typeof current.DateStamp === 'string' && typeof current.TimeStamp === 'string'
    ? providerTime(`${current.DateStamp}T${current.TimeStamp}`, {assumeUTC:true}) : null;
  const metrics = {};
  const observations = [];
  for (const [code, key, title] of SCALES) {
    const raw = current[code]?.Scale;
    // A missing value (null: NOAA writes the file in steps, about once a day a scale is briefly empty) leaves that scale out; a value
    // outside 0-5 is a broken feed.
    if (raw === null || raw === '' || raw === undefined) continue;
    if (!(typeof raw === 'string' && /^[0-5]$/.test(raw)) && !(Number.isInteger(raw) && raw >= 0 && raw <= 5)) {
      return unavailableResult(SOURCE, 'Invalid NOAA scale: expected a level from 0 to 5', {...META,metrics:{}}, now);
    }
    const scale = Number(raw);
    metrics[key] = { scale, label:LEVELS[scale] };
    if (scale > 0) observations.push({
      kind:'space-weather', title:`NOAA ${code}${scale} ${title}`,
      summary:`Current NOAA ${title} scale: ${code}${scale} (${LEVELS[scale]}). Global conditions; this feed does not identify a local impact site.`,
      source:SOURCE, url:SOURCE_URL, providerId:`${code}${scale}`, observedAt, publishedAt:observedAt,
      severity:SEVERITIES[scale], lat:null, lon:null, locationMethod:'global', locationPrecision:'unknown',
    });
  }
  if (!Object.keys(metrics).length) return unavailableResult(SOURCE, 'Invalid NOAA scales: no current scale value', {...META,metrics:{}}, now);
  const summary = `Current NOAA scales: ${SCALES.filter(([,key])=>metrics[key]).map(([code,key,title])=>`${code}${metrics[key].scale} ${title} (${metrics[key].label})`).join('; ')}. These are current conditions, separate from NOAA forecasts.`;
  const out = freshResult(SOURCE, observedAt, observations, {...META,metrics,summary}, now);
  if (out.stale) { out.metrics = {}; out.summary = 'Current NOAA space-weather scales are unavailable within the one-hour freshness window.'; }
  return out;
}

export async function briefing({ now = Date.now() } = {}) {
  const data = await safeFetch(FEED_URL, {timeout:10000,retries:0,maxBytes:2*1024*1024});
  return data?.error ? unavailableResult(SOURCE, data.error, {...META,metrics:{}}, now) : parseSWPC(data,{now});
}
