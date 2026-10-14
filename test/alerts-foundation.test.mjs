import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as deltaEngine from '../lib/delta/engine.mjs';

const missing = error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
};
const atomic = await import('../lib/atomic-json.mjs').catch(missing);
const levels = await import('../lib/alerts/levels.mjs').catch(missing);
const metrics = await import('../lib/alerts/metrics.mjs').catch(missing);

function workdir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-alerts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const strays = dir => readdirSync(dir).filter(name => name.endsWith('.tmp'));

// ─── atomic JSON ─────────────────────────────────────────────────────────────

test('writeJsonAtomic and readJsonWithBackup round-trip and create the parent directory', t => {
  assert.equal(typeof atomic.writeJsonAtomic, 'function', 'writeJsonAtomic is implemented');
  const dir = workdir(t);
  const path = join(dir, 'nested', 'deeper', 'store.json');
  atomic.writeJsonAtomic(path, { version: 1, items: [1, 'two', null] });
  const read = atomic.readJsonWithBackup(path);
  assert.deepEqual(read, { value: { version: 1, items: [1, 'two', null] }, source: 'primary' });
  assert.deepEqual(strays(join(dir, 'nested', 'deeper')), []);
});

test('a missing primary and backup reads as an empty store without an error', t => {
  const dir = workdir(t);
  assert.deepEqual(atomic.readJsonWithBackup(join(dir, 'never-written.json')), { value: null, source: 'none' });
});

test('the previous primary is copied to .bak on the next write', t => {
  const dir = workdir(t);
  const path = join(dir, 'store.json');
  atomic.writeJsonAtomic(path, { n: 1 });
  assert.throws(() => readFileSync(`${path}.bak`), { code: 'ENOENT' }, 'the first write has nothing to back up');
  atomic.writeJsonAtomic(path, { n: 2 });
  assert.deepEqual(JSON.parse(readFileSync(`${path}.bak`, 'utf8')), { n: 1 });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { n: 2 });
  assert.deepEqual(strays(dir), []);
});

test('a corrupt primary falls back to the backup', t => {
  const dir = workdir(t);
  const path = join(dir, 'store.json');
  atomic.writeJsonAtomic(path, { n: 1 });
  atomic.writeJsonAtomic(path, { n: 2 });
  writeFileSync(path, '{"n": 2, truncat');
  const read = atomic.readJsonWithBackup(path);
  assert.equal(read.source, 'backup');
  assert.deepEqual(read.value, { n: 1 });
});

test('both files corrupt returns none with an error and never throws', t => {
  const dir = workdir(t);
  const path = join(dir, 'store.json');
  writeFileSync(path, 'not json');
  writeFileSync(`${path}.bak`, '{also not');
  let read;
  assert.doesNotThrow(() => { read = atomic.readJsonWithBackup(path); });
  assert.equal(read.value, null);
  assert.equal(read.source, 'none');
  assert.equal(typeof read.error, 'string');
  assert.ok(read.error.length > 0);
});

test('a directory in place of the file is a failure, not a crash', t => {
  const dir = workdir(t);
  const path = join(dir, 'store.json');
  mkdirSync(path);
  const read = atomic.readJsonWithBackup(path);
  assert.equal(read.value, null);
  assert.equal(read.source, 'none');
  assert.equal(typeof read.error, 'string');
});

test('maxBytes rejects an oversize primary and uses the small backup', t => {
  const dir = workdir(t);
  const path = join(dir, 'store.json');
  atomic.writeJsonAtomic(path, { small: true });
  atomic.writeJsonAtomic(path, { big: 'x'.repeat(5000) });
  const limited = atomic.readJsonWithBackup(path, { maxBytes: 1000 });
  assert.equal(limited.source, 'backup');
  assert.deepEqual(limited.value, { small: true });
  const unlimited = atomic.readJsonWithBackup(path, { maxBytes: 100000 });
  assert.equal(unlimited.source, 'primary');
  assert.equal(unlimited.value.big.length, 5000);
  const none = atomic.readJsonWithBackup(path, { maxBytes: 5 });
  assert.equal(none.source, 'none');
  assert.equal(none.value, null);
  assert.match(none.error, /large|size|limit/i);
});

