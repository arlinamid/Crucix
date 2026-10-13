// Runs scripts/cli.mjs as a subprocess for the e2e tests and resolves with { code, stdout, stderr }.
// The child gets its own profile (CRUCIX_HOME) and runs/ folder; an optional preload (node --import) stubs the network.
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI = join(ROOT, 'scripts', 'cli.mjs');
export const STUB_FETCH = join(ROOT, 'test', 'helpers', 'stub-feed-fetch.mjs');
export const OFFLINE_FETCH = join(ROOT, 'test', 'helpers', 'stub-offline-fetch.mjs');

export function childEnv({ workdir, runsDir, env = {} }) {
  const merged = { ...process.env, CRUCIX_HOME: join(workdir, 'home'), RUNS_DIR: runsDir, NO_COLOR: '1', CRUCIX_LANG: 'en', LANG: 'en_US.UTF-8', ...env };
  delete merged.CRUCIX_ENV_FILE;
  if (env.PORT === undefined) delete merged.PORT;
  return merged;
}

// On Windows --import needs a file:// URL, a drive-letter path is read as a URL scheme.
export const nodeArgs = (args, preload) => [...(preload ? ['--import', pathToFileURL(preload).href] : []), CLI, ...args];

export function runCli(args, { workdir, runsDir, preload = null, env = {}, timeout = 30_000 }) {
  return new Promise(done => {
    execFile(process.execPath, nodeArgs(args, preload), { env: childEnv({ workdir, runsDir, env }), cwd: workdir, timeout }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}
