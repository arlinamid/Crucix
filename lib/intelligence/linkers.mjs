// Deterministic event-to-event links for the entity graph. Every rule says what it joins and how strongly; none of them says that one event
// caused another, and two reports of one wire story are one source, not two (a link never counts as corroboration by itself: the threads
// count independent sources separately). Rules:
//   same-story  two reports (news, OSINT) from different outlets whose titles share enough words, more readily when they also name the
//               same chokepoint, site, actor or CVE; and the related reports buildEvents already found (title, place and day).
//   co-occurs   a report and an observation (a PortWatch row, a heat detection, a KEV entry ...) naming the same specific entity, two
//               observations of it, or two observations of different kinds within 100 km and 24 hours. Two reports that only share an
//               entity are not linked (a busy strait is in many unrelated stories).
import { eventLevel } from '../alerts/levels.mjs';
import { TEXT_KINDS, TRUSTED_METHODS } from './entities.mjs';
import { distanceKm } from './chokepoints.mjs';
import { extractEntities, tokensOf } from './extract.mjs';

const HOUR = 3600000;
const STORY_WINDOW = 36 * HOUR;
const ENTITY_WINDOW = 48 * HOUR;
const PLACE_WINDOW = 24 * HOUR;
const PLACE_KM = 100;
const MAX_CANDIDATES = 150;
// How much older than its first sighting an observation's own time may be (PortWatch publishes with up to ~10 days of lag).
const STATE_LAG = 14 * 24 * HOUR;
const MAX_EDGES_PER_EVENT = 24;
// How much a shared entity of each type is worth as a link (times the weaker of the two entity strengths).
const ENTITY_WEIGHT = Object.freeze({ cve: 1, site: 0.9, chokepoint: 0.8, actor: 0.75 });
const REPORT_KINDS = new Set(['news', 'osint']);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const round = value => Math.round(value * 100) / 100;

/** The graph records of a sweep's event records: entities, title tokens, level, source key, trusted point and provider time. */
export function graphRecordsOf(events, dictionaries = {}) {
  const out = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!object(event) || typeof event.id !== 'string') continue;
    const location = object(event.location) ? event.location : {};
    const kind = str(event.kind, 40);
    const trusted = !TEXT_KINDS.has(kind) && TRUSTED_METHODS.has(str(location.method, 80)) && Number.isFinite(location.lat) && Number.isFinite(location.lon);
    const observed = Date.parse(event.observedAt || event.publishedAt || '');
    const source = object(event.source) ? event.source : {};
    out.push({
      id: event.id, kind, level: eventLevel(event), title: str(event.title, 160), tokens: tokensOf(event.title),
      source: str(source.hostname, 120) || str(source.name, 120).toLowerCase(),
      entities: extractEntities(event, dictionaries),
      point: trusted ? [Math.round(location.lat * 100) / 100, Math.round(location.lon * 100) / 100] : null,
      observed: Number.isFinite(observed) ? observed : null,
      related: (Array.isArray(event.relatedSources) ? event.relatedSources : []).map(item => item?.eventId).filter(id => typeof id === 'string').slice(0, 8),
    });
  }
  return out;
}

function shared(a, b) {
  const set = new Set(a);
  let count = 0;
  for (const token of b) if (set.has(token)) count++;
  return count;
}

const isReport = record => REPORT_KINDS.has(record.k);
const countriesOf = record => record.n.filter(([id]) => id.startsWith('country:')).map(([id]) => id);
// Two reports that each name a country the other does not are different stories however alike their titles are ("Americans in Austria:
// US midterm deadlines" and "Americans in Norway: US midterm deadlines"); one naming a subset of the other's countries is not.
const otherCountries = (a, b) => { const x = countriesOf(a), y = countriesOf(b); return x.some(id => !y.includes(id)) && y.some(id => !x.includes(id)); };
const specificOf = record => record.n.filter(([id]) => !id.startsWith('country:'));

/**
 * The edges of the graph's events `ids` (normally the ones a sweep just added) to the events the graph holds: `[{a, b, type, s, m}]`, at
 * most 24 per event, strongest first. `related` maps an id to the related reports buildEvents found. Pure apart from reading `graph`.
 */
