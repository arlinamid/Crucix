import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import config from '../crucix.config.mjs';
import { createSweepPipeline } from '../lib/sweep-pipeline.mjs';

const quiet = { log() {}, warn() {}, error() {} };

test('sweep pipeline: a sweep that cannot be synthesized reports it and writes nothing, without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-pipeline-'));
  try {
    const pipeline = createSweepPipeline({ runsDir: dir, config, logger: quiet });
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
    const pipeline = createSweepPipeline({ runsDir: dir, config: { ...config, risk: { ...config.risk, enabled: false } }, logger: quiet });
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
