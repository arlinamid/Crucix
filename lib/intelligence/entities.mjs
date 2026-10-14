import { join } from 'node:path';
import { readJsonWithBackup, writeJsonAtomic } from '../atomic-json.mjs';
import { eventLevel } from '../alerts/levels.mjs';
import { countriesInText, countryByIso3, countryByName } from './countries.mjs';
import { countryAt } from './geo.mjs';

const VERSION = 1;
const DAY = 86400000;
const HOUR = 3600000;
const MAX_COUNTRIES = 3;
const MAX_INGEST = 10000;
const MAX_NEGATIVE = 50000;
const LINK_DAYS = 7;
const SERIES_STEP = HOUR;             // at most one series point per country per hour
const SERIES_DENSE = 2 * DAY;         // older points are thinned ...
const SERIES_SPARSE_STEP = 6 * HOUR;  // ... to one per six hours
const LEVELS = new Set(['critical', 'high', 'watch', 'info']);
const ID = /^event-[a-f0-9]{1,64}$/;

// Location methods whose coordinates are a real place of the event. Everything else (headline-keyword, text-keyword,
// country-centroid, who-region-centroid, theater-centre, global, unknown, any new method) never locates a country.
export const TRUSTED_METHODS = new Set(['provider', 'polygon-centroid', 'polygon-vertex-mean', 'configured-point', 'forecast-grid']);
// Methods whose label is a word copied from the title or a region name, not a provider's place field.
const TEXT_LABEL_METHODS = new Set(['headline-keyword', 'text-keyword', 'who-region-centroid', 'theater-centre']);
// Kinds whose label and coordinates never count as a place: reports about somewhere, not observations there.
export const TEXT_KINDS = new Set(['news', 'osint', 'signal']);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key) ? value[key] : undefined;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const str = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const reasonOf = error => error?.code || (error instanceof Error ? error.message : String(error));

/** The time an event counts at: its provider time when known and not in the future of its first sighting, else the sighting. */
export const refTime = ref => ref.o !== null ? Math.min(ref.o, ref.t) : ref.t;

/**
 * The countries of one event: `l` (located) from trusted coordinates and structured place labels, otherwise `m`
 * (mentioned) from the title and summary of reports and of events without a trusted place. Null when no country.
 */
export function resolveEventCountries(event) {
  const kind = str(own(event, 'kind'), 40);
  const location = object(own(event, 'location')) ? event.location : {};
  const method = str(location.method, 80);
  const trusted = TRUSTED_METHODS.has(method) && finite(location.lat) && finite(location.lon);
  const located = [];
  let point = null;
  if (trusted && !TEXT_KINDS.has(kind)) {
    point = countryAt(location.lat, location.lon);
    if (point) located.push(point);
  }
  const text = `${str(own(event, 'title'), 600)}\n${str(own(event, 'summary'), 600)}`;
  const label = str(location.label, 200);
  if (label && !TEXT_KINDS.has(kind) && !TEXT_LABEL_METHODS.has(method)) {
    // An ambiguous name (Georgia, Jordan, ...) counts only as the whole label and only without a resolved point.
    const exact = point ? null : countryByName(label);
    let named = exact ? [exact.iso3] : countriesInText(label, { limit: MAX_COUNTRIES });
    // Without trusted coordinates the label may be a keyword the dashboard matched inside a longer name ("Sudan" for
    // South Sudan): it counts only when the event's own text names the same country.
    if (!trusted) { const confirmed = countriesInText(text, { limit: MAX_COUNTRIES, ambiguous: true }); named = named.filter(iso3 => confirmed.includes(iso3)); }
    for (const iso3 of named) if (!located.includes(iso3)) located.push(iso3);
  }
  if (located.length) return { c: located.slice(0, MAX_COUNTRIES), m: 'l' };
  if (!TEXT_KINDS.has(kind) && trusted) return null;
  const mentioned = countriesInText(text, { limit: MAX_COUNTRIES });
  return mentioned.length ? { c: mentioned, m: 'm' } : null;
}

function normalizeRef(value) {
  if (!object(value)) return null;
  const c = Array.isArray(value.c) ? [...new Set(value.c.filter(code => typeof code === 'string' && countryByIso3(code)))].slice(0, MAX_COUNTRIES) : [];
  if (!c.length || (value.m !== 'l' && value.m !== 'm') || !finite(value.t)) return null;
  return { c, m: value.m, l: LEVELS.has(value.l) ? value.l : null, k: str(value.k, 40), o: finite(value.o) ? value.o : null, t: value.t };
}

