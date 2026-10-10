#!/usr/bin/env node
// Crucix Executable Builder (Cross-Platform Node SEA: Windows, Linux, macOS)
// Generates a standalone native binary (bin/crucix.exe or bin/crucix) using Node.js SEA and postject.

import { existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const binDir = join(ROOT, 'bin');
const distBuildDir = join(ROOT, 'dist', 'sea-build');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const exeName = isWin ? 'crucix.exe' : 'crucix';
const targetExe = join(binDir, exeName);

console.log(`\n=============================================================`);
console.log(`        CRUCIX STANDALONE EXECUTABLE BUILDER (SEA)`);
console.log(`=============================================================\n`);

console.log(`📦 Node verzió:      ${process.version}`);
console.log(`💻 Platform:         ${process.platform} (${process.arch})`);
console.log(`📂 Célfájl:          ${targetExe}\n`);

// 1. Ensure directories exist
mkdirSync(binDir, { recursive: true });
mkdirSync(distBuildDir, { recursive: true });

// 2. Generate launcher script (main.cjs)
const launcherScript = `// Crucix Standalone SEA Launcher
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

function findCliPath() {
  const candidates = [
    process.env.CRUCIX_HOME,
    path.join(os.homedir(), '.crucix'),
    process.cwd(),
    path.dirname(process.execPath),
    path.resolve(path.dirname(process.execPath), '..'),
    path.resolve(path.dirname(process.execPath), '..', '..'),
    path.join(os.homedir(), 'Crucix'),
    path.join(os.homedir(), 'tools', 'Crucix'),
    'D:\\\\tools\\\\Crucix',
  ].filter(Boolean);

  for (const dir of candidates) {
    const candidate = path.join(dir, 'scripts', 'cli.mjs');
    if (fs.existsSync(candidate)) return candidate;
  }

  // Walk up from cwd
  let cur = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(cur, 'scripts', 'cli.mjs');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

const cliPath = findCliPath();

if (!cliPath) {
  console.error('\\n❌ Hiba: A Crucix projektgyökér (scripts/cli.mjs) nem található.');
  console.error('Futtasd a programot a Crucix könyvtárából, tedd a binárist a projektbe,');
  console.error('vagy állítsd be a CRUCIX_HOME környezeti változót (%USERPROFILE%\\\\.crucix vagy ~/.crucix).\\n');
  process.exit(1);
}

process.env.CRUCIX_EXECUTABLE = '1';

const crucixHome = path.resolve(path.dirname(cliPath), '..');
if (!process.env.CRUCIX_HOME) {
  process.env.CRUCIX_HOME = crucixHome;
}
if (!process.env.RUNS_DIR) {
  process.env.RUNS_DIR = path.join(crucixHome, 'runs');
}

// Ensure working folder is set to Crucix home directory
try {
  process.chdir(crucixHome);
} catch (e) {}

process.argv[1] = cliPath;
import(pathToFileURL(cliPath).href).catch(err => {
  console.error('\\n❌ Hiba történt a Crucix futtatásakor:', err?.stack || err?.message || err);
  process.exit(1);
});
`;

const mainCjsPath = join(distBuildDir, 'main.cjs');
writeFileSync(mainCjsPath, launcherScript, 'utf8');

// 3. Write sea-config.json
const seaConfigPath = join(distBuildDir, 'sea-config.json');
const prepBlobPath = join(distBuildDir, 'sea-prep.blob');
writeFileSync(seaConfigPath, JSON.stringify({
  main: mainCjsPath,
  output: prepBlobPath,
  disableExperimentalSEAWarning: true
}, null, 2), 'utf8');

// 4. Generate SEA preparation blob
console.log('⚙️  SEA bináris blob generálása (node --experimental-sea-config)...');
execSync(`"${process.execPath}" --experimental-sea-config "${seaConfigPath}"`, { stdio: 'inherit' });

// 5. Copy Node binary to target
console.log(`📋 Futtatható bináris előkészítése -> ${targetExe}...`);
copyFileSync(process.execPath, targetExe);

// 6. Inject blob into executable with postject
console.log('💉 Kód és futtatókörnyezet beoltása (postject)...');
const machoFlag = isMac ? ' --macho-segment-name NODE_SEA' : '';
const postjectCmd = `npx --yes postject "${targetExe}" NODE_SEA_BLOB "${prepBlobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2${machoFlag} --overwrite`;
execSync(postjectCmd, { stdio: 'inherit' });

if (!isWin) {
  try {
    chmodSync(targetExe, 0o755);
  } catch (err) {
    console.warn('⚠️  chmod hiba:', err?.message || err);
  }
}

if (isMac) {
  try {
    execSync(`codesign --sign - "${targetExe}"`, { stdio: 'inherit' });
    console.log('🔏 Mach-O kódaláírás sikeres (ad-hoc codesign)');
  } catch (err) {
    console.warn('⚠️  codesign nem sikerült vagy nem elérhető:', err?.message || err);
  }
}

// 7. Cleanup temp build folder
try {
  rmSync(distBuildDir, { recursive: true, force: true });
} catch {
  // ignore
}

const stat = statSync(targetExe);
const mb = (stat.size / (1024 * 1024)).toFixed(1);

const runCmd = isWin ? `.\\bin\\crucix.exe` : `./bin/crucix`;

console.log(`\n=============================================================`);
console.log(`✅ Crucix Executable Sikeresen Létrejött!`);
console.log(`📁 Elérési út:       ${targetExe}`);
console.log(`📏 Méret:           ${mb} MB`);
console.log(`=============================================================\n`);
console.log(`💡 Használati példák a terminálból:`);
console.log(`   ${runCmd} -b                       # Vezetői összefoglaló`);
console.log(`   ${runCmd} -m                       # Pénzügyi piacok & nyersanyagok`);
console.log(`   ${runCmd} --earthquakes --since 14d # Földrengések az elmúlt 2 hétből`);
console.log(`   ${runCmd} --risk UA                # Ukrajna kockázati profilja`);
console.log(`   ${runCmd} --daemon                 # Fejetlen háttérszerver indítása`);
console.log(`   ${runCmd} --collector              # Folyamatos adatgyűjtő ciklus\n`);