test('a failed validate falls back to the backup and a throwing validate never escapes', t => {
  const dir = workdir(t);
  const path = join(dir, 'store.json');
  atomic.writeJsonAtomic(path, { ok: true, n: 1 });
  atomic.writeJsonAtomic(path, { ok: false, n: 2 });
  const validate = value => value?.ok === true;
  const fallback = atomic.readJsonWithBackup(path, { validate });
  assert.equal(fallback.source, 'backup');
  assert.deepEqual(fallback.value, { ok: true, n: 1 });
  assert.equal(atomic.readJsonWithBackup(path).source, 'primary', 'no validate accepts any parsed JSON');
  const never = atomic.readJsonWithBackup(path, { validate: () => false });
  assert.equal(never.source, 'none');
  assert.equal(never.value, null);
  assert.match(never.error, /valid/i);
  let thrown;
  assert.doesNotThrow(() => { thrown = atomic.readJsonWithBackup(path, { validate: () => { throw new Error('boom'); } }); });
  assert.equal(thrown.source, 'none');
  assert.equal(thrown.value, null);
});

test('a corrupt primary is never copied over a good backup', t => {
  const dir = workdir(t);
  const path = join(dir, 'store.json');
  atomic.writeJsonAtomic(path, { n: 1 });
  atomic.writeJsonAtomic(path, { n: 2 });
  writeFileSync(path, '{"n": corrupt');
  atomic.writeJsonAtomic(path, { n: 3 });
  assert.deepEqual(JSON.parse(readFileSync(`${path}.bak`, 'utf8')), { n: 1 }, 'the good backup survives');
  assert.deepEqual(atomic.readJsonWithBackup(path), { value: { n: 3 }, source: 'primary' });
});

test('a failed write throws, leaves the old primary intact and removes its temporary files', t => {
  const dir = workdir(t);
  const path = join(dir, 'store.json');
  atomic.writeJsonAtomic(path, { n: 1 });
  const circular = {}; circular.self = circular;
  for (const bad of [circular, undefined, () => 1, 10n]) assert.throws(() => atomic.writeJsonAtomic(path, bad), `${typeof bad} is not serialisable`);
  assert.deepEqual(atomic.readJsonWithBackup(path), { value: { n: 1 }, source: 'primary' });
  const target = join(dir, 'occupied.json');
  mkdirSync(target);
  assert.throws(() => atomic.writeJsonAtomic(target, { n: 2 }), 'a directory cannot be replaced by a file');
  assert.deepEqual(strays(dir), []);
});

// Replace node:fs functions for one test: the module's named imports follow after syncBuiltinESMExports().
function failFs(t, failures) {
  const saved = Object.fromEntries(Object.keys(failures).map(name => [name, fs[name]]));
  for (const [name, message] of Object.entries(failures)) fs[name] = () => { throw Object.assign(new Error(message), { code: 'EIO' }); };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(fs, saved); syncBuiltinESMExports(); });
}

test('a failing cleanup never hides the error that stopped the write', t => {
  const dir = workdir(t);
  const path = join(dir, 'store.json');
  atomic.writeJsonAtomic(path, { n: 1 });
  failFs(t, { renameSync: 'rename failed', unlinkSync: 'unlink failed' });
  assert.throws(() => atomic.writeJsonAtomic(path, { n: 2 }), /rename failed/, 'the rename error, not the unlink error');
});

test('a failing close in the cleanup never hides the write error either', t => {
  const dir = workdir(t);
  failFs(t, { fsyncSync: 'fsync failed', closeSync: 'close failed' });
  assert.throws(() => atomic.writeJsonAtomic(join(dir, 'store.json'), { n: 1 }), /fsync failed/);
});