export function linkEvents(ids, graph, { now = Date.now(), related = null } = {}) {
  const edges = new Map();
  const put = (a, b, type, s, m) => {
    if (a === b || s <= 0) return;
    const key = a < b ? `${a}|${b}|${type}` : `${b}|${a}|${type}`;
    const known = edges.get(key);
    if (!known || known.s < s) edges.set(key, { a, b, type, s: round(Math.min(1, s)), m });
  };
  // Located observations of the last day, binned by whole degree, for the place rule.
  const cells = new Map();
  for (const record of graph.recent(now - 3 * PLACE_WINDOW)) {
    if (!record.g || isReport(record)) continue;
    const key = `${Math.floor(record.g[0])}|${Math.floor(record.g[1])}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(record);
  }
  for (const id of Array.isArray(ids) ? ids : []) {
    const record = graph.get(id);
    if (!record) continue;
    const local = [];
    const add = (other, type, s, m) => local.push({ other, type, s, m });
    // Related reports buildEvents found (same words, place and day): kept as a same-story link when both are in the graph.
    for (const other of related?.get(id) ?? []) if (graph.get(other)) add(other, 'same-story', 0.6, 'rule');
    const specific = specificOf(record);
    const specificIds = new Set(specific.map(([entity]) => entity));
    // Candidates: events sharing any entity within the story window, newest first, a bounded number per entity.
    const candidates = new Map();
    // A state an observation reports (a PortWatch day, a KEV entry) may be days older than the sweep that first saw it: two events are close
    // in time when either their own times or their first sightings are.
    const close = (other, window) => Math.abs(other.time - record.time) <= window || Math.abs(other.t - record.t) <= window;
    for (const [entity] of record.n) {
      for (const other of graph.eventsWith(entity, { sinceMs: Math.min(record.time, record.t) - ENTITY_WINDOW - STATE_LAG, limit: MAX_CANDIDATES })) {
        if (other.id !== id && close(other, ENTITY_WINDOW)) candidates.set(other.id, other);
      }
    }
    for (const other of candidates.values()) {
      if (other.s && other.s === record.s) continue;
      const common = shared(record.w, other.w);
      const union = new Set([...record.w, ...other.w]).size || 1;
      const jaccard = common / union;
      const sharedSpecific = specificOf(other).filter(([entity]) => specificIds.has(entity));
      // same-story: two reports, different outlets, enough common title words (fewer when they also share a specific entity).
      if (isReport(record) && isReport(other)) {
        if (Math.abs(other.time - record.time) > STORY_WINDOW) continue;
        if (otherCountries(record, other)) continue;
        if ((common >= 3 && jaccard >= 0.4) || (sharedSpecific.length && common >= 2 && jaccard >= 0.25)) add(other.id, 'same-story', 0.3 + jaccard, 'rule');
        continue;
      }
      // co-occurs: a shared specific entity between a report and an observation, or between two observations.
      let best = 0;
      for (const [entity, , strengthOther] of sharedSpecific) {
        const strengthOwn = record.n.find(([item]) => item === entity)?.[2] ?? 0;
        best = Math.max(best, Math.min(strengthOwn, strengthOther) * (ENTITY_WEIGHT[entity.split(':')[0]] ?? 0.5));
      }
      if (best > 0) add(other.id, 'co-occurs', best, 'rule');
    }
    // co-occurs by place: two observations of different kinds within 100 km and 24 hours.
    if (record.g && !isReport(record)) {
      const [lat, lon] = record.g;
      for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
        for (const other of cells.get(`${Math.floor(lat) + y}|${Math.floor(lon) + x}`) ?? []) {
          if (other.id === id || other.k === record.k || Math.abs(other.time - record.time) > PLACE_WINDOW) continue;
          if (distanceKm(lat, lon, other.g[0], other.g[1]) <= PLACE_KM) add(other.id, 'co-occurs', 0.6, 'rule');
        }
      }
    }
    for (const edge of local.sort((p, q) => q.s - p.s || (p.other < q.other ? -1 : 1)).slice(0, MAX_EDGES_PER_EVENT)) put(id, edge.other, edge.type, edge.s, edge.m);
  }
  return [...edges.values()].sort((p, q) => (p.a + p.b < q.a + q.b ? -1 : 1));
}
