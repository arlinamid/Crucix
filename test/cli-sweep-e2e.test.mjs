// End-to-end: `crucix --sweep` with every source failing at once (offline stub). The derived stage must still fill the
// history, risk index, alert store, delta memory and sweep archive, so the query commands work from the disk afterwards.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OFFLINE_FETCH, runCli } from './helpers/run-cli.mjs';

let workdir;
let runsDir;
const cli = (args, options = {}) => runCli(args, { workdir, runsDir, ...options });
const sweep = (args = []) => cli(['--sweep', ...args], { preload: OFFLINE_FETCH, timeout: 90_000 });

before(() => {
  workdir = mkdtempSync(join(tmpdir(), 'crucix-sweep-e2e-'));
  runsDir = join(workdir, 'runs');
});
after(() => rmSync(workdir, { recursive: true, force: true }));

test('e2e sweep: refuses to run next to a live Crucix instance', async () => {
  mkdirSync(runsDir, { recursive: true });
  const lock = join(runsDir, 'instance.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try {
    const { code, stderr } = await sweep();
    assert.equal(code, 1);
    assert.match(stderr, /already running/);
    assert.equal(existsSync(join(runsDir, 'latest.json')), false, 'nothing was written');
  } finally {
    rmSync(lock, { force: true });
  }
});

test('e2e sweep: the first sweep fills history, risk, alerts, memory and the archive; the second gives a delta', { timeout: 150_000 }, async () => {
  const first = await sweep();
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /Sweep Completed Successfully/);
  assert.match(first.stdout, /Processed: synthesize, delta, events, risk, alerts, archive/);
  for (const file of ['latest.json', 'intelligence/history.json', 'intelligence/countries.json', 'alerts/alerts.json', 'memory/hot.json', 'sweeps/index.json']) {
    assert.ok(existsSync(join(runsDir, file)), `${file} was written`);
  }
  assert.equal(existsSync(join(runsDir, 'instance.lock')), false, 'the lock is released on exit');

  const sweeps = JSON.parse((await cli(['--sweeps', '--no-server', '--json'])).stdout);
  assert.equal(sweeps.length, 1);
  assert.ok(sweeps[0].id);
  for (const [args, header] of [[['-A'], /Crucix Alerts/], [['--risk'], /Country Risk Ranking/], [['--history'], /Crucix Events/], [['-b'], /INTELLIGENCE BRIEFING/]]) {
    const view = await cli([...args, '--no-server']);
    assert.equal(view.code, 0, args.join(' '));
    assert.match(view.stdout, header, args.join(' '));
  }
  assert.match((await cli(['--delta', '--no-server'])).stdout, /No delta information available yet/);

  // The second sweep also checks that --json keeps stdout clean (the adapters' progress lines go to stderr).
  const second = await sweep(['--json']);
  assert.equal(second.code, 0, second.stderr);
  const raw = JSON.parse(second.stdout);
  assert.ok(raw.crucix?.timestamp);
  assert.match(second.stderr, /Starting intelligence sweep/);

  assert.equal(JSON.parse((await cli(['--sweeps', '--no-server', '--json'])).stdout).length, 2);
  const delta = await cli(['--delta', '--no-server']);
  assert.match(delta.stdout, /Total Changes:\s+\d+/);
  assert.doesNotMatch(delta.stdout, /No delta information/);
});
