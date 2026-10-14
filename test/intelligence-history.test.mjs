import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const module = await import('../lib/intelligence/history.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const id = n => `event-${n.toString(16).padStart(32, '0')}`;
function event(n, overrides = {}) {
  return {
    id: id(n), kind: 'news', title: `Article ${n}`, summary: 'Public summary',
    source: { name: 'Example News', url: `https://news.example/articles/${n}`, hostname: 'news.example', status: 'ok' },
    observedAt: null, publishedAt: '2026-09-30T08:00:00.000Z', collectedAt: '2026-10-01T11:00:00.000Z',
    location: { lat: 47.5, lon: 19, method: 'provider', label: 'Budapest', precision: 'city' },
    severity: 'monitor', quality: { level: 'partial', checks: { sourceUrl: true, providerTime: true, location: true, sourceStatus: true }, explanationCodes: [] },
    relatedSources: [], ...overrides,
  };
}
function store(t, options = {}) {
  assert.equal(typeof module.HistoryStore, 'function', 'HistoryStore is implemented');
  const dir = mkdtempSync(join(tmpdir(), 'crucix-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // This file tests the JSON-file store (history.json and its .bak); test/history-sqlite.test.mjs tests the SQLite store.
  return { dir, history: new module.HistoryStore(dir, { now: () => NOW, engine: 'json', ...options }) };
}

test('history survives restart and leaves raw and archived files untouched', t => {
  const { dir, history } = store(t);
  mkdirSync(join(dir, 'archive'));
  writeFileSync(join(dir, 'archive', 'operator.json'), '{"private":"keep"}');
  writeFileSync(join(dir, 'raw.json'), '{"raw":"keep"}');
  history.add([event(1)]);
  const restarted = new module.HistoryStore(dir, { engine: 'json', now: () => NOW });
  assert.equal(restarted.get(id(1)).title, 'Article 1');
  assert.equal(restarted.get(id(1)).firstSeenAt, '2026-10-01T11:00:00.000Z');
  assert.equal(restarted.get(id(1)).lastSeenAt, '2026-10-01T11:00:00.000Z');
  assert.equal(restarted.get(id(1)).observedAt, null);
  assert.equal(readFileSync(join(dir, 'raw.json'), 'utf8'), '{"raw":"keep"}');
  assert.equal(readFileSync(join(dir, 'archive', 'operator.json'), 'utf8'), '{"private":"keep"}');
});

test('duplicate sweeps preserve first collection and ignore older title and time updates', t => {
  const { history } = store(t);
  history.add([event(1, { collectedAt: '2026-09-29T10:00:00.000Z' })]);
  history.add([event(1, { title: 'Current', collectedAt: '2026-10-01T10:00:00.000Z' })]);
  history.add([event(1, { title: 'Stale', collectedAt: '2026-09-28T10:00:00.000Z' })]);
  const record = history.get(id(1));
  assert.equal(record.title, 'Current');
  assert.equal(record.firstSeenAt, '2026-09-29T10:00:00.000Z');
  assert.equal(record.lastSeenAt, '2026-10-01T10:00:00.000Z');
  assert.equal(record.collectedAt, '2026-10-01T10:00:00.000Z');
  assert.equal(history.query().total, 1);
});

test('same kind and original URL updates preserve the initial event identity', t => {
  const { history } = store(t);
  history.add([event(1)]);
  history.add([event(2, { title: 'Revised', collectedAt: '2026-10-01T12:00:00.000Z', source: event(1).source })]);
  assert.equal(history.query().total, 1);
  assert.equal(history.get(id(1)).title, 'Revised');
});

test('event IDs require exactly 32 hexadecimal characters in storage and related references', t => {
  const { history } = store(t);
  assert.equal(typeof module.isEventId, 'function', 'public event ID validator is available');
  for (const invalid of ['event-' + 'a'.repeat(16), 'event-' + 'b'.repeat(64), 'event-' + 'A'.repeat(32), 'event-' + 'a'.repeat(31), 'event-' + 'a'.repeat(33), ['event-' + 'a'.repeat(32)], null]) assert.equal(module.isEventId(invalid), false);
  assert.equal(module.isEventId(id(1)), true);
  history.add([event(1), event(2, { id: 'event-' + 'a'.repeat(16) }), event(3, { id: 'event-' + 'b'.repeat(64) }), event(4, { relatedSources: [{ eventId: 'event-' + 'c'.repeat(16), name: 'Bad ID', url: 'https://other.example/item' }] })]);
  assert.equal(history.query().total, 2);
  assert.equal(history.get(id(4)).relatedSources.length, 0);
});

test('ID and URL collisions coalesce with earliest identity and newest content across restart', t => {
  const { dir, history } = store(t);
  history.add([
    event(1, { title: 'Initial A', collectedAt: '2026-09-28T10:00:00.000Z' }),
    event(2, { title: 'Initial B', collectedAt: '2026-09-29T10:00:00.000Z' }),
  ]);
  history.add([event(1, { title: 'Updated A at B URL', source: event(2).source, collectedAt: '2026-10-01T10:00:00.000Z' })]);
  assert.equal(history.query().total, 1, 'one canonical original source URL remains');
  const record = history.query().items[0];
  assert.equal(record.id, id(1));
  assert.equal(record.firstSeenAt, '2026-09-28T10:00:00.000Z');
  assert.equal(record.lastSeenAt, '2026-10-01T10:00:00.000Z');
  assert.equal(record.title, 'Updated A at B URL');
  assert.equal(record.source.url, event(2).source.url);
  const restarted = new module.HistoryStore(dir, { engine: 'json', now: () => NOW });
  assert.equal(restarted.query().total, 1);
  assert.deepEqual(restarted.get(id(1)), record);
  restarted.add([event(2, { title: 'Stale B', collectedAt: '2026-09-30T10:00:00.000Z' })]);
  assert.equal(restarted.query().total, 1);
  assert.equal(restarted.get(id(1)).title, 'Updated A at B URL');
  assert.equal(restarted.get(id(1)).lastSeenAt, '2026-10-01T10:00:00.000Z');
});

test('URL collision keeps newer existing content and earliest identity regardless of incoming ID', t => {
  const { dir, history } = store(t);
  history.add([
    event(2, { title: 'First identity B', collectedAt: '2026-09-27T10:00:00.000Z' }),
    event(1, { title: 'A old', collectedAt: '2026-09-28T10:00:00.000Z' }),
  ]);
  history.add([event(2, { title: 'Newest B', collectedAt: '2026-10-01T11:00:00.000Z' })]);
  history.add([event(1, { title: 'Intermediate A', source: event(2).source, collectedAt: '2026-10-01T10:00:00.000Z' })]);
  assert.equal(history.query().total, 1);
  const record = history.query().items[0];
  assert.equal(record.id, id(2));
  assert.equal(record.title, 'Newest B');
  assert.equal(record.firstSeenAt, '2026-09-27T10:00:00.000Z');
  assert.equal(record.lastSeenAt, '2026-10-01T11:00:00.000Z');
  assert.equal(new module.HistoryStore(dir, { engine: 'json', now: () => NOW }).get(id(2)).title, 'Newest B');
});

test('an older ID update cannot merge current unrelated source URLs', t => {
  const { history } = store(t);
  history.add([event(1), event(2)]);
  history.add([event(1, { title: 'Stale URL change', source: event(2).source, collectedAt: '2026-09-29T10:00:00.000Z' })]);
  assert.equal(history.query().total, 2);
  assert.equal(history.get(id(1)).source.url, event(1).source.url);
  assert.equal(history.get(id(1)).title, 'Article 1');
});

test('source links preserve their original fragment while fragment changes cannot duplicate history', t => {
  const { history } = store(t);
  history.add([event(1, { source: { ...event(1).source, url: 'https://news.example/report#original' } })]);
  assert.equal(history.get(id(1)).source.url, 'https://news.example/report#original');
  history.add([event(2, { source: { ...event(2).source, url: 'https://news.example/report#updated' } })]);
  assert.equal(history.query().total, 1);
  assert.equal(history.get(id(1)).source.url, 'https://news.example/report#updated');
});

test('traceability level is recomputed after malicious links and coordinates are rejected', t => {
  const { history } = store(t);
  history.add([event(1, { observedAt: null, publishedAt: null, source: { name: 'Unknown', url: 'javascript:evil()', status: 'unknown' }, location: { lat: NaN, lon: 300 }, quality: { level: 'complete', checks: { sourceUrl: true, providerTime: true, location: true, sourceStatus: true }, explanationCodes: [] } })]);
  assert.equal(history.get(id(1)).quality.level, 'minimal');
  assert.deepEqual(history.get(id(1)).quality.checks, { sourceUrl: false, providerTime: false, location: false, sourceStatus: false });
});

test('query and get expire records when the injected clock advances without another sweep', t => {
  let clock = NOW;
  const { dir, history } = store(t, { now: () => clock });
  history.add([event(1)]);
  clock += 31 * 86400000;
  assert.equal(history.get(id(1)), null);
  assert.equal(history.query().total, 0);
  assert.equal(new module.HistoryStore(dir, { now: () => clock }).query().total, 0);
});

test('default record cap applies to valid oversized loaded data', t => {
  const { dir } = store(t);
  writeFileSync(join(dir, 'intelligence', 'history.json'), JSON.stringify({ version: 1, records: Array.from({ length: 10003 }, (_, n) => event(n + 1)) }));
  const history = new module.HistoryStore(dir, { engine: 'json', now: () => NOW });
  assert.equal(history.query().total, 10000);
  assert.ok(statSync(join(dir, 'intelligence', 'history.json')).size <= 20 * 1024 * 1024);
});

test('invalid or forged collection times cannot gain indefinite retention', t => {
  const { history } = store(t);
  history.add([event(1, { collectedAt: 'invalid' }), event(2, { collectedAt: '2027-01-01T00:00:00Z' }), event(3, { collectedAt: '2026-02-30T12:00:00Z' })]);
  assert.equal(history.query().total, 0);
});

test('retention uses last collection, independent of old provider publication time', t => {
  const { history } = store(t);
  history.add([
    event(1, { collectedAt: '2026-08-31T12:00:00.000Z' }),
    event(2, { publishedAt: '2020-01-01T00:00:00.000Z' }),
    event(3, { collectedAt: '2026-09-01T12:00:00.000Z' }),
  ]);
  assert.deepEqual(history.query().items.map(item => item.id), [id(2), id(3)]);
});

test('record and byte caps evict oldest records and the persisted journal remains valid', t => {
  const { dir, history } = store(t, { maxRecords: 2, maxBytes: 2400 });
  history.add([event(1, { collectedAt: '2026-09-28T10:00:00.000Z' }), event(2, { collectedAt: '2026-09-29T10:00:00.000Z' }), event(3)]);
  assert.equal(history.get(id(1)), null);
  assert.deepEqual(history.query().items.map(item => item.id), [id(3), id(2)]);
  assert.ok(statSync(join(dir, 'intelligence', 'history.json')).size <= 2400);
  JSON.parse(readFileSync(join(dir, 'intelligence', 'history.json'), 'utf8'));
  history.add([event(4, { summary: 'x'.repeat(100000) })]);
  assert.ok(statSync(join(dir, 'intelligence', 'history.json')).size <= 2400);
});

test('loaded over-cap journal is normalized and bounded before it becomes queryable', t => {
  const { dir } = store(t);
  const records = Array.from({ length: 7 }, (_, n) => event(n + 1));
  writeFileSync(join(dir, 'intelligence', 'history.json'), JSON.stringify({ version: 1, records }));
  const reloaded = new module.HistoryStore(dir, { engine: 'json', now: () => NOW, maxRecords: 2, maxBytes: 2200 });
  assert.ok(reloaded.query().total <= 2);
  assert.ok(statSync(join(dir, 'intelligence', 'history.json')).size <= 2200);
  assert.ok(reloaded.query().stats.retainedBytes <= 2200);
});

test('corrupt primary recovers the valid backup without copying corrupt bytes into it', t => {
  const { dir, history } = store(t);
  history.add([event(1)]);
  history.add([event(2)]);
  const path = join(dir, 'intelligence', 'history.json');
  const backup = `${path}.bak`;
  JSON.parse(readFileSync(backup, 'utf8'));
  writeFileSync(path, '{broken');
  const restarted = new module.HistoryStore(dir, { engine: 'json', now: () => NOW });
  assert.ok(restarted.get(id(1)));
  JSON.parse(readFileSync(path, 'utf8'));
  JSON.parse(readFileSync(backup, 'utf8'));
  assert.equal(readdirSync(join(dir, 'intelligence')).some(name => name.endsWith('.tmp')), false);
});

test('valid backup also recovers a semantically invalid primary', t => {
  const { dir, history } = store(t);
  history.add([event(1)]);
  writeFileSync(join(dir, 'intelligence', 'history.json'), JSON.stringify({ version: 1, records: 'not-an-array' }));
  const reloaded = new module.HistoryStore(dir, { engine: 'json', now: () => NOW });
  assert.equal(reloaded.get(id(1)).title, 'Article 1');
});

test('valid backup recovers a parsed journal containing no usable collection records', t => {
  const { dir, history } = store(t);
  history.add([event(1)]);
  writeFileSync(join(dir, 'intelligence', 'history.json'), JSON.stringify({ version: 1, records: [{ id: 'garbage', token: 'private' }] }));
  const reloaded = new module.HistoryStore(dir, { engine: 'json', now: () => NOW });
  assert.ok(reloaded.get(id(1)), 'valid backup record survives unusable primary data');
});

test('valid backup survives a primary containing only future collection records', t => {
  const { dir, history } = store(t);
  history.add([event(1)]);
  const path = join(dir, 'intelligence', 'history.json');
  writeFileSync(path, JSON.stringify({ version: 1, records: [event(2, { collectedAt: '2027-01-01T00:00:00.000Z' })] }));
  const reloaded = new module.HistoryStore(dir, { engine: 'json', now: () => NOW });
  assert.ok(reloaded.get(id(1)), 'valid backup record survives a future-only primary');
  assert.equal(reloaded.get(id(2)), null);
  const backup = JSON.parse(readFileSync(`${path}.bak`, 'utf8'));
  assert.ok(backup.records.some(record => record.id === id(1)), 'recovery never replaces a usable backup with an empty journal');
  assert.equal(new module.HistoryStore(dir, { engine: 'json', now: () => NOW }).get(id(1)).title, 'Article 1');
});

test('unknown location provenance cannot be upgraded during history normalization', t => {
  const { history } = store(t);
  history.add([event(1, { location: { lat: 47.5, lon: 19, method: 'unknown', label: 'Legacy position', precision: 'unknown' }, quality: { level: 'complete' } })]);
  const record = history.get(id(1));
  assert.equal(record.location.lat, 47.5);
  assert.equal(record.quality.checks.location, false);
  assert.equal(record.quality.level, 'partial');
  assert.ok(record.quality.explanationCodes.includes('unknown-location-method'));
});

test('storage allowlists fields, rejects unsafe links and isolates returned objects', t => {
  const { dir, history } = store(t);
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"raw":{"apiKey":"secret"},"token":"hidden"}');
  history.add([event(1, { ...hostile, title: 'x'.repeat(10000), source: { name: 'Public', url: 'https://user:secret@evil.example/', hostname: 'forged.example', status: 'ok', authorization: 'secret' }, location: { lat: 1000, lon: 19, method: 'provider', raw: 'secret' }, quality: { level: 'complete', checks: { sourceUrl: true, arbitrarySecret: 'secret' }, raw: 'secret' }, relatedSources: [{ eventId: id(2), name: 'Unsafe', url: 'javascript:alert(1)', token: 'secret' }] })]);
  const record = history.get(id(1));
  assert.ok(record.title.length <= 500);
  assert.equal(record.source.url, null);
  assert.equal(record.location.lat, null);
  assert.equal(record.relatedSources.length, 0);
  assert.equal({}.polluted, undefined);
  const serialized = readFileSync(join(dir, 'intelligence', 'history.json'), 'utf8');
  assert.equal(/secret|hidden|apiKey|authorization|__proto__/.test(serialized), false);
  record.source.name = 'Modified outside store';
  history.query().items[0].quality.checks.sourceUrl = 'changed';
  assert.equal(history.get(id(1)).source.name, 'Public');
  assert.equal(typeof history.get(id(1)).quality.checks.sourceUrl, 'boolean');
});

test('search is Unicode accent insensitive and treats regex metacharacters as literal text', t => {
  const { history } = store(t);
  history.add([event(1, { title: 'Árvíztűrő TÜKÖRFÚRÓGÉP (a+b)', source: { ...event(1).source, name: 'Északi Hírek' } }), event(2, { title: 'Different article' })]);
  assert.equal(history.query({ q: 'arvizturo tukorfurogep' }).total, 1);
  assert.equal(history.query({ q: '(a+b)' }).total, 1);
  assert.equal(history.query({ q: '.*' }).total, 0);
  assert.equal(history.query({ source: 'eszaki hirek' }).total, 1);
});

test('filters use collection dates inclusively and pagination and timeline reflect all matches', t => {
  const { history } = store(t);
  history.add([event(1, { collectedAt: '2026-09-29T10:00:00.000Z' }), event(2, { collectedAt: '2026-09-30T23:59:59.999Z' }), event(3, { kind: 'earthquake' })]);
  const page = history.query({ kind: 'news', from: '2026-09-29', to: '2026-09-30', limit: '1', offset: '1' });
  assert.equal(page.total, 2);
  assert.equal(page.limit, 1);
  assert.equal(page.offset, 1);
  assert.deepEqual(page.items.map(item => item.id), [id(1)]);
  assert.deepEqual(page.stats.timeline, [{ date: '2026-09-29', count: 1 }, { date: '2026-09-30', count: 1 }]);
  assert.equal(history.query().limit, 50);
  assert.equal(history.query({ offset: 9000 }).items.length, 0);
});

test('malformed query filters produce controlled validation errors', t => {
  const { history } = store(t);
  for (const filters of [
    { limit: 0 }, { limit: 201 }, { limit: '1e2' }, { offset: -1 }, { offset: 1_000_001 },
    { q: ['array'] }, { q: 'x'.repeat(301) }, { source: {} }, { kind: 'invalid-kind' },
    { from: '2026-02-30' }, { to: '10/01/2026' }, { from: '2026-10-01', to: '2026-09-01' },
    { from: '2026-10-01T12:00:00' }, { to: '2026-10-01T25:00:00Z' },
  ]) {
    assert.throws(() => history.query(filters), error => error.status === 400 && error.code === 'INVALID_FILTER');
  }
});
