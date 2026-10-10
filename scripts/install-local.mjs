#!/usr/bin/env node
// Install Crucix into User Profile (%USERPROFILE%/.crucix) and .local/bin
// Usage: node scripts/install-local.mjs

import { existsSync, mkdirSync, cpSync, copyFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const HOME = homedir();
const userCrucixDir = join(HOME, '.crucix');
const userLocalBinDir = join(HOME, '.local', 'bin');
const isWin = process.platform === 'win32';
const exeName = isWin ? 'crucix.exe' : 'crucix';
const srcExe = join(ROOT, 'bin', exeName);
const targetExe = join(userLocalBinDir, exeName);

console.log('\n=============================================================');
console.log('       CRUCIX LOCAL USER PROFILE INSTALLER');
console.log('=============================================================\n');
console.log(`🏠 Felhasználói könyvtár (HOME): ${HOME}`);
console.log(`📂 Munkakönyvtár (.crucix):     ${userCrucixDir}`);
console.log(`🚀 Bináris mappa (.local/bin):    ${userLocalBinDir}\n`);

// 1. Build latest executable first
console.log('🔨 [1/5] Legfrissebb SEA bináris fordítása...');
execSync(`"${process.execPath}" scripts/build-exe.mjs`, { cwd: ROOT, stdio: 'inherit' });

// 2. Ensure directories exist
console.log('\n📁 [2/5] Célkönyvtárak előkészítése...');
mkdirSync(userCrucixDir, { recursive: true });
mkdirSync(userLocalBinDir, { recursive: true });

// 3. Copy working files into %USERPROFILE%/.crucix
console.log('📦 [3/5] Munkakönyvtár fájlok szinkronizálása -> ' + userCrucixDir + '...');

const copyDirs = [
  'apis',
  'dashboard',
  'data',
  'lib',
  'locales',
  'scripts',
  'runs',
  'node_modules',
];

for (const dir of copyDirs) {
  const src = join(ROOT, dir);
  const dest = join(userCrucixDir, dir);
  if (existsSync(src)) {
    process.stdout.write(`   • Másolás: ${dir}/... `);
    cpSync(src, dest, { recursive: true, force: true });
    console.log('kész');
  }
}

const copyFiles = [
  'package.json',
  'package-lock.json',
  'crucix.config.mjs',
  'server.mjs',
  'diag.mjs',
];

for (const file of copyFiles) {
  const src = join(ROOT, file);
  const dest = join(userCrucixDir, file);
  if (existsSync(src)) {
    copyFileSync(src, dest);
  }
}

// Copy .env or .env.example
const srcEnv = existsSync(join(ROOT, '.env')) ? join(ROOT, '.env') : join(ROOT, '.env.example');
const destEnv = join(userCrucixDir, '.env');
if (!existsSync(destEnv) || existsSync(join(ROOT, '.env'))) {
  copyFileSync(srcEnv, destEnv);
  console.log('   • .env konfiguráció másolva a profilba');
}

// 4. Copy standalone executable and shims to .local/bin
console.log('\n🚀 [4/5] Végrehajtható bináris telepítése -> ' + userLocalBinDir + '...');
copyFileSync(srcExe, targetExe);
try {
  chmodSync(targetExe, 0o755);
} catch {}
console.log(`   • ${exeName} sikeresen átmásolva (${(srcExe ? 'OK' : 'HIÁNYZIK')})`);

if (isWin) {
  // Add crucix.cmd wrapper for Windows Command Prompt convenience
  const cmdShim = `@echo off\r\n"%~dp0crucix.exe" %*\r\n`;
  writeFileSync(join(userLocalBinDir, 'crucix.cmd'), cmdShim, 'utf8');
  console.log('   • crucix.cmd parancsfájl létrehozva');
}

// Add unix-compatible shell wrapper for WSL/Git Bash
const shShim = `#!/usr/bin/env sh
basedir=$(dirname "$0")
if [ -f "$basedir/crucix.exe" ]; then
  exec "$basedir/crucix.exe" "$@"
else
  exec "$basedir/crucix" "$@"
fi
`;
writeFileSync(join(userLocalBinDir, 'crucix'), shShim, { encoding: 'utf8', mode: 0o755 });
console.log('   • crucix shell shim létrehozva');

// 5. Verification
console.log('\n🔍 [5/5] Telepítés ellenőrzése független könyvtárból...');
try {
  const verifyOut = execFileSync(targetExe, ['--categories', '--no-server'], {
    cwd: HOME,
    encoding: 'utf8',
    env: { ...process.env, CRUCIX_HOME: userCrucixDir },
  });
  console.log('✅ A bináris sikeresen fut a felhasználói munkakönyvtárból (%USERPROFILE%/.crucix)!');
  
  const briefOut = execFileSync(targetExe, ['-b', '--no-server', '-L', 'hu'], {
    cwd: HOME,
    encoding: 'utf8',
    env: { ...process.env, CRUCIX_HOME: userCrucixDir },
  });
  if (briefOut.includes('CRUCIX VEZETŐI INTELLIGENCIA ÖSSZEFOGLALÓ')) {
    console.log('✅ A vezetői összefoglaló (briefing) sikeresen válaszol magyar nyelven.');
  }
} catch (err) {
  console.error('❌ Hiba történt az ellenőrzés során:', err.message);
  process.exit(1);
}

console.log('\n=============================================================');
console.log('🎉 CRUCIX SIKERESEN TELEPÍTVE ÉS ELÉRHETŐ A RENDSZEREN!');
console.log('=============================================================');
console.log('Munkakönyvtár:    ' + userCrucixDir);
console.log('Bináris elérési út: ' + targetExe);
console.log('\nTerminál parancsok bárhonnan futtatva:');
console.log('  crucix -b                               # Vezetői összefoglaló (EN)');
console.log('  crucix -b -L hu                         # Vezetői összefoglaló (HU)');
console.log('  crucix -m                               # Pénzügyi piacok és nyersanyagok');
console.log('  crucix --earthquakes                    # Legfrissebb földrengések');
console.log('  crucix --thermal                        # NASA FIRMS műholdas hőtérkép');
console.log('  crucix --risk UA                        # Ukrajna kockázati profil');
console.log('  crucix --help                           # Összes parancssori opció');
console.log('=============================================================\n');
