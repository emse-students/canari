#!/usr/bin/env bash
#
# Renders infrastructure/.env for ONE deployed environment, from env-manifest.tsv beside this file.
#
# WHY IT EXISTS. The 34 keys it writes used to be ~40 hand-written if/upsert/warn blocks inside
# `cd.yml`'s deploy job. See the manifest's header for the two failure modes that shape caused. What
# matters here is the consequence for a second environment: the logic is now written once and takes
# the environment as an argument, so dev and production cannot drift apart by being maintained
# separately.
#
# THE ONE RULE THAT MAKES ISOLATION REAL, AND IT IS AN INDIRECTION, NOT A DOCUMENT. A manifest row
# says `secret:AUTHENTIK_URL`. In production this script reads the environment variable
# `AUTHENTIK_URL`. In dev it reads `DEV_AUTHENTIK_URL` and NEVER the bare name. So a dev secret that
# nobody created is EMPTY - not production's value - and a `required` row then fails the deploy
# before a container is touched. That is the whole reason `cd-dev.yml` was dangerous: it read the
# bare names, so every secret production had, dev silently inherited, `JWT_SECRET` included - and a
# shared signing secret makes a token minted by either environment valid in the other.
#
# Usage:
#   render-env.sh --environment prod|dev --domain canari-emse.fr [--build dev.abc1234] [--out FILE]
#
# It writes nothing until every `required` row has a value, so a failed run leaves the previous
# .env in place rather than a half-written one.

set -euo pipefail

MANIFEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env-manifest.tsv"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

ENVIRONMENT=""
DOMAIN=""
BUILD=""
OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
  --environment)
    ENVIRONMENT="${2:-}"
    shift 2
    ;;
  --domain)
    DOMAIN="${2:-}"
    shift 2
    ;;
  --build)
    BUILD="${2:-}"
    shift 2
    ;;
  --out)
    OUT="${2:-}"
    shift 2
    ;;
  *)
    printf 'render-env: unknown argument %s\n' "$1" >&2
    exit 2
    ;;
  esac
done

case "$ENVIRONMENT" in
prod | dev) ;;
*)
  printf 'render-env: --environment must be prod or dev (got "%s")\n' "$ENVIRONMENT" >&2
  exit 2
  ;;
esac

[ -n "$DOMAIN" ] || {
  printf 'render-env: --domain is required\n' >&2
  exit 2
}
[ -f "$MANIFEST" ] || {
  printf 'render-env: manifest not found at %s\n' "$MANIFEST" >&2
  exit 2
}

TEMPLATE="$REPO_ROOT/infrastructure/.env.example"
[ -f "$TEMPLATE" ] || {
  printf 'render-env: %s is missing - cannot generate .env\n' "$TEMPLATE" >&2
  exit 1
}
: "${OUT:=$REPO_ROOT/infrastructure/.env}"

# ── Where a value comes from ──────────────────────────────────────────────────
# The indirection described in the header. `dev` prefixes; `prod` does not. Nothing else in this
# script knows about environments, which is what keeps the two paths identical in every other way.
secret_value() {
  local name="$1" varname
  if [ "$ENVIRONMENT" = "dev" ]; then
    varname="DEV_${name}"
  else
    varname="$name"
  fi
  printf '%s' "${!varname-}"
}

# ── The computed values ───────────────────────────────────────────────────────
# ALLOW_ORIGIN is the chat-gateway's CORS list. Every entry is a Canari client, and dropping one
# costs that client the gateway with no server-side error to show for it. The three tauri spellings
# are the app itself, one per platform - `http(s)://tauri.localhost` on Android/Windows,
# `tauri://localhost` on iOS/macOS/Linux; omitting the iOS spelling from the Nest list once cost
# that platform its login. `127.0.0.1:1420` is how tauri.conf.json's devUrl spells the dev server.
#
# THE DEPLOY'S COLOUR DOES NOT PROVE THIS VALUE: an origin that is merely WRONG parses fine and
# simply matches nothing. Read the served header back after deploying.
#
# The two environments differ in ONE way and it matters: production's list carries
# `https://dev.<domain>` because that name is a proxied CNAME onto production's own tunnel today,
# so a list built from FRONTEND_URL alone would refuse a hostname production itself serves. Dev's
# list does NOT carry production's origin - dev has no business accepting it.
compute_allow_origin() {
  local frontend_url="$1" tauri
  tauri="http://localhost:1420,http://127.0.0.1:1420,http://tauri.localhost,https://tauri.localhost,tauri://localhost"
  if [ "$ENVIRONMENT" = "dev" ]; then
    printf '%s,%s' "$frontend_url" "$tauri"
  else
    printf '%s,https://dev.%s,%s' "$frontend_url" "$DOMAIN" "$tauri"
  fi
}

# ── Transforms ───────────────────────────────────────────────────────────────
# .env is line-based, so a value carrying a newline would truncate the file at that point and every
# key after it would be lost. Both transforms below exist for exactly that reason.
transform_value() {
  local key="$1" value="$2"
  case "$key" in
  FIREBASE_SERVICE_ACCOUNT_JSON)
    # A service-account JSON is pretty-printed by the console that emits it.
    printf '%s' "$value" | tr -d '\r\n'
    ;;
  APNS_VOIP_KEY_P8)
    # A raw PEM is multi-line; ApnsVoipService accepts base64 or PEM, so encode when it is PEM.
    case "$value" in
    *"BEGIN PRIVATE KEY"*) printf '%s' "$value" | base64 -w0 ;;
    *) printf '%s' "$value" ;;
    esac
    ;;
  *)
    printf '%s' "$value"
    ;;
  esac
}

