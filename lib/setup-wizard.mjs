// Crucix Interactive Setup Wizard & Configuration Assistant
// Guides users step-by-step through configuring .env (Language, AI, Telegram, Discord, API keys)
// Features: 1-click browser link opening, standalone web UI setup server, and Express routes.

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './open-browser.mjs';
import { getSetupHtml } from './setup-html.mjs';
import { requireSameOriginJson } from './http-security.mjs';
import { settingsEnvPath } from './user-paths.mjs';
import { getEnvSearchPaths, readEnvFileValues } from '../apis/utils/env.mjs';

export { getSetupHtml };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/**
 * Parses an existing .env file into a key-value dictionary and raw lines.
 */
export function parseEnvContent(content) {
  const values = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(trimmed);
    if (match) {
      let val = match[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else {
        val = val.replace(/\s+#.*$/, '').trim();
      }
      values[match[1]] = val;
    }
  }
  return { values, lines };
}

/**
 * Updates an .env file preserving comments, structure, and spacing.
 * If the file doesn't exist, uses .env.example or creates a base template.
 */
export function updateEnvFile(filePath, updates = {}) {
  let templateContent = '';
  if (existsSync(filePath)) {
    templateContent = readFileSync(filePath, 'utf8');
  } else {
    const examplePath = join(ROOT, '.env.example');
    if (existsSync(examplePath)) {
      templateContent = readFileSync(examplePath, 'utf8');
    } else {
      templateContent = '# Crucix Environment Configuration\n';
    }
  }

  const lines = templateContent.split(/\r?\n/);
  const updatedKeys = new Set();
  const outputLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Match active or commented-out key: KEY=... or # KEY=... or #KEY=...
    const match = /^(#\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(trimmed);
    if (match) {
      const key = match[2];
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        const val = updates[key];
        updatedKeys.add(key);
        if (val === undefined || val === null || val === '') {
          outputLines.push(`${key}=`);
        } else {
          const needsQuotes = /[\s#"']/.test(val);
          outputLines.push(`${key}=${needsQuotes ? `"${val}"` : val}`);
        }
        continue;
      }
    }
    outputLines.push(line);
  }

  // Append any keys that weren't present in the template
  const missingKeys = Object.keys(updates).filter(k => !updatedKeys.has(k) && updates[k] !== undefined);
  if (missingKeys.length > 0) {
    outputLines.push('\n# === Custom / Wizard Added Settings ===');
    for (const k of missingKeys) {
      const val = updates[k];
      const needsQuotes = /[\s#"']/.test(val);
      outputLines.push(`${k}=${needsQuotes ? `"${val}"` : val}`);
    }
  }

  const finalContent = outputLines.join('\n');
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  mkdirSync(dirname(filePath), { recursive: true });
  try {
    writeFileSync(tmpPath, finalContent, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmpPath, filePath);
  } catch {
    writeFileSync(filePath, finalContent, { encoding: 'utf8', mode: 0o600 });
    try { unlinkSync(tmpPath); } catch {}
  }

  return finalContent;
}

/**
 * Quick connection test for Telegram bot
 */
export async function testTelegram(botToken, chatId) {
  if (!botToken || !chatId) return { ok: false, error: 'Hiányzó bot token vagy chat ID' };
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '🟢 Crucix Intelligence — A Telegram értesítések és a bot sikeresen beállítva!',
      }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    if (data.ok) return { ok: true };
    return { ok: false, error: data.description || 'Ismeretlen Telegram hiba' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Quick connection test for Discord webhook
 */
export async function testDiscord(webhookUrl) {
  if (!webhookUrl) return { ok: false, error: 'Hiányzó Discord Webhook URL' };
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '🟢 **Crucix Intelligence** — A Discord webhook értesítések sikeresen beállítva!',
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok || res.status === 204) return { ok: true };
    return { ok: false, error: `HTTP hiba: ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * The .env file settings are saved to: CRUCIX_ENV_FILE, else CRUCIX_HOME/.env, else ~/.crucix/.env
 * (%USERPROFILE%\.crucix\.env). apis/utils/env.mjs reads it before any other .env, so a saved value is the one in force.
 */
export function resolveTargetEnvPath() {
  return settingsEnvPath();
}

const MAX_SETTING_VALUE = 4096;

export class SettingsError extends Error {}
const saveStatus = err => (err instanceof SettingsError ? 400 : 500);

/** The current values for the setup forms: the .env files merged as they load, or `targetEnv` alone if it is not one of them. */
export function currentEnvValues(targetEnv) {
  const paths = getEnvSearchPaths();
  return readEnvFileValues(paths.includes(resolve(targetEnv)) ? paths : [resolve(targetEnv)]);
}

/**
 * Writes form or wizard values to `targetEnv`. Keys must be upper-case environment names and values one line: a line
 * break would start a new KEY= line of its own. A settings file that does not exist yet starts as a copy of the .env in
 * use (a source checkout's project .env), so moving to the profile loses nothing.
 */
export function saveSettings(targetEnv, updates) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new SettingsError('Settings must be an object of KEY: value pairs');
  const clean = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) throw new SettingsError(`Invalid setting name: ${key.slice(0, 64)}`);
    if (value === undefined || value === null) { clean[key] = ''; continue; }
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new SettingsError(`Invalid value for ${key}`);
    const text = String(value);
    if (/[\r\n\0]/.test(text) || text.length > MAX_SETTING_VALUE) throw new SettingsError(`The value of ${key} must be a single line of at most ${MAX_SETTING_VALUE} characters`);
    clean[key] = text;
  }
  const target = resolve(targetEnv);
  const searched = getEnvSearchPaths();
  if (!existsSync(target) && searched.includes(target)) {
    const seed = searched.find(path => path !== target && existsSync(path));
    if (seed) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(seed, target);
    }
  }
  updateEnvFile(target, clean);
  return target;
}

/**
 * Installs setup API routes on an existing Express application (e.g. server.mjs). The POST routes write .env, send test
 * messages and open URLs, so each one parses its JSON body through requireSameOriginJson: a page on another site cannot
 * reach them through the operator's browser.
 * @param {{security?: {publicUrl?: string|null, allowedHosts?: string[]}}} [options]
 */
export function installSetupRoutes(app, { security = {} } = {}) {
  const targetEnv = resolveTargetEnvPath();
  const guard = requireSameOriginJson({ ...security, limit: '32kb' });

  app.get(['/setup', '/setup.html'], (_req, res) => {
    const html = getSetupHtml();
    res.type('html').send(html);
  });

  app.get('/api/setup/config', (_req, res) => {
    res.json({ targetEnv, values: currentEnvValues(targetEnv), isStandalone: false, autoExitOnSave: false });
  });

  app.post('/api/setup/test-telegram', guard, async (req, res) => {
    const { botToken, chatId } = req.body || {};
    const result = await testTelegram(botToken, chatId);
    res.json(result);
  });

  app.post('/api/setup/test-discord', guard, async (req, res) => {
    const { webhookUrl } = req.body || {};
    const result = await testDiscord(webhookUrl);
    res.json(result);
  });

  app.post('/api/setup/open-url', guard, (req, res) => {
    const { url } = req.body || {};
    if (url && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('tg://'))) {
      openBrowser(url);
      res.json({ ok: true });
    } else {
      res.status(400).json({ ok: false, error: 'Érvénytelen URL' });
    }
  });

  app.post('/api/setup/save', guard, (req, res) => {
    const updates = req.body || {};
    try {
      const savedTo = saveSettings(targetEnv, updates);
      res.json({ ok: true, message: 'Settings saved successfully', targetEnv: savedTo, isStandalone: false, willExit: false });
    } catch (err) {
      res.status(saveStatus(err)).json({ ok: false, error: err.message });
    }
  });
}

/**
 * Starts a standalone, zero-dependency lightweight HTTP server to serve the setup UI.
 */
const STANDALONE_BODY_LIMIT = 32 * 1024;
const LOOPBACK_HOST = /^(localhost|[a-z0-9-]+\.localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(?::\d{1,5})?$/i;

/**
 * Why the standalone setup server (127.0.0.1 only) refuses a request, or null. The Host must be a loopback name, so a
 * DNS-rebinding page cannot reach it under its own name; a POST must be JSON and, when the browser says where it
 * comes from, from this same origin. A request without Origin and Sec-Fetch-Site (curl, scripts) passes on its JSON
 * Content-Type, which a page on another site cannot send without a preflight this server never answers.
 */
export function standaloneRefusal(req) {
  const host = String(req.headers.host || '');
  if (!LOOPBACK_HOST.test(host)) return { status: 403, error: 'The setup server only answers on localhost' };
  if (req.method !== 'POST') return null;
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return { status: 415, error: 'Content-Type must be application/json' };
  const origin = req.headers.origin;
  const fetchSite = req.headers['sec-fetch-site'];
  if ((origin !== undefined && origin !== `http://${host.toLowerCase()}`) || (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none')) {
    return { status: 403, error: 'Cross-origin request refused' };
  }
  return null;
}

export async function startSetupWebServer(options = {}) {
  const targetEnv = options.envPath || resolveTargetEnvPath();
  const port = options.port || Number(process.env.SETUP_PORT || 3117);
  const autoExitOnSave = options.autoExitOnSave === true;
  const exitHandler = typeof options.onExit === 'function' ? options.onExit : () => process.exit(0);

  return new Promise((resolvePromise, rejectPromise) => {
    const server = http.createServer(async (req, res) => {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;

      const sendJson = (data, statusCode = 200) => {
        res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      };

      // The config route returns API keys and the POST routes write .env: only this machine's own page may use them.
      const refusal = standaloneRefusal(req);
      if (refusal) return sendJson({ ok: false, error: refusal.error }, refusal.status);

      // 1. Setup page
      if (pathname === '/' || pathname === '/setup' || pathname === '/setup.html') {
        const content = getSetupHtml();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(content);
      }

      // Static fonts CSS
      if (pathname === '/vendor/fonts.css') {
        const fontPath = join(ROOT, 'dashboard', 'public', 'vendor', 'fonts.css');
        if (existsSync(fontPath)) {
          res.writeHead(200, { 'Content-Type': 'text/css' });
          return res.end(readFileSync(fontPath, 'utf8'));
        }
      }

      // 2. GET /api/setup/config
      if (pathname === '/api/setup/config' && req.method === 'GET') {
        return sendJson({
          targetEnv,
          values: currentEnvValues(targetEnv),
          isStandalone: true,
          autoExitOnSave,
        });
      }

      // 3. POST /api/setup/exit
      if (pathname === '/api/setup/exit' && req.method === 'POST') {
        sendJson({ ok: true, message: 'Beállító szerver leállítása folyamatban' });
        setTimeout(() => {
          try { server.close(); } catch {}
          exitHandler();
        }, 300);
        return;
      }

      // Parse JSON body for POST endpoints
      if (req.method === 'POST') {
        let bodyRaw = '';
        let tooLarge = false;
        req.setEncoding('utf8');
        req.on('data', chunk => {
          if (tooLarge) return;
          bodyRaw += chunk;
          if (Buffer.byteLength(bodyRaw) > STANDALONE_BODY_LIMIT) tooLarge = true;
        });
        req.on('end', async () => {
          if (tooLarge) return sendJson({ ok: false, error: 'The request body is larger than 32 KB' }, 413);
          let body = {};
          try {
            if (bodyRaw) body = JSON.parse(bodyRaw);
          } catch {
            return sendJson({ ok: false, error: 'The request body is not valid JSON' }, 400);
          }

          if (pathname === '/api/setup/test-telegram') {
            const result = await testTelegram(body.botToken, body.chatId);
            return sendJson(result);
          }

          if (pathname === '/api/setup/test-discord') {
            const result = await testDiscord(body.webhookUrl);
            return sendJson(result);
          }

          if (pathname === '/api/setup/open-url') {
            if (body.url && (body.url.startsWith('http://') || body.url.startsWith('https://') || body.url.startsWith('tg://'))) {
              openBrowser(body.url);
              return sendJson({ ok: true });
            }
            return sendJson({ ok: false, error: 'Érvénytelen URL' }, 400);
          }

          if (pathname === '/api/setup/save') {
            try {
              const savedTo = saveSettings(targetEnv, body);

              const willExit = autoExitOnSave;
              sendJson({
                ok: true,
                message: 'Settings saved successfully',
                targetEnv: savedTo,
                isStandalone: true,
                willExit,
              });

              if (willExit) {
                setTimeout(() => {
                  console.log('\n=============================================================');
                  console.log('✅ Beállítások sikeresen mentve a .env fájlba!');
                  console.log('🏁 A beállító varázsló befejeződött, a folyamat leállt.');
                  console.log('=============================================================\n');
                  console.log('💡 Indítsd el a Crucix-et:');
                  console.log('   crucix                        # Vezérlőpult megnyitása a böngészőben');
                  console.log('   crucix -b                     # Vezetői összefoglaló a terminálban\n');
                  try {
                    server.close();
                  } catch {}
                  exitHandler();
                }, 1000);
              }
              return;
            } catch (err) {
              return sendJson({ ok: false, error: err.message }, saveStatus(err));
            }
          }

          return sendJson({ error: 'Endpoint not found' }, 404);
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Try fallback port
        console.warn(`[Crucix Setup] Port ${port} is in use, trying ${port + 1}...`);
        server.listen(port + 1, '127.0.0.1');
      } else {
        rejectPromise(err);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = typeof address === 'object' ? address.port : port;
      const setupUrl = `http://localhost:${actualPort}/setup.html`;

      const isHeadless = Boolean(options.headless) ||
        options.autoOpen === false ||
        process.env.NO_AUTO_OPEN === '1' ||
        process.env.HEADLESS === '1';

      if (!isHeadless) {
        openBrowser(setupUrl);
      }

      resolvePromise({
        server,
        port: actualPort,
        setupUrl,
        close: () => server.close(),
      });
    });
  });
}

/**
 * Runs the interactive setup wizard in the terminal.
 */
export async function runSetupWizard(options = {}) {
  const targetEnv = options.envPath || resolveTargetEnvPath();
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const ask = async (promptText, defaultVal = '') => {
    const suffix = defaultVal ? ` [alapértelmezett: ${defaultVal}]: ` : ': ';
    const answer = await rl.question(promptText + suffix);
    return answer.trim() || defaultVal;
  };

  const askYesNo = async (promptText, defaultYes = true) => {
    const hint = defaultYes ? ' (I/n)' : ' (i/N)';
    const ans = (await rl.question(promptText + hint + ': ')).trim().toLowerCase();
    if (!ans) return defaultYes;
    return ans === 'i' || ans === 'y' || ans === 'igen' || ans === 'yes';
  };

  console.log('\n=============================================================');
  console.log('       CRUCIX INTELLIGENCE ENGINE — BEÁLLÍTÓ VARÁZSLÓ');
  console.log('=============================================================\n');

  if (options.web) {
    rl.close();
    const isHeadless = Boolean(options.headless) ||
      options.autoOpen === false ||
      process.env.NO_AUTO_OPEN === '1' ||
      process.env.HEADLESS === '1';

    console.log('🚀 Webes beállító kiszolgáló indítása...');
    try {
      const { setupUrl } = await startSetupWebServer({
        envPath: targetEnv,
        autoOpen: !isHeadless,
        headless: isHeadless,
        port: options.port,
        autoExitOnSave: true,
      });
      if (isHeadless) {
        console.log(`\n🌐 A grafikus beállító felület készen áll:`);
      } else {
        console.log(`\n🌐 A grafikus beállító felület megnyílt a böngésződben:`);
      }
      console.log(`   👉 ${setupUrl}\n`);
      console.log('💡 A felületen közvetlenül kattinthatsz a botok indításához és a kulcsok igényléséhez.');
      console.log('💾 Mentés után a varázsló automatikusan bezárja az ablakot és befejezi a folyamatot.\n');
      return;
    } catch (err) {
      console.error('❌ Hiba történt a webes felület indításakor:', err.message);
      return;
    }
  }

  // If not explicitly requested --cli and running interactively, offer opening browser setup
  if (!options.cli && process.stdin.isTTY) {
    console.log('Válassz beállítási módot:');
    console.log('  1) Grafikus Webes Felület (Ajánlott — 1 kattintásos linkek és kulcskérés)');
    console.log('  2) Szöveges terminálos varázsló (automatikus böngésző megnyitással)\n');

    const modeChoice = await ask('Melyiket szeretnéd indítani? (1/2)', '1');
    if (modeChoice === '1') {
      rl.close();
      console.log('\n🚀 Webes beállító kiszolgáló indítása...');
      try {
        const { setupUrl } = await startSetupWebServer({
          envPath: targetEnv,
          autoOpen: true,
          port: options.port,
          autoExitOnSave: true,
        });
        console.log(`\n🌐 A grafikus beállító felület megnyílt a böngésződben:`);
        console.log(`   👉 ${setupUrl}\n`);
        console.log('💡 A felületen közvetlenül kattinthatsz a botok indításához és a kulcsok igényléséhez.');
        console.log('💾 Mentés után a varázsló automatikusan bezárja az ablakot és befejezi a folyamatot.\n');
        return;
      } catch (err) {
        console.warn('⚠️  Nem sikerült elindítani a webes felületet:', err.message);
        console.log('Folytatás a szöveges terminálos varázslóval...\n');
      }
    }
  }

  console.log('Ez a varázsló végigvezet a Crucix kulcsfontosságú beállításain');
  console.log('(Nyelv, Értesítések, Mesterséges Intelligencia, API kulcsok).\n');
  console.log(`📁 Célkonfigurációs fájl: ${targetEnv}\n`);

  // Load existing values if present
  const existingValues = currentEnvValues(targetEnv);

  const updates = {};

  try {
    // -------------------------------------------------------------
    // 1. LÉPÉS: Nyelvválasztás (Language)
    // -------------------------------------------------------------
    console.log('--- [1/6] Kimenet Nyelve (Language) ---');
    console.log('Választható nyelvek:');
    console.log('  1) Magyar (hu)');
    console.log('  2) English (en)');
    console.log('  3) Français (fr)');
    const currentLang = existingValues.CRUCIX_LANG || 'hu';
    const langChoice = await ask('Válassz nyelvet (1/2/3)', currentLang === 'hu' ? '1' : currentLang === 'en' ? '2' : '3');
    const selectedLang = langChoice === '2' ? 'en' : langChoice === '3' ? 'fr' : 'hu';
    updates.CRUCIX_LANG = selectedLang;
    updates.TRADE_IDEAS_LANG = selectedLang;
    console.log(`✅ Kiválasztott nyelv: ${selectedLang}\n`);

    // -------------------------------------------------------------
    // 2. LÉPÉS: Dashboard és Szerver beállítások
    // -------------------------------------------------------------
    console.log('--- [2/6] Dashboard és Hálózat ---');
    const currentPort = existingValues.PORT || '3117';
    updates.PORT = await ask('Dashboard és REST API port', currentPort);
    
    console.log('\nHálózati elérés:');
    console.log('  127.0.0.1  - Csak a helyi gépről érhető el (biztonságos)');
    console.log('  0.0.0.0    - Elérhető a helyi hálózatról / LAN-ról (pl. másik gépről, telefonról)');
    const currentHost = existingValues.HOST || '127.0.0.1';
    updates.HOST = await ask('Kiszolgáló IP címe (HOST)', currentHost);
    console.log(`✅ Szerver beállítás: http://${updates.HOST}:${updates.PORT}\n`);

    // -------------------------------------------------------------
    // 3. LÉPÉS: AI / LLM Modell Kapcsolat
    // -------------------------------------------------------------
    console.log('--- [3/6] Mesterséges Intelligencia (AI / LLM) Integráció ---');
    console.log('Az AI összegzi az eseményeket, vezetői összefoglalókat és kereskedési ötleteket generál.');
    console.log('Lehetőségek:');
    console.log('  1) cursor            - Cursor IDE beépített modell (automatikus kapcsolat, ingyenes)');
    console.log('  2) ollama            - Helyi Ollama szerver (100% privát, ingyenes, pl. llama3.1)');
    console.log('  3) openai-compatible - Helyi LM Studio, llama.cpp vagy vLLM');
    console.log('  4) anthropic         - Claude 3.5 / 3.7 Sonnet (Anthropic API kulcs szükséges)');
    console.log('  5) openai            - GPT-4o / GPT-5 (OpenAI API kulcs szükséges)');
    console.log('  6) gemini            - Google Gemini 2.5 (Gemini API kulcs szükséges)');
    console.log('  7) none              - Nincs külső AI (Gyors szabály- és heurisztika alapú motor)');

    const currentProvider = existingValues.LLM_PROVIDER || 'cursor';
    let defaultProvChoice = '1';
    if (currentProvider === 'ollama') defaultProvChoice = '2';
    else if (currentProvider === 'openai-compatible') defaultProvChoice = '3';
    else if (currentProvider === 'anthropic') defaultProvChoice = '4';
    else if (currentProvider === 'openai') defaultProvChoice = '5';
    else if (currentProvider === 'gemini') defaultProvChoice = '6';
    else if (!currentProvider || currentProvider === 'none') defaultProvChoice = '7';

    const provChoice = await ask('Válassz AI szolgáltatót (1-7)', defaultProvChoice);
    const provMap = {
      '1': 'cursor',
      '2': 'ollama',
      '3': 'openai-compatible',
      '4': 'anthropic',
      '5': 'openai',
      '6': 'gemini',
      '7': '',
    };
    const chosenProvider = provMap[provChoice] ?? 'cursor';
    updates.LLM_PROVIDER = chosenProvider;

    if (chosenProvider === 'cursor') {
      console.log('✅ Cursor LLM engedélyezve: automatikusan használja a szerkesztő aktív modelljét.');
    } else if (chosenProvider === 'ollama') {
      updates.OLLAMA_BASE_URL = await ask('Ollama URL', existingValues.OLLAMA_BASE_URL || 'http://localhost:11434');
      updates.LLM_MODEL = await ask('Ollama modell neve', existingValues.LLM_MODEL || 'llama3.1:8b');
      console.log(`✅ Helyi Ollama beállítva: ${updates.OLLAMA_BASE_URL} (${updates.LLM_MODEL})`);
    } else if (chosenProvider === 'openai-compatible') {
      updates.LLM_BASE_URL = await ask('Helyi OpenAI-kompatibilis API URL (pl. LM Studio)', existingValues.LLM_BASE_URL || 'http://localhost:1234/v1');
      updates.LLM_MODEL = await ask('Modell azonosító', existingValues.LLM_MODEL || 'local-model');
    } else if (['anthropic', 'openai', 'gemini'].includes(chosenProvider)) {
      if (chosenProvider === 'anthropic') {
        const openAnthropic = await askYesNo('Megnyissam az Anthropic Console kulcskérő oldalt a böngésződben?', true);
        if (openAnthropic) openBrowser('https://console.anthropic.com/settings/keys');
      } else if (chosenProvider === 'openai') {
        const openOpenAi = await askYesNo('Megnyissam az OpenAI API kulcskérő oldalt a böngésződben?', true);
        if (openOpenAi) openBrowser('https://platform.openai.com/api-keys');
      } else if (chosenProvider === 'gemini') {
        const openGemini = await askYesNo('Megnyissam a Google AI Studio kulcskérő oldalt a böngésződben?', true);
        if (openGemini) openBrowser('https://aistudio.google.com/app/apikey');
      }

      updates.LLM_API_KEY = await ask(`${chosenProvider.toUpperCase()} API kulcs`, existingValues.LLM_API_KEY || '');
      if (existingValues.LLM_MODEL) {
        updates.LLM_MODEL = await ask('Modell felülbírálás (opcionális)', existingValues.LLM_MODEL);
      }
    } else {
      console.log('✅ Szabályalapú működés kiválasztva (külső AI hívás nélkül).');
    }
    console.log('');

    // -------------------------------------------------------------
    // 4. LÉPÉS: Telegram Riasztások és Kétirányú Bot Vezérlés
    // -------------------------------------------------------------
    console.log('--- [4/6] Telegram Riasztások és Távvezérlés ---');
    console.log('A Crucix képes Telegramon azonnali vészjelzéseket küldeni (földrengések, piaci zuhanás, katonai eszkaláció),');
    console.log('és válaszol parancsokra (/brief, /status, /sweep, /alerts).\n');

    const wantTelegram = await askYesNo('Szeretnél Telegram értesítéseket beállítani?', !!existingValues.TELEGRAM_BOT_TOKEN);

    if (wantTelegram) {
      console.log('\n🤖 1. BOT LÉTREHOZÁSA (@BotFather):');
      const openFather = await askYesNo('Megnyissam a @BotFather-t a böngésződben/Telegramban most?', true);
      if (openFather) {
        openBrowser('https://t.me/BotFather');
        console.log('   🌐 @BotFather megnyitva! (Írd be neki: /newbot, majd adj nevet a botodnak)');
      }

      const botToken = await ask('\nTelegram Bot Token (amit a BotFather adott)', existingValues.TELEGRAM_BOT_TOKEN || '');

      console.log('\n🆔 2. SAJÁT CHAT ID LEKÉRÉSE (@userinfobot):');
      const openUserBot = await askYesNo('Megnyissam a @userinfobot-ot a böngésződben a Chat ID lekéréséhez?', true);
      if (openUserBot) {
        openBrowser('https://t.me/userinfobot');
        console.log('   🌐 @userinfobot megnyitva! (Nyomj Start-ot, és másold ki az "Id" mező számát)');
      }

      const chatId = await ask('\nTelegram Chat ID', existingValues.TELEGRAM_CHAT_ID || '');

      updates.TELEGRAM_BOT_TOKEN = botToken;
      updates.TELEGRAM_CHAT_ID = chatId;

      if (botToken && chatId) {
        const channels = (existingValues.ALERT_NOTIFY_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!channels.includes('telegram')) channels.push('telegram');
        updates.ALERT_NOTIFY_CHANNELS = channels.join(',');

        const testTg = await askYesNo('\nTeszteljük a kapcsolatot egy próbaüzenet küldésével?', true);
        if (testTg) {
          process.stdout.write('   ⏳ Üzenet küldése a Telegramnak... ');
          const tgResult = await testTelegram(botToken, chatId);
          if (tgResult.ok) {
            console.log('✅ SIKERES! Ellenőrizd a Telegram alkalmazásodat!');
          } else {
            console.log(`❌ Nem sikerült elküldeni: ${tgResult.error}`);
            console.log('   (A beállításokat elmentjük, később újra ellenőrizheted.)');
          }
        }
      }
    } else {
      console.log('⏭️  Telegram beállítás kihagyva.');
    }
    console.log('');

    // -------------------------------------------------------------
    // 5. LÉPÉS: Discord Webhook Riasztások
    // -------------------------------------------------------------
    console.log('--- [5/6] Discord Webhook Riasztások ---');
    console.log('A Crucix képes közvetlenül Discord csatornára küldeni az intelligencia riasztásokat.\n');

    const wantDiscord = await askYesNo('Szeretnél Discord értesítéseket beállítani?', !!existingValues.DISCORD_WEBHOOK_URL);

    if (wantDiscord) {
      console.log('\n📖 HOGYAN HOZZ LÉTRE DISCORD WEBHOOKOT 1 PERC ALATT:');
      console.log('  1. A Discord szervereden kattints a célcsatorna melletti fogaskerék ikonra (Csatorna beállítások).');
      console.log('  2. Válaszd az "Integrációk" (Integrations) -> "Webhookok" (Webhooks) menüt.');
      console.log('  3. Kattints az "Új Webhook" gombra, majd kattints a "Webhook URL másolása" gombra.\n');

      const webhookUrl = await ask('Discord Webhook URL', existingValues.DISCORD_WEBHOOK_URL || '');
      updates.DISCORD_WEBHOOK_URL = webhookUrl;

      if (webhookUrl) {
        const channels = (updates.ALERT_NOTIFY_CHANNELS || existingValues.ALERT_NOTIFY_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!channels.includes('discord')) channels.push('discord');
        updates.ALERT_NOTIFY_CHANNELS = channels.join(',');

        const testDc = await askYesNo('Teszteljük a Discord webhookot egy próbaüzenettel?', true);
        if (testDc) {
          process.stdout.write('   ⏳ Üzenet küldése a Discordnak... ');
          const dcResult = await testDiscord(webhookUrl);
          if (dcResult.ok) {
            console.log('✅ SIKERES! Ellenőrizd a Discord csatornádat!');
          } else {
            console.log(`❌ Nem sikerült elküldeni: ${dcResult.error}`);
          }
        }
      }
    } else {
      console.log('⏭️  Discord beállítás kihagyva.');
    }
    console.log('');

    // -------------------------------------------------------------
    // 6. LÉPÉS: Ingyenes OSINT Adatforrás API Kulcsok
    // -------------------------------------------------------------
    console.log('--- [6/6] Ingyenes Geopolitikai & OSINT Adatforrás Kulcsok ---');
    console.log('A források zöme (USGS földrengések, 539 globális sajtóorgánum, OpenSky repülések,');
    console.log('ACLED konfliktusok, ENSZ, RIPE statisztikák, IODA) kulcs NÉLKÜL is azonnal működik.');
    console.log('Az alábbi ingyenes regisztrációkkal növelheted az adatfrissítés sebességét és pontosságát.\n');

    const wantApiKeys = await askYesNo('Szeretnél megadni ingyenes API kulcsokat?', false);

    if (wantApiKeys) {
      console.log('\n(Nyomj Entert az üresen hagyáshoz, ha később szeretnéd megadni)\n');
      
      console.log('🔥 NASA FIRMS műholdas hőtérkép és tűz hotspotok (ingyenes)');
      if (await askYesNo('Megnyissam a NASA FIRMS regisztrációs oldalt a böngésződben?', true)) {
        openBrowser('https://firms.modaps.eosdis.nasa.gov/api');
      }
      updates.FIRMS_MAP_KEY = await ask('FIRMS MAP KEY', existingValues.FIRMS_MAP_KEY || '');

      console.log('\n📊 FRED amerikai jegybanki makrogazdasági adatok (ingyenes)');
      if (await askYesNo('Megnyissam a FRED kulcs igénylő oldalt a böngésződben?', true)) {
        openBrowser('https://fred.stlouisfed.org/docs/api/api_key.html');
      }
      updates.FRED_API_KEY = await ask('FRED API KEY', existingValues.FRED_API_KEY || '');

      console.log('\n⚡ EIA globális és amerikai energia/olaj/gáz statisztikák (ingyenes)');
      if (await askYesNo('Megnyissam az EIA regisztrációs oldalt a böngésződben?', true)) {
        openBrowser('https://api.eia.gov/register');
      }
      updates.EIA_API_KEY = await ask('EIA API KEY', existingValues.EIA_API_KEY || '');

      console.log('\n📈 Financial Modeling Prep részvények, indexek és devizák (ingyenes, 250 hívás/nap; a Crucix ~192-t használ)');
      if (await askYesNo('Megnyissam az FMP regisztrációs oldalt a böngésződben?', true)) {
        openBrowser('https://site.financialmodelingprep.com/register');
      }
      updates.FMP_API_KEY = await ask('FMP API KEY', existingValues.FMP_API_KEY || '');

      console.log('\n💹 Finnhub második részvényforrás (ingyenes, 60 hívás/perc)');
      if (await askYesNo('Megnyissam a Finnhub regisztrációs oldalt a böngésződben?', true)) {
        openBrowser('https://finnhub.io/register');
      }
      updates.FINNHUB_API_KEY = await ask('FINNHUB API KEY', existingValues.FINNHUB_API_KEY || '');

      console.log('\n💱 Alap deviza az árfolyam-keresztekhez: USD, EUR, GBP, HUF, JPY, CHF, CAD, AUD, CNY');
      const base = (await ask('CRUCIX_BASE_CURRENCY', existingValues.CRUCIX_BASE_CURRENCY || 'USD')).trim().toUpperCase();
      updates.CRUCIX_BASE_CURRENCY = /^(USD|EUR|GBP|HUF|JPY|CHF|CAD|AUD|CNY)$/.test(base) ? base : 'USD';

      console.log('\n🚢 AISStream valós idejű globális tengeri forgalom (ingyenes)');
      if (await askYesNo('Megnyissam az AISStream regisztrációs oldalt a böngésződben?', true)) {
        openBrowser('https://aisstream.io/account');
      }
      updates.AISSTREAM_API_KEY = await ask('AISSTREAM API KEY', existingValues.AISSTREAM_API_KEY || '');

      console.log('\n🌐 Cloudflare Radar globális internetkimaradások (ingyenes)');
      if (await askYesNo('Megnyissam a Cloudflare Token készítő oldalt a böngésződben?', true)) {
        openBrowser('https://dash.cloudflare.com/profile/api-tokens');
      }
      updates.CLOUDFLARE_API_TOKEN = await ask('CLOUDFLARE API TOKEN', existingValues.CLOUDFLARE_API_TOKEN || '');
    }

    // -------------------------------------------------------------
    // MENTÉS ÉS ÖSSZEGZÉS
    // -------------------------------------------------------------
    console.log('\n💾 Beállítások mentése...');
    saveSettings(targetEnv, updates);

    console.log('\n=============================================================');
    console.log('🎉 CRUCIX BEÁLLÍTÁS SIKERESEN ELMENTVE!');
    console.log('=============================================================');
    console.log(`📁 Fájl:          ${targetEnv}`);
    console.log(`🌐 Nyelv:         ${updates.CRUCIX_LANG}`);
    console.log(`🤖 AI Szolgáltató:${updates.LLM_PROVIDER || 'Szabályalapú (kikapcsolva)'}`);
    console.log(`📱 Telegram:      ${updates.TELEGRAM_BOT_TOKEN ? 'Bekapcsolva ✅' : 'Kikapcsolva ⚪'}`);
    console.log(`💬 Discord:       ${updates.DISCORD_WEBHOOK_URL ? 'Bekapcsolva ✅' : 'Kikapcsolva ⚪'}`);
    console.log(`🖥️  Szerver:       http://${updates.HOST}:${updates.PORT}`);
    console.log('=============================================================\n');

    console.log('💡 Hasznos parancsok a kezdéshez:');
    console.log('   crucix -b                     # Vezetői intelligencia összefoglaló a terminálban');
    console.log('   crucix -m                     # Pénzügyi piacok, nyersanyagok és arany');
    console.log('   crucix --serve                # Háttérszerver indítása adatgyűjtéssel');
    console.log('   crucix setup                  # Bármikor újraindíthatod ezt a varázslót\n');

  } catch (err) {
    console.error('\n❌ Hiba történt a beállítás során:', err.message);
  } finally {
    rl.close();
  }
}