test('readJsonWithBackup takes null options like none', t => {
  const dir = workdir(t);
  const path = join(dir, 'store.json');
  atomic.writeJsonAtomic(path, { n: 1 });
  let read;
  assert.doesNotThrow(() => { read = atomic.readJsonWithBackup(path, null); });
  assert.deepEqual(read, { value: { n: 1 }, source: 'primary' });
});

// ─── levels ──────────────────────────────────────────────────────────────────

test('LEVELS is the ordered four-level scale and levelRank orders it', () => {
  assert.deepEqual(levels.LEVELS, ['critical', 'high', 'watch', 'info']);
  assert.deepEqual(levels.LEVELS.map(levels.levelRank), [3, 2, 1, 0]);
  for (const unknown of ['unknown', '', 'constructor', '__proto__', null, undefined, 5, {}]) assert.equal(levels.levelRank(unknown), -1, String(unknown));
});

test('eventLevel maps the event severity scale onto the alert levels', () => {
  const words = ['unknown', 'monitor', 'low', 'moderate', 'elevated', 'high', 'critical', 'Red', 'Orange', 'Extreme', 'Severe', 'Moderate', 'Minor', 'banana'];
  assert.deepEqual(words.map(severity => levels.eventLevel({ severity })), [null, 'info', 'info', 'watch', 'high', 'high', 'critical', 'critical', 'high', 'critical', 'high', 'watch', 'info', null]);
  for (const notEvent of [null, undefined, 'critical', 42, [], {}, { severity: null }, { severity: 7 }]) assert.equal(levels.eventLevel(notEvent), null, JSON.stringify(notEvent));
});

test('levelAtLeast compares ranks and rejects unknown levels', () => {
  assert.equal(levels.levelAtLeast('high', 'watch'), true);
  assert.equal(levels.levelAtLeast('high', 'high'), true);
  assert.equal(levels.levelAtLeast('critical', 'info'), true);
  assert.equal(levels.levelAtLeast('info', 'high'), false);
  assert.equal(levels.levelAtLeast('watch', 'high'), false);
  assert.equal(levels.levelAtLeast('banana', 'info'), false);
  assert.equal(levels.levelAtLeast('critical', 'banana'), false);
  assert.equal(levels.levelAtLeast(null, null), false);
});

test('threatOf maps a level onto the 2-5 threat scale and falls back to 1', () => {
  assert.deepEqual(['info', 'watch', 'high', 'critical'].map(levels.threatOf), [2, 3, 4, 5]);
  for (const unknown of ['banana', null, undefined, 'constructor']) assert.equal(levels.threatOf(unknown), 1, String(unknown));
});

// ─── metrics registry ────────────────────────────────────────────────────────

const LIVE_KEYS = ['hormuz_transits', 'bab_el_mandeb_transits', 'suez_transits', 'malacca_transits', 'bosporus_transits', 'panama_transits', 'gibraltar_transits', 'dover_transits',
  'hu_power_price', 'grid_frequency_hz', 'mil_aircraft_total'];
const KEYS = ['vix', 'hy_spread', 't10y2y', 'wti', 'brent', 'natgas', 'gold', 'silver', 'y10', 'usd_index', 'mortgage', 'fed_funds', 'unemployment', 'btc', 'eth', 'eurhuf', ...LIVE_KEYS, 'urgent_posts', 'who_alerts', 'conflict_events', 'conflict_fatalities', 'sources_ok', 'sources_failed', 'sources_stale', 'risk_max_score', 'risk_countries_high', 'risk_conflict_escalating'];

