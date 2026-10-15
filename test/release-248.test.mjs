// 2.48: the model ideas after the sweep, gzip, lean SSE updates, the file log and the sweep step timings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { IdeaCadence } from '../lib/llm/cadence.mjs';
import { compactSweepForLLM } from '../lib/llm/ideas.mjs';
import { compressResponses, staticGzip } from '../lib/http-compress.mjs';
import { broadcastEvent } from '../lib/sse.mjs';
import { installFileLog, SweepTimings } from '../lib/logger.mjs';

const idea = n => ({ title: `Generated idea ${n}`, type: 'WATCH', confidence: 'LOW', horizon: 'Days', rationale: 'A source-grounded observation.' });

test('ideas: the sweep publishes rule ideas at once, the model runs after it and its ideas are kept for the next sweeps', async () => {
  let calls = 0;
  const provider = { isConfigured: true, name: 'test', async complete() { calls++; return { text: JSON.stringify([idea(calls)]) }; } };
  const cadence = new IdeaCadence({ everyNSweeps: 4, now: () => Date.UTC(2026, 9, 15) });
  assert.equal(cadence.due(), true, 'the first sweep is due');
  const now = await cadence.current({ fred: [{ id: 'VIXCLS', value: 30 }] });
  assert.equal(now.ideasSource, 'rules'); assert.equal(calls, 0, 'no model call while publishing');
  const fresh = await cadence.generate(provider, { fred: [] });
  assert.equal(fresh.ideasSource, 'llm'); assert.equal(fresh.ideas[0].title, 'Generated idea 1');
  assert.equal(cadence.lastRun.parsed, 1); assert.ok(cadence.lastRun.promptChars > 100); assert.ok(Number.isFinite(cadence.lastRun.ms));
  assert.deepEqual([cadence.due(), cadence.due(), cadence.due()], [false, false, true], 'then every 4th sweep');
  const later = await cadence.current({});
  assert.equal(later.ideasSource, 'llm'); assert.equal(later.ideasCached, true);
  const failing = { isConfigured: true, name: 'test', async complete() { throw new Error('timed out'); } };
  assert.equal(await cadence.generate(failing, {}), null, 'a failed run keeps the published ideas');
  assert.match(cadence.lastRun.error, /timed out/);
  assert.equal((await cadence.current({})).ideas[0].title, 'Generated idea 1');
});

test('ideas: the model sees the story threads, the country risk movers, the conflict reports and the air alerts', () => {
  const text = compactSweepForLLM({
    threads: { topicCounts: { conflict: 3 }, top: [{ status: 'active', topic: 'economy', title: 'Oil rises', memberCount: 4, sources: 3, countries: [{ iso3: 'SAU' }] },
      { status: 'escalating', topic: 'conflict', title: 'Houthis strike Aramco', memberCount: 9, sources: 6, countries: [{ iso3: 'SAU' }, { iso3: 'YEM' }] }] },
    risk: { top: [{ name: 'Saudi Arabia', score: 61, change24h: 7 }, { name: 'Peru', score: 20, change24h: 0 }], conflict: { top: [{ name: 'Yemen', stories: 12, usual: 4, escalation: 2.5 }] } },
    airAlerts: [{ squawk: '7700', callsign: 'BRO179P', country: 'United Kingdom' }], airNotable: [{ kind: 'military' }, { kind: 'high' }],
  });
  assert.match(text, /STORY_THREADS[\s\S]*\[escalating\/conflict\] Houthis strike Aramco \(9 records, 6 sources, SAU\/YEM\)[\s\S]*\[active\/economy\] Oil rises/, 'escalating first');
  assert.match(text, /THREAD_TOPICS: conflict=3/);
  assert.match(text, /COUNTRY_RISK_MOVERS_24H: Saudi Arabia 61 \(\+7\)/); assert.doesNotMatch(text, /Peru/);
  assert.match(text, /ARMED_CONFLICT_REPORTS: Yemen: 12 stories today vs 4 usual, escalation 2\.5/);
  assert.match(text, /AIR_ALERTS: 1 emergency squawks \(7700 BRO179P United Kingdom\); 1 military-pattern callsigns airborne/);
});

async function serve(t, app) {
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  return (path, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers });
}

