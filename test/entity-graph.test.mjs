import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDictionaries, extractEntities, slugOf, tokensOf } from '../lib/intelligence/extract.mjs';
import { chokepointAt } from '../lib/intelligence/chokepoints.mjs';
import { GraphStore } from '../lib/intelligence/graph.mjs';
import { graphRecordsOf, linkEvents, LINK_RULES_VERSION } from '../lib/intelligence/linkers.mjs';
import { EntityStore } from '../lib/intelligence/entities.mjs';
import { runRiskStep } from '../lib/intelligence/risk-step.mjs';
import { METRICS } from '../lib/alerts/metrics.mjs';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const HOUR = 3600000;
const actors = { release: 'test', countries: { RUS: { groups: [{ name: 'APT28', aliases: ['Fancy Bear', 'Sofacy'] }, { name: 'Snake', aliases: ['Turla'] }] } } };
const ids = (list, prefix = '') => list.map(item => item.id).filter(id => id.startsWith(prefix));
let serial = 0;
const id = () => `event-${(++serial).toString(16).padStart(8, '0')}`;
const news = (title, extra = {}) => ({ id: id(), kind: 'news', title, summary: '', location: {}, source: { name: extra.outlet || 'Outlet', hostname: extra.host || `${serial}.example` },
  publishedAt: new Date(extra.at ?? NOW).toISOString(), severity: 'unknown', relatedSources: [], ...extra.event });
const observation = (kind, title, lat, lon, extra = {}) => ({ id: id(), kind, title, summary: '', location: { lat, lon, method: 'provider' },
  source: { name: extra.source || kind, hostname: extra.host || `${kind}.example` }, observedAt: new Date(extra.at ?? NOW).toISOString(), severity: extra.severity || 'moderate', relatedSources: [] });

function withGraph(t, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-graph-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return fn(new GraphStore(dir, { now: () => NOW }), dir);
}

function build(graph, events, dictionaries = createDictionaries({ actors })) {
  const records = graphRecordsOf(events, dictionaries);
  const added = graph.ingest(records, { now: NOW });
  const related = new Map(records.filter(record => record.related.length).map(record => [record.id, record.related]));
  const edges = linkEvents(added, graph, { now: NOW, related });
  graph.link(edges, { now: NOW });
  return edges;
}

test('extractEntities: chokepoints by name (also a Hungarian case) and by trusted coordinates, CVEs and actors', () => {
  const dictionaries = createDictionaries({ actors });
  assert.deepEqual(ids(extractEntities(news('Houthi missile hits tanker near Bab el-Mandeb'), dictionaries), 'chokepoint:'), ['chokepoint:bab_el_mandeb']);
  assert.equal(extractEntities(news('Drones over the Red Sea'), dictionaries).find(entity => entity.type === 'chokepoint').s, 0.5, 'a whole sea is a weaker link');
  assert.deepEqual(ids(extractEntities(news('A Hormuzi-szorosban feltartóztattak egy tankert'), dictionaries), 'chokepoint:'), ['chokepoint:hormuz']);
  const transit = extractEntities(observation('maritime', 'Transits', 26.5, 56.3), dictionaries).find(entity => entity.type === 'chokepoint');
  assert.deepEqual([transit.id, transit.rel, transit.s], ['chokepoint:hormuz', 'near', 0.9]);
  assert.deepEqual(ids(extractEntities(news('Fancy Bear exploits cve-2026-1234 in ministries'), dictionaries)).sort(), ['actor:apt28', 'cve:CVE-2026-1234']);
  assert.deepEqual(ids(extractEntities(news('Snake spotted in a garden'), dictionaries)), [], 'a plain-word actor name needs a cyber context');
  assert.deepEqual(ids(extractEntities(news('Turla hackers target embassies'), dictionaries)), ['actor:snake']);
  assert.deepEqual(extractEntities(news('Strike in the Red Sea'), {}).length, 1, 'no actor dictionary: no actors, the rest still works');
  assert.equal(chokepointAt(0, 0), null);
});

test('slugOf and tokensOf are stable and bounded', () => {
  assert.equal(slugOf('Mezzeh Air Base'), 'mezzeh-air-base');
  assert.match(slugOf('Аэродром Кубинка'), /^h[0-9a-z]+$/, 'a name without Latin letters gets a hash');
  assert.equal(slugOf('Аэродром Кубинка'), slugOf('Аэродром Кубинка'));
  assert.deepEqual(tokensOf('The 12 killed in Riyadh airport attack, says report'), ['airport', 'attack', 'killed', 'riyadh']);
});

