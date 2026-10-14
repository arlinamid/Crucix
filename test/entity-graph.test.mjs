import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDictionaries, extractEntities, slugOf, tokensOf } from '../lib/intelligence/extract.mjs';
import { chokepointAt } from '../lib/intelligence/chokepoints.mjs';
import { GraphStore } from '../lib/intelligence/graph.mjs';
import { graphRecordsOf, linkEvents } from '../lib/intelligence/linkers.mjs';
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
