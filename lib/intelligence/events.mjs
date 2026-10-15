import { createHash } from 'node:crypto';
import { normalizeLiveSources, LIVE_KINDS } from './live-sources.mjs';

// Limits apply to entries examined, not just accepted records. This keeps even
// malformed or duplicate-heavy input bounded, without I/O or wall-clock reads.
const MAX_EVENTS = 2000;
const FEED_TOPICS = new Set(['conflict', 'politics', 'technology', 'health', 'economy']);
const MAX_RELATED = 8;
const MAX_BUCKET = 32;
const MAX_CANDIDATES = 64;
const DAY_MS = 24 * 60 * 60 * 1000;
const SEVERITIES = ['unknown', 'monitor', 'low', 'moderate', 'elevated', 'high', 'critical'];
// Provider severity words that are not already on the event scale. CAP orders Extreme > Severe > Moderate > Minor, so only
// Extreme (and GDACS Red) is critical; Severe (an NWS Flood Warning, for one) is high, or the threat level would sit at 5
// most of the time. Stored history is not rewritten (a record takes the new level at its next sighting).
// dashboard/public/record-core.js mirrors this table.
const SEVERITY_ALIASES = { extreme: 'critical', severe: 'high', red: 'critical', orange: 'high', yellow: 'moderate', medium: 'moderate', minor: 'low', info: 'low', green: 'low' };
const STATUSES = new Set(['ok', 'error', 'stale', 'disabled', 'unknown']);
const STOP_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'the', 'to', 'with', 'news', 'report', 'reports', 'update', 'updates', 'breaking']);

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = value => Array.isArray(value) ? value : [];
const text = (value, limit = 300) => typeof value === 'string'
  ? value.slice(0, limit).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim() : '';
const normalized = value => text(value, 300).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001F\u007F]/.test(value)) return null;
  try {
    const url = new URL(value);
    // Match journal/export rules: auth-bearing URLs are not public references.
    // Inspect decoded parameter names, including case and encoded-key variants.
    if ([...url.searchParams.keys()].some(key => /^(?:access[-_]?token|refresh[-_]?token|api[-_]?key|token|secret|password|authorization|auth|signature)$/i.test(key))) return null;
    const result = url.toString();
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.hostname && result.length <= 2048
      ? result : null;
  } catch { return null; }
}

function hostname(url) {
  return url ? new URL(url).hostname.toLowerCase().replace(/^www\./, '') : null;
}

function identityUrl(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  parsed.hostname = parsed.hostname.replace(/^www\./, '');
  return parsed.toString();
}

function providerTime(raw) {
  if (raw instanceof Date) raw = raw.getTime();
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || Math.abs(raw) > 253402300799999) return null;
    const date = new Date(raw);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof raw !== 'string' || !raw || raw.length > 128) return null;
  let value = raw.trim();
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (compact) value = `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`;
  const calendar = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (calendar) {
    const day = `${calendar[1]}-${calendar[2]}-${calendar[3]}`;
    const parsedDay = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== day) return null;
    if (value.length > 10) {
      const clock = value.match(/T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/);
      if (!clock || Number(clock[1]) > 23 || Number(clock[2]) > 59 || Number(clock[3] || 0) > 59) return null;
    }
  } else {
    // Validate the calendar and clock before Date.parse can roll an impossible
    // RFC date into a different day. An explicit zone also avoids machine-local
    // timezone assumptions for provider publication times.
    const rfc = value.match(/^(?:[A-Za-z]{3},?\s+)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(?:[+-]\d{4}|[A-Za-z]{1,5})$/);
    if (!rfc || Number(rfc[4]) > 23 || Number(rfc[5]) > 59 || Number(rfc[6] || 0) > 59) return null;
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(rfc[2].toLowerCase()) + 1;
    if (!month) return null;
    const day = `${rfc[3]}-${String(month).padStart(2, '0')}-${rfc[1].padStart(2, '0')}`;
    const parsedDay = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== day) return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function firstTime(...values) {
  for (const value of values) {
    const result = providerTime(value);
    if (result) return result;
  }
  return null;
}

function coordinates(lat, lon) {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90 && Number.isFinite(lon) && lon >= -180 && lon <= 180;
}

