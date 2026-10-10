import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnvContent, updateEnvFile } from '../lib/setup-wizard.mjs';

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
