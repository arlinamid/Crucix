import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { copyFileSync, createReadStream, createWriteStream, writeFileSync as writeFileNow } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip, deflateRawSync, gunzipSync, inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LIVE_KINDS } from './live-sources.mjs';

const DAY = 86400000;
const HARD_RECORDS = 10000;
// The SQLite store (Node's built-in node:sqlite) keeps every record of its retention window: no total cap of 10,000, which at ~6,000
// records a day held less than two days. MAX_ROWS is only a safety net against a runaway source.
const MAX_ROWS = 1_000_000;
const MAX_OFFSET = MAX_ROWS;
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
    offset: integer(own(filters, 'offset'), 'offset', 0, MAX_OFFSET, 0),
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

function mergeRecord(records, urls, incoming, { restoring = false, changes = null } = {}) {
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
    if (changes && previous.id !== merged.id) changes.removed.add(previous.id);
    const oldKey = urlKey(previous);
    if (oldKey && urls.get(oldKey) === previous.id) urls.delete(oldKey);
  }
  records.set(merged.id, merged);
  if (changes) changes.written.set(merged.id, merged);
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

/** The JSON-file store (one history.json and its .bak): the fallback where node:sqlite is not available (Node before 22.13). */
export class JsonHistoryStore {
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

  add(events) { return this.#ingest(events, false); }

  /**
   * Events of an earlier time (an archived sweep) merged in as they were seen then: a stored record keeps its newest content and last
   * sighting, and takes the earlier first sighting. The background import of the sweep archives uses it.
   */
  importRecords(events) { return this.#ingest(events, true); }

  #ingest(events, restoring) {
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
      result[mergeRecord(records, urls, record, { restoring })]++;
    }
    const bounded = this.#bounded([...records.values()], time);
    this.#persist(bounded);
    this.#records = bounded;
    return { ...result, total: bounded.length };
  }

