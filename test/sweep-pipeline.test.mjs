import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import config from '../crucix.config.mjs';
import { createSweepPipeline } from '../lib/sweep-pipeline.mjs';

const quiet = { log() {}, warn() {}, error() {} };
// The real synthesize() fetches the news feeds; these tests stay offline.
const snapshotOf = raw => ({ meta: { timestamp: raw.crucix.timestamp, sourcesOk: 0, sourcesQueried: 0 }, news: [], newsFeed: [], health: [] });

test('sweep pipeline: a sweep that cannot be synthesized reports it and writes nothing, without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-pipeline-'));
  try {
    const pipeline = createSweepPipeline({ runsDir: dir, config, logger: quiet, synthesize: snapshotOf });
    const result = await pipeline.run(null);
    assert.equal(result.snapshot, null);
    assert.equal(result.steps.synthesize.ok, false);
    assert.ok(result.steps.synthesize.error);
    assert.equal(existsSync(join(dir, 'sweeps', 'index.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sweep pipeline: a failing step does not stop the next ones and RISK_ENABLED=false skips the risk step', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-pipeline-'));
  try {
    const pipeline = createSweepPipeline({ runsDir: dir, config: { ...config, risk: { ...config.risk, enabled: false } }, logger: quiet, synthesize: snapshotOf });
    pipeline.history.add = () => { throw new Error('disk full\nsecond line'); };
    const raw = { crucix: { timestamp: new Date().toISOString(), totalDurationMs: 1, sourcesQueried: 0, sourcesOk: 0, sourcesFailed: 0, version: 'test' }, sources: {}, timing: {} };
    const { snapshot, steps } = await pipeline.run(raw);
    assert.ok(snapshot);
    assert.deepEqual(steps.events, { ok: false, error: 'disk full' }, 'only the first line of the error is kept');
    assert.equal(steps.risk.skipped, 'RISK_ENABLED=false');
    assert.equal(steps.delta.ok, true);
    assert.equal(steps.alerts.ok, true);
    assert.equal(steps.archive.ok, true, 'the archive step ran after the failed history write');
    assert.equal(existsSync(join(dir, 'intelligence', 'countries.json')), false, 'no risk files with the step switched off');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sweep pipeline: the world-RSS headlines join the news feed before the events are built, so their countries reach the risk store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-pipeline-'));
  try {
    const now = new Date().toISOString();
    const worldNews = () => [
      { title: 'Oroszországban drónok csapódtak be egy finomítóba', summary: '', source: 'Telex', url: 'https://telex.example/1', date: now, country: 'HU', lang: 'hu', tier: 2 },
      { title: 'Oroszországban drónok csapódtak be egy finomítóba', source: 'Index.hu', url: 'https://index.example/1', date: now, country: 'HU', lang: 'hu', tier: 2 },
    ];
    const pipeline = createSweepPipeline({ runsDir: dir, config, logger: quiet, synthesize: snapshotOf, worldNews });
    const raw = { crucix: { timestamp: now, totalDurationMs: 1, sourcesQueried: 0, sourcesOk: 0, sourcesFailed: 0, version: 'test' }, sources: {}, timing: {} };
    const { snapshot, steps } = await pipeline.run(raw);
    assert.deepEqual(steps.worldNews, { ok: true, added: 1 }, 'the same title from a second outlet is not added twice');
    const news = snapshot.events.filter(event => event.kind === 'news');
    assert.equal(news.length, 1);
    assert.equal(steps.risk.ok, true);
    assert.ok(snapshot.risk.top.some(row => row.iso3 === 'RUS'), 'the Hungarian headline counts as a mention of Russia');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
