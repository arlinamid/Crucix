#!/usr/bin/env node
// Syncs dashboard/public/setup.html into lib/setup-html.mjs as embedded fallback
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const htmlPath = join(ROOT, 'dashboard', 'public', 'setup.html');
const outPath = join(ROOT, 'lib', 'setup-html.mjs');

const htmlContent = readFileSync(htmlPath, 'utf8');

const outputCode = `// Embedded Setup HTML provider
// Supports live disk lookup for development and embedded fallback for standalone binary (SEA).

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

export const EMBEDDED_SETUP_HTML = ${JSON.stringify(htmlContent)};

export function getSetupHtml() {
  const candidatePaths = [
    process.env.CRUCIX_SETUP_HTML,
    join(ROOT, 'dashboard', 'public', 'setup.html'),
    join(process.cwd(), 'dashboard', 'public', 'setup.html'),
  ].filter(Boolean);

  for (const p of candidatePaths) {
    if (existsSync(p)) {
      try {
        return readFileSync(p, 'utf8');
      } catch {}
    }
  }

  return EMBEDDED_SETUP_HTML;
}
`;

writeFileSync(outPath, outputCode, 'utf8');
console.log('✅ lib/setup-html.mjs synchronized with dashboard/public/setup.html');
