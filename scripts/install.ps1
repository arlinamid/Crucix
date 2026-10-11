# Crucix standalone installer (Windows x64). Node is not required.
#   irm https://github.com/arlinamid/Crucix/releases/latest/download/install.ps1 | iex
# Pin a tag:  $env:CRUCIX_VERSION = 'v2.39.3'; irm ... | iex
# Dest:       $env:CRUCIX_BIN (default %USERPROFILE%\.local\bin)

$ErrorActionPreference = 'Stop'
$repo = if ($env:CRUCIX_REPO) { $env:CRUCIX_REPO } else { 'arlinamid/Crucix' }
$tag = if ($env:CRUCIX_VERSION) { $env:CRUCIX_VERSION } else { 'latest' }
$binDir = if ($env:CRUCIX_BIN) { $env:CRUCIX_BIN } else { Join-Path $env:USERPROFILE '.local\bin' }

$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -eq 'AMD64') { $cpu = 'x64' }
elseif ($arch -eq 'ARM64') { $cpu = 'arm64' }
else { throw "Unsupported Windows architecture: $arch" }

$asset = "crucix-windows-$cpu.exe"
if ($cpu -ne 'x64') {
  throw "This release has no Windows $cpu binary yet. Use an x64 machine or build from source (npm run install:local)."
}

$base = if ($tag -eq 'latest') {
  "https://github.com/$repo/releases/latest/download"
} else {
  if ($tag -notmatch '^v') { $tag = "v$tag" }
  "https://github.com/$repo/releases/download/$tag"
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("crucix-dl-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$exeTmp = Join-Path $tmp $asset
$sumsTmp = Join-Path $tmp 'SHA256SUMS.txt'

Write-Host "Crucix standalone install"
Write-Host "  source  $base/$asset"
Write-Host "  dest    $(Join-Path $binDir 'crucix.exe')"

try {
  try {
    Invoke-WebRequest -Uri "$base/$asset" -OutFile $exeTmp -UseBasicParsing
    Invoke-WebRequest -Uri "$base/SHA256SUMS.txt" -OutFile $sumsTmp -UseBasicParsing
  } catch {
    throw "Download failed. Check $base/$asset ($($_.Exception.Message))"
  }

$actual = (Get-FileHash -Algorithm SHA256 -Path $exeTmp).Hash.ToLowerInvariant()
$expected = $null
foreach ($line in Get-Content $sumsTmp) {
  if ($line -match '^([a-fA-F0-9]{64})\s+(\S+)\s*$' -and $Matches[2] -eq $asset) {
    $expected = $Matches[1].ToLowerInvariant()
    break
  }
}
if (-not $expected) { throw "SHA256SUMS.txt has no entry for $asset" }
if ($actual -ne $expected) { throw "Checksum mismatch for $asset`n  expected $expected`n  got      $actual" }
Write-Host "  sha256  $actual"

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$target = Join-Path $binDir 'crucix.exe'
Copy-Item -Force $exeTmp $target
Set-Content -Path (Join-Path $binDir 'crucix.cmd') -Value "@echo off`r`n`"%~dp0crucix.exe`" %*`r`n" -Encoding ascii
$sh = "#!/usr/bin/env sh`nbasedir=`$(dirname `"`$0`")`nexec `"`$basedir/crucix.exe`" `"`$@`"`n"
Set-Content -Path (Join-Path $binDir 'crucix') -Value $sh -Encoding ascii

$onPath = ($env:PATH -split ';' | ForEach-Object { $_.TrimEnd('\') }) -contains $binDir.TrimEnd('\')
Write-Host ""
Write-Host "Installed $target"
if (-not $onPath) {
  Write-Host "Add this folder to PATH, then open a new terminal:"
  Write-Host "  $binDir"
}
Write-Host "  crucix --version"
Write-Host "  crucix install --no-setup"
Write-Host "  crucix setup"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
