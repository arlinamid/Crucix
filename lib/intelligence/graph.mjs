// The entity graph: which events name which entities (extract.mjs) and which events are linked to each other (linkers.mjs), kept across
// sweeps in <runsDir>/intelligence/graph.json. Evidence-first: an event is only referenced by id with the few fields the linkers and the
// threads need (kind, level, source, title, tokens, entities, point, time), never copied whole; every edge says how it was made (`m`) and
// how strong it is (`s`). Bounded like the entity store: a retention window, a cap on events and on edges, an atomic write that never throws.
import { join } from 'node:path';
import { readJsonWithBackup, writeJsonAtomic, writeJsonAtomicAsync } from '../atomic-json.mjs';
import { topicsOf } from './topics.mjs';

const VERSION = 1;
const DAY = 86400000;
const ID = /^event-[a-f0-9]{1,64}$/;
const ENTITY = /^(?:country|chokepoint|site|actor|cve|flight|aircraft|airline):[A-Za-z0-9_.-]{1,80}$/;
const LEVELS = new Set(['critical', 'high', 'watch', 'info']);
export const EDGE_TYPES = Object.freeze(['same-story', 'co-occurs']);
export const EDGE_METHODS = Object.freeze(['provider', 'rule', 'text', 'editorial', 'llm']);
const RELS = new Set(['located-in', 'near', 'mentions', 'involves']);
const MAX_ENTITIES = 12;
const MAX_TOKENS = 16;
const FEED_TOPICS = new Set(['conflict', 'politics', 'technology', 'health', 'economy']);
// The thread window (72 hours) plus a margin at ~6,000 events a day; the file of that many events is about 10 MB.
const MAX_EVENTS = 30000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SKIPPED = 50000;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const str = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const reasonOf = error => error?.code || (error instanceof Error ? error.message : String(error));
const rank = level => level === 'critical' ? 3 : level === 'high' ? 2 : level === 'watch' ? 1 : level === 'info' ? 0 : -1;
const strength = value => finite(value) ? Math.round(Math.min(1, Math.max(0, value)) * 100) / 100 : null;

/** The time an event counts at: its provider time when known and not after its first sighting, else the sighting. */
export const graphTime = record => record.o !== null ? Math.min(record.o, record.t) : record.t;
const edgeKey = (a, b, type) => a < b ? `${a}|${b}|${type}` : `${b}|${a}|${type}`;

function normalizeRecord(value) {
  if (!object(value) || !finite(value.t)) return null;
  const n = (Array.isArray(value.n) ? value.n : []).slice(0, MAX_ENTITIES)
    .filter(item => Array.isArray(item) && ENTITY.test(item[0]) && RELS.has(item[1]) && strength(item[2]) !== null)
    .map(([id, rel, s]) => [id, rel, strength(s)]);
  const g = Array.isArray(value.g) && finite(value.g[0]) && finite(value.g[1]) && Math.abs(value.g[0]) <= 90 && Math.abs(value.g[1]) <= 180 ? [value.g[0], value.g[1]] : null;
  return {
    k: str(value.k, 40), l: LEVELS.has(value.l) ? value.l : null, s: str(value.s, 120), h: str(value.h, 160),
    w: (Array.isArray(value.w) ? value.w : []).filter(token => typeof token === 'string' && token.length <= 40).slice(0, MAX_TOKENS),
    n, g, o: finite(value.o) ? value.o : null, t: value.t,
    // The topic of the record's specialist feed (news-feeds.mjs), or null.
    p: FEED_TOPICS.has(value.p) ? value.p : null,
  };
}

function normalizeEdge(key, value) {
  const parts = typeof key === 'string' ? key.split('|') : [];
  if (parts.length !== 3 || !ID.test(parts[0]) || !ID.test(parts[1]) || parts[0] >= parts[1] || !EDGE_TYPES.includes(parts[2])) return null;
  if (!Array.isArray(value) || strength(value[0]) === null || !EDGE_METHODS.includes(value[1]) || !finite(value[2]) || !finite(value[3])) return null;
  return [strength(value[0]), value[1], value[2], value[3]];
}

export class GraphStore {
  #now;
  #retentionMs;
  #maxEvents;
  #maxEdges;

