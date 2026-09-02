#!/usr/bin/env bash
#
# Builds infrastructure/.env and frontend/.env for a LOCAL stack out of a snapshot of production's
# infrastructure/.env, and classifies every single variable rather than copying the file.
#
# WHY A CLASSIFICATION AND NOT A COPY. Decided with the user on 2026-09-02 ("tout pareil que la
# prod") with one correction the user did not have to make, because the difference is not a
# preference:
#
#   * A THIRD-PARTY credential is kept as production's. Stripe, Lydia, FCM, APNs, Cloudflare TURN,
#     MiGallery, Safe Browsing, the inter-app API keys: none of them has a local equivalent, and
#     substituting one would only produce failures that mean nothing.
#   * A DATA-AT-REST key is kept as production's, because it is the only way the data can be read.
#     `CHANNELS_ENCRYPTION_SECRET` is the one: regenerate it and every salon carried in by
#     `dump-prod-to-local.sh` becomes undecryptable.
#   * An AUTHENTICATION secret is REGENERATED. `JWT_SECRET`, `INTERNAL_SECRET`,
#     `INTERNAL_SHARED_SECRET` and `CALL_ROOM_SECRET` mint or verify credentials, so sharing them
#     would make a token forged on a laptop valid in production. They carry no data, so a fresh
#     value costs nothing at all.
#   * A TOPOLOGY variable is local by definition - hosts, ports, origins, registry, NODE_ENV.
#   * An OIDC CLIENT is local: `canari-local` on the production Authentik, its own id and secret,
#     redirect URIs on localhost. Production's client is not reused, or a page served from
#     localhost could obtain production tokens under production's own client.
#
# AN UNKNOWN VARIABLE IS AN ERROR, NOT A DEFAULT. If production gains a variable this script has
# never heard of, it stops and names it. Copying it blind could carry a live credential into a
# category that was never considered; dropping it silently would produce a local stack missing
# something with nothing to say so. Which of the five lists it belongs in is a decision, and a
# decision belongs to a person.
#
# NOTHING HERE PRINTS A VALUE. The summary counts variables per category and names them, never
# their contents: this script's whole input is secret.
#
# Usage:
#   infrastructure/local/env-from-prod.sh <path-to-prod-env>
#   infrastructure/local/env-from-prod.sh -            # read the snapshot from stdin
#
# Getting the snapshot is the CALLER's job, because the transport differs by platform: on Windows
# `ssh canari` only works through the PowerShell tool (Git Bash eats the backslashes in the
# cloudflared ProxyCommand). `make local-env` does it for you.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INFRA_ENV="$ROOT/infrastructure/.env"
FRONTEND_ENV="$ROOT/frontend/.env"

log() { printf '[env-from-prod] %s\n' "$*"; }
fail() {
  printf '[env-from-prod] ERROR %s\n' "$*" >&2
  exit 1
}