function snapshot() {
  return {
    markets: { vix: { value: 15.95, change: -0.12 }, crypto: [{ symbol: 'ETH-USD', price: 2745.87 }, { symbol: 'BTC-USD', price: 86327.37 }] },
    fred: [
      { id: 'VIXCLS', value: 16.34 }, { id: 'BAMLH0A0HYM2', value: 3.12 }, { id: 'T10Y2Y', value: 0.46 }, { id: 'DGS10', value: 5.29 },
      { id: 'DTWEXBGS', value: 120.33 }, { id: 'MORTGAGE30US', value: 7.28 }, { id: 'DFF', value: 3.88 }, { id: 'UNRATE', value: 4.1 },
    ],
    energy: { wti: 89.17, brent: 99.22, natgas: 2.93 },
    metals: { gold: 4213.5, silver: 61.45 },
    liveSources: [{ source: 'USGS', metrics: { HUF: 1 } }, { source: 'ECB', metrics: { HUF: 367.18, USD: 1.1298 } },
      { source: 'IMF-PortWatch', status: 'ok', metrics: { hormuz_transits: 3.1, bab_el_mandeb_transits: 27.1, suez_transits: 40, malacca_transits: 217.9, bosporus_transits: 49.6, panama_transits: 27, gibraltar_transits: 133, dover_transits: 172.3 } },
      { source: 'Energy-Charts-HU', status: 'ok', metrics: { hu_power_price: 172.6, grid_frequency_hz: 50.0307 } },
      { source: 'ADSB-Military', status: 'ok', metrics: { mil_aircraft_total: 71 } }],
    tg: { urgent: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] },
    who: [{ title: 'outbreak' }],
    acled: { totalEvents: 12, totalFatalities: 34 },
    meta: { sourcesOk: 32, sourcesFailed: 2, sourcesStale: 1 },
  };
}

test('METRICS describes the 37 metrics and METRIC_KEYS lists them in order', () => {
  assert.deepEqual(metrics.METRIC_KEYS, KEYS);
  assert.deepEqual(metrics.METRICS.map(metric => metric.key), KEYS);
  for (const metric of metrics.METRICS) {
    assert.equal(typeof metric.label, 'string', metric.key);
    assert.ok(metric.label.length > 0, metric.key);
    assert.equal(typeof metric.unit, 'string', metric.key);
    assert.ok(['number', 'count'].includes(metric.kind), metric.key);
    assert.equal(typeof metric.read, 'function', metric.key);
  }
  assert.deepEqual(metrics.METRICS.filter(metric => metric.kind === 'count').map(metric => metric.key), ['urgent_posts', 'who_alerts', 'conflict_events', 'conflict_fatalities', 'sources_ok', 'sources_failed', 'sources_stale', 'risk_countries_high', 'risk_conflict_escalating']);
  assert.equal(new Set(KEYS).size, KEYS.length);
});

test('the registry is frozen so callers cannot reshape it', () => {
  assert.ok(Object.isFrozen(metrics.METRICS));
  assert.ok(Object.isFrozen(metrics.METRICS[0]));
  assert.ok(Object.isFrozen(metrics.METRIC_KEYS));
});

test('metricValues reads all 37 keys from a snapshot', () => {
  assert.deepEqual(metrics.metricValues(snapshot()), {
    vix: 15.95, hy_spread: 3.12, t10y2y: 0.46, wti: 89.17, brent: 99.22, natgas: 2.93, gold: 4213.5, silver: 61.45,
    y10: 5.29, usd_index: 120.33, mortgage: 7.28, fed_funds: 3.88, unemployment: 4.1,
    btc: 86327.37, eth: 2745.87, eurhuf: 367.18,
    hormuz_transits: 3.1, bab_el_mandeb_transits: 27.1, suez_transits: 40, malacca_transits: 217.9, bosporus_transits: 49.6, panama_transits: 27, gibraltar_transits: 133, dover_transits: 172.3,
    hu_power_price: 172.6, grid_frequency_hz: 50.0307, mil_aircraft_total: 71,
    urgent_posts: 3, who_alerts: 1, conflict_events: 12, conflict_fatalities: 34,
    sources_ok: 32, sources_failed: 2, sources_stale: 1,
    risk_max_score: null, risk_countries_high: null, risk_conflict_escalating: null,
  });
});