function locationOf(entry) {
  const nested = object(entry.location);
  const lat = Object.hasOwn(nested, 'lat') ? nested.lat : entry.lat;
  const lon = Object.hasOwn(nested, 'lon') ? nested.lon : entry.lon;
  const label = text(nested.label || entry.region || entry.place || (typeof entry.location === 'string' ? entry.location : '') || entry.country || entry.areaDesc, 200) || null;
  if (!coordinates(lat, lon)) return { lat: null, lon: null, method: 'unknown', label, precision: 'unknown' };
  const method = text(nested.method || entry.locationMethod, 80) || 'unknown';
  const precision = text(nested.precision || entry.locationPrecision, 80)
    || (method === 'unknown' ? 'unknown' : /keyword|centroid|infer|estimate|approximate|polygon/i.test(method) ? 'approximate' : method === 'provider' ? 'exact' : 'unknown');
  return { lat, lon, method, label, precision };
}

function statusOf(entry) {
  if (entry.disabled || entry.status === 'disabled') return 'disabled';
  if (entry.err || entry.error || entry.status === 'error') return 'error';
  if (entry.stale || entry.status === 'stale') return 'stale';
  const status = text(entry.sourceStatus || entry.status, 20).toLowerCase();
  if (STATUSES.has(status)) return status;
  if (status === 'success') return 'ok';
  if (Object.hasOwn(entry, 'err') || Object.hasOwn(entry, 'stale') || Object.hasOwn(entry, 'disabled')) return 'ok';
  return 'unknown';
}

function sourceHealth(snapshot) {
  const health = new Map();
  for (const entry of list(snapshot.health).slice(0, 128)) {
    const item = object(entry);
    const name = normalized(item.n || item.name);
    if (name) health.set(name, statusOf(item));
  }
  return health;
}

function qualityOf(event) {
  const validLocation = coordinates(event.location.lat, event.location.lon);
  const checks = {
    sourceUrl: Boolean(event.source.url),
    providerTime: Boolean(event.observedAt || event.publishedAt),
    location: validLocation && event.location.method !== 'unknown',
    sourceStatus: event.source.status === 'ok',
  };
  const explanationCodes = [];
  if (!checks.sourceUrl) explanationCodes.push('missing-source-url');
  if (!checks.providerTime) explanationCodes.push('unknown-provider-time');
  if (!validLocation) explanationCodes.push('unknown-location');
  else if (event.location.method === 'unknown') explanationCodes.push('unknown-location-method');
  else if (event.location.precision === 'approximate' || /keyword|centroid|infer|estimate|approximate|polygon/i.test(event.location.method)) explanationCodes.push('inferred-location');
  if (!checks.sourceStatus) explanationCodes.push(event.source.status === 'unknown' ? 'source-status-unknown' : `source-${event.source.status}`);
  const present = Object.values(checks).filter(Boolean).length;
  return { level: present === 4 ? 'complete' : present >= 2 ? 'partial' : 'minimal', checks, explanationCodes };
}

function entryTimes(entry, kind, category) {
  let observedAt = firstTime(entry.observedAt);
  let publishedAt = firstTime(entry.publishedAt);
  if (kind === 'news' || kind === 'osint' || kind === 'health') {
    if (category === 'gdelt') observedAt ||= firstTime(entry.seendate, entry.timestamp, entry.date);
    else publishedAt ||= firstTime(entry.date, category === 'feed' || category === 'telegram-feed' ? entry.timestamp : null);
  } else if (kind === 'earthquake') observedAt ||= firstTime(entry.time);
  else if (kind === 'weather') {
    observedAt ||= firstTime(entry.onset);
    publishedAt ||= firstTime(entry.sent);
  } else if (kind === 'outage') observedAt ||= firstTime(entry.startIso, typeof entry.start === 'number' ? entry.start * 1000 : entry.start, entry.lastStart);
  else if (kind === 'conflict') observedAt ||= firstTime(entry.date, entry.event_date);
  return { observedAt, publishedAt };
}

function eventTitle(entry, kind, category) {
  if (kind === 'outage') return text(entry.title) || `Internet outage${category === 'country' ? ' summary' : ''} — ${text(entry.country || entry.countryCode, 100) || 'Unknown country'}`;
  if (kind === 'earthquake') {
    const magnitude = Number.isFinite(entry.magnitude) ? entry.magnitude : Number.isFinite(entry.mag) ? entry.mag : '?';
    return text(entry.title) || `M${magnitude} earthquake — ${text(entry.place, 200) || 'Unknown location'}`;
  }
  if (kind === 'conflict') return text(entry.title) || `${text(entry.type || entry.event_type, 100) || 'Conflict event'} — ${text(typeof entry.location === 'string' ? entry.location : entry.country, 180) || 'Unknown location'}`;
  return text(entry.title || entry.headline || entry.text || entry.label || entry.event || entry.reason || entry.key);
}