[ $# -ge 1 ] || fail "usage: $0 <path-to-prod-env>|-   (see the header)"
command -v openssl >/dev/null || fail "openssl is required to generate the local auth secrets"

SOURCE="$1"
SNAPSHOT="$(mktemp "${TMPDIR:-/tmp}/canari-prod-env.XXXXXX")"
trap 'rm -f "$SNAPSHOT"' EXIT
if [ "$SOURCE" = "-" ]; then
  cat >"$SNAPSHOT"
else
  [ -f "$SOURCE" ] || fail "no such file: $SOURCE"
  cat "$SOURCE" >"$SNAPSHOT"
fi

# CRLF is the expected shape here, not an edge case: the snapshot is routinely captured by
# PowerShell's Set-Content. A trailing CR would end up inside a secret's value.
sed -i 's/\r$//' "$SNAPSHOT"

PROD_NAMES="$(grep -oE '^[A-Z0-9_]+=' "$SNAPSHOT" | tr -d '=' | sort -u)"
[ -n "$PROD_NAMES" ] || fail "the snapshot holds no VARIABLE= lines - wrong file, or a failed capture"
log "snapshot: $(printf '%s\n' "$PROD_NAMES" | wc -l | tr -d ' ') variables"

# ── The five lists ───────────────────────────────────────────────────────────
# Kept exactly as production has them: no local equivalent, or the key that reads the data.
KEEP="APNS_VOIP_KEY_ID APNS_VOIP_KEY_P8 APNS_VOIP_SANDBOX APNS_VOIP_TEAM_ID APNS_VOIP_TOPIC
AUTHENTIK_BASE_URL CALL_E2E_ENCRYPTION CERCLE_API_KEY CHANNELS_ENCRYPTION_SECRET
CLOUDFLARE_CALLS_API_TOKEN CLOUDFLARE_TURN_KEY_ID CLOUDFLARE_TURN_TTL_SECONDS EXTERNAL_API_KEY
FIREBASE_SERVICE_ACCOUNT_JSON GOOGLE_SAFE_BROWSING_API_KEY LYDIA_ENV LYDIA_PROVIDER_PRIVATE_TOKEN
LYDIA_PROVIDER_TOKEN MEDIA_MAX_SIZE_MB MIGALLERY_API_KEY MIGALLERY_API_URL SERVICE_ACCOUNT_USER_ID
SKY_API_KEY SKY_API_URL STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET TURN_CREDENTIAL TURN_URL
TURN_USERNAME"

# Regenerated per local stack: these mint or verify credentials.
REGENERATE="CALL_ROOM_SECRET INTERNAL_SECRET INTERNAL_SHARED_SECRET JWT_SECRET"

# Decided by the local topology. The values are written below, not taken from the snapshot.
LOCAL="ALLOW_ORIGIN DELIVERY_PORT DOMAIN ENABLE_DEV_ROUTES FRONTEND_HOST_PORT FRONTEND_URL
GARAGE_ACCESS_KEY_ID GARAGE_ADMIN_HOST_PORT GARAGE_ADMIN_TOKEN GARAGE_API_HOST_PORT GARAGE_BUCKET
GARAGE_ENDPOINT GARAGE_PORT GARAGE_REGION GARAGE_RPC_SECRET GARAGE_SECRET_ACCESS_KEY GARAGE_USE_SSL
GATEWAY_PORT IMAGE_PREFIX NODE_ENV POSTGRES_DB POSTGRES_PASSWORD POSTGRES_USER REGISTRY RUST_LOG
TAG"

# Its own local identity on the production Authentik - never production's client.
OIDC="AUTHENTIK_CLIENT_ID AUTHENTIK_CLIENT_SECRET"

in_list() {
  printf '%s\n' "$2" | tr ' ' '\n' | grep -qxF "$1"
}

# ── Every production variable must be in exactly one list ────────────────────
UNKNOWN=""
for name in $PROD_NAMES; do
  hits=0
  for list in "$KEEP" "$REGENERATE" "$LOCAL" "$OIDC"; do
    in_list "$name" "$list" && hits=$((hits + 1))
  done
  case "$hits" in
    0) UNKNOWN="$UNKNOWN $name" ;;
    1) ;;
    *) fail "$name appears in $hits lists - the classification contradicts itself" ;;
  esac
done

if [ -n "$UNKNOWN" ]; then
  printf '[env-from-prod] ERROR production carries %s variable(s) this script does not classify:\n' \
    "$(printf '%s' "$UNKNOWN" | wc -w | tr -d ' ')" >&2
  for name in $UNKNOWN; do printf '  %s\n' "$name" >&2; done
  fail "add each to KEEP, REGENERATE, LOCAL or OIDC above - which one is a decision, not a default"
fi
log "classification: every production variable is accounted for"

# ── Read one value out of the snapshot, whole ────────────────────────────────
# `cut -d= -f2` would truncate FIREBASE_SERVICE_ACCOUNT_JSON at its first `=`. This keeps
# everything after the FIRST separator, which is what a value is.
value_of() {
  sed -n "s/^$1=//p" "$SNAPSHOT" | head -1
}