test('every metric reads through its own read function', () => {
  const values = metrics.metricValues(snapshot());
  for (const metric of metrics.METRICS) assert.equal(metric.read(snapshot()), values[metric.key], metric.key);
});

test('a snapshot missing every block yields null for every key, including counts', () => {
  for (const empty of [{}, null, undefined, 'text', 7, []]) {
    const values = metrics.metricValues(empty);
    assert.deepEqual(Object.keys(values), KEYS);
    assert.ok(Object.values(values).every(value => value === null), JSON.stringify(empty));
  }
});

test('present but empty blocks count as zero, absent ones stay null', () => {
  const values = metrics.metricValues({ tg: { urgent: [] }, who: [], acled: { totalEvents: 0, totalFatalities: 0 }, meta: { sourcesOk: 0, sourcesFailed: 0 } });
  assert.equal(values.urgent_posts, 0);
  assert.equal(values.who_alerts, 0);
  assert.equal(values.conflict_events, 0);
  assert.equal(values.conflict_fatalities, 0);
  assert.equal(values.sources_ok, 0);
  assert.equal(values.sources_failed, 0);
  assert.equal(values.sources_stale, null);
});

test('vix prefers the live market quote and falls back to FRED', () => {
  const fredOnly = snapshot(); delete fredOnly.markets.vix;
  assert.equal(metrics.metricValues(fredOnly).vix, 16.34);
  const noQuote = snapshot(); noQuote.markets.vix = { change: 1 };
  assert.equal(metrics.metricValues(noQuote).vix, 16.34);
  const neither = snapshot(); delete neither.markets.vix; neither.fred = neither.fred.filter(row => row.id !== 'VIXCLS');
  assert.equal(metrics.metricValues(neither).vix, null);
});

test('unemployment reads the BLS series first and FRED UNRATE second', () => {
  const bls = snapshot(); bls.bls = [{ id: 'LNS14000000', value: 4.3 }];
  assert.equal(metrics.metricValues(bls).unemployment, 4.3);
  assert.equal(metrics.metricValues(snapshot()).unemployment, 4.1);
});

test('crypto and the ECB rate are matched by symbol and source, not position', () => {
  const values = metrics.metricValues({ markets: { crypto: [{ symbol: 'SOL-USD', price: 150 }, { symbol: 'ETH-USD', price: 3000 }] }, liveSources: [{ source: 'ECB', metrics: { USD: 1.1 } }] });
  assert.equal(values.btc, null);
  assert.equal(values.eth, 3000);
  assert.equal(values.eurhuf, null);
});

test('the live-source metrics name their unit and kind, and the PortWatch ones say they are 7-day means', () => {
  const byKey = Object.fromEntries(metrics.METRICS.map(metric => [metric.key, metric]));
  for (const key of LIVE_KEYS) assert.equal(byKey[key].kind, 'number', key);
  for (const key of LIVE_KEYS.filter(key => key.endsWith('_transits'))) {
    assert.equal(byKey[key].unit, 'transits/day', key);
    assert.match(byKey[key].label, /\(7-day mean\)$/, `${key}: PortWatch publishes a 7-day mean, not one day's count`);
  }
  assert.deepEqual([byKey.hu_power_price.unit, byKey.grid_frequency_hz.unit, byKey.mil_aircraft_total.unit], ['EUR/MWh', 'Hz', 'aircraft']);
  for (const word of [/worldwide/, /airborne/, /2 min/]) assert.match(byKey.mil_aircraft_total.label, word);
});