test('the alert metrics keep their chokepoint labels from the shared list', () => {
  assert.equal(METRICS.find(metric => metric.key === 'hormuz_transits').label, 'Strait of Hormuz transits (7-day mean)');
  assert.equal(METRICS.filter(metric => metric.key.endsWith('_transits')).length, 8);
});

test('linkers: same-story joins two outlets of one story, never two stories about different countries or one outlet twice', t => withGraph(t, graph => {
  const a = news('Twelve killed in attack on Riyadh airport in Saudi Arabia', { host: 'a.example' });
  const b = news('Saudi Arabia: twelve killed in Riyadh airport attack', { host: 'b.example' });
  const same = news('Saudi Arabia: twelve killed in Riyadh airport attack again', { host: 'a.example' });
  const austria = news('Americans in Austria: deadlines for voting in the US midterms', { host: 'c.example' });
  const norway = news('Americans in Norway: deadlines for voting in the US midterms', { host: 'd.example' });
  const edges = build(graph, [a, b, same, austria, norway]);
  const pairs = edges.map(edge => [edge.a, edge.b].sort().join('+'));
  assert.ok(pairs.includes([a.id, b.id].sort().join('+')));
  assert.ok(!pairs.includes([a.id, same.id].sort().join('+')), 'one outlet is one source');
  assert.ok(!pairs.includes([austria.id, norway.id].sort().join('+')), 'each names a country the other does not');
  assert.ok(edges.every(edge => edge.type === 'same-story' && edge.m === 'rule'));
}));

test('linkers: a report and an observation of the same chokepoint co-occur; two reports sharing only the strait do not', t => withGraph(t, graph => {
  // The PortWatch day is a week old (provider lag) but was first seen in this sweep.
  const transits = observation('maritime', 'Strait of Hormuz: 20 ship transits', 26.5, 56.3, { at: NOW - 7 * 24 * HOUR, source: 'IMF-PortWatch' });
  const seizure = news('Iran seizes tanker in the Strait of Hormuz', { host: 'x.example' });
  const prices = news('Oil traders watch Hormuz as prices climb', { host: 'y.example' });
  const edges = build(graph, [transits, seizure, prices]);
  const between = (p, q) => edges.find(edge => [edge.a, edge.b].sort().join('+') === [p.id, q.id].sort().join('+'));
  assert.equal(between(transits, seizure)?.type, 'co-occurs');
  assert.equal(between(transits, seizure).s, 0.64, 'min(0.8 named, 0.9 near) x 0.8 for a chokepoint');
  assert.equal(between(seizure, prices), undefined, 'a busy strait is in many unrelated stories');
}));

test('linkers: observations of different kinds within 100 km and a day co-occur by place', t => withGraph(t, graph => {
  const fire = observation('thermal', 'High-intensity fire at Mezzeh Air Base', 33.51, 36.28);
  const quake = observation('earthquake', 'M4.2 near Damascus', 33.6, 36.4, { at: NOW - 3 * HOUR });
  const far = observation('earthquake', 'M4.0 far away', 36.5, 40, { at: NOW - 3 * HOUR });
  const late = observation('outage', 'Outage near Damascus', 33.5, 36.3, { at: NOW - 30 * HOUR });
  const edges = build(graph, [fire, quake, far, late]);
  const linked = edges.map(edge => [edge.a, edge.b].sort().join('+'));
  assert.ok(linked.includes([fire.id, quake.id].sort().join('+')));
  assert.ok(!linked.some(pair => pair.includes(far.id)), 'more than 100 km away');
  assert.equal(edges.find(edge => [edge.a, edge.b].includes(fire.id) && [edge.a, edge.b].includes(quake.id)).s, 0.6);
}));

