#!/usr/bin/env bash
#
# Mints the TLS material the LOCAL estate needs, and nothing else touches production.
#
# WHY THE LOCAL ESTATE NEEDS TLS AT ALL, which is not a preference. `setRefreshCookie` in
# `apps/core-service/src/auth/auth.controller.ts` picks the refresh cookie's attributes from
# `ALLOW_INSECURE_COOKIES`, and its own error text states the rule: *"Use true for a stack served
# over plain HTTP on localhost, false for anything reached over HTTPS."* On `true` the cookie is
# `SameSite=Lax` without `Secure`, which a browser whose page IS `localhost` accepts and the Android
# WebView cannot: its page is `tauri.localhost`, so the cookie arrives in a THIRD-PARTY context, and
# a `Lax` cookie cannot be SET there. Measured 2026-09-04: the phone logs in, answers its PIN, then
# logs itself out before publishing a key package - so it joins no group, lists no conversation, and
# every `+A1` row is blocked on the estate rather than on the product. `SameSite=None` requires
# `Secure`, and `Secure` cannot be set over plain HTTP, so the only way out is real TLS.
#
# A LOCAL CA, NOT A BARE SELF-SIGNED LEAF, and the difference is the phone. A leaf signed by itself
# can only be trusted by pinning it everywhere; a CA can be installed once - in Chrome's store for
# the browsers, and on the device for Android - and then every certificate it signs is trusted,
# including the ones a later session mints for a second estate. The CA's private key is a local dev
# secret: it stays out of the repository, like every other credential here.
#
# Usage:
#   infrastructure/local/make-local-cert.sh          mint if absent, print what exists
#   infrastructure/local/make-local-cert.sh --force  re-mint, invalidating anything that trusted it
#
# Writes into `<repo>/infrastructure/local/certs/`, which is gitignored. Re-running without --force
# is a no-op that prints the expiry, so it is safe from a script that just wants the files present.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS="$HERE/certs"
DAYS=825 # the longest a leaf may live and still be accepted by Apple's rule; harmless elsewhere

log() { printf '[local-cert] %s\n' "$*"; }
fail() {
  printf '[local-cert] ERROR %s\n' "$*" >&2
  exit 1
}

command -v openssl >/dev/null 2>&1 || fail "openssl is not on PATH"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

mkdir -p "$CERTS"

if [ -f "$CERTS/local.crt" ] && [ "$FORCE" -eq 0 ]; then
  log "already present: $CERTS/local.crt"
  log "expires: $(openssl x509 -in "$CERTS/local.crt" -noout -enddate | cut -d= -f2)"
  log "re-mint with --force (this invalidates every client that trusted the old CA)"
  exit 0
fi

# ── The CA ──────────────────────────────────────────────────────────────────
# Generated once and kept: re-minting it is what forces every browser and the phone to install a new
# root, so `--force` says so out loud rather than doing it as a side effect of asking for a leaf.
#
# **NO `-subj`, AND THAT IS NOT A STYLE CHOICE.** Under MSYS - which is the shell this repository's
# Bash tool runs - an argument beginning with `/` is rewritten as a Windows path before openssl ever
# sees it, so `-subj "/CN=..."` arrives as `C:/Program Files/Git/CN=...` and openssl refuses it with
# `subject name is expected to be in the format /type0=value0`. The key is written and the
# certificate is not, which looks exactly like a half-finished run. A config file carries the same
# distinguished name through both shells untouched.
if [ ! -f "$CERTS/localCA.key" ] || [ "$FORCE" -eq 1 ]; then
  log "minting a local development CA"
  cat >"$CERTS/ca.cnf" <<'CACNF'
[req]
distinguished_name = dn
x509_extensions    = ext
prompt             = no
[dn]
CN = Canari Local Development CA
O  = Canari local estate
[ext]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage         = critical, keyCertSign, cRLSign
CACNF
  openssl req -x509 -nodes -newkey rsa:4096 -sha256 -days 3650 \
    -keyout "$CERTS/localCA.key" -out "$CERTS/localCA.crt" \
    -config "$CERTS/ca.cnf"
fi

# ── The leaf ────────────────────────────────────────────────────────────────
# SANs, not a CN: every current client ignores the Common Name entirely. `localhost` is what the
# browsers and the phone's `adb reverse` both reach the estate by; the two IP forms are there for a
# caller that resolves the name differently, and cost nothing.
cat >"$CERTS/leaf.cnf" <<'CNF'
[req]
distinguished_name = dn
req_extensions     = ext
prompt             = no
[dn]
CN = localhost
[ext]
subjectAltName   = @alt
keyUsage         = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
[alt]
DNS.1 = localhost
DNS.2 = tauri.localhost
IP.1  = 127.0.0.1
IP.2  = ::1
CNF

log "minting the leaf for localhost"
openssl req -nodes -newkey rsa:2048 -sha256 \
  -keyout "$CERTS/local.key" -out "$CERTS/local.csr" \
  -config "$CERTS/leaf.cnf"

openssl x509 -req -in "$CERTS/local.csr" \
  -CA "$CERTS/localCA.crt" -CAkey "$CERTS/localCA.key" -CAcreateserial \
  -out "$CERTS/local.crt" -days "$DAYS" -sha256 \
  -extfile "$CERTS/leaf.cnf" -extensions ext

rm -f "$CERTS/local.csr"

# nginx runs as a non-root user inside the image and only ever READS these.
chmod 644 "$CERTS/local.crt" "$CERTS/localCA.crt" 2>/dev/null || true
chmod 600 "$CERTS/local.key" "$CERTS/localCA.key" 2>/dev/null || true

log "wrote:"
log "  CA   $CERTS/localCA.crt   (install this one - browsers and the phone)"
log "  leaf $CERTS/local.crt     (nginx serves this)"
log "expires: $(openssl x509 -in "$CERTS/local.crt" -noout -enddate | cut -d= -f2)"
log ""
log "TRUSTING IT IS A SEPARATE, MANUAL STEP and nothing here does it for you:"
log "  Chrome/Edge : certmgr.msc -> Trusted Root Certification Authorities -> Import localCA.crt"
log "  Android     : adb push localCA.crt /sdcard/ then Settings > Security > Install from storage"
log "                (a debug APK must ALSO declare a network security config trusting user CAs)"