test('a live-source metric is read only while its source is current: stale, failed or absent sources give null', () => {
  const live = (status, extra = {}) => ({ liveSources: [{ source: 'IMF-PortWatch', status, metrics: { hormuz_transits: 3.1 }, ...extra },
    { source: 'Energy-Charts-HU', status, metrics: { hu_power_price: 172.6, grid_frequency_hz: 50.03 }, ...extra }, { source: 'ADSB-Military', status, metrics: { mil_aircraft_total: 71 }, ...extra }] });
  const read = snapshot => { const values = metrics.metricValues(snapshot); return [values.hormuz_transits, values.hu_power_price, values.grid_frequency_hz, values.mil_aircraft_total]; };
  assert.deepEqual(read(live('ok')), [3.1, 172.6, 50.03, 71]);
  // A value a snapshot still carries for a source that is no longer current is never read.
  for (const status of ['stale', 'error', 'disabled', undefined]) assert.deepEqual(read(live(status)), [null, null, null, null], String(status));
  assert.deepEqual(read(live('ok', { stale: true })), [null, null, null, null], 'stale flag');
  assert.deepEqual(read({ liveSources: [] }), [null, null, null, null], 'absent');
  assert.deepEqual(read({ liveSources: [{ source: 'Energy-Charts-HU', status: 'ok', metrics: {} }] }), [null, null, null, null], 'nothing current: an empty metrics object');
  // Matched by source name: the same key under another source does not count.
  assert.equal(metrics.metricValues({ liveSources: [{ source: 'EMSC', status: 'ok', metrics: { hormuz_transits: 9, mil_aircraft_total: 9 } }] }).hormuz_transits, null);
  const odd = metrics.metricValues({ liveSources: [{ source: 'IMF-PortWatch', status: 'ok', metrics: { hormuz_transits: '3.1', suez_transits: NaN } }] });
  assert.deepEqual([odd.hormuz_transits, odd.suez_transits], [null, null]);
});

test('non-finite and non-numeric values become null and hostile shapes never throw', () => {
  const hostile = {
    markets: { vix: { value: NaN }, crypto: [null, { symbol: 'BTC-USD', price: Infinity }, 'ETH-USD'] },
    fred: [null, { id: 'BAMLH0A0HYM2', value: '3.12' }, { id: 'T10Y2Y', value: -Infinity }, { id: 'DGS10' }, 7],
    energy: { wti: NaN, brent: '99', natgas: null },
    metals: [],
    liveSources: [null, { source: 'ECB' }, { source: 'ECB', metrics: null }, { source: 'IMF-PortWatch', status: 'ok', metrics: null }, { source: 'ADSB-Military', status: 'ok', metrics: 'many' }],
    tg: { urgent: 'many' }, who: { length: 5 }, acled: { totalEvents: NaN, totalFatalities: '9' },
    meta: { sourcesOk: Infinity, sourcesFailed: {}, sourcesStale: -1 },
  };
  let values;
  assert.doesNotThrow(() => { values = metrics.metricValues(hostile); });
  assert.deepEqual(Object.keys(values), KEYS);
  assert.equal(values.vix, null);
  assert.equal(values.hy_spread, null);
  assert.equal(values.t10y2y, null);
  assert.equal(values.y10, null);
  assert.equal(values.btc, null);
  assert.equal(values.eth, null);
  assert.equal(values.eurhuf, null);
  assert.equal(values.hormuz_transits, null);
  assert.equal(values.mil_aircraft_total, null);
  assert.equal(values.wti, null);
  assert.equal(values.brent, null);
  assert.equal(values.gold, null);
  assert.equal(values.urgent_posts, null);
  assert.equal(values.who_alerts, null);
  assert.equal(values.conflict_events, null);
  assert.equal(values.conflict_fatalities, null);
  assert.equal(values.sources_ok, null);
  assert.equal(values.sources_failed, null);
  assert.equal(values.sources_stale, -1, 'finite numbers pass through untouched');
});

test('metricValues does not mutate its input', () => {
  const input = snapshot();
  const before = JSON.stringify(input);
  metrics.metricValues(input);
  assert.equal(JSON.stringify(input), before);
});

// ─── delta engine ────────────────────────────────────────────────────────────

