// Deterministic event-to-event links for the entity graph. Every rule says what it joins and how strongly; none of them says that one event
// caused another, and two reports of one wire story are one source, not two (a link never counts as corroboration by itself: the threads
// count independent sources separately). Rules:
//   same-story  two reports (news, OSINT) from different outlets whose titles share enough words, more readily when they also name the
//               same chokepoint, site, actor or CVE; and the related reports buildEvents already found (title, place and day).
//   co-occurs   a report and an observation (a PortWatch row, a heat detection, a KEV entry ...) naming the same specific entity, two
//               observations of it, or two observations of different kinds within 100 km and 24 hours. Two reports that only share an
//               entity are not linked (a busy strait is in many unrelated stories). Since rules v2 also a report and an observation of the
//               same phenomenon (an earthquake, a cyclone, a flood ... hazards.mjs) in the same country within 48 hours; where a country has
//               many observations of that phenomenon spread over a wide area (NOAA's flood warnings across the states), only with a
//               distinctive shared title word too (a storm's or a state's name), or every storm story of the country would become one thread.
//               Many observations in one place (the aftershocks of one earthquake) are one event and need no such word.
//               Since rules v3 also an armed-conflict report (conflict.mjs) and an observation of the kinds a conflict leaves (a heat
//               detection at a military area, GNSS interference, military aircraft) in the same country, always with a distinctive shared
//               word: those observations cover whole regions for weeks, the shared place name is what ties a report to one.
//               Since rules v4 also a report and an observation of the same topic (topics.mjs: politics, technology, economy ...) that
//               share a RARE title word (in at most 6 reports of the window: "Ivanti", "recession"), in any country or none: a software
//               flaw or a prediction market names a product or a person, not a place. A frequent name ("Trump") alone never links, or every
//               story of a busy politician would become one thread; two reports each naming a country the other does not are not linked.
//               Since 2.51 also a report and an aviation observation (an air-watch incident, lib/air/watch.mjs) naming the same flight or
//               aircraft registration (an entity, at full strength), or the same airline when the report tells of an incident (an
//               emergency, a diversion, a descent ...): an airline alone flies thousands of flights a day and never links by itself. No
//               rules-version bump: these entities exist only in records extracted since 2.51, so a relink of the older ones adds nothing.
// Since rules v5 (2.52.4) a routine baseline row (an hourly AIS vessel count at a chokepoint, level info; not PortWatch's daily row) links nothing and nothing links
// to it: every event near a busy strait shared its place and its chokepoint with that hourly series, so a thunderstorm over Istanbul, a
// diverted flight and a news item naming the Bosphorus Bridge became one 74-record thread. And an observation that is merely located
// within a chokepoint's radius ('near') counts as being at that chokepoint only for the kinds a strait is about (shipping, GNSS
// interference, armed conflict); a weather notice or an air incident over the city keeps its place, not the strait.
import { eventLevel } from '../alerts/levels.mjs';
import { TEXT_KINDS, TRUSTED_METHODS } from './entities.mjs';
import { distanceKm } from './chokepoints.mjs';
import { isCountryNameWord } from './countries.mjs';
import { extractEntities, tokensOf } from './extract.mjs';
import { hazardsOf, isHazardWord } from './hazards.mjs';
import { conflictOf } from './conflict.mjs';
import { isTopicWord, topicsOf } from './topics.mjs';
import { airlineByIcao } from '../air/airlines.mjs';

/** Bumped when a rule changes how events are linked: a graph linked by an older version is linked again once, over its retained events. */
export const LINK_RULES_VERSION = 5;
// The edge types each rules version changed. A relink from the version just before drops only those, so the same-story edges an
// incremental sweep made with buildEvents' related reports (which a relink no longer has) survive a co-occurs change.
const CHANGED_TYPES = Object.freeze({ 5: ['co-occurs'] });