const rank = level => level === 'critical' ? 3 : level === 'high' ? 2 : level === 'watch' ? 1 : level === 'info' ? 0 : -1;

export class EntityStore {
  #now;
  #retentionMs;
  #maxRefs;
  #negative = new Set();

  /**
   * @param {string} runsDir the file is `<runsDir>/intelligence/countries.json`.
   * @param {{retentionDays?: number, maxRefs?: number, now?: () => number}} [options]
   */
  constructor(runsDir, { retentionDays = 35, maxRefs = 20000, now = Date.now } = {}) {
    this.path = join(String(runsDir), 'intelligence', 'countries.json');
    this.#now = typeof now === 'function' ? now : Date.now;
    this.#retentionMs = Math.min(90, Math.max(1, Number.isFinite(retentionDays) ? retentionDays : 35)) * DAY;
    this.#maxRefs = Number.isInteger(maxRefs) && maxRefs > 0 ? maxRefs : 20000;
    this.events = new Map();
    this.seriesMap = new Map();
    this.since = null;
    this.status = 'empty';
  }

  /** Read the file (or its .bak). Missing, corrupt or oversized gives an empty store; never throws. */
  load() {
    const result = readJsonWithBackup(this.path, { validate: value => own(value, 'version') === VERSION && object(own(value, 'events')) });
    this.events = new Map();
    this.seriesMap = new Map();
    this.since = null;
    const value = result.value;
    if (value) {
      for (const [id, raw] of Object.entries(value.events)) {
        const ref = ID.test(id) ? normalizeRef(raw) : null;
        if (ref) this.events.set(id, ref);
      }
      for (const [iso3, points] of Object.entries(object(value.series) ? value.series : {})) {
        if (!countryByIso3(iso3) || !Array.isArray(points)) continue;
        const clean = [];
        for (const point of points) {
          if (Array.isArray(point) && finite(point[0]) && finite(point[1]) && (!clean.length || point[0] > clean.at(-1)[0])) clean.push([point[0], point[1]]);
        }
        if (clean.length) this.seriesMap.set(iso3, clean);
      }
      this.since = finite(value.since) ? value.since : null;
    }
    this.status = result.source === 'primary' ? 'ok' : result.source === 'backup' ? 'recovered' : result.error ? 'corrupt' : 'empty';
    this.#prune(this.#now());
    return this.status;
  }