  /**
   * @param {string} runsDir the file is `<runsDir>/intelligence/graph.json`.
   * @param {{retentionDays?: number, maxEvents?: number, maxEdges?: number, now?: () => number}} [options]
   */
  constructor(runsDir, { retentionDays = 14, maxEvents = MAX_EVENTS, maxEdges = 80000, now = Date.now } = {}) {
    this.path = join(String(runsDir), 'intelligence', 'graph.json');
    this.#now = typeof now === 'function' ? now : Date.now;
    this.#retentionMs = Math.min(35, Math.max(1, finite(retentionDays) ? retentionDays : 14)) * DAY;
    this.#maxEvents = Number.isInteger(maxEvents) && maxEvents > 0 ? maxEvents : MAX_EVENTS;
    this.#maxEdges = Number.isInteger(maxEdges) && maxEdges > 0 ? maxEdges : 80000;
    this.#reset();
    this.status = 'empty';
  }

  // Events looked at and left out (nothing could link them), in memory only: the risk step need not extract them again every sweep.
  #skip(id) {
    this.skipped.add(id);
    if (this.skipped.size > MAX_SKIPPED) this.skipped.delete(this.skipped.values().next().value);
  }

  /** Whether the graph has seen the event: it holds it, or it left it out as unlinkable. */
  knows(id) { return this.events.has(id) || this.skipped.has(id); }

  #reset() {
    this.skipped = new Set();
    this.events = new Map();
    this.edges = new Map();
    this.labels = new Map();
    // The linkers.mjs LINK_RULES_VERSION the stored edges were made with (0: unknown, an older file).
    this.rules = 0;
    // When the graph first ingested (the oldest kept event's sighting for a file written before 2.41.1): how long it has been observing.
    this.since = null;
    this.byEntity = new Map();
    this.byEvent = new Map();
  }

  #index(id, record) {
    for (const [entity] of record.n) {
      if (!this.byEntity.has(entity)) this.byEntity.set(entity, new Set());
      this.byEntity.get(entity).add(id);
    }
  }

  #indexEdge(key) {
    const [a, b] = key.split('|');
    for (const [one, other] of [[a, key], [b, key]]) {
      if (!this.byEvent.has(one)) this.byEvent.set(one, new Set());
      this.byEvent.get(one).add(other);
    }
  }

  #rebuild() {
    this.byEntity = new Map();
    this.byEvent = new Map();
    for (const [id, record] of this.events) this.#index(id, record);
    for (const key of this.edges.keys()) this.#indexEdge(key);
  }

  /** Read the file (or its .bak). Missing, corrupt or oversized gives an empty graph; never throws. */
  load() {
    const result = readJsonWithBackup(this.path, { maxBytes: MAX_FILE_BYTES, validate: value => object(value) && value.version === VERSION && object(value.events) && object(value.edges) });
    this.#reset();
    const value = result.value;
    if (value) {
      for (const [id, raw] of Object.entries(value.events)) {
        const record = ID.test(id) ? normalizeRecord(raw) : null;
        if (record) this.events.set(id, record);
      }
      for (const [key, raw] of Object.entries(value.edges)) {
        const edge = normalizeEdge(key, raw);
        if (edge && this.events.has(key.split('|')[0]) && this.events.has(key.split('|')[1])) this.edges.set(key, edge);
      }
      this.rules = Number.isInteger(value.rules) && value.rules > 0 ? value.rules : 0;
      this.since = finite(value.since) ? value.since : null;
      for (const [entity, label] of Object.entries(object(value.labels) ? value.labels : {})) {
        if (ENTITY.test(entity) && typeof label === 'string') this.labels.set(entity, label.slice(0, 120));
      }
    }
    this.status = result.source === 'primary' ? 'ok' : result.source === 'backup' ? 'recovered' : result.error ? 'corrupt' : 'empty';
    this.#rebuild();
    if (this.since === null && this.events.size) this.since = Math.min(...[...this.events.values()].map(record => record.t));
    this.#prune(this.#now());
    return this.status;
  }

  /**
   * Adds event records (`{id, kind, level, source, title, tokens, entities:[{id, label, rel, s}], point:[lat,lon]|null, observed, time?}`): `time`
   * is when the record was first seen (the background backfill from the history passes it; a sweep's own events are seen `now`). An id seen
   * before only takes a higher level. Records with neither an entity nor a topic (topics.mjs) are left out: nothing could link them. A report
   * about a software flaw or an election often names no country, but its topic and its rare words can link it. Returns the ids added.
   */
  ingest(records, { now = this.#now() } = {}) {
    const added = [];
    if (!Array.isArray(records) || !finite(now)) return added;
    if (this.since === null) this.since = now;
    for (const item of records) if (finite(item?.time) && item.time < this.since) this.since = item.time;
    for (const item of records.slice(0, this.#maxEvents)) {
      const id = item?.id;
      if (typeof id !== 'string' || !ID.test(id)) continue;
      const known = this.events.get(id);
      if (known) {
        if (rank(item.level) > rank(known.l)) known.l = item.level;
        continue;
      }
      const entities = Array.isArray(item.entities) ? item.entities : [];
      const record = normalizeRecord({
        k: item.kind, l: item.level, s: item.source, h: item.title, w: item.tokens, g: item.point, o: item.observed, t: now, p: item.topic,
        n: entities.map(entity => [entity?.id, entity?.rel, entity?.s]),
      });
      if (record && finite(item.time) && item.time < now) record.t = item.time;
      if (!record || (!record.n.length && !topicsOf(record.w, record.k, record.p).size)) { this.#skip(id); continue; }
      for (const entity of entities) if (ENTITY.test(entity?.id) && typeof entity.label === 'string' && entity.label) this.labels.set(entity.id, entity.label.slice(0, 120));
      this.events.set(id, record);
      this.#index(id, record);
      added.push(id);
    }
    this.#prune(now);
    return added;
  }

  /** Adds or strengthens edges `{a, b, type, s, m}` between known events; the strongest reading of a pair and type is kept. Returns the count added. */
  link(edges, { now = this.#now() } = {}) {
    let added = 0;
    if (!Array.isArray(edges) || !finite(now)) return added;
    for (const edge of edges) {
      const { a, b, type, m } = object(edge) ? edge : {};
      const s = strength(edge?.s);
      if (!ID.test(a ?? '') || !ID.test(b ?? '') || a === b || !EDGE_TYPES.includes(type) || !EDGE_METHODS.includes(m) || s === null) continue;
      if (!this.events.has(a) || !this.events.has(b)) continue;
      const key = edgeKey(a, b, type);
      const known = this.edges.get(key);
      if (known) {
        known[3] = now;
        if (s > known[0]) { known[0] = s; known[1] = m; }
        continue;
      }
      this.edges.set(key, [s, m, now, now]);
      this.#indexEdge(key);
      added++;
    }
    this.#prune(now);
    return added;
  }

  #prune(now) {
    const cutoff = now - this.#retentionMs;
    let changed = false;
    for (const [id, record] of this.events) if (graphTime(record) < cutoff) { this.events.delete(id); changed = true; }
    if (this.events.size > this.#maxEvents) {
      this.events = new Map([...this.events].sort((a, b) => b[1].t - a[1].t || (a[0] < b[0] ? -1 : 1)).slice(0, this.#maxEvents));
      changed = true;
    }
    // The edges lose an end only when events went (an ingest that removed nothing need not read every edge).
    if (changed) for (const key of this.edges.keys()) {
      const [a, b] = key.split('|');
      if (!this.events.has(a) || !this.events.has(b)) this.edges.delete(key);
    }
    if (this.edges.size > this.#maxEdges) {
      this.edges = new Map([...this.edges].sort((x, y) => y[1][3] - x[1][3] || y[1][0] - x[1][0] || (x[0] < y[0] ? -1 : 1)).slice(0, this.#maxEdges));
      changed = true;
    }
    if (changed) {
      this.#rebuild();
      const used = new Set(this.byEntity.keys());
      for (const entity of this.labels.keys()) if (!used.has(entity)) this.labels.delete(entity);
    }
  }

  /** Removes every edge made by `method` (a rules change re-makes the rule edges; model links stay). Returns how many went. */
  dropEdges(method) {
    let removed = 0;
    for (const [key, edge] of this.edges) if (edge[1] === method) { this.edges.delete(key); removed++; }
    if (removed) this.#rebuild();
    return removed;
  }

  /** How many days of observation the graph holds (since its first ingest). */
  observedDays(now = this.#now()) {
    return this.since === null ? 0 : Math.max(0, (now - this.since) / DAY);
  }

  /** One event's record with its id, or null. */
  get(id) {
    const record = this.events.get(id);
    return record ? { id, ...record, time: graphTime(record) } : null;
  }

  /** Events naming `entity` at or after `sinceMs`, newest first. */
  eventsWith(entity, { sinceMs = -Infinity, limit = Infinity } = {}) {
    // Sorted as [time, id] pairs; only the kept ones become objects (a country can name thousands of events, the linkers keep 150).
    const rows = [];
    for (const id of this.byEntity.get(entity) ?? []) {
      const record = this.events.get(id);
      if (!record) continue;
      const time = graphTime(record);
      if (time >= sinceMs) rows.push([time, id, record]);
    }
    rows.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : 1));
    return (rows.length > limit ? rows.slice(0, limit) : rows).map(([time, id, record]) => ({ id, ...record, time }));
  }

  /** Events at or after `sinceMs`, newest first. */
  recent(sinceMs = -Infinity) {
    const rows = [];
    for (const [id, record] of this.events) { const time = graphTime(record); if (time >= sinceMs) rows.push([time, id, record]); }
    rows.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : 1));
    return rows.map(([time, id, record]) => ({ id, ...record, time }));
  }

  /** The edges of one event: `[{id, type, s, m, first, last}]`, strongest first. */
  edgesOf(id) {
    const out = [];
    for (const key of this.byEvent.get(id) ?? []) {
      const edge = this.edges.get(key);
      if (!edge) continue;
      const [a, b, type] = key.split('|');
      out.push({ id: a === id ? b : a, type, s: edge[0], m: edge[1], first: edge[2], last: edge[3] });
    }
    return out.sort((x, y) => y.s - x.s || (x.id < y.id ? -1 : 1));
  }

  /** The label an entity was last seen with (an ISO3 code for a country), or the id's own part. */
  label(entity) {
    return this.labels.get(entity) ?? String(entity).split(':').slice(1).join(':');
  }

  /**
   * Entities that share events with `entity` at or after `sinceMs`: `[{id, type, label, count}]`, most shared first. The count is of events
   * that name both; it is co-occurrence in reports, not a relation between the two.
   */
  neighbors(entity, { sinceMs = -Infinity, limit = 20 } = {}) {
    const counts = new Map();
    for (const id of this.byEntity.get(entity) ?? []) {
      const record = this.events.get(id);
      if (!record || graphTime(record) < sinceMs) continue;
      for (const [other] of record.n) if (other !== entity) counts.set(other, (counts.get(other) || 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, Math.max(0, limit))
      .map(([id, count]) => ({ id, type: id.split(':')[0], label: this.label(id), count }));
  }

  /**
   * Story groups over the whole retained graph: event id -> the smallest id of its group, for events joined by same-story edges of at least
   * `minStrength`. A report of one story from five outlets is one group, so counting groups counts stories, not copies.
   */
  storyGroups(minStrength = 0.55) {
    const parent = new Map();
    const find = id => { let root = id; while (parent.has(root) && parent.get(root) !== root) root = parent.get(root); return root; };
    for (const [key, edge] of this.edges) {
      const [a, b, type] = key.split('|');
      if (type !== 'same-story' || edge[0] < minStrength) continue;
      for (const id of [a, b]) if (!parent.has(id)) parent.set(id, id);
      const x = find(a), y = find(b);
      if (x !== y) parent.set(x < y ? y : x, x < y ? x : y);
    }
    const groups = new Map();
    for (const id of parent.keys()) groups.set(id, find(id));
    return groups;
  }

  #document() {
    return { version: VERSION, rules: this.rules, since: this.since, events: Object.fromEntries(this.events), edges: Object.fromEntries(this.edges), labels: Object.fromEntries(this.labels) };
  }

  /** save() off the main thread's file work, for the background maintenance. Never throws: false (and a warning) on failure. */
  async saveAsync(logger = console) {
    this.#prune(this.#now());
    try { await writeJsonAtomicAsync(this.path, this.#document()); return true; }
    catch (error) {
      try { logger?.warn?.(`[Graph] graph.json not saved (${reasonOf(error)})`); } catch { /* logging never breaks the store */ }
      return false;
    }
  }

  /** Write the file atomically. Never throws: false (and a warning) on failure. */
  save(logger = console) {
    this.#prune(this.#now());
    try {
      writeJsonAtomic(this.path, this.#document());
      return true;
    } catch (error) {
      try { logger?.warn?.(`[Graph] graph.json not saved (${reasonOf(error)})`); } catch { /* logging never breaks the store */ }
      return false;
    }
  }
}
