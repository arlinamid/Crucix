import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../lib/intelligence/graph.mjs';
import { ThreadStore, summarizeThreads, threadStatus } from '../lib/intelligence/threads.mjs';
import { EntityStore } from '../lib/intelligence/entities.mjs';
import { runRiskStep } from '../lib/intelligence/risk-step.mjs';
import { scoreCountries } from '../lib/intelligence/risk.mjs';
import { installRiskRoutes } from '../lib/intelligence/risk-routes.mjs';
import express from 'express';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const HOUR = 3600000;
const quiet = { log() {}, warn() {}, error() {} };
const record = (n, extra = {}) => ({ id: `event-${n.toString(16).padStart(8, '0')}`, kind: 'news', level: 'watch', source: `s${n}.example`, title: `Title ${n}`,
  tokens: [], entities: [{ id: 'country:SAU', rel: 'mentions', s: 0.5, label: 'SAU' }], point: null, observed: NOW - HOUR, ...extra });
const idOf = n => `event-${n.toString(16).padStart(8, '0')}`;

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-threads-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, graph: new GraphStore(dir, { now: () => NOW }), threads: new ThreadStore(dir, { now: () => NOW }) };
}

test('threads: strongly linked events form a thread, weak links and lone events do not', t => {
  const { graph, threads } = setup(t);
  graph.ingest([1, 2, 3, 4, 5].map(n => record(n)), { now: NOW });
  graph.link([
    { a: idOf(1), b: idOf(2), type: 'same-story', s: 0.9, m: 'rule' },
    { a: idOf(2), b: idOf(3), type: 'co-occurs', s: 0.64, m: 'rule' },
    { a: idOf(4), b: idOf(5), type: 'co-occurs', s: 0.4, m: 'rule' },
  ], { now: NOW });
  const list = threads.compute(graph, { now: NOW });
  assert.equal(list.length, 1);
  assert.equal(list[0].memberCount, 3);
  assert.equal(list[0].sources, 3);
  assert.deepEqual(list[0].edges, { 'same-story': 1, 'co-occurs': 1 });
  assert.equal(list[0].title, 'Title 2', 'the most linked member names the thread');
  assert.deepEqual(list[0].countries, [{ iso3: 'SAU', count: 3, located: false }]);
  assert.equal(threads.threadOf(idOf(4)), null);
  assert.equal(threads.threadOf(idOf(1)).id, list[0].id);
});

test('threads: the id survives a new member, a restart and a split (the bigger part keeps it)', t => {
  const { dir, graph, threads } = setup(t);
  graph.ingest([1, 2, 3].map(n => record(n)), { now: NOW });
  graph.link([{ a: idOf(1), b: idOf(2), type: 'same-story', s: 0.9, m: 'rule' }], { now: NOW });
  const first = threads.compute(graph, { now: NOW })[0].id;
  graph.link([{ a: idOf(3), b: idOf(2), type: 'same-story', s: 0.9, m: 'rule' }], { now: NOW });
  assert.equal(threads.compute(graph, { now: NOW })[0].id, first, 'a new member joins the thread, the id stays');
  threads.save(quiet);
  const restarted = new ThreadStore(dir, { now: () => NOW });
  assert.equal(restarted.load(), 'ok');
  graph.ingest([4, 5].map(n => record(n)), { now: NOW });
  graph.link([{ a: idOf(4), b: idOf(5), type: 'same-story', s: 0.9, m: 'rule' }], { now: NOW });
  const after = restarted.compute(graph, { now: NOW });
  assert.equal(after.length, 2);
  assert.ok(after.some(thread => thread.id === first && thread.memberCount === 3), 'the old thread keeps its id after a restart');
  assert.ok(after.every(thread => /^thread-[a-f0-9]{16}$/.test(thread.id)));
  assert.notEqual(after[0].id, after[1].id);
});

