import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireInstanceLock, alreadyRunningMessage, processIsAlive, releaseInstanceLock } from '../lib/instance-lock.mjs';
import { isBenignHttpParserClose } from '../lib/http-parser-error.mjs';

test('instance lock is exclusive, stale pid is stolen, owner can release', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-lock-'));
  try {
    const first = acquireInstanceLock(dir, { pid: process.pid });
    assert.equal(first.created, true);
    const again = acquireInstanceLock(dir, { pid: process.pid });
    assert.equal(again.created, false);
    const other = acquireInstanceLock(dir, { pid: process.pid + 100000 });
    assert.equal(other.error, 'already_running');
    assert.equal(other.pid, process.pid);
    assert.equal(releaseInstanceLock(dir, { pid: process.pid + 1 }), false);
    assert.equal(releaseInstanceLock(dir), true);
    const stale = acquireInstanceLock(dir, { pid: 1 });
    assert.equal(stale.created, true);
    const stolen = acquireInstanceLock(dir, { pid: process.pid });
    assert.equal(stolen.created, true);
    assert.equal(processIsAlive(process.pid), true);
    assert.equal(processIsAlive(1), false);
    assert.match(alreadyRunningMessage({ pid: 9 }, { port: 3117 }), /already running \(pid 9\)/);
    assert.match(alreadyRunningMessage({ pid: 9 }, { port: 3117, lang: 'hu' }), /már fut/);
  } finally {
    releaseInstanceLock(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('paused TLS parser AssertionError is treated as a known RSS abort', () => {
  const error = new Error('The expression evaluated to a falsy value:\n\n  assert(!this.paused)\n');
  error.name = 'AssertionError';
  error.stack = `${error.message}\n    at Parser.finish (bundle.cjs:1)\n    at TLSSocket.onHttpSocketEnd (bundle.cjs:2)`;
  assert.equal(isBenignHttpParserClose(error), true);
  assert.equal(isBenignHttpParserClose(new Error('boom')), false);
  assert.equal(isBenignHttpParserClose(null), false);
});

test('a second server on the same runs/ exits instead of starting another sweep', { timeout: 40000 }, async t => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const directory = mkdtempSync(join(tmpdir(), 'crucix-lock-server-'));
  const envFile = join(directory, 'empty.env');
  writeFileSync(envFile, '');
  const env = {
    ...process.env, CRUCIX_ENV_FILE: envFile, RUNS_DIR: join(directory, 'runs'), PORT: String(port), HOST: '127.0.0.1',
    NO_AUTO_OPEN: '1', AUTH_USER: '', AUTH_PASSWORD: '', LLM_PROVIDER: '', TELEGRAM_BOT_TOKEN: '',
    DISCORD_BOT_TOKEN: '', DISCORD_WEBHOOK_URL: '', TELEGRAM_OSINT_ENABLED: 'false', AISSTREAM_API_KEY: '',
  };
  const spawnServer = () => spawn(process.execPath, ['--import', new URL('./fixtures/block-network.mjs', import.meta.url).href, 'server.mjs'], {
    cwd: new URL('..', import.meta.url), windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const first = spawnServer();
  let firstLogs = '';
  first.stdout.on('data', chunk => firstLogs += chunk);
  first.stderr.on('data', chunk => firstLogs += chunk);
  t.after(async () => {
    const stopped = new Promise(resolve => first.once('exit', resolve));
    if (first.exitCode === null) { first.kill(); await stopped; }
    rmSync(directory, { recursive: true, force: true });
  });
  for (let i = 0; i < 150; i++) {
    if (first.exitCode !== null) assert.fail(`first server exited ${first.exitCode}: ${firstLogs}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
    } catch { /* still importing or binding */ }
    await new Promise(resolve => setTimeout(resolve, 100));
    if (i === 149) assert.fail(`first server never became ready: ${firstLogs}`);
  }
  const second = spawnServer();
  let secondLogs = '';
  second.stdout.on('data', chunk => secondLogs += chunk);
  second.stderr.on('data', chunk => secondLogs += chunk);
  const code = await new Promise(resolve => second.once('exit', resolve));
  assert.equal(code, 1);
  assert.match(secondLogs, /already running|már fut/);
});