  /** As SqliteHistoryStore.range: records first seen from `fromIso` to `toIso`, oldest first, one page after the cursor. */
  range(fromIso, toIso, { after = null, limit = 500 } = {}) {
    this.#expire();
    const seen = after?.firstSeenAt ?? '', id = after?.id ?? '';
    return clone(this.#records.filter(record => record.firstSeenAt >= fromIso && record.firstSeenAt <= toIso && (record.firstSeenAt > seen || (record.firstSeenAt === seen && record.id > id)))
      .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id)).slice(0, limit));
  }

  /** The newest `limit` records, newest first. */
  all({ limit = 20000 } = {}) { this.#expire(); return clone(this.#records.slice(0, limit)); }

  /** The JSON store needs no pruning or backup of its own (every write bounds it and keeps a .bak). */
  prune() { this.#expire(); return 0; }
  backup() { return false; }

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

// ===== The SQLite store =====
// node:sqlite, loaded without its "experimental" warning (Node 22.13+; Node 24 has none). null when the runtime lacks it.
let sqliteModule;
export function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  const emit = process.emitWarning;
  try {
    process.emitWarning = function (warning, ...rest) { if (/SQLite/i.test(String(warning?.message ?? warning))) return; return emit.call(process, warning, ...rest); };
    sqliteModule = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') ?? null : null;
  } catch { sqliteModule = null; }
  finally { process.emitWarning = emit; }
  return sqliteModule;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  url_key TEXT,
  kind TEXT NOT NULL,
  source_name TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  collected_at TEXT,
  search TEXT NOT NULL,
  source_search TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS records_last_seen ON records(last_seen);
CREATE INDEX IF NOT EXISTS records_url ON records(url_key);
CREATE INDEX IF NOT EXISTS records_first_seen ON records(first_seen, id);
-- Covers the query statistics (days, first-seen days, kinds, sources) and the source filter: read from the index, not from the rows
-- with their bodies.
DROP INDEX IF EXISTS records_stats;
CREATE INDEX IF NOT EXISTS records_stats_v2 ON records(last_seen, first_seen, kind, source_name, source_search);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(search, content='records', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS records_fts_insert AFTER INSERT ON records BEGIN
  INSERT INTO records_fts(rowid, search) VALUES (new.rowid, new.search);
END;
CREATE TRIGGER IF NOT EXISTS records_fts_delete AFTER DELETE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, search) VALUES ('delete', old.rowid, old.search);
END;
CREATE TRIGGER IF NOT EXISTS records_fts_update AFTER UPDATE OF search ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, search) VALUES ('delete', old.rowid, old.search);
  INSERT INTO records_fts(rowid, search) VALUES (new.rowid, new.search);
END;
`;
// The text search: every word of `q` as a word start (prefix) in the folded search text, and "a quoted phrase" as a phrase; the words
// are folded like the stored text (lower case, no accents), so "arviz" finds "Árvíz". An empty or punctuation-only query matches all.
export function ftsQuery(q) {
  const phrases = [];
  const rest = fold(String(q ?? '')).replace(/"([^"]*)"/g, (_, phrase) => { const words = phrase.split(/[^\p{L}\p{N}]+/u).filter(Boolean); if (words.length) phrases.push(`"${words.join(' ')}"`); return ' '; });
  const words = rest.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 16).map(word => `"${word}"*`);
  return [...phrases.slice(0, 8), ...words].join(' AND ');
}
// The stored body is the record without its lifecycle fields, which live in their own columns (a record seen again with the same content
// then changes only last_seen, and collected_at, NULL while it equals last_seen), and without `quality`, which normalizeHistoryEvent
// derives from the other fields on reading. Since 2.49 it is stored deflated (a BLOB, ~60% of the JSON); a row from before is JSON text
// until the background compaction or its next write rewrites it.
const bodyOf = record => { const { firstSeenAt, lastSeenAt, collectedAt, quality, ...rest } = record; return JSON.stringify(rest); };
const encodeBody = json => deflateRawSync(Buffer.from(json, 'utf8'));
const bodyJson = row => typeof row.body === 'string' ? row.body : inflateRawSync(Buffer.from(row.body)).toString('utf8');
const fromRow = row => {
  const body = JSON.parse(bodyJson(row));
  const record = { ...body, collectedAt: row.collected_at ?? body.collectedAt ?? row.last_seen, firstSeenAt: row.first_seen, lastSeenAt: row.last_seen };
  return body.quality ? record : normalizeHistoryEvent(record) ?? record;
};
const collectedColumn = record => record.collectedAt && record.collectedAt !== record.lastSeenAt ? record.collectedAt : null;
const searchOf = record => fold(`${record.title} ${record.summary} ${record.location.label} ${record.source.name} ${record.source.hostname || ''}`);
const sourceSearchOf = record => fold(`${record.source.name} ${record.source.hostname || ''}`);

/**
 * The event history in <runsDir>/intelligence/history.db (SQLite, WAL). A sweep writes only what changed: a new or changed record is one
 * row, a record seen again one indexed UPDATE of its last_seen; nothing is rewritten whole. Queries, counts and the timeline run in SQL.
 * The connection is opened per operation (a few ms), so no file stays locked between sweeps and other processes (the CLI collector) can
 * write too. The public API is the JSON store's: add, get, getMany, query; plus prune and backup for the background maintenance.
 */
export class SqliteHistoryStore {
  #path;
  #now;
  #retentionDays;
  #maxRows;
  #sqlite;
  #count = null;

  constructor(runsDir, { retentionDays = 30, maxRows = MAX_ROWS, now = Date.now } = {}) {
    if (typeof runsDir !== 'string' || !runsDir || typeof now !== 'function') throw new TypeError('HistoryStore requires runsDir and a clock function');
    this.#sqlite = loadSqlite();
    if (!this.#sqlite) throw new Error('node:sqlite is not available');
    this.#retentionDays = integer(retentionDays, 'retentionDays', 1, 365);
    this.#maxRows = integer(maxRows, 'maxRows', 1, MAX_ROWS);
    this.#now = now;
    const dir = join(runsDir, 'intelligence');
    mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.#path = join(dir, 'history.db');
    this.engine = 'sqlite';
    this.#open(db => {
      // A database from before the collected_at column (its rows keep collectedAt in the body until they are written again).
      db.exec(SCHEMA.slice(0, SCHEMA.indexOf('CREATE VIRTUAL TABLE')));
      if (!db.prepare('PRAGMA table_info(records)').all().some(column => column.name === 'collected_at')) db.exec('ALTER TABLE records ADD COLUMN collected_at TEXT');
      db.exec(SCHEMA);
      // The full-text index of a database from before it (2.48 and earlier): built once from the stored rows.
      if (!db.prepare("SELECT value FROM meta WHERE key = 'fts'").get()) {
        db.exec("INSERT INTO records_fts(records_fts) VALUES ('rebuild')");
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('fts', '1')").run();
      }
    });
    this.#migrate();
    this.prune();
  }

  #time() {
    const value = this.#now();
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('History clock must return finite epoch milliseconds');
    return value;
  }
  #cutoff(time = this.#time()) { return new Date(time - this.#retentionDays * DAY).toISOString(); }

  // One connection for one operation; a corrupt file is replaced by the daily backup once.
  #open(fn, { retried = false } = {}) {
    let db;
    try {
      db = new this.#sqlite.DatabaseSync(this.#path);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
      return fn(db);
    } catch (error) {
      const corrupt = /SQLITE_(CORRUPT|NOTADB)|malformed|not a database/i.test(String(error?.message));
      try { db?.close(); } catch { /* already closed */ }
      db = null;
      const gz = `${this.#path}.bak.gz`, plain = `${this.#path}.bak`;
      if (corrupt && !retried && (existsSync(gz) || existsSync(plain))) {
        try { renameSync(this.#path, `${this.#path}.corrupt-${Date.now()}`); } catch { /* keep going */ }
        for (const suffix of ['-wal', '-shm']) { try { unlinkSync(`${this.#path}${suffix}`); } catch { /* none */ } }
        if (existsSync(gz)) writeFileNow(this.#path, gunzipSync(readFileSync(gz)));
        else copyFileSync(plain, this.#path);
        this.#open(db2 => db2.exec(SCHEMA), { retried: true });
        return this.#open(fn, { retried: true });
      }
      throw error;
    } finally {
      try { db?.close(); } catch { /* already closed */ }
    }
  }

  // The JSON history of an older version moves into the database once; the file is kept as history.json.migrated.
  #migrate() {
    const legacy = join(this.dir, 'history.json');
    if (!existsSync(legacy)) return;
    let records = null;
    for (const path of [legacy, `${legacy}.bak`]) {
      try {
        if (statSync(path).size > MAX_LOAD_BYTES) continue;
        const data = JSON.parse(readFileSync(path, 'utf8'));
        if (object(data) && data.version === 1 && Array.isArray(data.records)) { records = data.records; break; }
      } catch { /* try the backup */ }
    }
    const time = this.#time();
    if (records) {
      const restored = new Map(), urls = new Map();
      for (const input of records) {
        const record = normalizeHistoryEvent(input);
        if (!usableCollection(record, time)) continue;
        const collection = record.collectedAt;
        record.firstSeenAt = record.firstSeenAt && record.firstSeenAt <= collection ? record.firstSeenAt : collection;
        record.lastSeenAt = record.lastSeenAt && record.lastSeenAt >= collection && Date.parse(record.lastSeenAt) <= time + FUTURE_TOLERANCE_MS ? record.lastSeenAt : collection;
        mergeRecord(restored, urls, record, { restoring: true });
      }
      this.#open(db => this.#write(db, [...restored.values()], new Set()));
    }
    for (const path of [legacy, `${legacy}.bak`]) if (existsSync(path)) { try { renameSync(path, `${path.replace(/\.json(\.bak)?$/, '.json$1')}.migrated`); } catch { /* left in place: read again harmlessly */ } }
  }

  #write(db, written, removed) {
    const upsert = db.prepare('INSERT INTO records (id, url_key, kind, source_name, first_seen, last_seen, collected_at, search, source_search, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(id) DO UPDATE SET url_key=excluded.url_key, kind=excluded.kind, source_name=excluded.source_name, first_seen=excluded.first_seen, '
      + 'last_seen=excluded.last_seen, collected_at=excluded.collected_at, search=excluded.search, source_search=excluded.source_search, body=excluded.body');
    const drop = db.prepare('DELETE FROM records WHERE id = ?');
    db.exec('BEGIN');
    try {
      for (const id of removed) drop.run(id);
      for (const record of written) upsert.run(record.id, urlKey(record), record.kind, record.source.name, record.firstSeenAt, record.lastSeenAt, collectedColumn(record), searchOf(record), sourceSearchOf(record), encodeBody(bodyOf(record)));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    this.#count = null;
  }

  add(events) { return this.#ingest(events, false); }

  /**
   * Events of an earlier time (an archived sweep) merged in as they were seen then: a stored record keeps its newest content and last
   * sighting and takes the earlier first sighting; a record that does not change is not written. The background import uses it.
   */
  importRecords(events) { return this.#ingest(events, true); }

  #ingest(events, restoring) {
    if (!Array.isArray(events)) throw new HistoryValidationError('Events must be an array', 'events', 'INVALID_EVENTS');
    const time = this.#time();
    const result = { added: 0, updated: 0, ignored: 0 };
    const incoming = [];
    for (const input of events) {
      const record = normalizeHistoryEvent(input);
      if (!usableCollection(record, time)) { result.ignored++; continue; }
      // Incoming first/last-seen fields cannot forge the storage lifecycle.
      record.firstSeenAt = record.collectedAt;
      record.lastSeenAt = record.collectedAt;
      incoming.push(record);
    }
    return this.#open(db => {
      // The stored records the batch can merge with, read in a few IN queries (not two lookups per record): by id and by canonical URL.
      const stored = new Map(), bodies = new Map(), idByUrl = new Map();
      const keep = row => { if (stored.has(row.id)) return; const record = fromRow(row); stored.set(row.id, record); bodies.set(row.id, bodyJson(row)); if (row.url_key) idByUrl.set(row.url_key, row.id); };
      const fetchIn = (column, values) => {
        const list = [...new Set(values.filter(Boolean))];
        for (let i = 0; i < list.length; i += 400) {
          const chunk = list.slice(i, i + 400);
          for (const row of db.prepare(`SELECT * FROM records WHERE ${column} IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) keep(row);
        }
      };
      fetchIn('id', incoming.map(record => record.id));
      fetchIn('url_key', incoming.map(urlKey));
      const seen = db.prepare('UPDATE records SET last_seen = ?, collected_at = ? WHERE id = ?');
      const upsert = db.prepare('INSERT INTO records (id, url_key, kind, source_name, first_seen, last_seen, collected_at, search, source_search, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT(id) DO UPDATE SET url_key=excluded.url_key, kind=excluded.kind, source_name=excluded.source_name, first_seen=excluded.first_seen, '
        + 'last_seen=excluded.last_seen, collected_at=excluded.collected_at, search=excluded.search, source_search=excluded.source_search, body=excluded.body');
      const drop = db.prepare('DELETE FROM records WHERE id = ?');
      db.exec('BEGIN');
      try {
        for (const record of incoming) {
          // The stored records this one can merge with: the same id and the same canonical URL (the in-memory store's maps, per record).
          const records = new Map(), urls = new Map();
          const key = urlKey(record);
          for (const match of [stored.get(record.id), key ? stored.get(idByUrl.get(key)) : null]) {
            if (!match || records.has(match.id)) continue;
            records.set(match.id, match);
            const matchKey = urlKey(match);
            if (matchKey) urls.set(matchKey, match.id);
          }
          const changes = { written: new Map(), removed: new Set() };
          const outcome = mergeRecord(records, urls, record, { changes, restoring });
          result[outcome]++;
          if (outcome === 'ignored') continue;
          for (const id of changes.removed) {
            drop.run(id);
            const gone = stored.get(id);
            if (gone && idByUrl.get(urlKey(gone)) === id) idByUrl.delete(urlKey(gone));
            stored.delete(id); bodies.delete(id);
          }
          for (const merged of changes.written.values()) {
            const body = bodyOf(merged), mergedKey = urlKey(merged), before = stored.get(merged.id);
            const same = bodies.get(merged.id) === body && before?.firstSeenAt === merged.firstSeenAt;
            // Nothing changed (an import of a sighting the store already covers): no write.
            if (same && before.lastSeenAt === merged.lastSeenAt && before.collectedAt === merged.collectedAt) continue;
            // A record seen again with the same content only moves its last_seen.
            if (same) seen.run(merged.lastSeenAt, collectedColumn(merged), merged.id);
            else upsert.run(merged.id, mergedKey, merged.kind, merged.source.name, merged.firstSeenAt, merged.lastSeenAt, collectedColumn(merged), searchOf(merged), sourceSearchOf(merged), encodeBody(body));
            stored.set(merged.id, merged); bodies.set(merged.id, body);
            if (mergedKey) idByUrl.set(mergedKey, merged.id);
          }
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      this.#count = null;
      return { ...result, total: this.#total(db, time) };
    });
  }

  #total(db, time = this.#time()) {
    if (this.#count === null) this.#count = Number(db.prepare('SELECT COUNT(*) AS n FROM records WHERE last_seen >= ?').get(this.#cutoff(time)).n);
    return this.#count;
  }

  get(id) {
    if (!isEventId(id)) return null;
    return this.#open(db => {
      const row = db.prepare('SELECT * FROM records WHERE id = ? AND last_seen >= ?').get(id, this.#cutoff());
      return row ? fromRow(row) : null;
    });
  }

  /** Several records by id: a Map of id to the record, in the order of `ids`; unknown, expired and malformed ids and repeats are left out. */
  getMany(ids) {
    const wanted = [...new Set(Array.isArray(ids) ? ids.filter(isEventId) : [])];
    const found = new Map();
    if (!wanted.length) return found;
    return this.#open(db => {
      const rows = new Map();
      const cutoff = this.#cutoff();
      for (let i = 0; i < wanted.length; i += 400) {
        const chunk = wanted.slice(i, i + 400);
        for (const row of db.prepare(`SELECT * FROM records WHERE last_seen >= ? AND id IN (${chunk.map(() => '?').join(',')})`).all(cutoff, ...chunk)) rows.set(row.id, row);
      }
      for (const id of wanted) if (rows.has(id)) found.set(id, fromRow(rows.get(id)));
      return found;
    });
  }

  /**
   * Records first seen from `fromIso` to `toIso` (inclusive), oldest first, one page after the cursor (the last record of the previous page):
   * the background graph backfill and the thread archive read the history with it.
   */
  range(fromIso, toIso, { after = null, limit = 500 } = {}) {
    const seen = after?.firstSeenAt ?? '', id = after?.id ?? '';
    return this.#open(db => db.prepare('SELECT * FROM records WHERE first_seen >= ? AND first_seen <= ? AND last_seen >= ? AND (first_seen > ? OR (first_seen = ? AND id > ?)) ORDER BY first_seen, id LIMIT ?')
      .all(fromIso, toIso, this.#cutoff(), seen, seen, id, limit).map(fromRow));
  }

  query(filters = {}) {
    const checked = validateHistoryFilters(filters);
    const time = this.#time();
    const q = fold(checked.q), source = fold(checked.source);
    const where = ['last_seen >= ?'], args = [this.#cutoff(time)];
    if (checked.kind) { where.push('kind = ?'); args.push(checked.kind); }
    if (source) { where.push('instr(source_search, ?) > 0'); args.push(source); }
    const match = q ? ftsQuery(q) : '';
    if (match) { where.push('rowid IN (SELECT rowid FROM records_fts WHERE records_fts MATCH ?)'); args.push(match); }
    if (checked.from) { where.push('last_seen >= ?'); args.push(checked.from); }
    if (checked.to) { where.push('last_seen <= ?'); args.push(checked.to); }
    const clause = where.join(' AND ');
    return this.#open(db => {
      const items = db.prepare(`SELECT * FROM records WHERE ${clause} ORDER BY last_seen DESC, id ASC LIMIT ? OFFSET ?`).all(...args, checked.limit, checked.offset).map(fromRow);
      const span = db.prepare(`SELECT COUNT(*) AS n, MIN(last_seen) AS earliest, MAX(last_seen) AS latest FROM records WHERE ${clause}`).get(...args);
      const timeline = db.prepare(`SELECT substr(last_seen, 1, 10) AS date, COUNT(*) AS count FROM records WHERE ${clause} GROUP BY date ORDER BY date`).all(...args)
        .map(row => ({ date: row.date, count: Number(row.count) }));
      // The same records by the day they were FIRST seen: a day's count there never moves (the timeline above counts a record on the
      // day of its latest sighting, so a story seen again moves to today).
      const firstSeenDays = db.prepare(`SELECT substr(first_seen, 1, 10) AS date, COUNT(*) AS count FROM records WHERE ${clause} GROUP BY date ORDER BY date`).all(...args)
        .map(row => ({ date: row.date, count: Number(row.count) }));
      const byKind = Object.create(null), bySource = Object.create(null);
      for (const row of db.prepare(`SELECT kind, COUNT(*) AS n FROM records WHERE ${clause} GROUP BY kind`).all(...args)) byKind[row.kind] = Number(row.n);
      for (const row of db.prepare(`SELECT source_name, COUNT(*) AS n FROM records WHERE ${clause} GROUP BY source_name`).all(...args)) bySource[row.source_name] = Number(row.n);
      const pages = db.prepare('PRAGMA page_count').get(), size = db.prepare('PRAGMA page_size').get();
      const total = Number(span.n);
      return {
        items, total, limit: checked.limit, offset: checked.offset,
        stats: { totalRecords: this.#total(db, time), matchedRecords: total, earliestAt: span.earliest ?? null, latestAt: span.latest ?? null, days: timeline, timeline, firstSeenDays, byKind, bySource,
          retainedBytes: Number(pages.page_count) * Number(size.page_size), maxRecords: this.#maxRows, maxBytes: null, retentionDays: this.#retentionDays, engine: 'sqlite' },
      };
    });
  }

  /** The newest `limit` records of the retention window, newest first (the CLI's offline commands filter them in memory). */
  all({ limit = 20000 } = {}) {
    return this.#open(db => db.prepare('SELECT * FROM records WHERE last_seen >= ? ORDER BY last_seen DESC, id ASC LIMIT ?').all(this.#cutoff(), limit).map(fromRow));
  }

  /** Drops what is past the retention window (and the oldest rows beyond the safety cap). Returns how many rows went. */
  prune() {
    const time = this.#time();
    return this.#open(db => {
      let removed = Number(db.prepare('DELETE FROM records WHERE last_seen < ?').run(this.#cutoff(time)).changes);
      const count = Number(db.prepare('SELECT COUNT(*) AS n FROM records').get().n);
      if (count > this.#maxRows) removed += Number(db.prepare('DELETE FROM records WHERE id IN (SELECT id FROM records ORDER BY last_seen ASC, id DESC LIMIT ?)').run(count - this.#maxRows).changes);
      if (removed) this.#count = null;
      return removed;
    });
  }

  /**
   * A consistent, gzipped copy of the database to history.db.bak.gz: the daily backup a corrupt file is restored from. SQLite's online
   * backup copies a few hundred pages a step between event-loop turns (node:sqlite backup) and the gzip runs as a stream, so a 60 MB
   * database never holds the server for its whole copy the way VACUUM INTO did (~1-2 s); VACUUM INTO only where the runtime lacks it.
   */
  async backup() {
    const target = `${this.#path}.bak.gz`, copy = `${this.#path}.bak.${process.pid}.tmp`, zipped = `${target}.${process.pid}.tmp`;
    for (const path of [copy, zipped]) if (existsSync(path)) unlinkSync(path);
    const db = new this.#sqlite.DatabaseSync(this.#path);
    try {
      db.exec('PRAGMA busy_timeout=5000;');
      if (typeof this.#sqlite.backup === 'function') await this.#sqlite.backup(db, copy, { rate: 256 });
      else db.prepare('VACUUM INTO ?').run(copy);
    } finally { try { db.close(); } catch { /* already closed */ } }
    try {
      await pipeline(createReadStream(copy), createGzip({ level: 6 }), createWriteStream(zipped));
      renameSync(zipped, target);
    } finally { for (const path of [copy, zipped]) { try { unlinkSync(path); } catch { /* gone */ } } }
    // The uncompressed backup of 2.46-2.48 is replaced by this one.
    try { unlinkSync(`${this.#path}.bak`); } catch { /* none */ }
    return true;
  }

  /**
   * Shrinks the file to its data once (VACUUM; ~1-2 s at 60 MB) and switches it to incremental vacuuming, after which `trim()` gives back
   * free pages a little at a time. Run once by the maintenance after the compaction rewrote the old rows.
   */
  vacuum() {
    return this.#open(db => { db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM;'); return true; });
  }

  /** Gives up to `pages` free pages back to the file system (only once vacuum() set incremental mode). Returns the free pages left. */
  trim(pages = 2000) {
    return this.#open(db => { db.prepare(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(pages))})`).all(); return Number(db.prepare('PRAGMA freelist_count').get().freelist_count); });
  }

  /** Rewrites up to `limit` rows still stored as JSON text (from before 2.49) in the compact form. Returns how many; 0 when none is left. */
  compact({ limit = 400 } = {}) {
    return this.#open(db => {
      const rows = db.prepare("SELECT rowid, * FROM records WHERE typeof(body) = 'text' LIMIT ?").all(limit);
      if (!rows.length) return 0;
      const update = db.prepare('UPDATE records SET body = ? WHERE rowid = ?');
      db.exec('BEGIN');
      try { for (const row of rows) update.run(encodeBody(bodyOf(fromRow(row))), row.rowid); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      return rows.length;
    });
  }
}

/**
 * The event history: the SQLite store where the runtime has node:sqlite (Node 22.13+), else the JSON-file store. `engine: 'json'` forces
 * the JSON store (its tests, and a runtime without SQLite).
 */
export class HistoryStore {
  constructor(runsDir, options = {}) {
    const { engine, ...rest } = options;
    if (engine !== 'json' && loadSqlite()) return new SqliteHistoryStore(runsDir, rest);
    const store = new JsonHistoryStore(runsDir, rest);
    store.engine = 'json';
    return store;
  }
}
