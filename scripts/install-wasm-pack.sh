#!/usr/bin/env bash
# Install wasm-pack when missing, from the official prebuilt release.
#
# The MLS WASM binary is a BUILD ARTEFACT and is never committed, so every pipeline that
# ships a client has to compile it - which means every pipeline needs this tool. The version
# is PINNED: two pipelines building the same crate with two different toolchains would ship
# two different cryptos to two different clients, silently, which is the exact defect the
# committed binary caused.
set -euo pipefail

WASM_PACK_VERSION="${WASM_PACK_VERSION:-0.15.0}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.cargo/bin}"

if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
export PATH="$INSTALL_DIR:$PATH"

if command -v wasm-pack >/dev/null 2>&1; then
  have="$(wasm-pack --version | awk '{print $2}')"
  if [ "$have" = "$WASM_PACK_VERSION" ]; then
    echo "wasm-pack already installed: $have"
    exit 0
  fi
  echo "wasm-pack $have found but $WASM_PACK_VERSION is pinned - replacing it."
fi

case "$(uname -s)" in
  Linux)
    target="x86_64-unknown-linux-musl"
    ;;
  Darwin)
    case "$(uname -m)" in
      arm64) target="aarch64-apple-darwin" ;;
      *) target="x86_64-apple-darwin" ;;
    esac
    ;;
  *)
    echo "No prebuilt wasm-pack for $(uname -s)."
    echo "Install it by hand: cargo install wasm-pack --locked --version ${WASM_PACK_VERSION}"
    exit 1
    ;;
esac

archive="wasm-pack-v${WASM_PACK_VERSION}-${target}"
url="https://github.com/rustwasm/wasm-pack/releases/download/v${WASM_PACK_VERSION}/${archive}.tar.gz"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading ${url}"
curl -fsSL "$url" | tar -xz -C "$tmp"

mkdir -p "$INSTALL_DIR"
install -m 0755 "${tmp}/${archive}/wasm-pack" "${INSTALL_DIR}/wasm-pack"

echo "wasm-pack $("${INSTALL_DIR}/wasm-pack" --version | awk '{print $2}') installed in ${INSTALL_DIR}"