test('the delta engine exports its metric tables with extractors', () => {
  for (const [name, expected] of [['NUMERIC_METRICS', ['vix', 'hy_spread', '10y2y', 'wti', 'brent', 'natgas', 'gold', 'silver', 'unemployment', 'fed_funds', '10y_yield', 'usd_index', 'mortgage']], ['COUNT_METRICS', ['urgent_posts', 'thermal_total', 'air_total', 'who_alerts', 'conflict_events', 'conflict_fatalities', 'sdr_online', 'news_count', 'sources_ok']]]) {
    assert.ok(Array.isArray(deltaEngine[name]), `${name} is exported`);
    assert.deepEqual(deltaEngine[name].map(metric => metric.key), expected);
    for (const metric of deltaEngine[name]) assert.equal(typeof metric.extract, 'function', metric.key);
  }
});

test('computeDelta output is unchanged', () => {
  const previous = {
    meta: { timestamp: '2026-10-02T08:00:00.000Z', sourcesOk: 30 },
    fred: [{ id: 'VIXCLS', value: 16 }, { id: 'DFF', value: 3.88 }], energy: { wti: 80 }, metals: { gold: 4000 },
    tg: { urgent: [{ postId: 'p1', text: 'old post' }] }, acled: { totalEvents: 10, totalFatalities: 20 }, who: [{ title: 'a' }],
    nuke: [{ anom: false }], health: [{ err: false }],
  };
  const current = {
    meta: { timestamp: '2026-10-02T08:15:00.000Z', sourcesOk: 28 },
    fred: [{ id: 'VIXCLS', value: 20 }, { id: 'DFF', value: 3.88 }], energy: { wti: 84 }, metals: { gold: 4000 },
    tg: { urgent: [{ postId: 'p1', text: 'old post' }, { postId: 'p2', text: 'new post' }] }, acled: { totalEvents: 16, totalFatalities: 20 }, who: [{ title: 'a' }, { title: 'b' }],
    nuke: [{ anom: true }], health: [{ err: true }, { err: true }, { err: true }, { err: true }],
  };
  assert.deepEqual(deltaEngine.computeDelta(current, previous), {
    timestamp: '2026-10-02T08:15:00.000Z',
    previous: '2026-10-02T08:00:00.000Z',
    signals: {
      new: [
        { key: 'tg_urgent:id:p2', text: 'new post', item: { postId: 'p2', text: 'new post' }, reason: 'New urgent OSINT post' },
        { key: 'nuke_anomaly', reason: 'Nuclear anomaly detected', severity: 'critical' },
        { key: 'source_degradation', reason: '4 additional sources failing (4 total down)', severity: 'moderate' },
      ],
      escalated: [
        { key: 'vix', label: 'VIX', from: 16, to: 20, pctChange: 25, direction: 'up', severity: 'critical' },
        { key: 'wti', label: 'WTI Crude', from: 80, to: 84, pctChange: 5, direction: 'up', severity: 'moderate' },
        { key: 'who_alerts', label: 'WHO Alerts', from: 1, to: 2, change: 1, direction: 'up', pctChange: 100, severity: 'moderate' },
        { key: 'conflict_events', label: 'Conflict Events', from: 10, to: 16, change: 6, direction: 'up', pctChange: 60, severity: 'moderate' },
      ],
      deescalated: [
        { key: 'sources_ok', label: 'Sources OK', from: 30, to: 28, change: -2, direction: 'down', pctChange: -6.7, severity: 'high' },
      ],
      unchanged: ['gold', 'fed_funds', 'urgent_posts', 'thermal_total', 'air_total', 'conflict_fatalities', 'sdr_online', 'news_count'],
    },
    summary: {
      totalChanges: 8, criticalChanges: 7, direction: 'risk-off',
      signalBreakdown: { new: 3, escalated: 4, deescalated: 1, unchanged: 8 },
    },
  });
});
