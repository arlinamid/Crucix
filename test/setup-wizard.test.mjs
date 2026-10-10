import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnvContent, updateEnvFile, startSetupWebServer, getSetupHtml } from '../lib/setup-wizard.mjs';

test('parseEnvContent correctly parses environment variables', () => {
  const content = `
# Comment
PORT=3117
HOST="0.0.0.0"
LLM_PROVIDER=cursor # inline comment
CRUCIX_LANG='hu'
`;
  const { values } = parseEnvContent(content);
  assert.equal(values.PORT, '3117');
  assert.equal(values.HOST, '0.0.0.0');
  assert.equal(values.LLM_PROVIDER, 'cursor');
  assert.equal(values.CRUCIX_LANG, 'hu');
});

test('updateEnvFile creates new .env from updates if not existing', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'crucix-setup-test-'));
  const envPath = join(tmpDir, '.env');
  try {
    updateEnvFile(envPath, {
      PORT: '4000',
      CRUCIX_LANG: 'hu',
      TELEGRAM_BOT_TOKEN: '123456:ABC',
    });

    assert.ok(existsSync(envPath));
    const content = readFileSync(envPath, 'utf8');
    const { values } = parseEnvContent(content);
    assert.equal(values.PORT, '4000');
    assert.equal(values.CRUCIX_LANG, 'hu');
    assert.equal(values.TELEGRAM_BOT_TOKEN, '123456:ABC');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('updateEnvFile updates existing keys and preserves other lines', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'crucix-setup-test-'));
  const envPath = join(tmpDir, '.env');
  try {
    updateEnvFile(envPath, {
      PORT: '3117',
      HOST: '127.0.0.1',
    });

    updateEnvFile(envPath, {
      PORT: '8080',
      TELEGRAM_CHAT_ID: '98765',
    });

    const content = readFileSync(envPath, 'utf8');
    const { values } = parseEnvContent(content);
    assert.equal(values.PORT, '8080');
    assert.equal(values.HOST, '127.0.0.1');
    assert.equal(values.TELEGRAM_CHAT_ID, '98765');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('startSetupWebServer serves setup page and handles save API', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'crucix-web-setup-test-'));
  const envPath = join(tmpDir, '.env');
  let webServer;

  try {
    webServer = await startSetupWebServer({
      port: 39182,
      envPath,
      autoOpen: false,
    });

    assert.ok(webServer.setupUrl.includes('39182'));

    // Test GET /setup.html
    const resPage = await fetch(`http://localhost:${webServer.port}/setup.html`);
    assert.equal(resPage.status, 200);
    const html = await resPage.text();
    assert.ok(html.includes('CRUCIX'));
    assert.ok(html.includes('BotFather'));

    // Test POST /api/setup/save
    const resSave = await fetch(`http://localhost:${webServer.port}/api/setup/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        PORT: '3118',
        CRUCIX_LANG: 'hu',
        TELEGRAM_BOT_TOKEN: '987654:XYZ',
      }),
    });
    assert.equal(resSave.status, 200);
    const saveJson = await resSave.json();
    assert.equal(saveJson.ok, true);

    // Verify .env was saved on disk
    const content = readFileSync(envPath, 'utf8');
    const { values } = parseEnvContent(content);
    assert.equal(values.PORT, '3118');
    assert.equal(values.CRUCIX_LANG, 'hu');
    assert.equal(values.TELEGRAM_BOT_TOKEN, '987654:XYZ');

    // Test GET /api/setup/config
    const resConfig = await fetch(`http://localhost:${webServer.port}/api/setup/config`);
    assert.equal(resConfig.status, 200);
    const configJson = await resConfig.json();
    assert.equal(configJson.values.TELEGRAM_BOT_TOKEN, '987654:XYZ');
  } finally {
    if (webServer?.close) webServer.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('getSetupHtml returns embedded HTML fallback when disk file does not exist', () => {
  const origEnv = process.env.CRUCIX_SETUP_HTML;
  try {
    process.env.CRUCIX_SETUP_HTML = 'C:\\nonexistent\\path\\to\\setup.html';
    const html = getSetupHtml();
    assert.ok(html.includes('CRUCIX'));
    assert.ok(html.includes('BotFather'));
    assert.ok(html.includes('Beállító Központ'));
  } finally {
    if (origEnv !== undefined) process.env.CRUCIX_SETUP_HTML = origEnv;
    else delete process.env.CRUCIX_SETUP_HTML;
  }
});

test('startSetupWebServer supports autoExitOnSave and triggers exitHandler', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'crucix-web-setup-exit-'));
  const envPath = join(tmpDir, '.env');
  let exitTriggered = false;
  let webServer;

  try {
    webServer = await startSetupWebServer({
      port: 39183,
      envPath,
      autoOpen: false,
      autoExitOnSave: true,
      onExit: () => {
        exitTriggered = true;
      },
    });

    const resSave = await fetch(`http://localhost:${webServer.port}/api/setup/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        PORT: '3119',
        CRUCIX_LANG: 'hu',
      }),
    });
    assert.equal(resSave.status, 200);
    const saveJson = await resSave.json();
    assert.equal(saveJson.ok, true);
    assert.equal(saveJson.willExit, true);
    assert.equal(saveJson.isStandalone, true);

    // Wait for exitHandler timeout
    await new Promise(r => setTimeout(r, 1200));
    assert.equal(exitTriggered, true);
  } finally {
    if (webServer?.close) webServer.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
