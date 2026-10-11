import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { FORBIDDEN, auditPackFiles, distTagFor, parsePublishArgs, refMatchesVersion } from '../scripts/publish-npm.mjs';
import { isPackageInstall } from '../lib/install-mode.mjs';
import { installUserProfile, profileDir } from '../lib/profile-install.mjs';
import { parseArgs } from '../scripts/cli.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const required = ['package.json', 'scripts/cli.mjs', 'server.mjs', 'crucix.config.mjs', '.env.example', 'dashboard/public/jarvis.html'];
const files = (...extra) => [...required, ...extra].map(path => ({ path, size: 100 }));

test('package.json ships the crucix bin, a strict file list and public provenance', () => {
  assert.deepEqual(pkg.bin, { crucix: 'scripts/cli.mjs' });
  assert.ok(readFileSync(new URL('../scripts/cli.mjs', import.meta.url), 'utf8').startsWith('#!/usr/bin/env node\n'));
  assert.deepEqual(pkg.publishConfig, { access: 'public', provenance: true });
  for (const entry of ['apis/', 'lib/', 'data/', 'dashboard/', 'locales/', 'scripts/', 'server.mjs', 'crucix.config.mjs', '.env.example']) assert.ok(pkg.files.includes(entry), entry);
  for (const entry of ['test/', 'runs/', 'bin/', 'docs/', '.env']) assert.ok(!pkg.files.includes(entry), entry);
  for (const entry of ['!**/.env', '!**/*.pem', '!**/*.key', '!scripts/publish-npm.mjs']) assert.ok(pkg.files.includes(entry), entry);
  assert.equal(pkg.scripts['publish:manual'], 'node scripts/publish-npm.mjs --manual');
  assert.equal(pkg.scripts['pack:audit'], 'node scripts/publish-npm.mjs --dry-run');
  assert.match(pkg.repository.url, /^git\+https:\/\/github\.com\/[^/]+\/Crucix\.git$/);
});

test('the pack audit rejects secrets, runtime data, binaries and tests, and requires the runtime files', () => {
  assert.deepEqual(auditPackFiles(files('lib/a.mjs', '.env.example')).problems, []);
  const bad = ['.env', 'apis/.env', '.env.production', 'runs/latest.json', 'lib/server.pem', 'certs/tls.key', 'bin/crucix.exe', 'test/a.test.mjs',
    'lib/a.test.mjs', '.npmrc', 'node_modules/x/index.js', 'lib/feeds.json.bak', 'docs/API.md', '.github/workflows/ci.yml', 'lib/id_rsa'];
  const { problems } = auditPackFiles(files(...bad));
  assert.deepEqual(problems.map(problem => problem.path).sort(), [...bad].sort());
  const missing = auditPackFiles([{ path: 'lib/a.mjs', size: 1 }]).problems.map(problem => problem.path);
  assert.deepEqual(missing, required);
  assert.match(auditPackFiles(files(), { maxBytes: 100 }).problems.at(-1).why, /unpacked size/);
  assert.match(auditPackFiles([...files(), { path: 'data/huge.json', size: 9 * 1048576 }]).problems[0].why, /larger than 8 MB/);
  assert.ok(FORBIDDEN.every(rule => rule.pattern instanceof RegExp && rule.why));
});

