// Names of the GitHub Release assets that `scripts/build-exe.mjs` and CI upload.
// install.ps1 / install.sh must stay in lockstep with this map.

const OS = Object.freeze({ win32: 'windows', linux: 'linux', darwin: 'macos' });
const ARCH = Object.freeze({ x64: 'x64', arm64: 'arm64' });

export function releaseAssetName(platform = process.platform, arch = process.arch) {
  const os = OS[platform];
  const cpu = ARCH[arch];
  if (!os || !cpu) return null;
  return `crucix-${os}-${cpu}${os === 'windows' ? '.exe' : ''}`;
}

export function installedBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'crucix.exe' : 'crucix';
}

export function checksumFor(sumsText, filename) {
  if (!sumsText || !filename) return null;
  for (const line of String(sumsText).split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+(\S+)\s*$/);
    if (match && match[2] === filename) return match[1].toLowerCase();
  }
  return null;
}

export function releaseDownloadUrl(repo, tag, filename) {
  const ownerRepo = repo || 'arlinamid/Crucix';
  const ref = !tag || tag === 'latest' ? 'latest' : tag;
  const path = ref === 'latest' ? 'latest/download' : `download/${ref}`;
  return `https://github.com/${ownerRepo}/releases/${path}/${filename}`;
}