test('GraphStore: round-trips, keeps the higher level, prunes by retention and drops edges of pruned events; a corrupt file starts empty', t => withGraph(t, (graph, dir) => {
  const a = news('Twelve killed in attack on Riyadh airport in Saudi Arabia', { host: 'a.example' });
  const b = news('Saudi Arabia: twelve killed in Riyadh airport attack', { host: 'b.example' });
  build(graph, [a, b]);
  assert.equal(graph.edgesOf(a.id).length, 1);
  graph.ingest([{ id: a.id, level: 'critical', entities: [] }], { now: NOW });
  assert.equal(graph.get(a.id).l, 'critical', 'a later, higher severity counts');
  assert.equal(graph.save({ warn() {} }), true);
  const again = new GraphStore(dir, { now: () => NOW });
  assert.equal(again.load(), 'ok');
  assert.equal(again.edgesOf(b.id)[0].id, a.id);
  assert.deepEqual(again.neighbors('country:SAU').map(row => row.id), []);
  assert.equal(again.eventsWith('country:SAU').length, 2);
  const later = new GraphStore(dir, { now: () => NOW + 20 * 24 * HOUR });
  later.load();
  assert.equal(later.events.size, 0, 'older than the 14-day window');
  assert.equal(later.edges.size, 0);
  mkdirSync(join(dir, 'intelligence'), { recursive: true });
  writeFileSync(join(dir, 'intelligence', 'graph.json'), '{not json');
  writeFileSync(join(dir, 'intelligence', 'graph.json.bak'), '{"version":99}');
  const broken = new GraphStore(dir, { now: () => NOW });
  assert.equal(broken.load(), 'corrupt');
  assert.equal(broken.events.size, 0);
}));

test('GraphStore: an event without any entity is not kept, hostile input is ignored, caps hold', t => withGraph(t, graph => {
  assert.deepEqual(graph.ingest([{ id: 'event-aa', kind: 'news', entities: [] }, { id: 'not-an-id', entities: [{ id: 'country:HUN', rel: 'mentions', s: 1 }] },
    { id: 'event-bb', entities: [{ id: 'country:HUN; drop', rel: 'mentions', s: 1 }, { id: 'country:HUN', rel: 'bogus', s: 1 }] }], { now: NOW }), []);
  assert.equal(graph.link([{ a: 'event-aa', b: 'event-bb', type: 'same-story', s: 1, m: 'rule' }, null, { a: 'x' }]), 0, 'unknown events are not linked');
  const small = new GraphStore(graph.path, { now: () => NOW, maxEvents: 2 });
  const records = ['event-01', 'event-02', 'event-03'].map(item => ({ id: item, kind: 'news', entities: [{ id: 'country:HUN', rel: 'mentions', s: 0.5, label: 'HUN' }] }));
  small.ingest(records, { now: NOW });
  assert.equal(small.events.size, 2);
}));

test('hazards: phenomena in the main languages, inflected forms, kinds; ambiguous words stay out', async () => {
  const { hazardsOf, isHazardWord } = await import('../lib/intelligence/hazards.mjs');
  const of = title => [...hazardsOf(tokensOf(title))].sort();
  assert.deepEqual(of('Barbados embassy remains closed after Panama earthquake'), ['quake']);
  assert.deepEqual(of('Panamá no tuvo muertos con un terremoto de 7,7'), ['quake']);
  assert.deepEqual(of('Földrengésben megsérült a templom'), ['quake'], 'a Hungarian case of a long word');
  assert.deepEqual(of('Death toll rises as Hurricane Simon unleashes floods'), ['cyclone', 'flood']);
  assert.deepEqual(of('Gunfire at the home of a key witness'), [], '"fire" alone is not a wildfire');
  assert.deepEqual(of('A storm of criticism over the budget'), [], '"storm" alone is not a cyclone');
  assert.deepEqual([...hazardsOf(['m47', 'panama'], 'earthquake')], ['quake'], 'an earthquake record is a quake whatever its title says');
  assert.equal(isHazardWord('terremoto'), true);
  assert.equal(isHazardWord('panama'), false);
});

test('linkers: a report and an observation of the same phenomenon in the same country co-occur; another phenomenon or country does not', t => withGraph(t, graph => {
  const quake = observation('earthquake', 'M4.7 PANAMA', 7.5, -80.5);
  const aftershock = observation('earthquake', 'M4.5 PANAMA', 7.6, -80.4, { host: 'emsc2.example' });
  const news1 = news('Barbados embassy remains closed after Panama earthquake', { host: 'bb.example' });
  const news2 = news('Panamá no tuvo muertos con un terremoto de 7,7', { host: 'ec.example' });
  const other = news('Panama deregisters three sanctioned tankers', { host: 'np.example' });
  const elsewhere = news('Earthquake shakes Chile', { host: 'cl.example' });
  const edges = build(graph, [quake, aftershock, news1, news2, other, elsewhere]);
  const linked = (p, q) => edges.some(edge => [edge.a, edge.b].includes(p.id) && [edge.a, edge.b].includes(q.id));
  assert.ok(linked(quake, news1) && linked(quake, news2), 'an English and a Spanish report of the quake');
  assert.ok(!linked(quake, other), 'the same country, another subject');
  assert.ok(!linked(quake, elsewhere), 'the same phenomenon, another country');
  assert.equal(edges.find(edge => [edge.a, edge.b].includes(quake.id) && [edge.a, edge.b].includes(news1.id)).s, 0.6);
}));