// Maps a provider severity word onto the event scale; null means "not a severity word".
export function normalizeSeverity(value) {
  const word = text(value, 30).toLowerCase();
  if (SEVERITIES.includes(word)) return word;
  return Object.hasOwn(SEVERITY_ALIASES, word) ? SEVERITY_ALIASES[word] : null;
}

function normalize(entry, descriptor, collectedAt, health) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const { kind, provider, category } = descriptor;
  const signalItem = kind === 'signal' ? object(entry.item) : {};
  let metadata = entry;
  if (kind === 'signal') {
    // Copy only recognized metadata: raw provider objects can contain arbitrarily
    // many unrelated properties and are never enumerated or retained here.
    metadata = {};
    for (const field of ['source', 'url', 'link', 'channel', 'sourceStatus', 'status', 'err', 'error', 'stale', 'disabled', 'location', 'region', 'place', 'country', 'areaDesc', 'lat', 'lon', 'locationMethod', 'locationPrecision', 'observedAt', 'publishedAt', 'collectedAt', 'providerId', 'id', 'key', 'severity', 'summary', 'overview', 'description', 'notes', 'reason', 'text', 'from', 'to', 'syndicatedFrom', 'originalSource', 'syndicationSource']) {
      metadata[field] = entry[field] ?? signalItem[field];
    }
    // The delta engine embeds original Telegram posts. Their date is a provider
    // publication time; the encompassing delta timestamp is only a sweep time.
    if (text(signalItem.channel, 120)) metadata.publishedAt ??= signalItem.date;
  }
  const title = eventTitle(entry, kind, category);
  if (!title) return null;
  const nestedSource = object(metadata.source);
  const name = text(nestedSource.name || (typeof metadata.source === 'string' ? metadata.source : '') || metadata.channel || provider, 120) || provider;
  const url = safeUrl(metadata.url || metadata.link || nestedSource.url);
  const explicitStatus = statusOf({
    sourceStatus: metadata.sourceStatus, status: metadata.status ?? nestedSource.status,
    ...(metadata.err !== undefined ? { err: metadata.err } : {}),
    ...(metadata.error !== undefined ? { error: metadata.error } : {}),
    ...(metadata.stale !== undefined ? { stale: metadata.stale } : {}),
    ...(metadata.disabled !== undefined ? { disabled: metadata.disabled } : {}),
  });
  const status = explicitStatus !== 'unknown' ? explicitStatus : health.get(normalized(provider)) || health.get(normalized(name)) || 'unknown';
  const location = locationOf(metadata);
  const times = entryTimes(metadata, kind, category);
  const rawId = metadata.providerId ?? metadata.id ?? metadata.event_id_cnty ?? (kind === 'signal' ? metadata.key : '');
  const providerId = typeof rawId === 'string' ? text(rawId, 200) : typeof rawId === 'number' && Number.isFinite(rawId) ? String(rawId) : '';
  const identity = providerId ? [kind, 'provider-id', normalized(name), providerId] : url
    ? [kind, 'url', identityUrl(url)]
    : [kind, normalized(name), normalized(title), times.observedAt, times.publishedAt, location.lat, location.lon];
  const severity = normalizeSeverity(metadata.severity) ?? (category === 'urgent' || metadata.urgent ? 'high' : 'unknown');
  const summary = text(metadata.summary || metadata.overview || metadata.description || metadata.notes || metadata.reason || (kind === 'osint' ? metadata.text : ''), 2000)
    || (kind === 'signal' && Number.isFinite(metadata.from) && Number.isFinite(metadata.to) ? `${metadata.from} → ${metadata.to}` : '');
  // A specialist feed's topic (news-feeds.mjs) travels with its headline: the entity graph reads it as the record's topic.
  const topic = kind === 'news' && FEED_TOPICS.has(metadata.topic) ? metadata.topic : null;
  const event = {
    id: `event-${digest(identity)}`, kind, title, summary, ...(topic ? { topic } : {}),
    source: { name, url, hostname: hostname(url), status },
    ...times, collectedAt: firstTime(metadata.collectedAt) || collectedAt,
    location, severity, quality: null, relatedSources: [],
  };
  for (const key of ['forecastAt','startsAt','validUntil']) {
    const value = firstTime(metadata[key]); if (value) event[key] = value;
  }
  event.quality = qualityOf(event);
  return { event, syndication: normalized(metadata.syndicatedFrom || metadata.originalSource || metadata.syndicationSource || '') };
}