# ── The published host ports ──────────────────────────────────────────────────
# THREE PORTS THAT MUST DIFFER BETWEEN THE TWO ESTATES, because both run on ONE machine and a port
# is machine-wide. They were previously written by `cd.yml` in the shape
# `grep -q '^KEY=' .env || echo KEY=<dev value>`, which never fired once: `render-env.sh` builds
# .env from `infrastructure/.env.example`, and the template DECLARES all three - 8080, 19010, 19011,
# production's own numbers. The key was never missing, so the dev override was never applied, and
# dev's rendered .env asked for production's frontend port. The estate would have refused to start
# on "port is already allocated" - or, on a restart race, taken production's traffic.
#
# The lesson is the shape, not the numbers: an "add it if absent" default is only a default when the
# key can actually be absent. Computed here instead, so ONE place decides and `render-env.sh` upserts
# it over whatever the template said.
compute_frontend_host_port() {
  if [ "$ENVIRONMENT" = "dev" ]; then printf '3080'; else printf '8080'; fi
}

# Garage's S3 API and admin ports. Published on 127.0.0.1 only, on both estates, and offset for dev.
compute_garage_api_host_port() {
  if [ "$ENVIRONMENT" = "dev" ]; then printf '19100'; else printf '19010'; fi
}
compute_garage_admin_host_port() {
  if [ "$ENVIRONMENT" = "dev" ]; then printf '19101'; else printf '19011'; fi
}

# ── Pass 1: resolve everything, and fail before writing anything ─────────────
# Two passes deliberately. A required secret discovered missing halfway through would otherwise
# leave .env regenerated from the template with some keys upserted and the rest at their template
# defaults - which starts, and is wrong. Nothing is written until every row has been resolved.
declare -a WRITE_KEYS=()
declare -a WRITE_VALUES=()
declare -a WARNINGS=()
MISSING=0
FRONTEND_URL_VALUE=""

# FRONTEND_URL is resolved first because ALLOW_ORIGIN is built from it.
FRONTEND_URL_VALUE="$(secret_value BASE_URL)"

while IFS=$'\t' read -r key prod dev source note; do
  case "$key" in "" | \#*) continue ;; esac

  disposition="$prod"
  [ "$ENVIRONMENT" = "dev" ] && disposition="$dev"

  # `skip` is the only disposition that may be silent about a key the other environment requires:
  # the absence is the decision, so a warning would be noise. See the manifest header.
  [ "$disposition" = "skip" ] && continue

  value=""
  case "$source" in
  literal:*) value="${source#literal:}" ;;
  computed)
    case "$key" in
    ALLOW_ORIGIN) value="$(compute_allow_origin "$FRONTEND_URL_VALUE")" ;;
    DEPLOY_BUILD) value="$BUILD" ;;
    FRONTEND_HOST_PORT) value="$(compute_frontend_host_port)" ;;
    GARAGE_API_HOST_PORT) value="$(compute_garage_api_host_port)" ;;
    GARAGE_ADMIN_HOST_PORT) value="$(compute_garage_admin_host_port)" ;;
    *)
      printf 'render-env: %s is marked computed and nothing computes it\n' "$key" >&2
      exit 2
      ;;
    esac
    ;;
  secret:*) value="$(transform_value "$key" "$(secret_value "${source#secret:}")")" ;;
  *)
    printf 'render-env: %s has an unknown SOURCE "%s"\n' "$key" "$source" >&2
    exit 2
    ;;
  esac

  if [ -z "$value" ]; then
    case "$disposition" in
    required)
      printf '::error::%s is not set for the %s environment - %s\n' "$key" "$ENVIRONMENT" "$note" >&2
      MISSING=1
      ;;
    warn) WARNINGS+=("::warning::$key is not set - $note") ;;
    silent | literal | computed) ;;
    *)
      printf 'render-env: %s has an unknown disposition "%s"\n' "$key" "$disposition" >&2
      exit 2
      ;;
    esac
    continue
  fi

  WRITE_KEYS+=("$key")
  WRITE_VALUES+=("$value")
done <"$MANIFEST"

if [ "$MISSING" -ne 0 ]; then
  printf '::error::refusing to write %s - the environment is incomplete and a partial .env starts, and is wrong\n' \
    "$OUT" >&2
  exit 1
fi

# ── Pass 2: write ────────────────────────────────────────────────────────────
# Regenerated from the template on every deploy so .env stays ordered like .env.example, drops keys
# that are no longer in it, and never accumulates leftovers. Every real secret is re-injected below,
# so nothing is lost; non-secret defaults come straight from the template.
TMP="$(mktemp "${TMPDIR:-/tmp}/render-env.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
cp "$TEMPLATE" "$TMP"

i=0
while [ "$i" -lt "${#WRITE_KEYS[@]}" ]; do
  key="${WRITE_KEYS[$i]}"
  # Drop any existing line for this key, then append. Not sed: a URL value contains '/' and a JSON
  # value contains almost everything, so no delimiter is safe.
  grep -v "^${key}=" "$TMP" >"$TMP.next" || true
  mv "$TMP.next" "$TMP"
  printf '%s=%s\n' "$key" "${WRITE_VALUES[$i]}" >>"$TMP"
  i=$((i + 1))
done

mv "$TMP" "$OUT"
trap - EXIT

for w in ${WARNINGS+"${WARNINGS[@]}"}; do printf '%s\n' "$w"; done
printf 'rendered %s for the %s environment: %s keys written\n' "$OUT" "$ENVIRONMENT" "${#WRITE_KEYS[@]}"