  /** Link events to countries (cached by event id) and prune. Returns the number of new references. */
  ingest(events, { now = this.#now() } = {}) {
    if (!Array.isArray(events) || !finite(now)) return 0;
    if (this.since === null) this.since = now;
    let added = 0;
    for (const event of events.slice(0, MAX_INGEST)) {
      const id = own(event, 'id');
      if (typeof id !== 'string' || !ID.test(id) || this.#negative.has(id)) continue;
      const level = eventLevel(event);
      const known = this.events.get(id);
      if (known) {
        // The country links are fixed at the first sighting; a later, higher severity still counts.
        if (rank(level) > rank(known.l)) known.l = level;
        continue;
      }
      const resolved = resolveEventCountries(event);
      if (!resolved) {
        if (this.#negative.size >= MAX_NEGATIVE) this.#negative.clear();
        this.#negative.add(id);
        continue;
      }
      const observed = Date.parse(own(event, 'observedAt') || own(event, 'publishedAt') || '');
      this.events.set(id, { c: resolved.c, m: resolved.m, l: level, k: str(own(event, 'kind'), 40), o: Number.isFinite(observed) ? observed : null, t: now });
      added++;
    }
    this.#prune(now);
    return added;
  }

  #prune(now) {
    const cutoff = now - this.#retentionMs;
    for (const [id, ref] of this.events) if (ref.t < cutoff) this.events.delete(id);
    if (this.events.size > this.#maxRefs) {
      const kept = [...this.events].sort((a, b) => b[1].t - a[1].t || (a[0] < b[0] ? -1 : 1)).slice(0, this.#maxRefs);
      this.events = new Map(kept);
    }
    for (const [iso3, points] of this.seriesMap) {
      const thinned = [];
      for (const point of points) {
        if (point[0] < cutoff) continue;
        const last = thinned.at(-1);
        if (last && point[0] < now - SERIES_DENSE && point[0] - last[0] < SERIES_SPARSE_STEP) continue;
        thinned.push(point);
      }
      if (thinned.length) this.seriesMap.set(iso3, thinned); else this.seriesMap.delete(iso3);
    }
  }

  /** References of one country, newest first: `{id, m, l, k, o, t, time}`. Filters: provider-time floor, kinds, mode 'l'|'m'. */
  countryEvents(iso3, { sinceMs = -Infinity, kinds = null, mode = null } = {}) {
    const out = [];
    const allowed = Array.isArray(kinds) ? new Set(kinds) : null;
    for (const [id, ref] of this.events) {
      if (!ref.c.includes(iso3) || (allowed && !allowed.has(ref.k)) || (mode && ref.m !== mode)) continue;
      const time = refTime(ref);
      if (time >= sinceMs) out.push({ id, m: ref.m, l: ref.l, k: ref.k, o: ref.o, t: ref.t, time });
    }
    return out.sort((a, b) => b.time - a.time || (a.id < b.id ? -1 : 1));
  }

  /** ISO3 codes with at least one reference at or after `sinceMs`, sorted. */
  countries(sinceMs = -Infinity) {
    const found = new Set();
    for (const ref of this.events.values()) if (refTime(ref) >= sinceMs) for (const iso3 of ref.c) found.add(iso3);
    return [...found].sort();
  }

  /**
   * Mentioned references per 24-hour window back from `now`: index 0 is the last 24 hours. With `groupOf` (an event id -> its story group, or
   * undefined) a story counts once per window however many outlets carried it.
   */
  mentionCounts(iso3, days = 7, now = this.#now(), groupOf = null) {
    const windows = Array.from({ length: Math.max(1, Math.min(90, Math.floor(days) || 1)) }, () => new Set());
    for (const [id, ref] of this.events) {
      if (ref.m !== 'm' || !ref.c.includes(iso3)) continue;
      const index = Math.floor((now - refTime(ref)) / DAY);
      if (index < 0 || index >= windows.length) continue;
      let key = id;
      if (typeof groupOf === 'function') { try { key = groupOf(id) ?? id; } catch { key = id; } }
      windows[index].add(key);
    }
    return windows.map(set => set.size);
  }

  /** How many days of observation the store holds (since its first ingest). */
  observedDays(now = this.#now()) {
    return this.since === null ? 0 : Math.max(0, (now - this.since) / DAY);
  }

  /** Countries sharing events with `iso3` in the last 7 days: `[{iso3, name, count}]`, most shared first. */
  linked(iso3, limit = 8, now = this.#now()) {
    const counts = new Map();
    for (const ref of this.events.values()) {
      if (ref.c.length < 2 || !ref.c.includes(iso3) || refTime(ref) < now - LINK_DAYS * DAY) continue;
      for (const other of ref.c) if (other !== iso3) counts.set(other, (counts.get(other) || 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, Math.max(0, limit))
      .map(([code, count]) => ({ iso3: code, name: countryByIso3(code).name, count }));
  }

  #links(now) {
    const pairs = {};
    for (const ref of this.events.values()) {
      if (ref.c.length < 2 || refTime(ref) < now - LINK_DAYS * DAY) continue;
      const codes = [...ref.c].sort();
      for (let i = 0; i < codes.length; i++) for (let j = i + 1; j < codes.length; j++) {
        const key = `${codes[i]}|${codes[j]}`;
        pairs[key] = (pairs[key] || 0) + 1;
      }
    }
    return pairs;
  }

  /** The recorded score history of one country: `[{at, score}]`, oldest first. */
  series(iso3) {
    return (this.seriesMap.get(iso3) || []).map(([at, score]) => ({ at, score }));
  }

  /** Append one point per scored country (score > 0 or an existing series), at most hourly; a clock that went back is skipped. */
  recordScores(scores, now = this.#now()) {
    if (!Array.isArray(scores) || !finite(now)) return;
    for (const row of scores) {
      const iso3 = own(row, 'iso3');
      const score = own(row, 'score');
      if (typeof iso3 !== 'string' || !countryByIso3(iso3) || !finite(score)) continue;
      const points = this.seriesMap.get(iso3);
      if (!points && score <= 0) continue;
      const last = points?.at(-1);
      if (last && now - last[0] < SERIES_STEP) continue;
      if (points) points.push([now, score]); else this.seriesMap.set(iso3, [[now, score]]);
    }
    this.#prune(now);
  }

  /** Write the file atomically. Never throws: false (and a warning) on failure. */
  save(logger = console) {
    const now = this.#now();
    this.#prune(now);
    try {
      writeJsonAtomic(this.path, {
        version: VERSION, since: this.since,
        events: Object.fromEntries(this.events), series: Object.fromEntries(this.seriesMap), links: this.#links(now),
      });
      return true;
    } catch (error) {
      try { logger?.warn?.(`[Risk] countries.json not saved (${reasonOf(error)})`); } catch { /* logging never breaks the store */ }
      return false;
    }
  }
}