// The id buildEvents gives a live row. It runs the same normalize() as buildEvents, so identity rules cannot drift.
export function liveEventId(row) {
  if (!LIVE_KINDS.includes(row?.kind)) return null;
  return normalize(row, { kind: row.kind, provider: row.source, category: 'live' }, null, new Map())?.event.id ?? null;
}

// Copies of the sources whose observations carry their event id; the input is never mutated.
export function stampLiveEventIds(liveSources) {
  if (!Array.isArray(liveSources)) return liveSources;
  return liveSources.map(source => {
    if (!source || typeof source !== 'object' || !Array.isArray(source.observations)) return source;
    return { ...source, observations: source.observations.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      const stamped = { ...row };
      delete stamped.eventId;
      const id = liveEventId(stamped);
      if (id) stamped.eventId = id;
      return stamped;
    }) };
  });
}

function mergeDuplicate(first, next) {
  first.observedAt ||= next.observedAt;
  if (!first.topic && next.topic) first.topic = next.topic;
  first.publishedAt ||= next.publishedAt;
  if (!coordinates(first.location.lat, first.location.lon) && coordinates(next.location.lat, next.location.lon)) first.location = next.location;
  else if (first.location.method === 'unknown' && next.location.method !== 'unknown') first.location = next.location;
  if (first.source.status === 'unknown') first.source.status = next.source.status;
  if (next.summary.length > first.summary.length) first.summary = next.summary;
  if (SEVERITIES.indexOf(next.severity) > SEVERITIES.indexOf(first.severity)) first.severity = next.severity;
  first.quality = qualityOf(first);
}

function tokensOf(title) {
  return new Set(normalized(title).split(' ').filter(token => token.length > 1 && !STOP_WORDS.has(token)).slice(0, 32));
}

function similar(a, b) {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared >= 3 && shared / (a.size + b.size - shared) >= 0.5;
}

function nearby(a, b) {
  const radians = degrees => degrees * Math.PI / 180;
  const deltaLat = radians(b.lat - a.lat);
  const deltaLon = radians(b.lon - a.lon);
  const arc = Math.sin(deltaLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(deltaLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, arc)))) <= 500;
}

function addRelated(event, other) {
  if (event.relatedSources.length >= MAX_RELATED || event.relatedSources.some(source => source.hostname === other.source.hostname)) return;
  event.relatedSources.push({ eventId: other.id, name: other.source.name, url: other.source.url, hostname: other.source.hostname, relationship: 'related-report' });
  if (!event.quality.explanationCodes.includes('related-reports-not-corroboration')) event.quality.explanationCodes.push('related-reports-not-corroboration');
}

function relateReports(records) {
  const index = new Map();
  const prepared = [];
  for (const record of records) {
    const event = record.event;
    if (!['news', 'osint', 'health', 'conflict'].includes(event.kind) || !event.source.hostname || !coordinates(event.location.lat, event.location.lon)) continue;
    const time = Date.parse(event.observedAt || event.publishedAt || '');
    if (!Number.isFinite(time)) continue;
    const tokens = tokensOf(event.title);
    if (tokens.size < 3) continue;
    const item = { ...record, tokens, time };
    const latBin = Math.floor((event.location.lat + 90) / 4);
    const lonBin = Math.floor((event.location.lon + 180) / 4) % 90;
    const timeBin = Math.floor(time / DAY_MS);
    const keys = [...tokens].sort().slice(0, 8);
    const candidates = new Set();
    search: for (const token of keys) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) for (let t = -1; t <= 1; t++) {
      const key = `${latBin + y}|${(lonBin + x + 90) % 90}|${timeBin + t}|${token}`;
      for (const prior of index.get(key) || []) {
        candidates.add(prior);
        if (candidates.size >= MAX_CANDIDATES) break search;
      }
    }
    for (const candidate of candidates) {
      const prior = prepared[candidate];
      if (event.source.hostname === prior.event.source.hostname || (record.syndication && record.syndication === prior.syndication)) continue;
      if (Math.abs(time - prior.time) > DAY_MS || !similar(tokens, prior.tokens) || !nearby(event.location, prior.event.location)) continue;
      addRelated(event, prior.event);
      addRelated(prior.event, event);
    }
    const position = prepared.push(item) - 1;
    for (const token of keys) {
      const key = `${latBin}|${lonBin}|${timeBin}|${token}`;
      const bucket = index.get(key) || [];
      bucket.push(position);
      if (bucket.length > MAX_BUCKET) bucket.shift();
      index.set(key, bucket);
    }
  }
}

