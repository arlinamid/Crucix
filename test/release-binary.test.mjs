import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checksumFor, installedBinaryName, releaseAssetName, releaseDownloadUrl } from '../lib/release-binary.mjs';

test('release asset names match the SEA canonical files CI uploads', () => {
  assert.equal(releaseAssetName('win32', 'x64'), 'crucix-windows-x64.exe');
  assert.equal(releaseAssetName('linux', 'x64'), 'crucix-linux-x64');
  assert.equal(releaseAssetName('darwin', 'arm64'), 'crucix-macos-arm64');
  assert.equal(releaseAssetName('darwin', 'x64'), 'crucix-macos-x64');
  assert.equal(releaseAssetName('aix', 'x64'), null);
  assert.equal(installedBinaryName('win32'), 'crucix.exe');
  assert.equal(installedBinaryName('linux'), 'crucix');
  assert.equal(releaseDownloadUrl('arlinamid/Crucix', 'latest', 'crucix-windows-x64.exe'),
    'https://github.com/arlinamid/Crucix/releases/latest/download/crucix-windows-x64.exe');
  assert.equal(releaseDownloadUrl('arlinamid/Crucix', 'v2.39.3', 'SHA256SUMS.txt'),
    'https://github.com/arlinamid/Crucix/releases/download/v2.39.3/SHA256SUMS.txt');
});

test('checksumFor reads sha256sum lines used on the GitHub Release', () => {
  const sums = [
    'e3f894463247f040158e057f35579be75e6700db4696c487244d94653e90b6ef  crucix-windows-x64.exe',
    'e3f894463247f040158e057f35579be75e6700db4696c487244d94653e90b6ef  crucix.exe',
    '4d6773273d5ca850ef048a07f44d417df7ae2b3787fcfa2dc02a395842ff8a99  crucix-linux-x64',
  ].join('\n');
  assert.equal(checksumFor(sums, 'crucix-windows-x64.exe'), 'e3f894463247f040158e057f35579be75e6700db4696c487244d94653e90b6ef');
  assert.equal(checksumFor(sums, 'crucix-linux-x64'), '4d6773273d5ca850ef048a07f44d417df7ae2b3787fcfa2dc02a395842ff8a99');
  assert.equal(checksumFor(sums, 'crucix-macos-arm64'), null);
});

test('install.ps1 and install.sh download the same canonical asset names', () => {
  const ps1 = readFileSync(new URL('../scripts/install.ps1', import.meta.url), 'utf8');
  const sh = readFileSync(new URL('../scripts/install.sh', import.meta.url), 'utf8');
  assert.match(ps1, /irm https:\/\/github\.com\/arlinamid\/Crucix\/releases\/latest\/download\/install\.ps1 \| iex/);
  assert.match(ps1, /crucix-windows-\$cpu\.exe/);
  assert.match(sh, /curl -fsSL https:\/\/github\.com\/arlinamid\/Crucix\/releases\/latest\/download\/install\.sh \| sh/);
  assert.match(sh, /ASSET="crucix-\$\{os_name\}-\$\{cpu\}"/);
  assert.match(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'), /cp scripts\/install\.ps1 scripts\/install\.sh dist-release\//);
});
