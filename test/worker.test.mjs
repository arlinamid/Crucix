import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerHost, workerCommand } from '../lib/worker/host.mjs';
import { HistoryStore } from '../lib/intelligence/history.mjs';

const quiet = { log() {}, warn() {}, error() {} };

test('worker: the command runs the CLI script with __worker (not an executable here)', async () => {
  const [file, args] = await workerCommand();
  assert.equal(file, process.execPath);
  assert.match(args[0], /scripts[\\/]cli\.mjs$/); assert.equal(args[1], '__worker');
});

test('worker: a real child process answers ping, extracts entities and runs a history job; a failing job rejects; the fallback runs without it', async t => {
  const runsDir = mkdtempSync(join(tmpdir(), 'crucix-worker-'));
  const host = new WorkerHost({ log: quiet, env: { RUNS_DIR: runsDir } });
  t.after(() => { host.stop(); rmSync(runsDir, { recursive: true, force: true }); });
  assert.equal(await host.start(), true, 'ready');
  const pong = await host.call('ping');
  assert.ok(pong.pid > 0 && pong.pid !== process.pid, 'another process');
  const records = await host.call('extract', { events: [{ id: 'event-' + 'a'.repeat(32), kind: 'news', title: 'Houthis strike Saudi oil facility near Strait of Hormuz', source: { name: 'X' }, location: {} }] });
  assert.equal(records.length, 1);
  assert.ok(records[0].entities.some(entity => entity.id.startsWith('country:')), 'the entities came back');
  new HistoryStore(runsDir).add([{ id: 'event-' + 'b'.repeat(32), kind: 'news', title: 'Election results', source: { name: 'Y' }, collectedAt: new Date().toISOString(), location: {} }]);
  const themes = await host.call('themes', { runsDir, days: 1 });
  assert.equal(themes.records, 1);
  await assert.rejects(host.call('no-such-job'), /unknown job/);
  assert.equal(host.status().available, true);
  // run(): the worker when it is there ...
  assert.equal((await host.run('ping', {}, () => 'fallback')).pid, pong.pid);
  host.stop();
  await new Promise(resolve => setTimeout(resolve, 300));
  // ... the server itself when it is not.
  assert.equal(host.available, false);
  assert.equal(await host.run('ping', {}, () => 'fallback'), 'fallback');
  await assert.rejects(host.call('ping'), /not available/);
});
