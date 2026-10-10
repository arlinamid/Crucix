// Crucix Interactive Setup Wizard & Configuration Assistant
// Guides users step-by-step through configuring .env (Language, AI, Telegram, Discord, API keys)
// Works across CLI, Standalone SEA Executable, and npm scripts.

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

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
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
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
  try {
    writeFileSync(tmpPath, finalContent, 'utf8');
    renameSync(tmpPath, filePath);
  } catch {
    writeFileSync(filePath, finalContent, 'utf8');
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
 * Resolves the primary .env file to update.
 */
export function resolveTargetEnvPath() {
  if (process.env.CRUCIX_ENV_FILE) return resolve(process.env.CRUCIX_ENV_FILE);
  if (process.env.CRUCIX_HOME) return join(process.env.CRUCIX_HOME, '.env');
  const userProfileEnv = join(homedir(), '.crucix', '.env');
  if (existsSync(userProfileEnv)) return userProfileEnv;
  const projectEnv = join(ROOT, '.env');
  if (existsSync(projectEnv) || existsSync(join(ROOT, 'package.json'))) return projectEnv;
  return userProfileEnv;
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
  console.log('Ez a varázsló végigvezet a Crucix kulcsfontosságú beállításain');
  console.log('(Nyelv, Értesítések, Mesterséges Intelligencia, API kulcsok).\n');
  console.log(`📁 Célkonfigurációs fájl: ${targetEnv}\n`);

  // Load existing values if present
  let existingValues = {};
  if (existsSync(targetEnv)) {
    try {
      existingValues = parseEnvContent(readFileSync(targetEnv, 'utf8')).values;
    } catch {}
  }

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
      console.log('\n📖 HOGYAN HOZZ LÉTRE TELEGRAM BOTOT 2 PERC ALATT:');
      console.log('  1. Nyisd meg a Telegram alkalmazásban a @BotFather-t: https://t.me/BotFather');
      console.log('  2. Küldd el neki a /newbot parancsot, majd adj meg egy nevet és egy felhasználónevet (pl. MyCrucixBot).');
      console.log('  3. A BotFather kiír egy tokent (formátum: 123456789:ABCdefGhIjk...).');
      console.log('  4. Nyisd meg a frissen létrehozott botodat és nyomj a START gombra!');
      console.log('  5. Saját azonosítód (Chat ID) lekéréséhez nyisd meg a @userinfobot-ot: https://t.me/userinfobot');
      console.log('     és másold ki az "Id" mező számsorát (pl. 987654321).\n');

      const botToken = await ask('Telegram Bot Token', existingValues.TELEGRAM_BOT_TOKEN || '');
      const chatId = await ask('Telegram Chat ID', existingValues.TELEGRAM_CHAT_ID || '');

      updates.TELEGRAM_BOT_TOKEN = botToken;
      updates.TELEGRAM_CHAT_ID = chatId;

      if (botToken && chatId) {
        // Automatically add telegram to ALERT_NOTIFY_CHANNELS
        const channels = (existingValues.ALERT_NOTIFY_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!channels.includes('telegram')) channels.push('telegram');
        updates.ALERT_NOTIFY_CHANNELS = channels.join(',');

        const testTg = await askYesNo('Teszteljük a kapcsolatot egy próbaüzenet küldésével?', true);
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
      console.log('  3. Kattints az "Új Webhook" gombra, adj neki egy nevet (pl. Crucix), majd kattints a "Webhook URL másolása" gombra.\n');

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
      
      console.log('🔥 NASA FIRMS műholdas hőtérkép és tűz hotspotok (ingyenes: firms.modaps.eosdis.nasa.gov/api)');
      updates.FIRMS_MAP_KEY = await ask('FIRMS MAP KEY', existingValues.FIRMS_MAP_KEY || '');

      console.log('\n📊 FRED amerikai jegybanki makrogazdasági adatok (ingyenes: fred.stlouisfed.org)');
      updates.FRED_API_KEY = await ask('FRED API KEY', existingValues.FRED_API_KEY || '');

      console.log('\n⚡ EIA globális és amerikai energia/olaj/gáz statisztikák (ingyenes: api.eia.gov/register)');
      updates.EIA_API_KEY = await ask('EIA API KEY', existingValues.EIA_API_KEY || '');

      console.log('\n🚢 AISStream valós idejű globális tengeri forgalom (ingyenes: aisstream.io)');
      updates.AISSTREAM_API_KEY = await ask('AISSTREAM API KEY', existingValues.AISSTREAM_API_KEY || '');

      console.log('\n🌐 Cloudflare Radar globális internetkimaradások (ingyenes: dash.cloudflare.com)');
      updates.CLOUDFLARE_API_TOKEN = await ask('CLOUDFLARE API TOKEN', existingValues.CLOUDFLARE_API_TOKEN || '');
    }

    // -------------------------------------------------------------
    // MENTÉS ÉS ÖSSZEGZÉS
    // -------------------------------------------------------------
    console.log('\n💾 Beállítások mentése...');
    updateEnvFile(targetEnv, updates);

    // If user profile .env exists and we edited another file, keep them synced
    const userCrucixEnv = join(homedir(), '.crucix', '.env');
    if (resolve(targetEnv) !== resolve(userCrucixEnv) && existsSync(join(homedir(), '.crucix'))) {
      try {
        updateEnvFile(userCrucixEnv, updates);
        console.log(`   • Szinkronizálva a felhasználói profilba is: ${userCrucixEnv}`);
      } catch {}
    }

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