// High-intensity satellite fire detections on or beside a mapped military area (dashboard/inject.mjs marks them with `site`):
// located, dated records. A detection elsewhere stays a map dot; a range fire and an attack look alike from orbit.
function siteFires(thermal) {
  const out = [];
  for (const row of list(thermal).slice(0, 64)) {
    for (const fire of list(object(row).fires).slice(0, 16)) {
      const item = object(fire);
      const site = text(item.site, 160);
      if (!site || !coordinates(item.lat, item.lon)) continue;
      const frp = Number.isFinite(item.frp) ? Math.round(item.frp) : null;
      out.push({
        providerId: `firms:${item.lat.toFixed(3)},${item.lon.toFixed(3)},${text(item.at, 40)}`, source: 'FIRMS',
        title: `High-intensity fire${frp !== null ? ` (${frp} MW)` : ''} at ${site}`,
        summary: `Satellite heat detection on or beside the mapped military area ${site} (${text(object(row).region, 80) || 'FIRMS region'}). Range fire, burn-off and attack look alike from orbit.`,
        lat: item.lat, lon: item.lon, locationMethod: 'provider', locationPrecision: 'exact', place: site,
        observedAt: item.at, severity: frp !== null && frp >= 100 ? 'high' : 'elevated',
        url: 'https://firms.modaps.eosdis.nasa.gov/map/',
      });
    }
  }
  return out;
}

/** Normalize dashboard snapshots into bounded plain records. Unknown provider
 * times stay null. Collection time and health timestamps never become evidence.
 * Relations are heuristic related reports, never independent confirmation. */
export function buildEvents(input, { now = Date.now() } = {}) {
  const snapshot = object(input);
  const collectedAt = firstTime(object(snapshot.meta).timestamp, snapshot.collectedAt);
  const health = sourceHealth(snapshot);
  const groups = [
    { entries: list(snapshot.news), kind: 'news', provider: 'News', category: 'news' },
    { entries: list(snapshot.newsFeed), kind: 'news', provider: 'News', category: 'feed' },
    // The specialist feeds' own quota (dashboard/inject.mjs topicNews): the same news records, carrying their feed's topic.
    { entries: list(snapshot.topicNews), kind: 'news', provider: 'News', category: 'feed' },
    { entries: list(object(snapshot.tg).urgent), kind: 'osint', provider: 'Telegram', category: 'urgent' },
    { entries: list(object(snapshot.tg).topPosts), kind: 'osint', provider: 'Telegram', category: 'top' },
    { entries: list(snapshot.who), kind: 'health', provider: 'WHO', category: 'health' },
    { entries: list(snapshot.supplementalHealth), kind: 'health', provider: 'ReliefWeb', category: 'health' },
    { entries: list(snapshot.earthquakes), kind: 'earthquake', provider: 'USGS', category: 'earthquake' },
    { entries: list(object(snapshot.noaa).alerts), kind: 'weather', provider: 'NOAA', category: 'weather' },
    { entries: list(object(snapshot.ioda).recentEvents), kind: 'outage', provider: 'IODA', category: 'outage' },
    { entries: list(object(snapshot.ioda).countries), kind: 'outage', provider: 'IODA', category: 'country' },
    { entries: list(object(snapshot.acled).recentEvents), kind: 'conflict', provider: 'ACLED', category: 'conflict' },
    { entries: list(object(snapshot.acled).deadliestEvents), kind: 'conflict', provider: 'ACLED', category: 'conflict' },
    { entries: siteFires(snapshot.thermal), kind: 'thermal', provider: 'FIRMS', category: 'thermal' },
    { entries: list(snapshot.kev), kind: 'cyber', provider: 'CISA-KEV', category: 'kev' },
    // The air watch's incidents (lib/air/watch.mjs): aviation observations naming a flight, an aircraft and an airline.
    { entries: list(snapshot.airIncidents), kind: 'aviation', provider: 'Air-Watch', category: 'incident' },
    ...['new', 'escalated', 'deescalated', 'resolved'].map(category => ({ entries: list(object(object(snapshot.delta).signals)[category]), kind: 'signal', provider: 'Crucix', category })),
    ...normalizeLiveSources(snapshot.liveSources, now).flatMap(source => LIVE_KINDS.map(kind => ({entries:source.observations.filter(row=>row.kind===kind),kind,provider:source.source,category:'live'}))),
  ];
  const records = new Map();
  const identifiers = new Map();
  const urls = new Map();
  let examined = 0;
  // Round-robin preserves smaller provider categories when a feed is oversized.
  for (let offset = 0; examined < MAX_EVENTS; offset++) {
    let found = false;
    for (const descriptor of groups) {
      if (offset >= descriptor.entries.length) continue;
      found = true;
      if (examined++ >= MAX_EVENTS) break;
      const entry = descriptor.entries[offset];
      const type = text(object(entry).type, 30).toLowerCase();
      const adjusted = descriptor.category !== 'feed' ? descriptor : {
        ...descriptor, kind: type === 'telegram' || type === 'osint' ? 'osint' : 'news',
        provider: type === 'gdelt' ? 'GDELT' : type === 'telegram' ? 'Telegram' : 'News',
        category: type === 'gdelt' ? 'gdelt' : type === 'telegram' ? 'telegram-feed' : 'feed',
      };
      const record = normalize(entry, adjusted, collectedAt, health);
      if (!record) continue;
      const urlKey = record.event.source.url && descriptor.category !== 'live' ? `${record.event.kind}|${identityUrl(record.event.source.url)}` : null;
      const previous = identifiers.get(record.event.id) || (urlKey ? urls.get(urlKey) : null);
      if (previous) {
        mergeDuplicate(previous.event, record.event);
        previous.syndication ||= record.syndication;
      } else records.set(record.event.id, record);
      const accepted = previous || record;
      identifiers.set(record.event.id, accepted);
      if (urlKey) urls.set(urlKey, accepted);
    }
    if (!found) break;
  }
  const normalizedRecords = [...records.values()];
  relateReports(normalizedRecords);
  return normalizedRecords.map(record => record.event);
}