test('gzip: large JSON and HTML go out gzipped to a client that accepts it, once per identical body; small ones and others as they are', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-gzip-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'app.js'), 'const x = 1;\n'.repeat(2000));
  writeFileSync(join(dir, 'tiny.js'), 'x');
  const app = express();
  app.use(compressResponses());
  app.use(staticGzip(dir));
  app.use(express.static(dir));
  const big = { rows: Array.from({ length: 20000 }, (_, n) => ({ n, text: 'snapshot row' })) };
  app.get('/api/data', (req, res) => res.json(big));
  app.get('/small', (req, res) => res.json({ ok: true }));
  app.get('/page', (req, res) => res.send('<html>' + 'x'.repeat(10000) + '</html>'));
  const get = await serve(t, app);
  // fetch decompresses; read the raw headers through a gzip-only request and Node's own inflate check.
  const data = await get('/api/data', { 'accept-encoding': 'gzip' });
  assert.equal(data.headers.get('content-encoding'), 'gzip'); assert.equal(data.headers.get('vary'), 'Accept-Encoding');
  assert.deepEqual((await data.json()).rows.length, 20000);
  assert.equal((await get('/api/data', { 'accept-encoding': 'identity' })).headers.get('content-encoding'), null);
  assert.equal((await get('/small', { 'accept-encoding': 'gzip' })).headers.get('content-encoding'), null, 'under 4 KB');
  const page = await get('/page', { 'accept-encoding': 'gzip' });
  assert.equal(page.headers.get('content-encoding'), 'gzip'); assert.match(page.headers.get('content-type'), /text\/html/);
  const script = await get('/app.js', { 'accept-encoding': 'gzip' });
  assert.equal(script.headers.get('content-encoding'), 'gzip'); assert.match(script.headers.get('content-type'), /javascript/);
  assert.equal((await script.text()).length, 'const x = 1;\n'.length * 2000);
  const again = await get('/app.js', { 'accept-encoding': 'gzip', 'if-modified-since': script.headers.get('last-modified') });
  assert.equal(again.status, 304);
  assert.equal((await get('/tiny.js', { 'accept-encoding': 'gzip' })).headers.get('content-encoding'), null);
  assert.equal((await get('/../package.json', { 'accept-encoding': 'gzip' })).status, 404, 'no way out of the folder');
});

test('sse: a lean client gets the update without the snapshot, a classic client the documented full message', () => {
  const out = new Map();
  const client = lean => { const c = { crucixLean: lean, destroyed: false, writableEnded: false, writableLength: 0, write(chunk) { out.set(c, chunk); } }; return c; };
  const lean = client(true), full = client(false);
  const clients = new Set([lean, full]);
  broadcastEvent(clients, { type: 'update', data: { meta: { timestamp: '2026-10-15T10:00:00Z' }, big: 'x'.repeat(1000) } });
  assert.deepEqual(JSON.parse(out.get(lean).slice(6)), { type: 'update', lean: true, at: '2026-10-15T10:00:00Z' });
  assert.equal(JSON.parse(out.get(full).slice(6)).data.big.length, 1000);
  broadcastEvent(clients, { type: 'ideas', data: { ideas: [] } });
  assert.equal(JSON.parse(out.get(lean).slice(6)).type, 'ideas', 'other messages are the same for both');
});

test('log: the console goes to a daily file too, the last warnings are kept, old days go', t => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'logs'));
  writeFileSync(join(dir, 'logs', 'crucix-2026-09-01.log'), 'old');
  const lines = [];
  const target = { log: (...a) => lines.push(a.join(' ')), info: () => {}, warn: (...a) => lines.push(a.join(' ')), error: () => {} };
  const log = installFileLog(dir, { now: () => Date.parse('2026-10-15T10:00:00Z'), target, maxBytesPerDay: 400 });
  target.log('[Crucix] Post-processing (ms): %s', 'save 23');
  target.warn('\u001b[33m[Maintenance] slow\u001b[0m');
  for (let i = 0; i < 20; i++) target.log('filler line number', i);
  assert.equal(lines.length, 22, 'the console still prints');
  assert.deepEqual(log.recent().map(row => row.text), ['[Maintenance] slow']);
  log.close();
  return new Promise(resolve => setTimeout(() => {
    const names = readdirSync(join(dir, 'logs'));
    assert.deepEqual(names, ['crucix-2026-10-15.log'], 'the 2026-09-01 file is past 14 days');
    const text = readFileSync(join(dir, 'logs', 'crucix-2026-10-15.log'), 'utf8');
    assert.match(text, /^2026-10-15T10:00:00\.000Z INFO  \[Crucix\] Post-processing \(ms\): save 23$/m);
    assert.match(text, /WARN  \[Maintenance\] slow/); assert.doesNotMatch(text, /\u001b/);
    assert.match(text, /400 bytes reached/); assert.doesNotMatch(text, /number 19/);
    resolve();
  }, 50));
});

test('sweep timings: the last sweep and the median and p95 per step over the window', () => {
  let now = 0;
  const timings = new SweepTimings({ windowMs: 1000, now: () => now });
  assert.deepEqual(timings.summary(), { count: 0, last: null, p50: null, p95: null });
  for (const ms of [100, 200, 300, 400]) { now += 100; timings.add({ 'events+history': ms, risk: ms / 2 }); }
  const summary = timings.summary();
  assert.equal(summary.count, 4); assert.equal(summary.last['events+history'], 400);
  assert.equal(summary.p50['events+history'], 300); assert.equal(summary.p95.risk, 200);
  now += 2000; timings.add({ risk: 1 });
  assert.equal(timings.summary().count, 1, 'older runs leave the window');
  assert.ok(gunzipSync);
});