test('threads: members older than 72 hours drop out; the status follows the members\' times', t => {
  const { graph, threads } = setup(t);
  graph.ingest([record(1, { observed: NOW - 80 * HOUR }), record(2, { observed: NOW - 79 * HOUR })], { now: NOW });
  graph.link([{ a: idOf(1), b: idOf(2), type: 'same-story', s: 0.9, m: 'rule' }], { now: NOW });
  assert.deepEqual(threads.compute(graph, { now: NOW }), []);
  assert.equal(threadStatus(NOW - 2 * HOUR, NOW - HOUR, NOW), 'emerging');
  assert.equal(threadStatus(NOW - 30 * HOUR, NOW - 2 * HOUR, NOW), 'active');
  assert.equal(threadStatus(NOW - 60 * HOUR, NOW - 30 * HOUR, NOW), 'fading');
  const summary = summarizeThreads([], NOW);
  assert.deepEqual(summary, { at: new Date(NOW).toISOString(), count: 0, top: [] });
});

test('the risk step builds the graph and the threads, marks member events and adds snapshot.threads', t => {
  const { dir, graph, threads } = setup(t);
  const store = new EntityStore(dir, { now: () => NOW });
  const at = new Date(NOW - HOUR).toISOString();
  const news = (n, host, title) => ({ id: idOf(n), kind: 'news', title, summary: '', location: {}, source: { name: host, hostname: host }, publishedAt: at, severity: 'high', relatedSources: [] });
  const snapshot = { events: [
    news(11, 'a.example', 'Twelve killed in attack on Riyadh airport in Saudi Arabia'),
    news(12, 'b.example', 'Saudi Arabia: twelve killed in Riyadh airport attack'),
    news(13, 'c.example', 'Pakistan imposes emergency rule in a northern province'),
  ] };
  const result = runRiskStep({ store, graph, threads, snapshot, raw: null, now: NOW, log: quiet });
  assert.equal(result.ok, true);
  assert.equal(snapshot.threads.count, 1);
  assert.equal(snapshot.threads.top[0].memberCount, 2);
  assert.equal(snapshot.events[0].thread, snapshot.threads.top[0].id);
  assert.equal(snapshot.events[2].thread, undefined);
  // A broken graph never stops the risk step.
  const broken = { ingest() { throw new Error('disk on fire'); } };
  const second = { events: [news(14, 'd.example', 'Anything')] };
  assert.equal(runRiskStep({ store, graph: broken, threads, snapshot: second, raw: null, now: NOW, log: quiet }).ok, true);
  assert.ok(second.risk);
});