# ── infrastructure/.env ──────────────────────────────────────────────────────
[ -f "$INFRA_ENV" ] && {
  cp "$INFRA_ENV" "$INFRA_ENV.bak"
  log "existing infrastructure/.env kept as .env.bak"
}

{
  cat <<'HEADER'
# LOCAL DEVELOPMENT - GENERATED by infrastructure/local/env-from-prod.sh. Do not commit (gitignored).
#
# This file carries PRODUCTION credentials for every third party: Stripe, Lydia, FCM, APNs,
# Cloudflare, MiGallery, Safe Browsing and the inter-app API keys. Decided by the user on
# 2026-09-02, so that local behaviour is production's behaviour. Two things follow, and they are
# consequences rather than warnings:
#
#   * A LOCAL ACTION CAN REACH A REAL THIRD PARTY. The Stripe key is production's, so a payment
#     started here is a real payment. `dump-prod-to-local.sh` removes every Stripe and Lydia
#     identifier from the copied database, so nothing real is ADDRESSABLE by accident - but the key
#     itself is live. To exercise payments locally, put an `sk_test_` key here; that is the tool for
#     it, not the live key.
#   * PUSH IS PRODUCTION'S SENDER. Same reasoning: the dump truncates `push_token`, so there is no
#     real device to send to. Do not restore that table from anywhere.
#
# The authentication secrets below are LOCAL and freshly generated - a token minted here is not
# valid in production, deliberately. `CHANNELS_ENCRYPTION_SECRET` is production's, because it is the
# key the dumped salon content is encrypted with.
HEADER
  printf '\n# ── Kept as production has them ───────────────────────────────────────────────\n'
  for name in $(printf '%s\n' "$KEEP" | tr ' ' '\n' | grep -v '^$' | sort); do
    if printf '%s\n' "$PROD_NAMES" | grep -qxF "$name"; then
      printf '%s=%s\n' "$name" "$(value_of "$name")"
    fi
  done

  printf '\n# ── Regenerated for this machine (auth, not data) ─────────────────────────────\n'
  for name in $(printf '%s\n' "$REGENERATE" | tr ' ' '\n' | grep -v '^$' | sort); do
    printf '%s=%s\n' "$name" "$(openssl rand -hex 32)"
  done

  printf '\n# ── The local OIDC client on the production Authentik ─────────────────────────\n'
  printf '# Created as `canari-local`, redirect URIs on http://localhost:1420. Production'"'"'s client\n'
  printf '# is deliberately NOT reused: a page served from localhost must not be able to obtain\n'
  printf '# production tokens under production'"'"'s own client id.\n'
  printf 'AUTHENTIK_CLIENT_ID=%s\n' "${CANARI_LOCAL_OIDC_CLIENT_ID:-}"
  printf 'AUTHENTIK_CLIENT_SECRET=%s\n' "${CANARI_LOCAL_OIDC_CLIENT_SECRET:-}"

  cat <<'TOPOLOGY'

# ── Local topology ───────────────────────────────────────────────────────────
# Most of this is also hardcoded in infrastructure/local/docker-compose.yml, which is what the
# containers actually read; it is written here so that a script or a psql invocation reading this
# file describes the same stack. POSTGRES_* MUST match the compose - the cluster was initialised
# with those.
DOMAIN=localhost
ALLOW_ORIGIN=*
FRONTEND_URL=http://localhost:1420
NODE_ENV=development
ENABLE_DEV_ROUTES=true
RUST_LOG=chat_gateway=debug,tower_http=debug

# Not present in production, and REQUIRED the moment NODE_ENV is not `production`: it decides
# whether the refresh cookie carries `Secure`. `true` is correct here and only here - the local
# stack is plain HTTP. core-service REFUSES to start with true under NODE_ENV=production.
ALLOW_INSECURE_COOKIES=true

# Images are built locally, never pulled.
REGISTRY=ghcr.io
IMAGE_PREFIX=emse-students/canari
TAG=local

POSTGRES_USER=admin
POSTGRES_PASSWORD=password
POSTGRES_DB=auth_db

FRONTEND_HOST_PORT=8080
GATEWAY_PORT=3000
DELIVERY_PORT=3001

GARAGE_RPC_SECRET=0000000000000000000000000000000000000000000000000000000000000000
GARAGE_ADMIN_TOKEN=dev-garage-admin-token
GARAGE_ACCESS_KEY_ID=canarilocal
GARAGE_SECRET_ACCESS_KEY=canari-local-garage-secret-key
GARAGE_API_HOST_PORT=19010
GARAGE_ADMIN_HOST_PORT=19011
GARAGE_ENDPOINT=garage
GARAGE_PORT=3900
GARAGE_USE_SSL=false
GARAGE_REGION=garage
GARAGE_BUCKET=canari-media
TOPOLOGY
} >"$INFRA_ENV"

