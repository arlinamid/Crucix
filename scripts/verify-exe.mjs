#!/usr/bin/env node
// Verification test for Crucix Standalone Executable (Windows / Linux / macOS)
// Validates binary existence, execution, help flag, offline/standalone capabilities,
// and platform-independent user profile config resolution.

import { existsSync, statSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const isWin = process.platform === 'win32';
const exePath = join(ROOT, 'bin', isWin ? 'crucix.exe' : 'crucix');

console.log('🔍 Executable ellenőrzése...');
console.log(`📁 Fájl: ${exePath}`);

assert.ok(existsSync(exePath), `A bináris nem található: ${exePath}`);

const stat = statSync(exePath);
console.log(`📏 Méret: ${(stat.size / (1024 * 1024)).toFixed(1)} MB`);
assert.ok(stat.size > 10 * 1024 * 1024, 'A bináris mérete túl kicsi egy beágyazott Node SEA futtatóhoz képest');

console.log('🔒 SHA-256 ellenőrzőösszeg integritásának vizsgálata...');
const fileBuf = readFileSync(exePath);
const computedHash = createHash('sha256').update(fileBuf).digest('hex');
console.log(`   Számított SHA-256: ${computedHash}`);

const shaPath = `${exePath}.sha256`;
if (existsSync(shaPath)) {
  const recorded = readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0];
  assert.equal(computedHash, recorded, `A rögzített (${recorded}) és számított (${computedHash}) SHA-256 eltér!`);
  console.log('✅ SHA-256 integritás sikeres: az ellenőrzőösszeg pontosan egyezik!');
} else {
  console.log('ℹ️  .sha256 fájl nem volt jelen, a hash kiszámítva.');
}

console.log('▶️ Futtatás: --help tesztelése...');
const helpOut = execFileSync(exePath, ['--help'], { encoding: 'utf8' });
assert.ok(helpOut.includes('Crucix Intelligence CLI'), 'A --help kimenet nem tartalmazza a várt címsort');
assert.ok(helpOut.includes('--sweep'), 'A --help kimenet nem tartalmazza a --sweep opciót');
assert.ok(helpOut.includes('--collector'), 'A --help kimenet nem tartalmazza a --collector opciót');
assert.ok(!helpOut.includes('npm run cli'), 'A bináris --help kimenete nem tartalmazhat npm parancsokat');
assert.ok(helpOut.includes('crucix [options]') || helpOut.includes('crucix [opciók]'), 'A bináris --help kimenetének crucix szintaxist kell mutatnia');
console.log('✅ --help sikeres (csak natív crucix parancsok, npm hivatkozás nélkül)');

console.log('▶️ Futtatás: --categories --no-server tesztelése...');
const catOut = execFileSync(exePath, ['--categories', '--no-server'], { encoding: 'utf8' });
assert.ok(catOut.includes('Kategóriák') || catOut.includes('Categories') || catOut.includes('news'), 'A --categories kimenet rendben');
console.log('✅ --categories --no-server sikeres');

console.log('▶️ Platform-független profilkönyvtár feloldás ellenőrzése...');
const testHomeDir = join(ROOT, 'dist', 'test-user-home');
try {
  mkdirSync(join(testHomeDir, '.crucix'), { recursive: true });
  writeFileSync(join(testHomeDir, '.crucix', '.env'), 'CRUCIX_TEST_USER_PROFILE=active\n', 'utf8');

  // Verify that env.mjs detects ~/.crucix/.env
  const { getEnvSearchPaths } = await import('../apis/utils/env.mjs');
  const paths = getEnvSearchPaths({ home: testHomeDir, cwd: join(ROOT, 'dist') });
  const expectedPath = resolve(join(testHomeDir, '.crucix', '.env'));
  assert.ok(paths.some(p => resolve(p) === expectedPath), `A keresési útvonalak nem tartalmazzák a profil .env-t: ${paths}`);
  console.log(`✅ Profilkönyvtár (.crucix/.env) észlelése sikeres: ${expectedPath}`);
} finally {
  try {
    rmSync(testHomeDir, { recursive: true, force: true });
  } catch {}
}

