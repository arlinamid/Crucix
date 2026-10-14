import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conflictOf, conflictSignals, summarizeConflict, ESCALATING } from '../lib/intelligence/conflict.mjs';
import { tokensOf } from '../lib/intelligence/extract.mjs';
import { GraphStore } from '../lib/intelligence/graph.mjs';
import { graphRecordsOf, linkEvents } from '../lib/intelligence/linkers.mjs';
import { threadStatus } from '../lib/intelligence/threads.mjs';
import { scoreCountries } from '../lib/intelligence/risk.mjs';
import { EntityStore } from '../lib/intelligence/entities.mjs';
import { METRICS } from '../lib/alerts/metrics.mjs';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const HOUR = 3600000;
const DAY = 24 * HOUR;
const reads = title => conflictOf(tokensOf(title)).conflict;
let serial = 0;
const report = (title, extra = {}) => ({ id: `event-${(++serial).toString(16).padStart(8, '0')}`, kind: 'news', title, summary: '', location: {},
  source: { name: 'x', hostname: extra.host || `${serial}.example` }, publishedAt: new Date(extra.at ?? NOW - HOUR).toISOString(), severity: 'unknown', relatedSources: [] });

function graphOf(t, { since = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-conflict-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const graph = new GraphStore(dir, { now: () => NOW });
  if (since !== null) graph.since = since;
  return { graph, dir };
}

test('conflictOf: strong words, two weak ones or an armed actor; strikes, attacks and air lines alone do not count', () => {
  for (const title of ['Israeli air strike kills Palestinian woman in Gaza City', 'Clashes erupt in Tripoli', 'Ukrainian drone attack kills two in Belgorod',
    'Headquarters of Saudi Aramco hit as Houthis and Riyadh trade strikes', 'US air strikes in Somalia', 'Légicsapás Gázában', 'Luftangriffe auf Kiew',
    'Bombardeo en Jartum deja decenas de muertos', 'Israeli artillery shells south Lebanon']) assert.equal(reads(title), true, title);
  for (const title of ['Teachers strike over pay', 'Man dies of heart attack', 'Cyberattack hits hospital', 'Air France strike cancels flights',
    'Air India pilots strike', 'Trade war escalates between US and China', 'Hamas says talks stalled', 'Taylor Swift tour attacks ticket prices']) assert.equal(reads(title), false, title);
  assert.equal(conflictOf(tokensOf('Missile strike kills four in Kharkiv')).casualties, true);
});

test('conflictSignals: distinct stories per day, a story from several outlets once; escalation only after seven days of observation', t => {
  const { graph } = graphOf(t, { since: NOW - 10 * DAY });
  const today = [report('Missile strike kills four in Kharkiv, Ukraine', { host: 'a.example' }), report('Kharkiv missile strike kills four, Ukraine says', { host: 'b.example' }),
    report('Artillery shelling hits Kherson, Ukraine'), report('Drone attack kills two soldiers in Ukraine'), report('Ukraine hosts a film festival')];
  const earlier = [2, 3, 4].map(days => report('Shelling hits Zaporizhzhia, Ukraine', { at: NOW - days * DAY - HOUR }));
  graph.ingest(graphRecordsOf([...today, ...earlier]), { now: NOW });
  graph.link([{ a: today[0].id, b: today[1].id, type: 'same-story', s: 0.9, m: 'rule' }], { now: NOW });
  const signals = conflictSignals(graph, { now: NOW, groups: graph.storyGroups(), observedDays: graph.observedDays(NOW) });
  const ukraine = signals.get('UKR');
  assert.deepEqual(ukraine.stories, [3, 0, 1, 1, 1, 0, 0], 'two outlets of the Kharkiv strike are one story; the film festival is no conflict');
  assert.equal(ukraine.sources, 4);
  assert.equal(ukraine.casualties, true);
  assert.equal(ukraine.intensity, 52.8);
  assert.equal(ukraine.escalation, 63.2, 'three stories against a usual half a story: (3 - 0.5) / (0.5 + 2) = 1, 100 x (1 - 1/e)');
  assert.ok(ukraine.escalation >= ESCALATING);
  const young = conflictSignals(graph, { now: NOW, groups: graph.storyGroups(), observedDays: 2 });
  assert.equal(young.get('UKR').escalation, null);
  assert.equal(young.get('UKR').value, young.get('UKR').intensity, 'the intensity alone while there is no week to compare with');
  const summary = summarizeConflict(signals, (iso3, name) => `${name}!`, iso3 => iso3 === 'UKR' ? 'Ukraine' : iso3, { observedDays: 10 });
  assert.deepEqual([summary.ready, summary.observedDays, summary.top[0].iso3, summary.top[0].displayName, summary.top[0].usual], [true, 10, 'UKR', 'Ukraine!', 0.5]);
});

test('conflictSignals: a sharp rise against the own week counts as escalating; risk v4 reads the value as the conflict component', t => {
  const { graph, dir } = graphOf(t, { since: NOW - 10 * DAY });
  const titles = ['Airstrike hits Khartoum market', 'Shelling in Omdurman', 'Clashes in El Fasher', 'Drone attack kills ten in Kordofan', 'Artillery fire on Kadugli',
    'Militia attack kills five in Darfur'];
  graph.ingest(graphRecordsOf(titles.map(title => report(`${title}, Sudan`))), { now: NOW });
  const signals = conflictSignals(graph, { now: NOW, groups: graph.storyGroups(), observedDays: 10 });
  assert.ok(signals.get('SDN').escalation >= ESCALATING);
  assert.equal(summarizeConflict(signals, undefined, undefined, { observedDays: 10 }).escalating, 1);
  const store = new EntityStore(dir, { now: () => NOW });
  const scores = scoreCountries({ store, conflicts: signals, now: NOW });
  const sudan = scores.find(row => row.iso3 === 'SDN');
  assert.equal(sudan, undefined, 'a country with no reference in the store is not a candidate');
  store.ingest(titles.map(title => report(`${title}, Sudan`)), { now: NOW });
  const scored = scoreCountries({ store, conflicts: signals, now: NOW }).find(row => row.iso3 === 'SDN');
  assert.equal(scored.components.conflict.value, signals.get('SDN').value);
  assert.equal(scored.components.conflict.weight, 0.09);
  assert.equal(scoreCountries({ store, conflicts: new Map(), now: NOW }).find(row => row.iso3 === 'SDN').components.conflict.value, 0);
  assert.equal(scoreCountries({ store, now: NOW }).find(row => row.iso3 === 'SDN').components.conflict.value, null);
  const metric = METRICS.find(item => item.key === 'risk_conflict_escalating');
  assert.equal(metric.read({ risk: { top: [], conflict: { escalating: 1 } } }), 1);
  assert.equal(metric.read({ risk: { top: [] } }), null);
});

test('threads: escalating when the last 12 hours bring three members from two outlets and twice the day before', () => {
  assert.equal(threadStatus(NOW - 30 * HOUR, NOW - HOUR, NOW, { recent: 4, earlier: 2, recentSources: 3 }), 'escalating');
  assert.equal(threadStatus(NOW - 30 * HOUR, NOW - HOUR, NOW, { recent: 4, earlier: 3, recentSources: 3 }), 'active', 'not twice as many');
  assert.equal(threadStatus(NOW - 30 * HOUR, NOW - HOUR, NOW, { recent: 3, earlier: 0, recentSources: 1 }), 'active', 'one outlet');
  assert.equal(threadStatus(NOW - 2 * HOUR, NOW - HOUR, NOW, { recent: 9, earlier: 0, recentSources: 5 }), 'emerging', 'a new thread is emerging first');
});

test('linkers: a conflict report and a heat detection at the military area it names co-occur; without a shared place word they do not', t => {
  const { graph } = graphOf(t);
  const fire = { id: 'event-f1', kind: 'thermal', title: 'High-intensity fire (140 MW) at Engels Air Base', summary: '', location: { lat: 51.48, lon: 46.2, method: 'provider' },
    source: { name: 'FIRMS', hostname: 'firms.example' }, observedAt: new Date(NOW - 2 * HOUR).toISOString(), severity: 'high', relatedSources: [] };
  const named = report('Drone attack hits Engels air base in Russia');
  const vague = report('Russia says drone attack repelled overnight');
  graph.ingest(graphRecordsOf([fire, named, vague]), { now: NOW });
  const edges = linkEvents([fire.id, named.id, vague.id], graph, { now: NOW });
  const between = (a, b) => edges.find(edge => [edge.a, edge.b].includes(a.id) && [edge.a, edge.b].includes(b.id));
  assert.equal(between(fire, named)?.s, 0.65);
  assert.equal(between(fire, vague), undefined);
});

test('the Country risk panel shows the armed-conflict section, escaped, with the not-ready note during the first week', () => {
  const window = { console };
  vm.runInContext(readFileSync(new URL('../dashboard/public/risk.js', import.meta.url), 'utf8'), vm.createContext({ window, document: { addEventListener() {} }, Intl, console }));
  const conflict = { escalating: 1, ready: false, observedDays: 2, top: [{ iso3: 'SDN', name: 'Sudan', displayName: 'Szudán <b>', stories: 6, usual: 0.5, sources: 5, casualties: true, intensity: 77.7, escalation: 80, value: 78.6 }] };
  const html = window.CrucixRisk.panelHtml({ top: [], counts: { scored: 0, high: 0 }, conflict }, { replay: false });
  assert.ok(html.includes('id="countryRiskConflict"') && html.includes('Szudán &lt;b&gt;') && html.includes('Escalating') && html.includes('casualties reported'));
  assert.ok(html.includes('2 so far'), 'the first week says why there is no escalation yet');
  assert.ok(!window.CrucixRisk.panelHtml({ top: [], counts: { scored: 0, high: 0 } }).includes('countryRiskConflict'), 'an older summary has no section');
});

test('threads: only an armed-conflict thread escalates; a fast aftershock sequence stays active', async t => {
  const { ThreadStore } = await import('../lib/intelligence/threads.mjs');
  const { graph, dir } = graphOf(t);
  const at = hours => NOW - hours * HOUR;
  const war = ['Shelling hits Kharkiv, Ukraine', 'Kharkiv shelling kills three, Ukraine says', 'Missile strike on Kharkiv, Ukraine', 'Kharkiv hit by missiles overnight, Ukraine']
    .map((title, n) => report(title, { at: n === 0 ? at(30) : at(2 + n) }));
  const quake = [0, 1, 2, 3].map(n => ({ id: `event-ab${n}`, kind: 'earthquake', title: 'M4.7 PANAMA', summary: '', location: { lat: 7.5, lon: -80.5, method: 'provider' },
    source: { name: 'EMSC', hostname: `emsc${n}.example` }, observedAt: new Date(n === 0 ? at(30) : at(2 + n)).toISOString(), severity: 'moderate', relatedSources: [] }));
  graph.ingest(graphRecordsOf([...war, ...quake]), { now: NOW });
  const chain = list => list.slice(1).map((item, n) => ({ a: list[n].id, b: item.id, type: 'same-story', s: 0.9, m: 'rule' }));
  graph.link([...chain(war), ...chain(quake).map(edge => ({ ...edge, type: 'co-occurs' }))], { now: NOW });
  const threads = new ThreadStore(dir, { now: () => NOW }).compute(graph, { now: NOW });
  assert.equal(threads.find(thread => thread.members.includes(war[0].id)).status, 'escalating');
  assert.equal(threads.find(thread => thread.members.includes('event-ab0')).status, 'active');
  assert.equal(reads('Container ship sinks after hitting mine in Strait of Hormuz — IRGC'), false, 'a mine alone stays out (a coal mine)');
  assert.equal(reads('IRGC navy seizes tanker in the Strait of Hormuz'), true);
});