test('linkers: where one phenomenon is observed all over a country, a report needs a distinctive shared word', t => withGraph(t, graph => {
  const states = [['Texas', 31, -97], ['Montana', 47, -110], ['Florida', 28, -82], ['Ohio', 40, -83], ['Oregon', 44, -121], ['Maine', 45, -69]];
  const warnings = states.map(([state, lat, lon]) => observation('weather', `Flash Flood Warning for ${state}, United States`, lat, lon, { host: 'noaa.example' }));
  const generic = news('Floods hit the United States', { host: 'g.example' });
  const texas = news('Texas floods force evacuations in the United States', { host: 'tx.example' });
  const edges = build(graph, [...warnings, generic, texas]);
  const touches = event => edges.filter(edge => edge.type === 'co-occurs' && [edge.a, edge.b].includes(event.id));
  assert.equal(touches(generic).length, 0, 'six warnings across the country: "floods" and the country are not enough');
  assert.deepEqual(touches(texas).map(edge => [edge.a, edge.b].find(id => id !== texas.id)), [warnings[0].id], 'the state name picks the Texas warning');
  assert.equal(touches(texas)[0].s, 0.7);
}));

test('the risk step links a graph made by older rules again, once', t => withGraph(t, (graph, dir) => {
  const quake = observation('earthquake', 'M4.7 PANAMA', 7.5, -80.5);
  const report = news('Barbados embassy remains closed after Panama earthquake', { host: 'bb.example' });
  graph.ingest(graphRecordsOf([quake, report]), { now: NOW });
  graph.rules = 1;
  assert.equal(graph.edges.size, 0);
  const store = new EntityStore(dir, { now: () => NOW });
  runRiskStep({ store, graph, snapshot: { events: [] }, raw: null, now: NOW, log: { warn() {}, error() {} } });
  assert.equal(graph.edges.size, 1, 'the stored pair is linked by the new rule');
  assert.equal(graph.rules, LINK_RULES_VERSION);
  const reloaded = new GraphStore(dir, { now: () => NOW });
  reloaded.load();
  assert.equal(reloaded.rules, LINK_RULES_VERSION, 'the version is saved with the graph');
}));

test('a rules change drops the old rule edges before linking again; model links stay', t => withGraph(t, (graph, dir) => {
  const a = news('Ivanti flaw exploited in attacks on Norway ministries', { host: 'a.example' });
  const b = news('Football results', { host: 'b.example' });
  graph.ingest(graphRecordsOf([a, b]), { now: NOW });
  graph.ingest([{ id: b.id, kind: 'news', entities: [{ id: 'country:NOR', rel: 'mentions', s: 0.5 }] }], { now: NOW });
  graph.link([{ a: a.id, b: b.id, type: 'co-occurs', s: 0.9, m: 'rule' }, { a: a.id, b: b.id, type: 'same-story', s: 0.6, m: 'llm' }], { now: NOW });
  graph.rules = 1;
  runRiskStep({ store: new EntityStore(dir, { now: () => NOW }), graph, snapshot: { events: [] }, raw: null, now: NOW, log: { warn() {}, error() {} } });
  assert.deepEqual(graph.edgesOf(a.id).map(edge => edge.m), ['llm'], 'the stale rule edge is gone, the model link is kept');
}));

