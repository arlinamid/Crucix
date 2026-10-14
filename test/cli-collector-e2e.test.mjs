// End-to-end: `crucix --collector` runs a sweep round (offline stub), processes it like `--sweep`, holds the instance lock
// while it runs and releases it on SIGTERM.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OFFLINE_FETCH, childEnv, nodeArgs, runCli } from './helpers/run-cli.mjs';

let workdir;
let runsDir;
before(() => {
  workdir = mkdtempSync(join(tmpdir(), 'crucix-collector-e2e-'));
  runsDir = join(workdir, 'runs');
});
after(() => rmSync(workdir, { recursive: true, force: true }));

test('e2e collector: one round fills the stores, a second copy is refused, SIGTERM releases the lock', { timeout: 90_000 }, async () => {
  const child = spawn(process.execPath, nodeArgs(['--collector', '--interval', '60'], OFFLINE_FETCH), { env: childEnv({ workdir, runsDir }), cwd: workdir });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(done => child.on('exit', (code, signal) => done({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no finished round in time\n${stdout}\n${stderr}`)), 70_000);
      const poll = setInterval(() => {
        if (/Processed: |Processing step failed/.test(stdout)) { clearTimeout(timer); clearInterval(poll); resolve(); }
      }, 200);
      child.on('exit', () => { clearTimeout(timer); clearInterval(poll); reject(new Error(`collector exited early\n${stdout}\n${stderr}`)); });
    });
    assert.match(stdout, /Processed: synthesize, worldNews, delta, events, risk, alerts, archive/);
    assert.ok(existsSync(join(runsDir, 'instance.lock')), 'the lock is held while it runs');
    for (const file of ['latest.json', 'intelligence/history.db', 'alerts/alerts.json', 'sweeps/index.json', 'memory/hot.json']) {
      assert.ok(existsSync(join(runsDir, file)), file);
    }

    const second = await runCli(['--collector'], { workdir, runsDir, preload: OFFLINE_FETCH });
    assert.equal(second.code, 1);
    assert.match(second.stderr, /already running/);
  } finally {
    child.kill('SIGTERM');
  }
  await exited;
  // Windows kills the process on SIGTERM without running its handlers; the next start replaces a lock of a dead pid.
  if (process.platform !== 'win32') assert.equal(existsSync(join(runsDir, 'instance.lock')), false, 'the lock is released');
});
