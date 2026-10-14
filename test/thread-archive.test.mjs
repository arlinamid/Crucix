import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { HistoryStore } from '../lib/intelligence/history.mjs';
import { GraphStore } from '../lib/intelligence/graph.mjs';
import { ThreadStore } from '../lib/intelligence/threads.mjs';
import { ThreadArchive, backfillGraph } from '../lib/intelligence/thread-archive.mjs';
import { Maintenance } from '../lib/maintenance.mjs';
import { installRiskRoutes } from '../lib/intelligence/risk-routes.mjs';
import { EntityStore } from '../lib/intelligence/entities.mjs';

const HOUR = 3600000, DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const quiet = { log() {}, warn() {}, error() {} };
const iso = ms => new Date(ms).toISOString();
let serial = 0;
// A news report as a sweep stores it: the same story from several outlets has alike titles.
function report(title, outlet, at, extra = {}) {
  serial++;
  return {
    id: `event-${serial.toString(16).padStart(32, '0')}`, kind: 'news', title, summary: '',
    source: { name: outlet, url: `https://${outlet}/story/${serial}`, status: 'ok' },
    publishedAt: iso(at - 10 * 60000), collectedAt: iso(at), location: {}, severity: 'monitor', ...extra,
  };
}
const story = (at, title = 'Magnitude 7 earthquake strikes northern Chile, tsunami warning issued for Antofagasta coast') =>
  ['reuters.com', 'apnews.com', 'bbc.co.uk'].map((outlet, n) => report(n ? `${title} - ${outlet}` : title, outlet, at + n * 20 * 60000));

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-archive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// The history store records its writes at the clock's time: add each batch at its own moment.
function historyAt(dir, batches) {
  const clock = { now: NOW };
  const history = new HistoryStore(dir, { now: () => clock.now });
  for (const events of batches) { clock.now = Date.parse(events[0].collectedAt); history.add(events.map(event => ({ ...event, collectedAt: iso(clock.now) }))); }
  clock.now = NOW;
  return history;
}

test('maintenance: one job at a time, a job queued twice runs once with its newest function, a failure is recorded and the next job runs', async () => {
  const maintenance = new Maintenance({ log: quiet, sliceMs: 0 });
  const order = [];
  let concurrent = 0, peak = 0;
  const job = name => async ctx => { concurrent++; peak = Math.max(peak, concurrent); order.push(name); await ctx.slice(); await ctx.slice(); concurrent--; };
  assert.equal(maintenance.schedule('a', job('a-old')), true);
  assert.equal(maintenance.schedule('a', job('a')), false, 'already queued');
  maintenance.schedule('boom', async () => { throw new Error('disk full'); });
  maintenance.schedule('b', job('b'));
  await maintenance.drain();
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(peak, 1);
  const status = maintenance.status();
  assert.equal(status.runs, 3); assert.equal(status.running, null); assert.deepEqual(status.queued, []);
  assert.equal(status.lastError.name, 'boom'); assert.equal(status.lastError.error, 'disk full');
  assert.equal(status.jobs.b.ok, true);
});

test('maintenance: a slice yields to the event loop, so a request waiting meanwhile is served before the job ends', async () => {
  const maintenance = new Maintenance({ log: quiet, sliceMs: 0 });
  const events = [];
  maintenance.schedule('long', async ctx => { for (let i = 0; i < 3; i++) { events.push(`work ${i}`); await ctx.slice(); } });
  setImmediate(() => events.push('request'));
  await maintenance.drain();
  assert.ok(events.indexOf('request') < events.indexOf('work 2'), events.join(', '));
});

test('graph: a record keeps the time it was first seen, and the observation start moves back with it', t => {
  const dir = setup(t);
  const graph = new GraphStore(dir, { now: () => NOW });
  const record = { id: 'event-' + 'a'.repeat(32), kind: 'news', level: 'watch', source: 'x', title: 'Election', tokens: ['election'], entities: [{ id: 'country:CHL', rel: 'mentions', s: 0.5 }], point: null, observed: null };
  graph.ingest([{ ...record, time: NOW - 2 * DAY }], { now: NOW });
  assert.equal(graph.get(record.id).time, NOW - 2 * DAY);
  assert.equal(graph.since, NOW - 2 * DAY);
});

test('backfill: history records of the thread window that the graph never saw are added in time order and linked into threads', async t => {
  const dir = setup(t);
  const history = historyAt(dir, story(NOW - 2 * DAY).map(event => [event]));
  const graph = new GraphStore(dir, { now: () => NOW });
  const added = await backfillGraph(graph, history, { now: NOW });
  assert.equal(added, 3);
  assert.ok([...graph.edges.keys()].some(key => key.endsWith('|same-story')), 'the reports two days ago link although the graph links at their own time');
  const threads = new ThreadStore(dir, { now: () => NOW });
  const list = threads.compute(graph, { now: NOW });
  assert.equal(list.length, 1); assert.equal(list[0].memberCount, 3);
  assert.equal(await backfillGraph(graph, history, { now: NOW }), 0, 'a second run adds nothing');
});

