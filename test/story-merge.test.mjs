import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../lib/intelligence/graph.mjs';
import { ThreadStore } from '../lib/intelligence/threads.mjs';
import { tokensOf } from '../lib/intelligence/extract.mjs';
import { mergeStories, storyMergeEdges, stem } from '../lib/intelligence/story-merge.mjs';

const HOUR = 3600000;
const NOW = Date.parse('2026-10-17T12:00:00Z');
const usa = { id: 'country:USA', rel: 'mentions', s: 0.5, label: 'USA' };
let serial = 0;
const report = (title, { hoursAgo = 2, outlet } = {}) => {
  const n = ++serial;
  return { id: `event-${n.toString(16).padStart(8, '0')}`, kind: 'news', level: null, source: outlet ?? `outlet${n}.example`, title, tokens: tokensOf(title),
    entities: [usa], point: null, observed: NOW - hoursAgo * HOUR };
};
// 200 unrelated reports, so that the story words are rare (the IDF needs a corpus).
const FILLER = Array.from({ length: 200 }, (_, i) => `Filler bulletin ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}zz harbour regatta`);

function setup(t, groups, lone = []) {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-story-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const graph = new GraphStore(dir, { now: () => NOW });
  const fillers = FILLER.map(title => report(title, { hoursAgo: 30 }));
  const all = [...fillers, ...groups.flat(), ...lone];
  graph.ingest(all, { now: NOW });
  // Each group: a thread the pair rules made (same-story edges along it).
  const edges = groups.flatMap(group => group.slice(1).map((record, i) => ({ a: group[i].id, b: record.id, type: 'same-story', s: 0.7, m: 'rule' })));
  graph.link(edges, { now: NOW });
  const threads = new ThreadStore(dir, { now: () => NOW });
  threads.compute(graph, { now: NOW });
  return { graph, threads };
}
const threadOf = (threads, record) => threads.assign.get(record.id);

test('stem: a common ending off, at most six letters', () => {
  assert.equal(stem('waives'), 'waiv'); assert.equal(stem('waiving'), 'waiv'); assert.equal(stem('waiver'), 'waiv');
  assert.equal(stem('sanctions'), 'sancti');
});

test('story merge: the threads of one story in different wordings become one thread; another story naming the same person does not join', t => {
  const a = [report('Trump waives new Russia sanctions under Graham Act'), report('Trump waives Russia sanctions, citing national interest')];
  const b = [report('Trump puts new Russia sanctions on hold under Graham Act'), report('Graham Act sanctions on Russia put on hold by Trump')];
  const c = [report('Kremlin hails Trump waiving Russia sanctions as historic'), report('Russia hails waiving of Graham Act sanctions')];
  const other = [report('Trump hosts golf tournament at Doral resort'), report('Doral golf tournament draws Trump to Florida resort')];
  const { graph, threads } = setup(t, [a, b, c, other]);
  assert.equal(new Set([a, b, c].map(group => threadOf(threads, group[0]))).size, 3, 'three threads before');
  const added = mergeStories(graph, threads, { now: NOW });
  assert.ok(added >= 2);
  assert.equal(new Set([...a, ...b, ...c].map(record => threadOf(threads, record))).size, 1, 'one thread after');
  assert.notEqual(threadOf(threads, other[0]), threadOf(threads, a[0]), 'the golf story stays apart');
  assert.equal(mergeStories(graph, threads, { now: NOW }), 0, 'a second run over the same threads adds nothing');
  // The joining edges are same-story text edges between reports of the two threads.
  const edge = graph.edgesOf(a[0].id).concat(graph.edgesOf(b[0].id), graph.edgesOf(c[0].id)).find(item => item.m === 'text');
  assert.equal(edge.type, 'same-story'); assert.equal(edge.s, 0.6);
});

test('story merge: a lone report joins the thread of its story; two lone reports are left to the pair rules; a short title is not enough', t => {
  const story = [report('Zacharia resigns as White House press secretary after five days'), report('White House press secretary Zacharia quits after five days')];
  const lone = report('Press secretary Zacharia leaves White House post after five days in office');
  const loneA = report('Volcanic eruption grounds flights across Iceland airspace');
  const loneB = report('Iceland volcanic eruption grounds flights across airspace');
  const short = report('Zacharia speaks');
  const { graph, threads } = setup(t, [story], [lone, loneA, loneB, short]);
  mergeStories(graph, threads, { now: NOW });
  assert.equal(threadOf(threads, lone), threadOf(threads, story[0]));
  assert.equal(threadOf(threads, loneA), undefined, 'two lone reports: not joined here');
  assert.equal(threadOf(threads, short), undefined, 'fewer than 4 weighted words');
});

test('story merge: threads more than 36 hours apart, or a merge past the member cap, are not joined', t => {
  const early = [report('Ferry capsizes off Zanzibar coast leaving dozens missing', { hoursAgo: 60 }), report('Dozens missing after ferry capsizes off Zanzibar coast', { hoursAgo: 59 })];
  const late = [report('Zanzibar ferry capsizing leaves dozens missing off coast', { hoursAgo: 3 }), report('Search for dozens missing after Zanzibar ferry capsizes', { hoursAgo: 2 })];
  const { graph, threads } = setup(t, [early, late]);
  assert.equal(storyMergeEdges(graph, threads.threads.map(thread => thread.members), { now: NOW }).length, 0, 'too far apart in time');
  const edges = storyMergeEdges(graph, threads.threads.map(thread => thread.members), { now: NOW, settings: { tau: 0.45, loneTau: 0.5, maxShare: 0.05, nameBoost: 1.5,
    windowMs: 72 * HOUR, dfWindowMs: 96 * HOUR, maxMembers: 3, strength: 0.6, minWords: 4, minCommon: 2 } });
  assert.equal(edges.length, 0, 'two threads of 2 would make 4 > 3 members');
  assert.equal(mergeStories(graph, threads, { now: NOW }), 0);
  assert.notEqual(threadOf(threads, early[0]), threadOf(threads, late[0]));
});
