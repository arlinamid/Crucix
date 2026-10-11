// Small JSON files in CRUCIX_HOME/cache so daily quotas survive a process restart.
// Tests use isolate-profile.mjs, so writes stay in a temp home.

import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { crucixHome } from '../../lib/user-paths.mjs';

const NAME = /^[a-z0-9-]{1,40}$/;
const MAX_BYTES = 256 * 1024;

export function quotaCachePath(name, options) {
  if (!NAME.test(name)) throw new Error(`invalid quota cache name: ${name}`);
  return join(crucixHome(options), 'cache', `${name}.json`);
}

export function readQuota(name, options) {
  try {
    const raw = readFileSync(quotaCachePath(name, options), 'utf8');
    if (raw.length > MAX_BYTES) return null;
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

export function writeQuota(name, value, options) {
  try {
    const dir = join(crucixHome(options), 'cache');
    mkdirSync(dir, { recursive: true });
    const text = JSON.stringify(value);
    if (text.length > MAX_BYTES) return false;
    writeFileSync(quotaCachePath(name, options), text);
    return true;
  } catch {
    return false;
  }
}

export function clearQuota(name, options) {
  try { unlinkSync(quotaCachePath(name, options)); } catch { /* missing is fine */ }
}
