// Load .env file for API keys
// Searches: explicit CRUCIX_ENV_FILE alone; otherwise the settings file first (CRUCIX_HOME/.env, else
// %USERPROFILE%\.crucix\.env or ~/.crucix/.env), then cwd .env, project root .env, ~/.crucix.env, apis/.env.
// The first file that sets a key wins, so what the setup page and the wizard save there (lib/user-paths.mjs) is what
// runs; a variable already set in the environment beats every file.
import { readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { crucixHome } from '../../lib/user-paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getEnvSearchPaths({ envFile = process.env.CRUCIX_ENV_FILE, cwd = process.cwd(), home = homedir(), crucixHomeDir = process.env.CRUCIX_HOME } = {}) {
  if (envFile) return [resolve(envFile)];
  const candidates = [
    join(crucixHome({ env: { CRUCIX_HOME: crucixHomeDir }, home }), '.env'),
    resolve(cwd, '.env'),
    resolve(__dirname, '..', '..', '.env'), // project root
    join(home, '.crucix.env'),              // %USERPROFILE%\.crucix.env or ~/.crucix.env
    resolve(__dirname, '..', '.env'),       // apis/.env (legacy)
  ];
  const seen = new Set();
  const paths = [];
  for (const p of candidates) {
    const normalized = resolve(p);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      paths.push(normalized);
    }
  }
  return paths;
}

export function parseEnvLine(line) {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (!match) return null;
  let value = match[2].trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    const end = value.lastIndexOf(quote);
    if (end > 0) value = value.slice(1, end);
  } else value = value.replace(/\s+#.*$/, '').trim();
  return { key: match[1], value };
}

function loadEnv(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    let loaded = 0;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parsed = parseEnvLine(trimmed);
      if (!parsed) continue;
      if (process.env[parsed.key] === undefined) { process.env[parsed.key] = parsed.value; loaded++; }
    }
    return loaded;
  } catch { return -1; }
}

/** The values the .env files set, merged in search order (first file wins): what the setup page shows as current. */
export function readEnvFileValues(paths = getEnvSearchPaths()) {
  const values = {};
  for (const p of [...paths].reverse()) {
    let content;
    try { content = readFileSync(p, 'utf-8'); } catch { continue; }
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parsed = parseEnvLine(trimmed);
      if (parsed) values[parsed.key] = parsed.value;
    }
  }
  return values;
}

export function loadAllEnv(paths = getEnvSearchPaths()) {
  let anyLoaded = false;
  for (const p of paths) {
    const loaded = loadEnv(p);
    if (loaded >= 0) anyLoaded = true;
  }
  return anyLoaded;
}

loadAllEnv();