/** The rule edge types a graph linked by `fromVersion` must drop before it is linked again; null for all of them. */
export function relinkTypes(fromVersion) {
  const types = new Set();
  for (let version = (Number.isInteger(fromVersion) ? fromVersion : 0) + 1; version <= LINK_RULES_VERSION; version++) {
    if (!CHANGED_TYPES[version]) return null;
    for (const type of CHANGED_TYPES[version]) types.add(type);
  }
  return [...types];
}

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
const ENTITY_WEIGHT = Object.freeze({ cve: 1, site: 0.9, chokepoint: 0.8, actor: 0.75, flight: 1, aircraft: 1, airline: 0 });
// The airline rule: a report of an incident and an air-watch incident of the same airline; stronger with a shared distinctive title word
// (a city of the route) or country.
const AIRLINE_STRENGTH = 0.6;
const AIRLINE_NAMED_STRENGTH = 0.7;
// Title-word beginnings of an air incident report (en, hu, de, fr), folded and lower case.
const INCIDENT_STEMS = ['emergenc', 'divert', 'diversion', 'descen', 'plung', 'plumm', 'drop', 'fell', 'fall', 'turbulen', 'mayday', 'squawk', 'depressur',
  'pressur', 'smoke', 'fire', 'engine', 'return', 'turned', 'crash', 'incident', 'injur', 'hijack', 'evacu', 'scare', 'kenyszer', 'zuhan', 'visszafordul',
  'notland', 'sinkflug', 'abstur', 'atterriss', 'deroute'];
const isIncidentWord = token => INCIDENT_STEMS.some(stem => token.startsWith(stem));
const airlineWords = id => new Set((airlineByIcao(id.split(':')[1])?.name ?? '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').split(/[^a-z0-9]+/).filter(Boolean));
const REPORT_KINDS = new Set(['news', 'osint']);
// More observations of one phenomenon in one country than this within the window, spread over more than CROWD_KM: a report needs a
// distinctive shared word to link.
const CROWD = 5;
const CROWD_KM = 800;
const MAX_SPREAD_POINTS = 40;
const HAZARD_STRENGTH = 0.6;
const HAZARD_NAMED_STRENGTH = 0.7;
const CONFLICT_STRENGTH = 0.65;
const CONFLICT_OBSERVATIONS = new Set(['conflict', 'thermal', 'interference', 'aviation']);
const TOPIC_STRENGTH = 0.6;
const TOPIC_NAMED_STRENGTH = 0.7;
// A word in more reports of the window than this is common (a busy politician's name, "war"): it does not tie a report to an observation.
const RARE = 6;
const MAX_PER_TOKEN = 200;
// Title words that say what kind of notice a record is, not which event: never distinctive.
const GENERIC = new Set(['warning', 'warnings', 'alert', 'alerts', 'watch', 'issued', 'until', 'notification', 'green', 'orange', 'red', 'yellow',
  'magnitude', 'depth', 'near', 'region', 'area', 'city', 'county', 'people', 'says', 'said', 'after', 'over', 'local', 'time', 'utc', 'week', 'today',
  'rate', 'system', 'unit', 'list', 'updated', 'update', 'report', 'data', 'user', 'users', 'year', 'month', 'first', 'last', 'more', 'than', 'will',
  // months (en, es, fr, de, hu): a date is in many unrelated titles
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'enero', 'febrero', 'marzo',
  'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre', 'janvier', 'fevrier', 'mars', 'avril', 'juin',
  'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre', 'januar', 'februar', 'marz', 'juni', 'juli', 'oktober', 'dezember',
  'januar', 'februar', 'marcius', 'aprilis', 'majus', 'junius', 'julius', 'augusztus', 'szeptember', 'oktober', 'november', 'december',
  // continents, regions and points of the compass
  'europe', 'european', 'africa', 'african', 'asia', 'asian', 'america', 'american', 'americas', 'middle', 'east', 'eastern', 'west', 'western',
  'north', 'northern', 'south', 'southern', 'central', 'gulf', 'pacific', 'atlantic', 'balkans', 'baltic', 'nordic', 'arab', 'latin', 'global', 'world',
  // the common words of institution and company names ("Council of Churches", "Dental Partners")
  'council', 'partners', 'group', 'union', 'company', 'international', 'national', 'association', 'committee', 'ministry', 'department', 'office',
  'agency', 'authority', 'court', 'university', 'institute', 'centre', 'center', 'foundation', 'holdings', 'corporation', 'services', 'network',
  'systems', 'security', 'forces', 'front', 'movement', 'alliance', 'federation', 'republic', 'state', 'states', 'united', 'royal', 'board',
  'commission', 'organization', 'organisation', 'federal', 'public', 'private', 'double', 'counter', 'capital', 'general', 'chief', 'head']);