test('the dist-tag, the release ref and the publish options are validated', () => {
  assert.equal(distTagFor('2.39.0'), 'latest');
  assert.equal(distTagFor('2.39.0-rc.1'), 'next');
  assert.equal(distTagFor('2.39.0', 'beta'), 'beta');
  for (const tag of ['1.2.3', 'v2', 'a b', 'x;rm -rf', '']) assert.throws(() => distTagFor('1.0.0', tag || '-'), /Invalid dist-tag/);
  assert.ok(refMatchesVersion('v2.39.0', '2.39.0') && refMatchesVersion('refs/tags/v2.39.0', '2.39.0'));
  assert.ok(!refMatchesVersion('v2.39.1', '2.39.0') && !refMatchesVersion('', '2.39.0'));
  assert.deepEqual(parsePublishArgs(['--manual', '--otp', '123456']), { mode: 'manual', dryRun: false, otp: '123456', tag: null, ref: null });
  assert.deepEqual(parsePublishArgs(['--ci', '--dry-run', '--tag=next']), { mode: 'ci', dryRun: true, otp: null, tag: 'next', ref: null });
  assert.equal(parsePublishArgs(['--dry-run']).mode, null);
  assert.throws(() => parsePublishArgs([]), /Choose/);
  assert.throws(() => parsePublishArgs(['--manual', '--dry-run']), /pack:audit/);
  assert.throws(() => parsePublishArgs(['--manual', '--otp', '12&calc']), /6-8 digit/);
  assert.throws(() => parsePublishArgs(['--manual', '--otp']), /needs a value/);
  assert.throws(() => parsePublishArgs(['--ci', '--tag', '$(id)']), /Invalid dist-tag/);
  assert.throws(() => parsePublishArgs(['--force']), /Unknown option/);
});

test('the publish-npm job runs after the gates, in the npm environment, with only read and id-token rights', () => {
  const job = workflow.slice(workflow.indexOf('\n  publish-npm:'), workflow.indexOf('\n  ci-gate:'));
  assert.match(job, /needs: \[syntax-and-lint, test, security-audit, package-executables\]/);
  assert.match(job, /if: startsWith\(github\.ref, 'refs\/tags\/v'\) \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.publish_npm\)/);
  assert.match(job, /environment:\n\s+name: npm/);
  assert.match(job, /permissions:\n\s+contents: read\n\s+id-token: write\n/);
  assert.doesNotMatch(job, /NODE_AUTH_TOKEN:/, 'OIDC trusted publishing: a 2FA token would fail with EOTP');
  assert.match(job, /node scripts\/publish-npm\.mjs "\$\{args\[@\]\}"/);
  assert.match(job, /persist-credentials: false/);
  const script = job.slice(job.lastIndexOf('run: |'));
  assert.doesNotMatch(script, /\$\{\{/, 'dispatch inputs reach the shell only through env variables');
  for (const input of ['publish_npm:', 'dry_run:', 'tag_override:']) assert.ok(workflow.includes(`      ${input}`), input);
});

test('an install under node_modules keeps .env and runs/ in the user profile', () => {
  assert.equal(isPackageInstall(`${sep}home${sep}me${sep}.npm${sep}_npx${sep}abc${sep}node_modules${sep}crucix`), true);
  assert.equal(isPackageInstall(`C:${sep}tools${sep}Crucix`), false);
  const dir = mkdtempSync(join(tmpdir(), 'crucix-profile-'));
  try {
    const root = mkdtempSync(join(tmpdir(), 'crucix-root-'));
    writeFileSync(join(root, '.env.example'), 'PORT=3117\n');
    const first = installUserProfile({ root, crucixHome: join(dir, 'p') });
    assert.equal(first.dir, profileDir({ crucixHome: join(dir, 'p') }));
    assert.ok(first.envCreated && existsSync(first.runs) && statSync(first.runs).isDirectory());
    assert.equal(readFileSync(first.env, 'utf8'), 'PORT=3117\n');
    writeFileSync(first.env, 'TELEGRAM_BOT_TOKEN=secret\n');
    const again = installUserProfile({ root, crucixHome: join(dir, 'p') });
    assert.equal(again.envCreated, false);
    assert.equal(readFileSync(again.env, 'utf8'), 'TELEGRAM_BOT_TOKEN=secret\n');
    if (process.platform !== 'win32') assert.equal(statSync(again.env).mode & 0o777, 0o600);
    assert.equal(profileDir({ home: dir, crucixHome: '' }), join(dir, '.crucix'));
    rmSync(root, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI takes install and --no-setup without reading them as a country or category', () => {
  const opts = parseArgs(['install', '--no-setup']);
  assert.deepEqual([opts.install, opts.noSetup, opts.country, opts.category], [true, true, null, null]);
  assert.equal(parseArgs(['UA']).country, 'UA');
});
