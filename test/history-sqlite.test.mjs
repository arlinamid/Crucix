import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryStore, SqliteHistoryStore, loadSqlite } from '../lib/intelligence/history.mjs';

const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const MINUTE = 60000, DAY = 86400000;
const id = n => `event-${n.toString(16).padStart(32, '0')}`;
const iso = ms => new Date(ms).toISOString();
function event(n, overrides = {}) {
  return {
    id: id(n), kind: 'news', title: `Árvíz Mexikóban ${n}`, summary: 'Public summary',
    source: { name: 'Example News', url: `https://www.news.example/articles/${n}`, status: 'ok' },
    publishedAt: '2026-10-14T08:00:00.000Z', collectedAt: iso(NOW),
    location: { lat: 19.4, lon: -99.1, method: 'provider', label: 'Mexico City', precision: 'city' }, severity: 'high', ...overrides,
  };
}
const skip = !loadSqlite() && 'node:sqlite is not available in this runtime';
function store(t, clock) {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-history-sqlite-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, history: new HistoryStore(dir, { now: () => clock.now }) };
}

test('the default store is SQLite: new records, records seen again and merges by URL write only what changed', { skip }, t => {
  const clock = { now: NOW };
  const { dir, history } = store(t, clock);
  assert.ok(history instanceof SqliteHistoryStore); assert.equal(history.engine, 'sqlite');
  assert.deepEqual(history.add([event(1), event(2)]), { added: 2, updated: 0, ignored: 0, total: 2 });
  clock.now += 15 * MINUTE;
  assert.deepEqual(history.add([event(1, { collectedAt: iso(clock.now) })]), { added: 0, updated: 1, ignored: 0, total: 2 });
  const one = history.get(id(1));
  assert.equal(one.firstSeenAt, iso(NOW)); assert.equal(one.lastSeenAt, iso(clock.now), 'seen again: only last_seen moves');
  assert.equal(one.collectedAt, iso(clock.now), 'and the collection time with it');
  // The same article under a new id merges into the earlier record (the canonical identity is the earliest first sighting).
  history.add([event(3, { source: { name: 'Example News', url: 'https://news.example/articles/2', status: 'ok' }, title: 'Updated title', collectedAt: iso(clock.now) })]);
  assert.equal(history.get(id(3)), null);
  assert.equal(history.get(id(2)).title, 'Updated title');
  assert.equal(history.query().total, 2);
  // A restart reads the same database.
  const restarted = new HistoryStore(dir, { now: () => clock.now });
  assert.equal(restarted.get(id(2)).title, 'Updated title');
  assert.ok(existsSync(join(dir, 'intelligence', 'history.db')));
});

test('queries run in SQL: accent-free text, source, kind, date range, paging and the stats', { skip }, t => {
  const clock = { now: NOW };
  const { history } = store(t, clock);
  history.add([event(1), event(2, { kind: 'osint', source: { name: 'Bellingcat', url: 'https://bellingcat.com/x', status: 'ok' } })]);
  clock.now += DAY;
  history.add([event(3, { title: 'Election in Brazil', collectedAt: iso(clock.now) })]);
  assert.equal(history.query({ q: 'arviz mexikoban' }).total, 2, 'folded text matches without accents');
  assert.equal(history.query({ source: 'bellingcat' }).total, 1);
  assert.equal(history.query({ kind: 'osint' }).total, 1);
  assert.equal(history.query({ from: '2026-10-15' }).total, 1);
  assert.equal(history.query({ to: '2026-10-14' }).total, 2);
  const page = history.query({ limit: 1, offset: 1 });
  assert.equal(page.items.length, 1); assert.equal(page.total, 3);
  assert.deepEqual(page.stats.days, [{ date: '2026-10-14', count: 2 }, { date: '2026-10-15', count: 1 }]);
  assert.deepEqual(page.stats.firstSeenDays, [{ date: '2026-10-14', count: 2 }, { date: '2026-10-15', count: 1 }]);
  assert.deepEqual({ ...page.stats.byKind }, { news: 2, osint: 1 });
  assert.equal(page.stats.totalRecords, 3); assert.equal(page.stats.engine, 'sqlite'); assert.equal(page.stats.retentionDays, 30);
  assert.equal(history.query({ offset: 900000 }).items.length, 0, 'beyond the old 10,000-record cap is a valid offset');
  assert.throws(() => history.query({ kind: 'nope' }), error => error.status === 400);
  const many = history.getMany([id(3), 'bad', id(1), id(99), id(1)]);
  assert.deepEqual([...many.keys()], [id(3), id(1)]);
});