// Which words of a title stand capitalised inside a sentence-case title (a name: "Grindr", "Guilfoyle"), and its first word (capitalised
// anyway: it tells nothing); null for a title in title case or capitals, where capitals tell nothing.
function capitalsOf(title) {
  const list = [...String(title || '').matchAll(/[\p{L}][\p{L}\p{N}'’-]*/gu)].map(match => match[0]);
  const long = list.filter(word => word.length > 3);
  const upper = long.filter(word => word[0] !== word[0].toLowerCase());
  if (!long.length || upper.length / long.length >= 0.6) return null;
  const fold = word => word.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/['’].*$/, '');
  return { caps: new Set(list.slice(1).filter(word => word[0] !== word[0].toLowerCase()).map(fold)), first: list.length ? fold(list[0]) : '' };
}

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
      id: event.id, kind, level: eventLevel(event), title: str(event.title, 160), tokens: tokensOf(event.title), topic: str(event.topic, 20) || null,
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
// Routine baseline rows (rules v5): the hourly AIS vessel count of a chokepoint (apis/sources/ships.mjs, source "Maritime", always info).
// PortWatch's daily transit rows (portwatch.imf.org) keep linking: one a day, and a fall of 25 % or more raises their level anyway.
const ROUTINE_SOURCES = new Set(['maritime']);
const isRoutine = record => record.k === 'maritime' && ROUTINE_SOURCES.has(record.s) && (!record.l || record.l === 'info');
// The kinds for which lying within a chokepoint's radius means being about the chokepoint (rules v5).
const NEAR_CHOKEPOINT_KINDS = new Set(['maritime', 'interference', 'conflict']);
const linkable = record => ([id, rel]) => !(rel === 'near' && id.startsWith('chokepoint:') && !NEAR_CHOKEPOINT_KINDS.has(record.k));
const countriesOf = record => record.n.filter(([id]) => id.startsWith('country:')).map(([id]) => id);
// Two reports that each name a country the other does not are different stories however alike their titles are ("Americans in Austria:
// US midterm deadlines" and "Americans in Norway: US midterm deadlines"); one naming a subset of the other's countries is not.
const otherCountries = (a, b) => { const x = countriesOf(a), y = countriesOf(b); return x.some(id => !y.includes(id)) && y.some(id => !x.includes(id)); };
const specificOf = record => record.n.filter(([id]) => !id.startsWith('country:')).filter(linkable(record));

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
  // How many observations of a phenomenon a country has around now (cached for the call), for the hazard rule.
  const crowds = new Map();
  const crowded = (country, hazard) => {
    const key = `${country}|${hazard}`;
    if (!crowds.has(key)) {
      const items = graph.eventsWith(country, { sinceMs: now - 3 * ENTITY_WINDOW }).filter(item => !isReport(item) && hazardsOf(item.w, item.k).has(hazard));
      let spread = 0;
      const points = items.filter(item => item.g).slice(0, MAX_SPREAD_POINTS);
      for (let i = 0; i < points.length && spread <= CROWD_KM; i++) for (let j = i + 1; j < points.length; j++) spread = Math.max(spread, distanceKm(points[i].g[0], points[i].g[1], points[j].g[0], points[j].g[1]));
      crowds.set(key, items.length > CROWD && spread > CROWD_KM);
    }
    return crowds.get(key);
  };
  // Title words of the window: which records carry each, and in how many reports (the rarity of the topic rule).
  const byToken = new Map();
  const reportCount = new Map();
  for (const record of graph.recent(now - 2 * ENTITY_WINDOW)) {
    for (const token of record.w) {
      if (!byToken.has(token)) byToken.set(token, []);
      const list = byToken.get(token);
      if (list.length < MAX_PER_TOKEN) list.push(record);
      if (isReport(record)) reportCount.set(token, (reportCount.get(token) || 0) + 1);
    }
  }
  const rare = token => (reportCount.get(token) || 0) <= RARE && !GENERIC.has(token) && !isTopicWord(token) && !isCountryNameWord(token) && !/\d/.test(token) && token.length >= 4;
  const capitals = new Map();
  const capitalsFor = item => { if (!capitals.has(item.id)) capitals.set(item.id, capitalsOf(item.h)); return capitals.get(item.id); };
  // A shared rare word is a name when every sentence-case title of the two capitalises it (and at least one is sentence case: in title case
  // capitals tell nothing); one such name links, otherwise two rare words are needed.
  const isName = (token, a, b) => {
    const told = [capitalsFor(a), capitalsFor(b)].filter(info => info && info.first !== token);
    return told.length > 0 && told.every(info => info.caps.has(token));
  };
  // Located observations of the last day, binned by whole degree, for the place rule.
  const cells = new Map();
  for (const record of graph.recent(now - 3 * PLACE_WINDOW)) {
    if (!record.g || isReport(record) || isRoutine(record)) continue;
    const key = `${Math.floor(record.g[0])}|${Math.floor(record.g[1])}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(record);
  }
  for (const id of Array.isArray(ids) ? ids : []) {
    const record = graph.get(id);
    if (!record || isRoutine(record)) continue;
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
        if (other.id !== id && !isRoutine(other) && close(other, ENTITY_WINDOW)) candidates.set(other.id, other);
      }
    }
    // ... and the records sharing a rare title word, for the topic rule (a record with no entity has only these).
    for (const token of record.w) {
      if (!rare(token)) continue;
      for (const other of byToken.get(token) ?? []) if (other.id !== id && !isRoutine(other) && !candidates.has(other.id) && close(other, ENTITY_WINDOW)) candidates.set(other.id, other);
    }
    const ownTopics = topicsOf(record.w, record.k, record.p);
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
      // co-occurs: a report and an observation of the same phenomenon in the same country (an earthquake report and the EMSC row).
      if (isReport(record) !== isReport(other)) {
        const report = isReport(record) ? record : other, observation = report === record ? other : record;
        const countries = countriesOf(record).filter(country => countriesOf(other).includes(country));
        const hazards = [...hazardsOf(report.w)].filter(hazard => hazardsOf(observation.w, observation.k).has(hazard));
        const distinct = countries.length ? record.w.filter(token => other.w.includes(token) && !GENERIC.has(token) && !isTopicWord(token) && !isCountryNameWord(token) && !/\d/.test(token)) : [];
        if (countries.length && hazards.length) {
          const wide = countries.some(country => hazards.some(hazard => crowded(country, hazard)));
          if (distinct.length || !wide) add(other.id, 'co-occurs', distinct.length ? HAZARD_NAMED_STRENGTH : HAZARD_STRENGTH, 'rule');
        }
        if (distinct.length && CONFLICT_OBSERVATIONS.has(observation.k) && conflictOf(report.w).conflict) add(other.id, 'co-occurs', CONFLICT_STRENGTH, 'rule');
        // co-occurs: an incident report and an air-watch incident of the same airline.
        const airlines = observation.k === 'aviation' ? sharedSpecific.filter(([entity]) => entity.startsWith('airline:')) : [];
        if (airlines.length && report.w.some(isIncidentWord)) {
          const own = new Set(airlines.flatMap(([entity]) => [...airlineWords(entity)]));
          const named = record.w.filter(token => other.w.includes(token) && !own.has(token) && !GENERIC.has(token) && !isTopicWord(token) && !/\d/.test(token) && token.length >= 4);
          add(other.id, 'co-occurs', named.length || countries.length ? AIRLINE_NAMED_STRENGTH : AIRLINE_STRENGTH, 'rule');
        }
        // co-occurs: the same topic and a rare shared word (a KEV entry and a report on the same product; a market and a report on its question).
        if (ownTopics.size && !otherCountries(record, other) && [...topicsOf(other.w, other.k, other.p)].some(topic => ownTopics.has(topic))) {
          const named = record.w.filter(token => other.w.includes(token) && rare(token));
          if (named.length >= 2) add(other.id, 'co-occurs', TOPIC_NAMED_STRENGTH, 'rule');
          else if (named.length === 1 && isName(named[0], record, other)) add(other.id, 'co-occurs', TOPIC_STRENGTH, 'rule');
        }
      }
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