log "wrote infrastructure/.env"

# ── frontend/.env ────────────────────────────────────────────────────────────
# Deliberately SHORT. `frontend/vite.config.js` proxies every backend route to its local service
# (`/api/auth` -> 3012, `/api/mls/` -> 3010, `/api/posts` -> 3014, `/api/ws` -> 3000, ...), so the
# service URLs are not needed at all in local dev - and the frontend ends up SAME-ORIGIN with the
# API, which is the shape production has through nginx.
[ -f "$FRONTEND_ENV" ] && {
  cp "$FRONTEND_ENV" "$FRONTEND_ENV.bak"
  log "existing frontend/.env kept as .env.bak"
}

cat >"$FRONTEND_ENV" <<FRONTEND
# LOCAL DEVELOPMENT - GENERATED by infrastructure/local/env-from-prod.sh. Do not commit (gitignored).
#
# Short on purpose: vite.config.js proxies every /api/* route to the local service, so the six
# VITE_*_URL variables are unnecessary here and their absence is what keeps the dev server
# same-origin with the API.
VITE_FRONTEND_URL=http://localhost:1420
VITE_AUTHENTIK_URL=$(value_of AUTHENTIK_BASE_URL)
VITE_AUTHENTIK_CLIENT_ID=${CANARI_LOCAL_OIDC_CLIENT_ID:-}
VITE_ENABLE_DEV_ROUTES=true
VITE_MEDIA_MAX_SIZE_MB=$(value_of MEDIA_MAX_SIZE_MB)

# Klipy (GIF picker) has no value in infrastructure/.env: it is a BUILD-TIME frontend variable that
# CI injects from the GitHub secret KLIPY_API_KEY, and a GitHub secret cannot be read back. Empty
# means the GIF picker is off locally; paste a key here to exercise it.
VITE_KLIPY_KEY=

# Mobile only, and both are build-time identities rather than secrets: the Android App Links
# certificate fingerprint and the Apple team id. CI injects them; they are empty here because an
# App Link cannot point at localhost anyway (see the campaign pages - the phone reaches the local
# stack over adb reverse, and the App Link path is verified against a deployed estate).
VITE_ANDROID_APP_LINK_SHA256=
VITE_APPLE_TEAM_ID=
FRONTEND

log "wrote frontend/.env"

if [ -z "${CANARI_LOCAL_OIDC_CLIENT_ID:-}" ]; then
  log "OWED: the canari-local OIDC client does not exist yet, so AUTHENTIK_CLIENT_ID/SECRET and"
  log "      VITE_AUTHENTIK_CLIENT_ID are EMPTY - login will fail until they are filled. Re-run with"
  log "      CANARI_LOCAL_OIDC_CLIENT_ID and CANARI_LOCAL_OIDC_CLIENT_SECRET set."
fi
log "done - no value was printed by this script"
