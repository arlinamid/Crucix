// `crucix install`: the user profile an npm install runs from. Only configuration (.env) and runtime data (runs/) live
// there; the code stays in the package. An existing .env is never overwritten.

import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { crucixHome as profileHome } from './user-paths.mjs';

export function profileDir({ home = homedir(), crucixHome = process.env.CRUCIX_HOME } = {}) {
  return profileHome({ env: { CRUCIX_HOME: crucixHome }, home });
}

export function installUserProfile({ root, home = homedir(), crucixHome = process.env.CRUCIX_HOME } = {}) {
  const dir = profileDir({ home, crucixHome });
  const runs = join(dir, 'runs');
  const env = join(dir, '.env');
  mkdirSync(runs, { recursive: true });
  let envCreated = false;
  if (!existsSync(env)) {
    const example = root ? join(root, '.env.example') : null;
    if (example && existsSync(example)) copyFileSync(example, env);
    else writeFileSync(env, '# Crucix Environment Configuration\n', 'utf8');
    envCreated = true;
  }
  // API keys and bot tokens: readable by the owner only (a no-op on Windows).
  try { chmodSync(env, 0o600); } catch { /* not supported on this file system */ }
  return { dir, runs, env, envCreated };
}