test('topicsOf: politics, technology, economy and the kinds; a soft word alone does not decide', async () => {
  const { topicsOf, leadingTopic, isTopicWord } = await import('../lib/intelligence/topics.mjs');
  const of = (title, kind) => [...topicsOf(tokensOf(title), kind)].sort();
  assert.deepEqual(of('Turkish police raid opposition TV station'), ['politics']);
  assert.deepEqual(of('Ivanti flaw exploited by Chinese hackers'), ['technology']);
  assert.deepEqual(of('Inflation edged up in September'), ['economy']);
  assert.deepEqual(of('A party at the beach'), [], '"party" alone is not politics');
  assert.deepEqual(of('Bank of England: policy rate 3.75%', 'economic'), ['economy']);
  assert.deepEqual(of('US OFAC SDN list updated', 'sanctions'), ['politics']);
  assert.deepEqual(of('Israeli air strike kills a woman in Gaza'), ['conflict']);
  assert.equal(leadingTopic({ politics: 2, conflict: 2, technology: 1 }), 'conflict');
  assert.equal(leadingTopic({}), null);
  assert.equal(isTopicWord('exploited'), true);
  assert.equal(isTopicWord('grindr'), false);
});

test('linkers: the topic rule links a report and an observation through a rare name, never through a topic word, a date or a busy name', t => withGraph(t, graph => {
  const breach = { id: 'event-b1', kind: 'cyber', title: 'Grindr: 1,200,000 accounts exposed', summary: '', location: {}, source: { name: 'HIBP', hostname: 'hibp.example' },
    observedAt: new Date(NOW - 2 * HOUR).toISOString(), severity: 'moderate', relatedSources: [] };
  const kev = { id: 'event-b2', kind: 'cyber', title: 'CVE-2026-1234: Ivanti Connect Secure Authentication Bypass Vulnerability exploited', summary: '', location: {},
    source: { name: 'CISA-KEV', hostname: 'kev.example' }, observedAt: new Date(NOW - 2 * HOUR).toISOString(), severity: 'high', relatedSources: [] };
  const grindr = news('Norway fines Microsoft subsidiary for sharing Grindr user data', { host: 'n1.example' });
  const coup = news('The West African coups and anti-French feelings exploited by rivals', { host: 'n2.example' });
  const busy = Array.from({ length: 8 }, (_, n) => news(`Trump speech number ${n} on markets`, { host: `t${n}.example` }));
  const market = { id: 'event-b3', kind: 'market', title: 'Will Trump win the 2028 election?', summary: '', location: {}, source: { name: 'Manifold', hostname: 'manifold.example' },
    observedAt: new Date(NOW - 2 * HOUR).toISOString(), severity: 'info', relatedSources: [] };
  const edges = build(graph, [breach, kev, grindr, coup, market, ...busy]);
  const linked = (a, b) => edges.some(edge => [edge.a, edge.b].includes(a.id) && [edge.a, edge.b].includes(b.id));
  assert.ok(linked(breach, grindr), 'Grindr is capitalised inside a sentence: a name');
  assert.ok(!linked(kev, coup), '"exploited" is the topic, not a name');
  assert.ok(!busy.some(item => linked(market, item)), 'a name in many reports of the window links nothing alone');
}));

// Live on 2026-10-18: an ATV item on the 1956 commemorations ("light painting on the Bosphorus Bridge in Istanbul"), a thunderstorm SIGMET
// over Istanbul and a diverted flight became one 74-record thread through the hourly AIS vessel counts of the Bosphorus.
test('linkers v5: hourly AIS counts link nothing, and a weather notice near a strait is not at the strait', t => withGraph(t, graph => {
  assert.equal(LINK_RULES_VERSION, 5);
  const counts = [0, 1, 2, 3].map(hour => observation('maritime', `Bosphorus: ${70 + hour} vessels in the last hour (25 moving, 20 tankers)`, 41.12, 29.07,
    { at: NOW - hour * HOUR, source: 'Maritime', severity: 'info' }));
  // As the live rows: source "Maritime" with no hostname (graph source key "maritime").
  for (const count of counts) count.source.hostname = '';
  const sigmet = observation('weather', 'SIGMET Thunderstorm LTBB ISTANBUL', 41.0, 28.9, { at: NOW - 2 * HOUR, source: 'Aviation-SIGMET' });
  const commemoration = news('Brazíliától Csehországig világszerte megemlékeznek az 1956-os forradalomról',
    { host: 'atv.hu', event: { summary: 'Fényfestés lesz látható az isztambuli Boszporusz-hídon.' } });
  const edges = build(graph, [...counts, sigmet, commemoration]);
  const touches = event => edges.filter(edge => edge.a === event.id || edge.b === event.id);
  for (const count of counts) assert.deepEqual(touches(count), [], 'a routine count is neither a source nor a target of links');
  assert.deepEqual(touches(commemoration), [], 'the commemoration shares nothing with a thunderstorm over the city');
}));

