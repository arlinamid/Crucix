// Dashboard static assets path resolver and embedded extractor
// Ensures jarvis.html, CSS, JS, and vendor assets are always available whether running:
// 1. In source / developer checkout
// 2. Installed in ~/.crucix or ~/.local/bin
// 3. Running as a standalone SEA binary on a clean machine without repo source

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { DASHBOARD_ASSETS_GZIP_B64 } from './embedded-dashboard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let cachedDashboardDir = null;

export function resolveDashboardPublicDir() {
  if (cachedDashboardDir && existsSync(join(cachedDashboardDir, 'jarvis.html'))) {
    return cachedDashboardDir;
  }

  // 1. Check explicit environment override
  if (process.env.CRUCIX_DASHBOARD_DIR && existsSync(join(process.env.CRUCIX_DASHBOARD_DIR, 'jarvis.html'))) {
    cachedDashboardDir = resolve(process.env.CRUCIX_DASHBOARD_DIR);
    return cachedDashboardDir;
  }

  // 2. Candidate paths to check on disk
  const candidates = [
    join(ROOT, 'dashboard', 'public'),
    join(process.cwd(), 'dashboard', 'public'),
    join(homedir(), '.crucix', 'dashboard', 'public'),
    join(dirname(process.execPath), 'dashboard', 'public'),
    join(dirname(process.execPath), '..', 'dashboard', 'public'),
    join(dirname(process.execPath), '..', 'share', 'crucix', 'dashboard', 'public'),
  ];

  for (const dir of candidates) {
    if (existsSync(join(dir, 'jarvis.html'))) {
      cachedDashboardDir = dir;
      return cachedDashboardDir;
    }
  }

  // 3. Fallback: unpack embedded assets to ~/.crucix/dashboard/public
  const targetDir = join(homedir(), '.crucix', 'dashboard', 'public');
  unpackEmbeddedDashboard(targetDir);
  cachedDashboardDir = targetDir;
  return cachedDashboardDir;
}

export function unpackEmbeddedDashboard(targetDir) {
  if (!DASHBOARD_ASSETS_GZIP_B64) return;
  try {
    const gzipped = Buffer.from(DASHBOARD_ASSETS_GZIP_B64, 'base64');
    const jsonStr = zlib.gunzipSync(gzipped).toString('utf8');
    const files = JSON.parse(jsonStr);

    for (const [relPath, b64Data] of Object.entries(files)) {
      const fullPath = join(targetDir, relPath);
      const parentDir = dirname(fullPath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
      writeFileSync(fullPath, Buffer.from(b64Data, 'base64'));
    }
  } catch (err) {
    console.error('[Crucix] Failed to unpack embedded dashboard assets:', err.message);
  }
}

export function getJarvisHtmlPath() {
  return join(resolveDashboardPublicDir(), 'jarvis.html');
}

export function readJarvisHtml() {
  return readFileSync(getJarvisHtmlPath(), 'utf8');
}