test('retention is by days, not by a total record count; prune and the backup run for the background maintenance', { skip }, async t => {
  const clock = { now: NOW };
  const { dir, history } = store(t, clock);
  history.add(Array.from({ length: 12000 }, (_, n) => event(n + 1)));
  assert.equal(history.query().total, 12000, 'more than the JSON store\'s 10,000 records');
  clock.now += 29 * DAY;
  history.add([event(20000, { collectedAt: iso(clock.now) })]);
  assert.equal(history.prune(), 0);
  clock.now += 2 * DAY;
  assert.equal(history.query().total, 1, 'records past 30 days are no longer served');
  assert.equal(history.prune(), 12000);
  assert.equal(await history.backup(), true);
  assert.ok(existsSync(join(dir, 'intelligence', 'history.db.bak')));
});

test('an older history.json moves into the database once and is kept as .migrated', { skip }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-history-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'intelligence'), { recursive: true });
  const old = { ...event(7), firstSeenAt: '2026-10-12T00:00:00.000Z', lastSeenAt: '2026-10-13T00:00:00.000Z', collectedAt: '2026-10-12T00:00:00.000Z' };
  writeFileSync(join(dir, 'intelligence', 'history.json'), JSON.stringify({ version: 1, records: [old, { id: 'garbage' }] }));
  writeFileSync(join(dir, 'intelligence', 'history.json.bak'), JSON.stringify({ version: 1, records: [old] }));
  const history = new HistoryStore(dir, { now: () => NOW });
  const record = history.get(id(7));
  assert.equal(record.firstSeenAt, '2026-10-12T00:00:00.000Z'); assert.equal(record.lastSeenAt, '2026-10-13T00:00:00.000Z');
  assert.deepEqual(readdirSync(join(dir, 'intelligence')).filter(name => name.startsWith('history.json')).sort(), ['history.json.bak.migrated', 'history.json.migrated']);
  assert.equal(new HistoryStore(dir, { now: () => NOW }).query().total, 1, 'not migrated twice');
});

test('a corrupt database is replaced by its backup', { skip }, async t => {
  const clock = { now: NOW };
  const { dir, history } = store(t, clock);
  history.add([event(1)]);
  await history.backup();
  writeFileSync(join(dir, 'intelligence', 'history.db'), 'this is not a database at all, just text that is long enough to be read as a header');
  const restored = new HistoryStore(dir, { now: () => clock.now });
  assert.equal(restored.get(id(1)).title, 'Árvíz Mexikóban 1');
  assert.ok(readdirSync(join(dir, 'intelligence')).some(name => name.startsWith('history.db.corrupt-')));
});

test('engine: json keeps the JSON-file store', t => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-history-json-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const history = new HistoryStore(dir, { engine: 'json', now: () => NOW });
  assert.equal(history.engine, 'json');
  history.add([event(1)]);
  assert.ok(existsSync(join(dir, 'intelligence', 'history.json')));
});

test('the CLI reads the history from the SQLite database when there is one', { skip }, async t => {
  const { runCli } = await import('./helpers/run-cli.mjs');
  const workdir = mkdtempSync(join(tmpdir(), 'crucix-history-cli-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const runsDir = join(workdir, 'runs');
  const now = Date.now();
  const history = new HistoryStore(runsDir, { now: () => now });
  history.add([event(1, { title: 'Stored in SQLite', collectedAt: iso(now) })]);
  const { code, stdout } = await runCli(['--history', '--no-server', '--json'], { workdir, runsDir });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout).map(row => row.title), ['Stored in SQLite']);
});