test('linkers v5: an unusual maritime row, a PortWatch day and GNSS interference near a strait still link to a report on it', t => withGraph(t, graph => {
  const alarm = observation('maritime', 'Bosphorus: 3 vessels in the last hour (0 moving, 0 tankers)', 41.12, 29.07, { source: 'Maritime', severity: 'high' });
  alarm.source.hostname = '';
  const portwatch = observation('maritime', 'Bosporus Strait: 12 transits', 41.12, 29.07, { source: 'IMF-PortWatch', host: 'portwatch.imf.org', severity: 'info' });
  const jamming = observation('interference', 'GNSS interference over the Bosphorus area', 41.1, 29.0, { source: 'GPSJam' });
  const closure = news('Turkey closes the Bosphorus to tanker traffic', { host: 'wire.example' });
  const edges = build(graph, [alarm, portwatch, jamming, closure]);
  const between = (p, q) => edges.find(edge => [edge.a, edge.b].sort().join('+') === [p.id, q.id].sort().join('+'));
  assert.equal(between(alarm, closure)?.type, 'co-occurs');
  assert.equal(between(portwatch, closure)?.type, 'co-occurs');
  assert.equal(between(jamming, closure)?.type, 'co-occurs');
}));

test('a relink from rules v4 drops only the co-occurs rule edges: the same-story edges of the incremental sweeps stay', t => withGraph(t, (graph, dir) => {
  const a = news('Ivanti flaw exploited in attacks on Norway ministries', { host: 'a.example' });
  const b = news('Norway ministries hit through Ivanti flaw', { host: 'b.example' });
  const c = news('Football results', { host: 'c.example' });
  graph.ingest(graphRecordsOf([a, b, c]), { now: NOW });
  graph.ingest([{ id: c.id, kind: 'news', entities: [{ id: 'country:NOR', rel: 'mentions', s: 0.5 }] }], { now: NOW });
  // A same-story edge buildEvents' related reports gave (a relink has no related list) and a stale co-occurs edge.
  graph.link([{ a: a.id, b: c.id, type: 'same-story', s: 0.6, m: 'rule' }, { a: b.id, b: c.id, type: 'co-occurs', s: 0.9, m: 'rule' }], { now: NOW });
  graph.rules = 4;
  runRiskStep({ store: new EntityStore(dir, { now: () => NOW }), graph, snapshot: { events: [] }, raw: null, now: NOW, log: { warn() {}, error() {} } });
  const types = id => graph.edgesOf(id).map(edge => edge.type).sort();
  assert.ok(types(c.id).includes('same-story'), 'the same-story edge survives');
  assert.ok(!graph.edgesOf(b.id).some(edge => edge.id === c.id && edge.type === 'co-occurs'), 'the stale co-occurs edge is gone');
  assert.equal(graph.rules, LINK_RULES_VERSION);
}));

test('relinkTypes: only co-occurs from v4, everything from an older or unknown version', async () => {
  const { relinkTypes } = await import('../lib/intelligence/linkers.mjs');
  assert.deepEqual(relinkTypes(4), ['co-occurs']);
  assert.equal(relinkTypes(3), null);
  assert.equal(relinkTypes(0), null);
  assert.equal(relinkTypes(undefined), null);
  assert.deepEqual(relinkTypes(LINK_RULES_VERSION), []);
});

// Live on 2026-10-19 the 1956 commemoration item still joined a GNSS interference cell over Istanbul through "Boszporusz-hídon".
test('extractEntities: a strait named only in a bridge name is a weak mention; naming the strait itself is not', () => {
  const strength = (title, summary = '') => extractEntities({ kind: 'news', title, summary, location: {} }).find(entity => entity.id === 'chokepoint:bosporus')?.s;
  assert.equal(strength('Világszerte megemlékeznek az 1956-os forradalomról', 'Fényfestés lesz látható az isztambuli Boszporusz-hídon.'), 0.5);
  assert.equal(strength('Bosphorus Bridge lit up for the anniversary'), 0.5);
  assert.equal(strength('Turkey closes the Bosphorus to tankers'), 0.8);
  assert.equal(strength('Tankerek várakoznak a Boszporuszon'), 0.8);
  assert.equal(strength('Bosphorus Bridge closed as tankers queue in the Bosphorus'), 0.8, 'the strait named on its own as well');
});