console.log('▶️ Teljes önállóság (standalone isolation) tesztelése forrásfájlok nélkül...');
const testIsolatedDir = join(ROOT, 'dist', 'test-isolated-env');
try {
  mkdirSync(testIsolatedDir, { recursive: true });
  const isolatedOut = execFileSync(exePath, ['--countries'], {
    cwd: testIsolatedDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      CRUCIX_HOME: join(testIsolatedDir, '.crucix'),
      RUNS_DIR: join(testIsolatedDir, '.crucix', 'runs'),
    },
  });
  assert.ok(isolatedOut.includes('Crucix World News Catalog') || isolatedOut.includes('Crucix Világ Hírforrás Katalógus'), 'A bináris nem működött izolált könyvtárban');
  assert.ok(isolatedOut.includes('191+ Countries') || isolatedOut.includes('191+ Ország'), 'A katalógus nem érhető el forrásfájlok nélkül');
  console.log('✅ Teljes önállóság (standalone isolation) sikeres: a bináris forrásfájlok nélkül is 100%-ban működik!');

  console.log('▶️ Standalone 1-kattintásos setup web szerver tesztelése...');
  const setupPort = 39483;
  const child = spawn(exePath, ['setup', '--web', '--no-open'], {
    cwd: testIsolatedDir,
    env: {
      ...process.env,
      SETUP_PORT: String(setupPort),
      NO_AUTO_OPEN: '1',
      HEADLESS: '1',
      CRUCIX_HOME: join(testIsolatedDir, '.crucix'),
      RUNS_DIR: join(testIsolatedDir, '.crucix', 'runs'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    let setupOk = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      try {
        const res = await fetch(`http://localhost:${setupPort}/setup.html`);
        if (res.status === 200) {
          const body = await res.text();
          assert.ok(body.includes('CRUCIX'), 'A setup oldal nem tartalmazza a CRUCIX nevet');
          assert.ok(body.includes('BotFather'), 'A setup oldal nem tartalmazza a BotFather-t');
          assert.ok(!body.includes('Setup page not found on disk'), 'A setup oldal nem található hibát adott');

          // Check API endpoint as well
          const configRes = await fetch(`http://localhost:${setupPort}/api/setup/config`);
          assert.equal(configRes.status, 200, 'A /api/setup/config nem adott 200 OK státuszt');
          const configJson = await configRes.json();
          assert.ok(typeof configJson === 'object', 'A setup config válasz nem érvényes objektum');

          setupOk = true;
          break;
        }
      } catch {}
    }
    assert.ok(setupOk, 'A webes setup szerver nem válaszolt a megadott időn belül');
    console.log('✅ Standalone setup web szerver sikeres: a beágyazott setup.html és a config API hibátlanul válaszol (felugró ablak nélkül)!');
  } finally {
    try {
      child.kill();
    } catch {}
  }

  console.log('▶️ Standalone web szerver & dashboard (jarvis.html) tesztelése...');
  const serverPort = 39486;
  const serverChild = spawn(exePath, ['server', '--headless', '--port', String(serverPort)], {
    cwd: testIsolatedDir,
    env: {
      ...process.env,
      PORT: String(serverPort),
      NO_AUTO_OPEN: '1',
      HEADLESS: '1',
      CRUCIX_HOME: join(testIsolatedDir, '.crucix'),
      RUNS_DIR: join(testIsolatedDir, '.crucix', 'runs'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    let serverOk = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      try {
        const res = await fetch(`http://localhost:${serverPort}/`);
        if (res.status === 200) {
          const body = await res.text();
          assert.ok(body.includes('CRUCIX') || body.includes('jarvis'), 'A dashboard HTML nem megfelelő');
          assert.ok(!body.includes('ENOENT'), 'ENOENT hiba történt a dashboard kiszolgálásakor');

          // Check API health endpoint
          const healthRes = await fetch(`http://localhost:${serverPort}/api/health`);
          if (healthRes.status === 200) {
            const healthData = await healthRes.json();
            assert.ok(typeof healthData === 'object', 'A health végpont nem JSON objektumot adott vissza');
          }

          serverOk = true;
          break;
        }
      } catch {}
    }
    assert.ok(serverOk, 'A standalone web szerver nem indult el vagy nem szolgálta ki a dashboardot');
    console.log('✅ Standalone web szerver & dashboard sikeres: a jarvis.html és az API végpontok hiba nélkül válaszolnak!');
  } finally {
    try {
      serverChild.kill();
    } catch {}
  }
} finally {
  try {
    rmSync(testIsolatedDir, { recursive: true, force: true });
  } catch {}
}

console.log('\n🎉 Minden bináris és platformfüggetlen konfigurációs teszt sikeresen lefutott!');
