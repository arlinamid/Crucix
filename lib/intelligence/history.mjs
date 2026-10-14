import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LIVE_KINDS } from './live-sources.mjs';

const DAY = 86400000;
const HARD_RECORDS = 10000;
const HARD_BYTES = 20 * 1024 * 1024;
const MAX_LOAD_BYTES = HARD_BYTES * 2;
const FUTURE_TOLERANCE_MS = 300000;
const KINDS = new Set(['news', 'osint', 'health', 'outage', 'conflict', 'signal', 'thermal', ...LIVE_KINDS]);
const SEVERITIES = new Set(['critical', 'high', 'elevated', 'moderate', 'low', 'monitor', 'unknown']);
const STATUSES = new Set(['ok', 'error', 'stale', 'disabled', 'unknown']);
const own = (value, key) => value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 300) => typeof value === 'string' ? value.slice(0, max * 2).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max) : '';
const clone = value => structuredClone(value);
const fold = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();

/** The generated EventRecord identity shared by storage, exports and HTTP routes. */
export const isEventId = value => typeof value === 'string' && /^event-[a-f0-9]{32}$/.test(value);

/** An API-safe validation error; callers may map status/code to a 400 response. */
export class HistoryValidationError extends Error {
  constructor(message, field, code = 'INVALID_FILTER') {
    super(message);
    this.name = 'HistoryValidationError';
    this.code = code;
    this.status = 400;
    if (field) this.field = field;
  }
}

/** Strict calendar-valid ISO dates and timestamps with an explicit timezone. */
export function normalizeIsoTime(value, { dateOnly = false, endOfDay = false } = {}) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/);
  if (!match || (!match[4] && !dateOnly)) return null;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  calendar.setUTCHours(0, 0, 0, 0);
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day)) return null;
  if (hour && (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)) return null;
  if (zone && zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return null;
  const timestamp = hour ? Date.parse(value) : calendar.getTime() + (endOfDay ? DAY - 1 : 0);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function safeSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) return null;
    // Auth-bearing URLs are not public source references and must not enter the journal.
    if ([...url.searchParams.keys()].some(key => /^(?:access[-_]?token|refresh[-_]?token|api[-_]?key|token|secret|password|authorization|auth|signature)$/i.test(key))) return null;
    return url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}

function normalizeSource(value) {
  const url = safeSourceUrl(own(value, 'url'));
  return {
    name: text(own(value, 'name'), 120) || 'Unknown source',
    url,
    hostname: url ? new URL(url).hostname.replace(/^www\./, '') : null,
    status: STATUSES.has(own(value, 'status')) ? own(value, 'status') : 'unknown',
  };
}