test('archive: a finished day\'s threads are computed once, listed newest first without the live ones, and readable by id', async t => {
  const dir = setup(t);
  const day1 = NOW - 6 * DAY, day2 = NOW - 5 * DAY;
  const history = historyAt(dir, [...story(day1).map(event => [event]), ...story(day2, 'Parliament votes to dissolve government in snap election after coalition collapse').map(event => [event])]);
  const archive = new ThreadArchive(dir, { now: () => NOW });
  const pending = archive.pendingDays(history);
  assert.ok(pending.includes(iso(day1).slice(0, 10)) && pending.includes(iso(day2).slice(0, 10)), pending.join(','));
  for (const day of pending) await archive.computeDay(day, history);
  assert.deepEqual(archive.pendingDays(history), [], 'each day once');
  const list = archive.list();
  assert.equal(list.total, 2);
  assert.equal(list.threads[0].day, iso(day2).slice(0, 10), 'newest day first');
  assert.equal(list.threads[0].memberCount, 3);
  const thread = archive.get(list.threads[1].id);
  assert.equal(thread.events.length, 3); assert.match(thread.events[0].title, /earthquake/i);
  assert.equal(archive.list({ liveIds: new Set([list.threads[0].id]) }).total, 1, 'a thread still live is not listed as past');
  assert.equal(archive.list({ topic: 'politics' }).threads.every(row => row.topic === 'politics'), true);
  const later = new ThreadArchive(dir, { now: () => NOW + 40 * DAY });
  assert.equal(later.prune(), 3, 'the two days with threads and the one without (its empty file keeps it from being computed again)');
  assert.deepEqual(readdirSync(join(dir, 'intelligence', 'threads-archive')).filter(name => name.endsWith('.json')), []);
});

async function serve(t, options) {
  const app = express();
  installRiskRoutes(app, { store: new EntityStore(options.dir), security: { allowedHosts: ['127.0.0.1'] }, ...options });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  return path => fetch(`http://127.0.0.1:${server.address().port}${path}`).then(async res => ({ status: res.status, body: await res.json() }));
}

test('routes: every current thread pages by topic, the past threads list, an archived thread opens by id', async t => {
  const dir = setup(t);
  const history = historyAt(dir, [...story(NOW - 6 * DAY).map(event => [event]), ...story(NOW - DAY, 'Ransomware attack shuts down hospital systems across three states, FBI investigating').map(event => [event])]);
  const graph = new GraphStore(dir, { now: () => NOW });
  await backfillGraph(graph, history, { now: NOW });
  const threads = new ThreadStore(dir, { now: () => NOW });
  threads.compute(graph, { now: NOW });
  const archive = new ThreadArchive(dir, { now: () => NOW });
  for (const day of archive.pendingDays(history)) await archive.computeDay(day, history);
  const get = await serve(t, { dir, history, graph, threads, archive });
  const current = await get('/api/threads?limit=1&offset=0');
  assert.equal(current.status, 200); assert.equal(current.body.total, 1); assert.equal(current.body.threads.length, 1);
  assert.equal((await get('/api/threads?topic=health')).body.total, 0);
  for (const bad of ['/api/threads?topic=nope', '/api/threads?limit=0', '/api/threads?limit=201', '/api/threads?x=1', '/api/threads/archive?from=yesterday']) assert.equal((await get(bad)).status, 400, bad);
  const past = await get('/api/threads/archive');
  assert.equal(past.status, 200); assert.equal(past.body.total, 1);
  assert.equal(past.body.threads[0].events, undefined, 'the list leaves the events out');
  const detail = await get('/api/threads/' + past.body.threads[0].id);
  assert.equal(detail.status, 200); assert.equal(detail.body.archived, true); assert.equal(detail.body.events.length, 3);
  assert.equal((await get('/api/threads/thread-0000000000000000')).status, 404);
});

test('panel: the topic chips count every thread from the summary, and "Show all" offers them on a live page', () => {
  const window = { localStorage: null };
  const document = { addEventListener() {}, getElementById() { return null; } };
  vm.runInNewContext(readFileSync(new URL('../dashboard/public/threads.js', import.meta.url), 'utf8'), { window, document, console });
  const threads = window.CrucixThreads;
  threads.mount({ t: (key, fallback) => fallback, fetchJson: async () => ({}), getThreads: () => null });
  const row = (n, topic) => ({ id: `thread-${n.toString(16).padStart(16, '0')}`, title: `T${n}`, status: 'active', first: '2026-10-20T10:00:00Z', last: '2026-10-20T11:00:00Z', memberCount: 3, sources: 3, topic, countries: [], entities: [], kinds: ['news'] });
  const html = threads.panelHtml({ at: '2026-10-20T12:00:00Z', count: 79, topicCounts: { conflict: 6, disaster: 16 }, top: [row(1, 'conflict'), row(2, 'disaster')] }, { replay: false });
  assert.match(html, /data-thread-topic="conflict"[^>]*>Conflict <span class="th-n">6<\/span>/);
  assert.match(html, /data-thread-topic="disaster"[^>]*>Disaster <span class="th-n">16<\/span>/);
  assert.match(html, /data-thread-more="all"[^>]*>Show all \(79\)/);
  assert.match(html, /data-thread-view="past"/);
});
