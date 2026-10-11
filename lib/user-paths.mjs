// Where Crucix keeps the operator's own files.
//   Settings — the .env the setup page and the wizard write, feeds.json of Settings > News feeds — live in the profile:
//   CRUCIX_HOME, else ~/.crucix (%USERPROFILE%\.crucix on Windows). CRUCIX_ENV_FILE names the .env file itself.
//   Sweep output (runs/) follows RUNS_DIR, then CRUCIX_HOME/runs; a source checkout that already has a runs/ folder keeps
//   using it, a copy installed from npm never writes next to its code.
// A variable set in the environment itself always beats any .env file (apis/utils/env.mjs never overwrites one).

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isPackageInstall } from './install-mode.mjs';

export function crucixHome({ env = process.env, home = homedir() } = {}) {
  return env.CRUCIX_HOME ? resolve(env.CRUCIX_HOME) : join(home, '.crucix');
}

/** The .env file settings are saved to. */
export function settingsEnvPath(options = {}) {
  const env = options.env ?? process.env;
  return env.CRUCIX_ENV_FILE ? resolve(env.CRUCIX_ENV_FILE) : join(crucixHome(options), '.env');
}

/** feeds.json: the feeds switched off and the operator's own feeds. */
export function feedsSettingsPath(options = {}) {
  return join(crucixHome(options), 'feeds.json');
}

export function resolveRunsDir({ root, configured = null, env = process.env, home = homedir() } = {}) {
  if (configured) return resolve(configured);
  if (env.RUNS_DIR) return resolve(env.RUNS_DIR);
  if (env.CRUCIX_HOME) return join(resolve(env.CRUCIX_HOME), 'runs');
  const packaged = isPackageInstall(root);
  const projectRuns = join(root, 'runs');
  if (!packaged && existsSync(projectRuns)) return projectRuns;
  const userRuns = join(home, '.crucix', 'runs');
  if (existsSync(userRuns)) return userRuns;
  return !packaged && existsSync(join(root, 'package.json')) ? projectRuns : userRuns;
}