test('the thread and entity routes: list, one thread with its events and links, an entity with its neighbours; bad ids are 400, unknown 404', async t => {
  const { dir, graph, threads } = setup(t);
  const store = new EntityStore(dir, { now: () => NOW });
  const at = new Date(NOW - HOUR).toISOString();
  const news = (n, host, title) => ({ id: idOf(n), kind: 'news', title, summary: '', location: {}, source: { name: host, hostname: host, url: `https://${host}/${n}` }, publishedAt: at, severity: 'high', relatedSources: [] });
  const snapshot = { events: [news(21, 'a.example', 'Iran seizes tanker in the Strait of Hormuz'), news(22, 'b.example', 'Tanker seized by Iran in the Strait of Hormuz')] };
  assert.equal(runRiskStep({ store, graph, threads, snapshot, raw: null, now: NOW, log: quiet, language: 'hu' }).ok, true);
  const app = express();
  installRiskRoutes(app, { store, getSnapshot: () => snapshot, getState: () => null, graph, threads, security: {}, language: 'hu' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const list = await (await fetch(`${url}/api/threads`)).json();
  assert.equal(list.total, 1);
  const [row] = list.threads;
  assert.equal(row.score, undefined, 'the ordering score stays internal');
  assert.deepEqual(row.countries.map(item => [item.iso3, item.displayName]), [['IRN', 'Irán']]);
  const one = await (await fetch(`${url}/api/threads/${row.id}`)).json();
  assert.equal(one.events.length, 2);
  assert.equal(one.events[0].url.startsWith('https://'), true);
  assert.ok(one.events[0].entities.some(entity => entity.id === 'chokepoint:hormuz'));
  assert.equal(one.links.length, 1);
  assert.equal(one.links[0].type, 'same-story');
  const entity = await (await fetch(`${url}/api/entities/${encodeURIComponent('chokepoint:hormuz')}`)).json();
  assert.equal(entity.label, 'Strait of Hormuz');
  assert.equal(entity.events.length, 2);
  assert.deepEqual(entity.neighbors.map(item => item.id), ['country:IRN']);
  assert.equal(entity.threads[0].id, row.id);
  const sheet = await (await fetch(`${url}/api/countries/IRN`)).json();
  assert.equal(sheet.threads[0].id, row.id, 'the country sheet lists its threads');
  assert.equal((await fetch(`${url}/api/threads/nope`)).status, 400);
  assert.equal((await fetch(`${url}/api/threads/thread-0000000000000000`)).status, 404);
  assert.equal((await fetch(`${url}/api/entities/${encodeURIComponent('bogus:x')}`)).status, 400);
  assert.equal((await fetch(`${url}/api/entities/${encodeURIComponent('cve:CVE-1999-0001')}`)).status, 404);
  assert.equal((await fetch(`${url}/api/threads?x=1`)).status, 400);
});

test('risk v3: corroboration reads the broadest thread naming the country by severity; the attention counts a story once', t => {
  const { dir, graph } = setup(t);
  const store = new EntityStore(dir, { now: () => NOW });
  const thread = { countries: [{ iso3: 'IRN' }], sources: 5, kinds: ['maritime', 'news', 'market'], maxLevel: 'high' };
  const weak = { countries: [{ iso3: 'IRN' }, { iso3: 'OMN' }], sources: 2, kinds: ['news'], maxLevel: null };
  const at = new Date(NOW - HOUR).toISOString();
  store.ingest([1, 2, 3].map(n => ({ id: idOf(n), kind: 'news', title: 'Iran seizes a tanker', summary: '', location: {}, publishedAt: at })), { now: NOW });
  const scores = scoreCountries({ store, threads: [thread, weak], now: NOW });
  assert.equal(scores.find(row => row.iso3 === 'IRN').components.corroboration.value, 80, 'high (0.8) x full breadth');
  assert.equal(scoreCountries({ store, threads: [weak], now: NOW }).find(row => row.iso3 === 'IRN').components.corroboration.value, 2.5, 'info-like (0.2) x half a source step');
  assert.equal(scoreCountries({ store, threads: [], now: NOW }).find(row => row.iso3 === 'IRN').components.corroboration.value, 0, 'threads but none for the country: zero');
  assert.equal(scoreCountries({ store, now: NOW }).find(row => row.iso3 === 'IRN').components.corroboration.value, null, 'no threads: missing');
  assert.equal(store.mentionCounts('IRN', 7, NOW)[0], 3);
  graph.ingest([1, 2, 3].map(n => record(n)), { now: NOW });
  graph.link([{ a: idOf(1), b: idOf(2), type: 'same-story', s: 0.9, m: 'rule' }, { a: idOf(2), b: idOf(3), type: 'co-occurs', s: 0.9, m: 'rule' }], { now: NOW });
  const groups = graph.storyGroups();
  assert.equal(groups.get(idOf(2)), idOf(1), 'a same-story pair is one story');
  assert.equal(groups.get(idOf(3)), undefined, 'a co-occurrence is not the same story');
  assert.equal(store.mentionCounts('IRN', 7, NOW, id => groups.get(id))[0], 2, 'two outlets of one story count once');
});

test('alert rule "thread": a thread with enough sources, kinds and observations at the level fires once per thread with its members as evidence', async () => {
  const { evaluateRule } = await import('../lib/alerts/evaluators.mjs');
  const { DEFAULT_RULES, validateRule, describeRule } = await import('../lib/alerts/rules.mjs');
  const rule = DEFAULT_RULES.find(item => item.id === 'threads-multisource');
  assert.equal(rule.notify, false, 'linked is not confirmed: not sent to the channels by default');
  assert.match(describeRule(rule), /Story threads from 3\+ sources/);
  assert.equal(validateRule({ id: 'x', name: 'X', kind: 'thread', params: { minSources: 1 } }).ok, false, 'a thread needs two sources at least');
  const at = new Date(NOW - HOUR).toISOString();
  const events = [{ id: idOf(31), kind: 'maritime', title: 'Hormuz transits', severity: 'high', observedAt: at, source: { name: 'PortWatch' }, location: {} },
    { id: idOf(32), kind: 'news', title: 'Iran seizes tanker', severity: 'moderate', publishedAt: at, source: { name: 'Reuters' }, location: {} }];
  const thread = { id: 'thread-0123456789abcdef', title: 'Iran seizes tanker', memberCount: 4, sources: 3, observations: 1, kinds: ['maritime', 'news'], maxLevel: 'high', members: [idOf(31), idOf(32)] };
  const ctx = threads => ({ snapshot: { threads: { top: threads } }, events, now: NOW });
  const [hit, ...rest] = evaluateRule(rule, ctx([thread]));
  assert.equal(rest.length, 0);
  assert.equal(hit.dedupKey, 'threads-multisource|thread-0123456789abcdef');
  assert.equal(hit.entity.type, 'thread');
  assert.match(hit.summary, /not confirmed/);
  assert.equal(hit.evidence.length, 2);
  for (const weaker of [{ sources: 2 }, { kinds: ['news'] }, { observations: 0 }, { maxLevel: 'watch' }, { id: 'thread-bad' }]) {
    assert.deepEqual(evaluateRule(rule, ctx([{ ...thread, ...weaker }])), [], JSON.stringify(weaker));
  }
  assert.deepEqual(evaluateRule(rule, { snapshot: {}, events, now: NOW }), [], 'an older snapshot without threads');
});

test('briefing: the model sees thread labels and a thread summary; the rule briefing tells a thread once, citing its rows', async () => {
  const { generateBriefing } = await import('../lib/llm/briefing.mjs');
  const at = new Date(NOW - HOUR).toISOString();
  const thread = 'thread-0123456789abcdef';
  const event = (n, title, extra = {}) => ({ id: `event-${n.toString(16).padStart(32, '0')}`, kind: 'news', title, summary: '', severity: 'high', publishedAt: at, location: {}, source: { name: 'x' }, ...extra });
  const snapshot = {
    events: [event(1, 'Iran seizes tanker in Hormuz', { thread }), event(2, 'Tanker seized near Hormuz by Iran', { thread }), event(3, 'Floods in Kenya')],
    threads: { top: [{ id: thread, title: 'Iran seizes tanker in Hormuz', memberCount: 2, sources: 2, kinds: ['news'] }] },
  };
  const rules = await generateBriefing({ scope: 'global', snapshot, now: NOW, language: 'en' });
  assert.equal(rules.source, 'rules');
  const told = rules.bullets.filter(bullet => /Hormuz/.test(bullet.text));
  assert.equal(told.length, 1, 'one bullet for the thread');
  assert.match(told[0].text, /2 linked records/);
  assert.equal(told[0].refs.length, 2);
  assert.ok(rules.bullets.some(bullet => /Kenya/.test(bullet.text)));
  let seen = '';
  const provider = { isConfigured: true, config: {}, complete: async (system, user) => { seen = system + '\n' + user; return { text: '{"bullets":[{"text":"Iran seized a tanker.","refs":[1,2]}]}' }; } };
  const model = await generateBriefing({ scope: 'global', snapshot, provider, now: NOW, language: 'en', log: quiet });
  assert.equal(model.source, 'llm');
  assert.match(seen, /STORY_THREADS[^\n]*\n- T1: Iran seizes tanker in Hormuz \(2 records, 2 sources, kinds: news\)/);
  assert.equal((seen.match(/"thread":"T1"/g) || []).length, 2, 'both rows carry the label');
  assert.match(seen, /one bullet per thread/);
});

test('ask: the context lists the story threads and labels their events', async () => {
  const { buildAskContext } = await import('../lib/alerts/ask.mjs');
  const thread = 'thread-0123456789abcdef';
  const { text } = buildAskContext({ events: [{ id: 'event-1', kind: 'news', title: 'Iran seizes tanker', severity: 'high', thread, source: { name: 'x' } }, { id: 'event-2', kind: 'news', title: 'Floods', source: { name: 'y' } }],
    threads: { top: [{ id: thread, title: 'Iran seizes tanker', memberCount: 3, sources: 3 }] } });
  assert.match(text, /Story thread T1 \(linked by rule, not confirmed\): Iran seizes tanker \(3 records, 3 sources\)/);
  assert.match(text, /\[E1\] \(news, high, thread T1\) Iran seizes tanker/);
  assert.match(text, /\[E2\] \(news\) Floods/);
});
