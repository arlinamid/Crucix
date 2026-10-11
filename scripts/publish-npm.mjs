#!/usr/bin/env node
// Publishes Crucix to npm, and audits what would be published.
//
//   node scripts/publish-npm.mjs --dry-run           pack audit only (npm run pack:audit)
//   node scripts/publish-npm.mjs --manual [--otp N]  local release: clean tree, check, tests, audit, confirm, publish
//   node scripts/publish-npm.mjs --ci [--dry-run]    GitHub Actions (environment "npm"): tag check, audit, publish with provenance
//
// Options: --tag <dist-tag> (default: latest, or next for a prerelease), --ref <v1.2.3> (CI: the tag being released,
// default GITHUB_REF_NAME). A version already on the registry is skipped, not an error. CI publishes through GitHub
// OIDC (npm Trusted Publisher: repo arlinamid/Crucix, workflow ci.yml, environment npm). A classic token with 2FA
// cannot publish from Actions (EOTP); do not set NODE_AUTH_TOKEN on the publish step.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_PACKAGE_BYTES = 40 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const REQUIRED_FILES = ['package.json', 'scripts/cli.mjs', 'server.mjs', 'crucix.config.mjs', '.env.example', 'dashboard/public/jarvis.html'];

// Paths that must never reach the registry: secrets, runtime data, binaries and development files.
export const FORBIDDEN = Object.freeze([
  { pattern: /(^|\/)\.env$/, why: 'environment file with secrets' },
  { pattern: /(^|\/)\.env\.(?!example$)[^/]+$/, why: 'environment file with secrets' },
  { pattern: /(^|\/)\.npmrc$/, why: 'npm credentials file' },
  { pattern: /\.(pem|key|p12|pfx|crt|cer|jks|keystore)$/i, why: 'key or certificate' },
  { pattern: /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/, why: 'SSH key' },
  { pattern: /\.(exe|dll|so|dylib|node|blob|zip|7z|tar|tgz|gz)$/i, why: 'binary or archive' },
  { pattern: /^(runs|test|tests|bin|dist|docs|node_modules|\.git|\.github)\//, why: 'not part of the runtime package' },
  { pattern: /(^|\/)node_modules\//, why: 'bundled dependency' },
  { pattern: /\.(bak|tmp|log|orig|swp)$/i, why: 'temporary or backup file' },
  { pattern: /(^|\/)(latest|briefing)[^/]*\.json$/, why: 'sweep output' },
  { pattern: /\.test\.m?js$/, why: 'test file' },
]);

/** The problems in an `npm pack --json` file list: forbidden paths, oversized files, missing runtime files. */
export function auditPackFiles(files, { maxBytes = MAX_PACKAGE_BYTES, maxFileBytes = MAX_FILE_BYTES, required = REQUIRED_FILES } = {}) {
  const problems = [];
  let totalBytes = 0;
  const paths = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    const path = String(file?.path ?? '').replace(/\\/g, '/');
    const size = Number(file?.size) || 0;
    paths.add(path);
    totalBytes += size;
    const rule = FORBIDDEN.find(item => item.pattern.test(path));
    if (rule) problems.push({ path, why: rule.why });
    else if (size > maxFileBytes) problems.push({ path, why: `larger than ${Math.round(maxFileBytes / 1048576)} MB` });
  }
  for (const path of required) if (!paths.has(path)) problems.push({ path, why: 'required runtime file missing' });
  if (totalBytes > maxBytes) problems.push({ path: '(package)', why: `unpacked size ${(totalBytes / 1048576).toFixed(1)} MB over ${Math.round(maxBytes / 1048576)} MB` });
  return { problems, totalBytes, fileCount: paths.size };
}

/** The dist-tag: an explicit one, else `next` for a prerelease (1.2.3-rc.1) and `latest` otherwise. */
export function distTagFor(version, override = null) {
  if (override) {
    if (!/^[a-z][a-z0-9._-]{0,63}$/i.test(override) || /^v?\d/.test(override)) throw new Error(`Invalid dist-tag: ${override}`);
    return override;
  }
  return String(version).includes('-') ? 'next' : 'latest';
}

/** Whether a release ref (v1.2.3, refs/tags/v1.2.3) names this version. */
export function refMatchesVersion(ref, version) {
  const name = String(ref ?? '').replace(/^refs\/tags\//, '');
  return name === `v${version}` || name === version;
}

export function parsePublishArgs(argv) {
  const opts = { mode: null, dryRun: false, otp: null, tag: null, ref: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--manual') opts.mode = 'manual';
    else if (arg === '--ci') opts.mode = 'ci';
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--otp') opts.otp = value();
    else if (arg.startsWith('--otp=')) opts.otp = arg.slice(6);
    else if (arg === '--tag') opts.tag = value();
    else if (arg.startsWith('--tag=')) opts.tag = arg.slice(6);
    else if (arg === '--ref') opts.ref = value();
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!opts.mode && !opts.dryRun) throw new Error('Choose --manual, --ci or --dry-run');
  if (opts.mode === 'manual' && opts.dryRun) throw new Error('--manual publishes; use npm run pack:audit for a dry run');
  if (opts.otp !== null && !/^\d{6,8}$/.test(opts.otp)) throw new Error('--otp takes the 6-8 digit code from your authenticator');
  if (opts.tag !== null) distTagFor('0.0.0', opts.tag);
  return opts;
}

// npm through the same Node when run as an npm script; otherwise npm on PATH (a .cmd shim on Windows needs the shell,
// which is safe here: every argument is validated above or comes from package.json).
function npm(args, { capture = true, env = process.env } = {}) {
  const execPath = process.env.npm_execpath;
  const [command, fullArgs, shell] = execPath && /\.c?js$/.test(execPath)
    ? [process.execPath, [execPath, ...args], false]
    : [process.platform === 'win32' ? 'npm.cmd' : 'npm', args, process.platform === 'win32'];
  return spawnSync(command, fullArgs, { cwd: ROOT, env, shell, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', maxBuffer: 64 * 1024 * 1024 });
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function step(label) {
  console.log(`\n▶ ${label}`);
}

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function readPackage() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
}

function packAudit() {
  step('Pack audit (npm pack --dry-run --json)');
  const result = npm(['pack', '--dry-run', '--json', '--ignore-scripts']);
  if (result.status !== 0) fail(`npm pack failed:\n${result.stderr}`);
  let report;
  try { report = JSON.parse(result.stdout)[0]; } catch { fail('npm pack did not return JSON'); }
  const audit = auditPackFiles(report.files);
  console.log(`  ${audit.fileCount} files, ${(audit.totalBytes / 1048576).toFixed(1)} MB unpacked, ${(report.size / 1048576).toFixed(1)} MB packed`);
  if (audit.problems.length) {
    for (const problem of audit.problems) console.error(`  ✖ ${problem.path}: ${problem.why}`);
    fail(`The package would contain ${audit.problems.length} file(s) that must not be published`);
  }
  const cli = readFileSync(join(ROOT, 'scripts', 'cli.mjs'), 'utf8');
  if (!cli.startsWith('#!/usr/bin/env node\n')) {
    fail(cli.startsWith('#!/usr/bin/env node\r')
      ? 'scripts/cli.mjs has CRLF line endings, which break the crucix bin on Linux and macOS: run git add --renormalize . and check out again'
      : 'scripts/cli.mjs (the crucix bin) lacks its #!/usr/bin/env node line');
  }
  console.log('  ✔ no secrets, runtime data, binaries or tests; runtime files present');
  return report;
}

/** 'published', 'absent', or an Error for a registry that could not be asked. */
function registryState(name, version) {
  const result = npm(['view', `${name}@${version}`, 'version', '--json']);
  if (result.status === 0) return result.stdout.trim() ? 'published' : 'absent';
  if (/E404|404 Not Found/.test(`${result.stdout}${result.stderr}`)) return 'absent';
  return new Error(result.stderr.trim().split('\n').slice(-3).join(' '));
}

function runGate(label, script) {
  step(label);
  const result = npm(['run', script], { capture: false });
  if (result.status !== 0) fail(`npm run ${script} failed`);
}

async function confirm(version, tag) {
  if (!process.stdin.isTTY) fail('A manual publish needs an interactive terminal for the confirmation');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`\nPublish crucix@${version} with dist-tag "${tag}" to the public npm registry?\nType the version to confirm: `);
    return answer.trim() === version;
  } finally {
    rl.close();
  }
}

async function manual(opts, pkg) {
  step('Git working tree');
  const status = git(['status', '--porcelain']);
  if (status === null) fail('git is not available');
  if (status) fail(`The working tree has uncommitted changes:\n${status}`);
  const head = git(['describe', '--exact-match', '--tags', 'HEAD']);
  console.log(head && refMatchesVersion(head, pkg.version) ? `  ✔ clean, HEAD is ${head}` : `  ✔ clean (HEAD is not tagged v${pkg.version}; tag it after publishing)`);
  runGate('npm run check', 'check');
  runGate('npm test', 'test');
  packAudit();
  step('Registry');
  const state = registryState(pkg.name, pkg.version);
  if (state instanceof Error) fail(`Could not ask the registry: ${state.message}`);
  if (state === 'published') {
    console.log(`  crucix@${pkg.version} is already on npm; bump the version first. Nothing published.`);
    return;
  }
  const who = npm(['whoami']);
  if (who.status !== 0) fail('Not logged in to npm: run npm login first');
  console.log(`  ✔ ${pkg.name}@${pkg.version} is new; logged in as ${who.stdout.trim()}`);
  const tag = distTagFor(pkg.version, opts.tag);
  if (!(await confirm(pkg.version, tag))) fail('Not confirmed; nothing published');
  // Provenance needs a CI identity (OIDC); a publish from a workstation goes out without it.
  const args = ['publish', '--access', 'public', '--tag', tag, '--provenance=false', ...(opts.otp ? ['--otp', opts.otp] : [])];
  step(`npm ${args.filter(arg => !/^\d{6,8}$/.test(arg)).join(' ')}`);
  const result = npm(args, { capture: false });
  if (result.status !== 0) fail('npm publish failed');
  console.log(`\n✔ Published ${pkg.name}@${pkg.version} (${tag})`);
}

function ci(opts, pkg) {
  const ref = opts.ref ?? (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null);
  step('Release ref');
  if (ref) {
    if (!refMatchesVersion(ref, pkg.version)) fail(`Tag ${ref} does not match package.json version ${pkg.version}`);
    console.log(`  ✔ ${ref} matches ${pkg.version}`);
  } else {
    console.log(`  manual dispatch: publishing package.json version ${pkg.version}`);
  }
  packAudit();
  step('Registry');
  const state = registryState(pkg.name, pkg.version);
  if (state instanceof Error) fail(`Could not ask the registry: ${state.message}`);
  if (state === 'published') {
    console.log(`  ${pkg.name}@${pkg.version} is already on npm; skipping.`);
    return;
  }
  const tag = distTagFor(pkg.version, opts.tag);
  // actions/setup-node puts a placeholder in NODE_AUTH_TOKEN when no token is given. A real classic token with
  // 2FA still required makes `npm publish` fail with EOTP; GitHub OIDC (trusted publishing) does not.
  const oidc = Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  const token = [process.env.NODE_AUTH_TOKEN, process.env.NPM_TOKEN].find(value => value && !/^X{5}(-X{5})+$/.test(value));
  if (!oidc && !token) {
    console.log('  ::warning::No GitHub OIDC audience and no NPM_ACCESS_TOKEN; skipping the publish.');
    return;
  }
  if (oidc) console.log('  Using GitHub OIDC trusted publishing (no access token, so no 2FA OTP).');
  const args = ['publish', '--provenance', '--access', 'public', '--tag', tag, ...(opts.dryRun ? ['--dry-run'] : [])];
  step(`npm ${args.join(' ')}`);
  const env = { ...process.env };
  if (oidc) {
    delete env.NODE_AUTH_TOKEN;
    delete env.NPM_TOKEN;
    delete env.NPM_ACCESS_TOKEN;
    // setup-node's registry-url writes always-auth + ${NODE_AUTH_TOKEN} into this file; that blocks OIDC.
    delete env.NPM_CONFIG_USERCONFIG;
  } else {
    env.NODE_AUTH_TOKEN = token;
  }
  const result = npm(args, { capture: false, env });
  if (result.status !== 0) {
    fail(oidc
      ? 'npm publish failed. On npmjs.com → crucix → Trusted Publisher, add GitHub Actions: repository arlinamid/Crucix, workflow filename ci.yml, environment name npm.'
      : 'npm publish failed. A token that still requires 2FA needs --otp; use a granular Automation token that bypasses 2FA, or trusted publishing.');
  }
  console.log(`\n✔ ${opts.dryRun ? 'Dry run of' : 'Published'} ${pkg.name}@${pkg.version} (${tag})`);
}

async function main() {
  let opts;
  try { opts = parsePublishArgs(process.argv.slice(2)); } catch (error) { fail(error.message); }
  const pkg = readPackage();
  console.log(`crucix publish — ${pkg.name}@${pkg.version} (${opts.mode ?? 'audit'}${opts.dryRun ? ', dry run' : ''})`);
  if (opts.mode === 'manual') return manual(opts, pkg);
  if (opts.mode === 'ci') return ci(opts, pkg);
  packAudit();
  console.log('\n✔ Pack audit passed; nothing published');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => fail(error.message));
}