/** Allowlist the public EventRecord schema. It never copies raw/provider objects. */
export function normalizeHistoryEvent(value) {
  if (!object(value)) return null;
  const id = own(value, 'id');
  if (!isEventId(id)) return null;
  const source = normalizeSource(own(value, 'source'));
  const rawLocation = own(value, 'location');
  const lat = own(rawLocation, 'lat'); const lon = own(rawLocation, 'lon');
  const located = typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90 && typeof lon === 'number' && Number.isFinite(lon) && Math.abs(lon) <= 180;
  const observedAt = normalizeIsoTime(own(value, 'observedAt'));
  const publishedAt = normalizeIsoTime(own(value, 'publishedAt'));
  const method = located ? text(own(rawLocation, 'method'), 60) || 'unknown' : 'unknown';
  const precision = located ? text(own(rawLocation, 'precision'), 60) || 'unknown' : 'unknown';
  // Traceability checks are derived from the sanitized fields, never a truth score.
  const checks = { sourceUrl: Boolean(source.url), providerTime: Boolean(observedAt || publishedAt), location: located && method !== 'unknown', sourceStatus: source.status === 'ok' };
  const relatedSources = [];
  const related = own(value, 'relatedSources');
  if (Array.isArray(related)) for (const entry of related.slice(0, 8)) {
    const url = safeSourceUrl(own(entry, 'url'));
    const eventId = own(entry, 'eventId');
    if (!url || !isEventId(eventId) || eventId === id) continue;
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    if (hostname === source.hostname || relatedSources.some(item => item.hostname === hostname)) continue;
    relatedSources.push({ eventId, name: text(own(entry, 'name'), 120) || hostname, url, hostname, relationship: 'related-report' });
  }
  const codes = [];
  if (!checks.sourceUrl) codes.push('missing-source-url');
  if (!checks.providerTime) codes.push('unknown-provider-time');
  if (!located) codes.push('unknown-location');
  else if (method === 'unknown') codes.push('unknown-location-method');
  else if (/keyword|centroid|infer|estimate|approximate|polygon/i.test(method) || precision === 'approximate') codes.push('inferred-location');
  if (!checks.sourceStatus) codes.push(source.status === 'unknown' ? 'source-status-unknown' : `source-${source.status}`);
  if (relatedSources.length) codes.push('related-reports-not-corroboration');
  const present = Object.values(checks).filter(Boolean).length;
  const record = {
    id,
    kind: KINDS.has(own(value, 'kind')) ? own(value, 'kind') : 'signal',
    title: text(own(value, 'title'), 300) || 'Untitled event',
    summary: text(own(value, 'summary'), 2000),
    source,
    observedAt,
    publishedAt,
    collectedAt: normalizeIsoTime(own(value, 'collectedAt')),
    location: {
      lat: located ? lat : null, lon: located ? lon : null,
      method,
      label: text(own(rawLocation, 'label'), 160),
      precision,
    },
    severity: SEVERITIES.has(own(value, 'severity')) ? own(value, 'severity') : 'unknown',
    quality: { level: present === 4 ? 'complete' : present >= 2 ? 'partial' : 'minimal', checks, explanationCodes: codes },
    relatedSources,
  };
  const firstSeenAt = normalizeIsoTime(own(value, 'firstSeenAt'));
  for (const key of ['forecastAt','startsAt','validUntil']) {
    const time = normalizeIsoTime(own(value,key)); if (time) record[key]=time;
  }
  const lastSeenAt = normalizeIsoTime(own(value, 'lastSeenAt'));
  if (firstSeenAt) record.firstSeenAt = firstSeenAt;
  if (lastSeenAt) record.lastSeenAt = lastSeenAt;
  return record;
}

