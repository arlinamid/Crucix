#!/bin/sh
# Crucix standalone installer (Linux x64, macOS arm64). Node is not required.
#   curl -fsSL https://github.com/arlinamid/Crucix/releases/latest/download/install.sh | sh
# Pin a tag:  CRUCIX_VERSION=v2.39.3 curl -fsSL ... | sh
# Dest:       CRUCIX_BIN (default ~/.local/bin)

set -eu
REPO="${CRUCIX_REPO:-arlinamid/Crucix}"
TAG="${CRUCIX_VERSION:-latest}"
BIN_DIR="${CRUCIX_BIN:-$HOME/.local/bin}"

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux)  os_name=linux ;;
  Darwin) os_name=macos ;;
  *) echo "Unsupported OS: $os" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) cpu=x64 ;;
  arm64|aarch64) cpu=arm64 ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

ASSET="crucix-${os_name}-${cpu}"
if [ "$TAG" != latest ] && ! echo "$TAG" | grep -q '^v'; then
  TAG="v$TAG"
fi
if [ "$TAG" = latest ]; then
  BASE="https://github.com/${REPO}/releases/latest/download"
else
  BASE="https://github.com/${REPO}/releases/download/${TAG}"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "Crucix standalone install"
echo "  source  ${BASE}/${ASSET}"
echo "  dest    ${BIN_DIR}/crucix"

if ! curl -fsSL "${BASE}/${ASSET}" -o "${TMP}/${ASSET}"; then
  echo "Download failed. This release may not have ${ASSET}." >&2
  exit 1
fi
curl -fsSL "${BASE}/SHA256SUMS.txt" -o "${TMP}/SHA256SUMS.txt"

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "${TMP}/${ASSET}" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL=$(shasum -a 256 "${TMP}/${ASSET}" | awk '{print $1}')
else
  echo "Need sha256sum or shasum to verify the download." >&2
  exit 1
fi
EXPECTED=$(awk -v f="$ASSET" '$2==f {print $1; exit}' "${TMP}/SHA256SUMS.txt" | tr 'A-F' 'a-f')
if [ -z "$EXPECTED" ]; then
  echo "SHA256SUMS.txt has no entry for ${ASSET}" >&2
  exit 1
fi
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "Checksum mismatch for ${ASSET}" >&2
  echo "  expected ${EXPECTED}" >&2
  echo "  got      ${ACTUAL}" >&2
  exit 1
fi
echo "  sha256  ${ACTUAL}"

mkdir -p "$BIN_DIR"
cp "${TMP}/${ASSET}" "${BIN_DIR}/crucix"
chmod 755 "${BIN_DIR}/crucix"

echo
echo "Installed ${BIN_DIR}/crucix"
case ":$PATH:" in
  *":${BIN_DIR}:"*) ;;
  *) echo "Add this folder to PATH, then open a new terminal:"; echo "  ${BIN_DIR}" ;;
esac
echo "  crucix --version"
echo "  crucix install --no-setup"
echo "  crucix setup"
