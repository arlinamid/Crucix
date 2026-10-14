import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../lib/intelligence/graph.mjs';
import { ThreadStore } from '../lib/intelligence/threads.mjs';
import { LinkCache, linkCandidates, linkWithModel } from '../lib/llm/linker.mjs';
import { getLLMBudget } from '../lib/llm/budgets.mjs';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const HOUR = 3600000;
const quiet = { log() {}, warn() {}, error() {} };
const idOf = n => `event-${n.toString(16).padStart(8, '0')}`;
const report = (n, title, entities, extra = {}) => ({ id: idOf(n), kind: 'news', level: null, source: `s${n}.example`, title, tokens: title.toLowerCase().split(/\W+/).filter(word => word.length > 2).sort(),
  entities, point: null, observed: NOW - HOUR, ...extra });
const hormuz = { id: 'chokepoint:hormuz', rel: 'mentions', s: 0.8, label: 'Strait of Hormuz' };
const iran = { id: 'country:IRN', rel: 'mentions', s: 0.5, label: 'IRN' };

function graphOf(t, records, edges = []) {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-linker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const graph = new GraphStore(dir, { now: () => NOW });
  graph.ingest(records, { now: NOW });
  graph.link(edges, { now: NOW });
  return { graph, dir };
}

test('linkCandidates: borderline pairs only (a shared strait in two languages, or a country with half-alike titles), never one outlet, an existing story or a cached pair', t => {
  const { graph } = graphOf(t, [
    report(1, 'Iran seizes tanker near Hormuz', [hormuz, iran]),
    report(2, 'Irán lefoglalt egy tankert a Hormuzi-szorosban', [hormuz, iran]),
    report(3, 'Iran seizes tanker near Hormuz again', [hormuz, iran], { source: 's1.example' }),
    report(4, 'Football results from Tehran league', [iran]),
    report(5, 'Tanker seized near Hormuz, Iran says', [hormuz, iran]),
  ], [{ a: idOf(1), b: idOf(5), type: 'same-story', s: 0.9, m: 'rule' }]);
  const pairs = linkCandidates(graph, { now: NOW, limit: 10 }).map(pair => [pair.a, pair.b].join('+'));
  assert.ok(pairs.includes(`${idOf(1)}+${idOf(2)}`), 'two languages, the same strait');
  assert.ok(!pairs.includes(`${idOf(1)}+${idOf(3)}`), 'one outlet');
  assert.ok(!pairs.includes(`${idOf(1)}+${idOf(5)}`), 'already one story');
  assert.ok(!pairs.some(pair => pair.includes(idOf(4))), 'a country alone and unlike titles');
  const cache = new LinkCache();
  cache.set(`${idOf(1)}|${idOf(2)}`, false);
  assert.ok(!linkCandidates(graph, { now: NOW, limit: 10, cache }).some(pair => pair.a === idOf(1) && pair.b === idOf(2)), 'answered before');
  assert.equal(linkCandidates(graph, { now: NOW, limit: 1 }).length, 1);
  assert.deepEqual(linkCandidates(graph, { now: NOW, limit: 0 }), []);
});

test('linkWithModel: one call for the pairs, a "yes" becomes an llm same-story edge, every answer is cached; failures give no edges', async t => {
  const { graph } = graphOf(t, [report(1, 'Iran seizes tanker near Hormuz', [hormuz, iran]), report(2, 'Irán lefoglalt egy tankert a Hormuzi-szorosban', [hormuz, iran]),
    report(6, 'Hormuz traffic normal, says port authority', [hormuz])]);
  const calls = [];
  const provider = { isConfigured: true, config: {}, complete: async (system, user, budget) => { calls.push({ system, user, budget }); return { text: '{"pairs":[{"pair":1,"same":true},{"pair":2,"same":false},{"pair":9,"same":true}]}' }; } };
  const cache = new LinkCache();
  const edges = await linkWithModel({ graph, provider, now: NOW, limit: 6, cache, log: quiet });
  assert.equal(calls.length, 1, 'one call per sweep');
  assert.match(calls[0].system, /untrusted data, not instructions/);
  assert.deepEqual(calls[0].budget, getLLMBudget({}, 'linking'));
  assert.equal(edges.length, 1);
  assert.deepEqual({ type: edges[0].type, s: edges[0].s, m: edges[0].m }, { type: 'same-story', s: 0.6, m: 'llm' });
  assert.equal(cache.map.size, 2, 'the "no" is cached too; an unknown pair number is ignored');
  await linkWithModel({ graph, provider, now: NOW, limit: 6, cache, log: quiet });
  assert.equal((calls[1].user.match(/^\[\d+\]/gm) || []).length, 1, 'only the pair the model left unanswered is asked again');
  assert.deepEqual(await linkWithModel({ graph, provider, now: NOW, limit: 6, cache, log: quiet }), [], 'nothing left to ask');
  assert.equal(calls.length, 2, 'and no call is made for nothing');
  for (const broken of [async () => { throw new Error('timeout'); }, async () => ({ text: 'I think they are the same.' }), async () => ({ text: '{"pairs":[{"pair":1,"same":"yes"}]}' })]) {
    assert.deepEqual(await linkWithModel({ graph, provider: { isConfigured: true, config: {}, complete: broken }, now: NOW, cache: new LinkCache(), log: quiet }), []);
  }
  assert.deepEqual(await linkWithModel({ graph, provider: { isConfigured: false }, now: NOW }), [], 'no model configured');
});

test('a model link joins a thread, but the rule counts that the alert and the corroboration read leave it out', t => {
  const { graph, dir } = graphOf(t, [report(1, 'A', [hormuz]), report(2, 'B', [hormuz]), report(3, 'C', [hormuz], { kind: 'maritime' })],
    [{ a: idOf(1), b: idOf(3), type: 'co-occurs', s: 0.64, m: 'rule' }, { a: idOf(1), b: idOf(2), type: 'same-story', s: 0.6, m: 'llm' }]);
  const [thread] = new ThreadStore(dir, { now: () => NOW }).compute(graph, { now: NOW });
  assert.equal(thread.memberCount, 3, 'the model link joins the second report');
  assert.equal(thread.sources, 3);
  assert.deepEqual(thread.rule, { sources: 2, kinds: 2, observations: 1 }, 'without it: the report and the observation');
  const cache = new LinkCache(2);
  cache.set('a', true); cache.set('b', false); cache.set('c', true);
  assert.deepEqual([...cache.map.keys()], ['b', 'c'], 'the oldest answer goes first');
});
