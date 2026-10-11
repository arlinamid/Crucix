import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { crucixHome, feedsSettingsPath, resolveRunsDir, settingsEnvPath } from '../lib/user-paths.mjs';
import { parseEnvContent, resolveTargetEnvPath, saveSettings, SettingsError, startSetupWebServer } from '../lib/setup-wizard.mjs';

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('npm test runs every file against its own empty profile, never the real ~/.crucix', () => {
  assert.match(process.env.CRUCIX_HOME || '', /crucix-test-home-/);
  assert.equal(resolveTargetEnvPath(), join(process.env.CRUCIX_HOME, '.env'));
});

test('settings live in CRUCIX_HOME or ~/.crucix; CRUCIX_ENV_FILE names the .env itself', () => {
  const home = resolve('/home/op');
  assert.equal(crucixHome({ env: {}, home }), join(home, '.crucix'));
  assert.equal(crucixHome({ env: { CRUCIX_HOME: '/srv/crucix' }, home }), resolve('/srv/crucix'));
  assert.equal(settingsEnvPath({ env: {}, home }), join(home, '.crucix', '.env'));
  assert.equal(settingsEnvPath({ env: { CRUCIX_HOME: '/srv/crucix' }, home }), join(resolve('/srv/crucix'), '.env'));
  assert.equal(settingsEnvPath({ env: { CRUCIX_HOME: '/srv/crucix', CRUCIX_ENV_FILE: '/etc/crucix.env' }, home }), resolve('/etc/crucix.env'));
  assert.equal(feedsSettingsPath({ env: { CRUCIX_HOME: '/srv/crucix' }, home }), join(resolve('/srv/crucix'), 'feeds.json'));
});

test('runs/ follows the configured dir, RUNS_DIR, CRUCIX_HOME, then a checkout\'s own runs/; an npm copy never uses its own', t => {
  const base = tempDir(t, 'crucix-paths-');
  const checkout = join(base, 'checkout');
  const home = join(base, 'home');
  mkdirSync(join(checkout, 'runs'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), '{}');
  assert.equal(resolveRunsDir({ root: checkout, configured: '/x/runs', env: { RUNS_DIR: '/y' }, home }), resolve('/x/runs'));
  assert.equal(resolveRunsDir({ root: checkout, env: { RUNS_DIR: '/y', CRUCIX_HOME: '/z' }, home }), resolve('/y'));
  assert.equal(resolveRunsDir({ root: checkout, env: { CRUCIX_HOME: '/z' }, home }), join(resolve('/z'), 'runs'));
  assert.equal(resolveRunsDir({ root: checkout, env: {}, home }), join(checkout, 'runs'));
  const packaged = join(base, 'node_modules', 'crucix');
  mkdirSync(join(packaged, 'runs'), { recursive: true });
  assert.equal(resolveRunsDir({ root: packaged, env: {}, home }), join(home, '.crucix', 'runs'));
  assert.ok(!resolveRunsDir({ root: packaged, env: {}, home }).includes(`${sep}node_modules${sep}`));
});

test('a checkout save writes the profile .env, never the project .env next to package.json', t => {
  const checkout = tempDir(t, 'crucix-checkout-env-');
  const home = tempDir(t, 'crucix-home-env-');
  writeFileSync(join(checkout, 'package.json'), '{}');
  writeFileSync(join(checkout, '.env'), 'PORT=3117\n');
  const target = settingsEnvPath({ env: {}, home });
  saveSettings(target, { PORT: '3200' });
  assert.equal(parseEnvContent(readFileSync(target, 'utf8')).values.PORT, '3200');
  assert.equal(parseEnvContent(readFileSync(join(checkout, '.env'), 'utf8')).values.PORT, '3117');
  assert.equal(target, join(home, '.crucix', '.env'));
});

test('saveSettings writes one-line values under upper-case names only, and only to the file it is given', t => {
  const dir = tempDir(t, 'crucix-save-');
  const target = join(dir, 'nested', '.env');
  assert.equal(saveSettings(target, { PORT: 3200, LLM_PROVIDER: 'openai', EMPTY: null }), resolve(target));
  const values = parseEnvContent(readFileSync(target, 'utf8')).values;
  assert.deepEqual([values.PORT, values.LLM_PROVIDER, values.EMPTY], ['3200', 'openai', '']);
  assert.throws(() => saveSettings(target, { TOKEN: 'abc\nNODE_OPTIONS=--require ./evil.js' }), SettingsError, 'a line break would add a setting of its own');
  assert.throws(() => saveSettings(target, { 'lower_case': 'x' }), SettingsError);
  assert.throws(() => saveSettings(target, { 'A=B': 'x' }), SettingsError);
  assert.throws(() => saveSettings(target, { KEY: { nested: true } }), SettingsError);
  assert.throws(() => saveSettings(target, ['PORT']), SettingsError);
  assert.ok(!readFileSync(target, 'utf8').includes('NODE_OPTIONS'));
  const other = join(process.env.CRUCIX_HOME, '.env');
  assert.ok(!existsSync(other), 'an explicit file is the only one written: nothing is mirrored into the profile');
});

function rawRequest(port, { method = 'GET', path = '/api/setup/config', headers = {}, body = null } = {}) {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', fail);
    if (body !== null) req.write(body);
    req.end();
  });
}

test('the standalone setup server answers its own localhost page only', async t => {
  const dir = tempDir(t, 'crucix-standalone-');
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'TELEGRAM_BOT_TOKEN=secret-token\n');
  const server = await startSetupWebServer({ port: 39191, envPath, autoOpen: false });
  t.after(() => server.close());
  const { port } = server;
  const json = { 'Content-Type': 'application/json' };

  const own = await rawRequest(port, { headers: { Host: `localhost:${port}` } });
  assert.equal(own.status, 200);
  assert.equal(own.headers['access-control-allow-origin'], undefined, 'no page on another site may read the keys');
  assert.equal(JSON.parse(own.text).values.TELEGRAM_BOT_TOKEN, 'secret-token');

  const rebound = await rawRequest(port, { headers: { Host: `attacker.example:${port}` } });
  assert.equal(rebound.status, 403, 'a DNS-rebinding name is refused');
  assert.ok(!rebound.text.includes('secret-token'));

  const save = body => rawRequest(port, { method: 'POST', path: '/api/setup/save', headers: { ...json, Host: `localhost:${port}`, ...body.headers }, body: body.text ?? '{"PORT":"3300"}' });
  assert.equal((await save({ headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await save({ headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await save({ headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await save({ text: '{broken' })).status, 400);
  assert.equal((await save({ text: JSON.stringify({ BIG: 'x'.repeat(40 * 1024) }) })).status, 413);
  assert.equal((await save({ text: JSON.stringify({ KEY: 'a\nB=c' }) })).status, 400);
  assert.equal((await save({ headers: { Origin: `http://localhost:${port}`, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal(parseEnvContent(readFileSync(envPath, 'utf8')).values.PORT, '3300');
  const exit = await rawRequest(port, { method: 'POST', path: '/api/setup/exit', headers: { Host: `localhost:${port}`, Origin: 'https://evil.example', ...json }, body: '{}' });
  assert.equal(exit.status, 403, 'another site cannot stop the wizard either');
});
