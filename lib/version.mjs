import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The package.json version, or CRUCIX_VERSION when the SEA binary has no package.json beside it. */
export function packageVersion() {
  const baked = process.env.CRUCIX_VERSION;
  if (baked) return baked;
  const pkgPath = join(ROOT, 'package.json');
  if (!existsSync(pkgPath)) return '0.0.0';
  try {
    return String(JSON.parse(readFileSync(pkgPath, 'utf8')).version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

export function versionLine() {
  return `crucix ${packageVersion()}`;
}