/** Geographic display groups only: 4-degree bins anchored at (-90,-180),
 * UTC epoch-aligned 24-hour provider-time bins by default. Unknown location/time
 * and singleton bins remain unclustered. Titles need not describe the same event.
 * sourceCount counts URL hostnames, not independent evidence or confirmed truth. */
export function clusterEvents(input, options = {}) {
  const settings = object(options);
  const cellDegrees = Number.isFinite(settings.cellDegrees) && settings.cellDegrees >= 0.1 && settings.cellDegrees <= 30 ? settings.cellDegrees : 4;
  const windowHours = Number.isFinite(settings.windowHours) && settings.windowHours >= 0.1 && settings.windowHours <= 168 ? settings.windowHours : 24;
  const groups = new Map();
  for (const entry of list(input).slice(0, MAX_EVENTS)) {
    const event = object(entry);
    const location = object(event.location);
    if (!['news', 'osint'].includes(event.kind) || !/^event-[a-f0-9]{1,64}$/.test(event.id || '') || !coordinates(location.lat, location.lon)) continue;
    const time = firstTime(event.observedAt, event.publishedAt);
    if (!time) continue;
    const key = `${Math.floor((location.lat + 90) / cellDegrees)}|${Math.floor((location.lon + 180) / cellDegrees)}|${Math.floor(Date.parse(time) / (windowHours * 3600000))}`;
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key).set(event.id, event);
  }
  const clusters = [];
  for (const [key, members] of groups) {
    if (members.size < 2) continue;
    const events = [...members.values()].sort((a, b) => a.id.localeCompare(b.id));
    const eventIds = events.map(event => event.id);
    const sources = new Set(events.map(event => hostname(safeUrl(object(event.source).url))).filter(Boolean));
    const lat = events.reduce((sum, event) => sum + event.location.lat, 0) / events.length;
    const lon = events.reduce((sum, event) => sum + event.location.lon, 0) / events.length;
    clusters.push({ id: `cluster-${digest([cellDegrees, windowHours, key, eventIds])}`, eventIds, lat, lon, count: events.length, sourceCount: sources.size, label: `${events.length} related reports` });
  }
  return clusters.sort((a, b) => a.id.localeCompare(b.id));
}