function queryText(value, field, max) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new HistoryValidationError(`Invalid ${field} filter`, field);
  return value.trim();
}
function integer(value, field, min, max, fallback) {
  if (value === undefined || value === '') return fallback;
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !/^\d+$/.test(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new HistoryValidationError(`Invalid ${field}; expected ${min}–${max}`, field);
  return Number(value);
}

export function validateHistoryFilters(filters = {}) {
  if (!object(filters)) throw new HistoryValidationError('Filters must be an object');
  const result = {
    q: queryText(own(filters, 'q'), 'q', 300),
    kind: queryText(own(filters, 'kind'), 'kind', 40),
    source: queryText(own(filters, 'source'), 'source', 200),
    from: queryText(own(filters, 'from'), 'from', 40),
    to: queryText(own(filters, 'to'), 'to', 40),
    limit: integer(own(filters, 'limit'), 'limit', 1, 200, 50),
    offset: integer(own(filters, 'offset'), 'offset', 0, HARD_RECORDS, 0),
  };
  if (result.kind && !KINDS.has(result.kind)) throw new HistoryValidationError('Unknown kind filter', 'kind');
  for (const field of ['from', 'to']) if (result[field]) {
    const time = normalizeIsoTime(result[field], { dateOnly: true, endOfDay: field === 'to' });
    if (!time) throw new HistoryValidationError(`Invalid ISO ${field} date`, field);
    result[field] = time;
  }
  if (result.from && result.to && result.from > result.to) throw new HistoryValidationError('from must precede to', 'from');
  return result;
}

const compare = (a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.id.localeCompare(b.id);
const urlKey = record => {
  if (!record.source.url) return null;
  const canonical = new URL(record.source.url);
  canonical.hash = '';
  canonical.hostname = canonical.hostname.replace(/^www\./, '');
  return `${record.kind}\0${canonical.href}`;
};
const documentBody = records => JSON.stringify({ version: 1, records });
const usableCollection = (record, time) => Boolean(record?.collectedAt) && Date.parse(record.collectedAt) <= time + FUTURE_TOLERANCE_MS;

function mergeRecord(records, urls, incoming, { restoring = false } = {}) {
  const key = urlKey(incoming);
  const byId = records.get(incoming.id);
  const byUrl = key ? records.get(urls.get(key)) : null;
  const matches = [...new Map([byId, byUrl].filter(Boolean).map(record => [record.id, record])).values()];
  // A stale ID update cannot make its old URL merge otherwise current records.
  if (!restoring && (byId && incoming.lastSeenAt < byId.lastSeenAt || !byId && byUrl && incoming.lastSeenAt < byUrl.lastSeenAt)) return 'ignored';
  const identities = restoring || !matches.length ? [...matches, incoming] : matches;
  // Canonical identity: earliest stored firstSeenAt; lexical ID breaks a tie.
  // Content: newest valid lastSeenAt; incoming wins an exact timestamp tie.
  const canonical = identities.reduce((a, b) => a.firstSeenAt < b.firstSeenAt || a.firstSeenAt === b.firstSeenAt && a.id < b.id ? a : b);
  const newest = matches.slice().sort(compare)[0];
  const content = !newest || incoming.lastSeenAt >= newest.lastSeenAt ? incoming : newest;
  const merged = { ...content, id: canonical.id, firstSeenAt: canonical.firstSeenAt };
  merged.relatedSources = merged.relatedSources.filter(source => source.eventId !== merged.id);
  for (const previous of matches) {
    records.delete(previous.id);
    const oldKey = urlKey(previous);
    if (oldKey && urls.get(oldKey) === previous.id) urls.delete(oldKey);
  }
  records.set(merged.id, merged);
  const mergedKey = urlKey(merged);
  if (mergedKey) urls.set(mergedKey, merged.id);
  return matches.length ? 'updated' : 'added';
}

function atomicWrite(path, body) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, body, 'utf8');
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export class HistoryStore {
  #records = [];
  #path;
  #now;
  #maxRecords;
  #retentionDays;
  #maxBytes;
  #bytes = 0;

  constructor(runsDir, { maxRecords = HARD_RECORDS, retentionDays = 30, maxBytes = HARD_BYTES, now = Date.now } = {}) {
    if (typeof runsDir !== 'string' || !runsDir || typeof now !== 'function') throw new TypeError('HistoryStore requires runsDir and a clock function');
    this.#maxRecords = integer(maxRecords, 'maxRecords', 1, HARD_RECORDS);
    this.#retentionDays = integer(retentionDays, 'retentionDays', 1, 30);
    this.#maxBytes = integer(maxBytes, 'maxBytes', 26, HARD_BYTES);
    this.#now = now;
    const dir = join(runsDir, 'intelligence');
    mkdirSync(dir, { recursive: true });
    this.#path = join(dir, 'history.json');
    const currentTime = this.#time();
    const primary = this.#read(this.#path, currentTime);
    const loaded = primary ?? this.#read(`${this.#path}.bak`, currentTime) ?? [];
    const records = new Map();
    const urls = new Map();
    for (const input of loaded) {
      const record = normalizeHistoryEvent(input);
      if (!usableCollection(record, currentTime)) continue;
      const collection = record.collectedAt;
      record.firstSeenAt = record.firstSeenAt && record.firstSeenAt <= collection ? record.firstSeenAt : collection;
      record.lastSeenAt = record.lastSeenAt && record.lastSeenAt >= collection && Date.parse(record.lastSeenAt) <= currentTime + FUTURE_TOLERANCE_MS ? record.lastSeenAt : collection;
      mergeRecord(records, urls, record, { restoring: true });
    }
    this.#records = this.#bounded([...records.values()], currentTime);
    this.#persist(this.#records);
  }

  #time() {
    const value = this.#now();
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('History clock must return finite epoch milliseconds');
    return value;
  }

  #read(path, time) {
    try {
      if (statSync(path).size > MAX_LOAD_BYTES) return null;
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (!object(data) || data.version !== 1 || !Array.isArray(data.records)) return null;
      // A parsed but unusable nonempty primary must not erase a valid backup.
      if (data.records.length && !data.records.some(input => usableCollection(normalizeHistoryEvent(input), time))) return null;
      return data.records;
    } catch { return null; }
  }

  #bounded(records, time) {
    const cutoff = time - this.#retentionDays * DAY;
    const ordered = records.filter(record => Date.parse(record.lastSeenAt) >= cutoff).sort(compare).slice(0, this.#maxRecords);
    let bytes = Buffer.byteLength(documentBody([]));
    const retained = [];
    for (const record of ordered) {
      const size = Buffer.byteLength(JSON.stringify(record)) + (retained.length ? 1 : 0);
      if (bytes + size > this.#maxBytes) continue;
      retained.push(record); bytes += size;
    }
    return retained;
  }

  #persist(records) {
    const body = documentBody(records);
    // Both copies contain validated data; no corrupt on-disk bytes are copied.
    atomicWrite(this.#path, body);
    atomicWrite(`${this.#path}.bak`, body);
    this.#bytes = Buffer.byteLength(body);
  }

  #expire() {
    const records = this.#bounded(this.#records, this.#time());
    if (records.length !== this.#records.length) {
      this.#persist(records);
      this.#records = records;
    }
  }

  add(events) {
    if (!Array.isArray(events)) throw new HistoryValidationError('Events must be an array', 'events', 'INVALID_EVENTS');
    const time = this.#time();
    const records = new Map(this.#records.map(record => [record.id, record]));
    const urls = new Map(this.#records.filter(record => record.source.url).map(record => [urlKey(record), record.id]));
    const result = { added: 0, updated: 0, ignored: 0 };
    for (const input of events) {
      const record = normalizeHistoryEvent(input);
      if (!usableCollection(record, time)) { result.ignored++; continue; }
      // Incoming first/last-seen fields cannot forge the storage lifecycle.
      record.firstSeenAt = record.collectedAt;
      record.lastSeenAt = record.collectedAt;
      result[mergeRecord(records, urls, record)]++;
    }
    const bounded = this.#bounded([...records.values()], time);
    this.#persist(bounded);
    this.#records = bounded;
    return { ...result, total: bounded.length };
  }

  get(id) {
    this.#expire();
    if (!isEventId(id)) return null;
    const record = this.#records.find(item => item.id === id);
    return record ? clone(record) : null;
  }

  /**
   * Several records with ONE expiry pass (get() runs one per call: about 19 ms at 10,000 records). A Map of id to a copy of the
   * record, in the order of `ids`; unknown, expired and malformed ids and repeats are left out.
   */
  getMany(ids) {
    this.#expire();
    const wanted = new Set(Array.isArray(ids) ? ids.filter(isEventId) : []);
    const found = new Map();
    if (!wanted.size) return found;
    const index = new Map();
    for (const record of this.#records) {
      if (!wanted.has(record.id)) continue;
      index.set(record.id, record);
      if (index.size === wanted.size) break;
    }
    for (const id of wanted) if (index.has(id)) found.set(id, clone(index.get(id)));
    return found;
  }

  query(filters = {}) {
    const checked = validateHistoryFilters(filters);
    this.#expire();
    const q = fold(checked.q); const source = fold(checked.source);
    const matched = this.#records.filter(record =>
      (!checked.kind || record.kind === checked.kind) &&
      (!source || fold(`${record.source.name} ${record.source.hostname || ''}`).includes(source)) &&
      (!q || fold(`${record.title} ${record.summary} ${record.location.label} ${record.source.name} ${record.source.hostname || ''}`).includes(q)) &&
      (!checked.from || record.lastSeenAt >= checked.from) && (!checked.to || record.lastSeenAt <= checked.to));
    const days = new Map(); const byKind = Object.create(null); const bySource = Object.create(null);
    for (const record of matched) {
      const day = record.lastSeenAt.slice(0, 10);
      days.set(day, (days.get(day) || 0) + 1);
      byKind[record.kind] = (byKind[record.kind] || 0) + 1;
      bySource[record.source.name] = (bySource[record.source.name] || 0) + 1;
    }
    const timeline = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
    return {
      items: clone(matched.slice(checked.offset, checked.offset + checked.limit)),
      total: matched.length, limit: checked.limit, offset: checked.offset,
      stats: { totalRecords: this.#records.length, matchedRecords: matched.length, earliestAt: matched.at(-1)?.lastSeenAt ?? null, latestAt: matched[0]?.lastSeenAt ?? null, days: timeline, timeline, byKind, bySource, retainedBytes: this.#bytes, maxRecords: this.#maxRecords, maxBytes: this.#maxBytes, retentionDays: this.#retentionDays },
    };
  }
}
