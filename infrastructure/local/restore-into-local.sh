#!/usr/bin/env bash
#
# Restores a production dump into the LOCAL stack, strips the things a copy must never carry, and
# verifies the result rather than asserting it.
#
# WHY LOCAL AT ALL. Decided with the user on 2026-09-02: development and the whole cross-client test
# campaign move off canari-emse.fr and dev.canari-emse.fr onto a local stack, and a local stack
# nobody can log into or interact with is useless. The user chose a FULL copy, PII included, over an
# anonymised one - the same choice already made for the dev estate on 2026-09-01, and for the same
# reason.
#
# WHAT A COPY DOES NOT BUY. The server holds only ciphertext: MLS keys live on the device and the
# media CEK is client-generated, so copied conversations are UNREADABLE on a fresh local client. The
# copy buys realistic users, communities, posts, forms, calendar and shop, and nothing at all for
# chat. It also does NOT test a Postgres major upgrade - `pg_dump` reads ROWS, and the restore below
# writes a new cluster initialised by whichever major is running locally. Only a binary copy of
# PGDATA tests that; see docs/wiki/backlog.md on PostgreSQL 15 -> 18.
#
# THE DIRECTION CANNOT INVERT, AND IT IS ENFORCED RATHER THAN DOCUMENTED. Every destructive
# statement goes through local_sql(), which re-reads the target container's
# `com.docker.compose.project` label and refuses unless it is exactly the local project. That name
# is a hardcoded constant, so no argument a caller can pass points this anywhere else - an ALLOWLIST
# of what may be written to, which is what a destructive control needs. This script is also
# structurally safer than its dev sibling: it never touches production at all, because the dump
# arrives as a FILE. Fetching it is `pull-prod-dump.sh`'s job, and that script only reads.
#
# Containers are found by compose LABEL and the database user is read from the container's own
# environment, so this needs no compose file, no .env and no path to be correct. What it operates on
# is what Docker says is running.
#
# Usage:
#   infrastructure/local/restore-into-local.sh <dump.sql.gz> [--dry-run]
#
# A `<dump>.meta` sidecar written by `pull-prod-dump.sh` carries the row counts measured ON
# PRODUCTION, which is what turns step 5 into a verification instead of a hope.
set -euo pipefail

# ── The target. A constant, deliberately: see the header. ────────────────────
readonly LOCAL_PROJECT="canari-local"
readonly DATABASE="auth_db"

log() { printf '[restore-into-local] %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() {
  printf '[restore-into-local] ERROR %s\n' "$*" >&2
  exit 1
}

DUMP=""
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -*) fail "unknown option: $arg" ;;
    *) DUMP="$arg" ;;
  esac
done
[ -n "$DUMP" ] || fail "usage: $0 <dump.sql.gz> [--dry-run]"
[ -f "$DUMP" ] || fail "no such dump: $DUMP"

command -v docker >/dev/null || fail "docker is required"
docker version >/dev/null 2>&1 || fail "the Docker daemon is not answering - start Docker Desktop"

# ── Locate a service's container by compose label ────────────────────────────
# The label is written by compose itself and is the only identifier here that cannot be a typo in a
# path. `--filter status=running` matters: a stale exited container of the same name would otherwise
# be selected and every later check would describe a container that is not serving anything.
container_for() {
  local project="$1" service="$2" found
  found=$(docker ps --filter "label=com.docker.compose.project=${project}" \
    --filter "label=com.docker.compose.service=${service}" \
    --filter "status=running" --format '{{.Names}}' | head -1)
  [ -n "$found" ] || return 1
  printf '%s' "$found"
}

project_of() {
  docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$1" 2>/dev/null
}

# Read a variable out of the container's own environment rather than from a file on disk, so the
# credential used is the one the cluster was actually started with.
container_env() {
  docker inspect -f "{{range .Config.Env}}{{println .}}{{end}}" "$1" |
    sed -n "s/^$2=//p" | head -1
}

LOCAL_PG=$(container_for "$LOCAL_PROJECT" postgres) || fail \
  "no running postgres in the '$LOCAL_PROJECT' compose project - start it with 'make run-services'"
LOCAL_USER=$(container_env "$LOCAL_PG" POSTGRES_USER)
[ -n "$LOCAL_USER" ] || fail "$LOCAL_PG declares no POSTGRES_USER"
log "target: $LOCAL_PG (project $LOCAL_PROJECT, user $LOCAL_USER)"

# ── The guard every write passes through ─────────────────────────────────────
# Re-verified per call rather than once at startup: a check that ran minutes ago describes the
# container that was there minutes ago.
local_sql() {
  local actual
  actual=$(project_of "$LOCAL_PG")
  [ "$actual" = "$LOCAL_PROJECT" ] || fail \
    "refusing to write: $LOCAL_PG belongs to project '$actual', not '$LOCAL_PROJECT'"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[restore-into-local] [dry-run] would run: %s\n' "${1%%$'\n'*}"
    return 0
  fi
  docker exec -i "$LOCAL_PG" psql -v ON_ERROR_STOP=1 -U "$LOCAL_USER" -d "$2" -c "$1"
}

local_sql_ro() {
  docker exec -i "$LOCAL_PG" psql -tAX -U "$LOCAL_USER" -d "$DATABASE" -c "$1"
}

# ── 1. What production said, at dump time ────────────────────────────────────
META="$DUMP.meta"
PROD_USERS=""
if [ -f "$META" ]; then
  PROD_USERS=$(sed -n 's/^users=//p' "$META" | head -1)
  log "dump metadata: production reported $PROD_USERS users when it was taken"
else
  log "NO .meta sidecar beside the dump, so the row count cannot be compared against production."
  log "  The restore still verifies its own strips; only the completeness check is unavailable."
fi

# ── 2. Quiesce the local application services ────────────────────────────────
# Not the datastores: postgres is the target and must stay up. Anything that writes has to stop, or
# the restore races a service that is still serving the old data.
LOCAL_APPS=$(docker ps --filter "label=com.docker.compose.project=${LOCAL_PROJECT}" \
  --filter "status=running" --format '{{.Names}}\t{{.Label "com.docker.compose.service"}}' |
  awk -F'\t' '$2 != "postgres" && $2 != "redis" && $2 != "garage" && $2 != "coturn" { print $1 }')

if [ -n "$LOCAL_APPS" ]; then
  log "stopping local services: $(echo "$LOCAL_APPS" | tr '\n' ' ')"
  [ "$DRY_RUN" -eq 1 ] || xargs -r docker stop >/dev/null <<<"$LOCAL_APPS"
else
  log "no local application services running"
fi

restart_local_apps() {
  if [ -n "$LOCAL_APPS" ]; then
    log "restarting local services"
    [ "$DRY_RUN" -eq 1 ] || xargs -r docker start >/dev/null <<<"$LOCAL_APPS" || true
  fi
}
trap 'restart_local_apps' EXIT

# ── 3. Replace the local database ────────────────────────────────────────────
log "recreating $DATABASE on the target…"
# Terminating first: DROP DATABASE fails while a single connection remains, and a stopped service
# can still have a socket in the cluster's view for a moment.
local_sql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DATABASE' AND pid <> pg_backend_pid();" postgres
local_sql "DROP DATABASE IF EXISTS $DATABASE;" postgres
local_sql "CREATE DATABASE $DATABASE OWNER \"$LOCAL_USER\";" postgres

if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] skipping the restore and the strips"
  exit 0
fi

log "restoring $(du -h "$DUMP" | cut -f1)…"
gunzip -c "$DUMP" | docker exec -i "$LOCAL_PG" psql -q -U "$LOCAL_USER" -d "$DATABASE" >/dev/null
log "restore complete"

# ── 4. The strips ────────────────────────────────────────────────────────────
# The list lives in ONE place because there are two copies of production now, and its failure mode
# is an absence: `.github/scripts/tests/dev-copy-guards.test.sh` derives it from the entity
# declarations. `local_sql` is passed BY NAME so the allowlist of writable targets stays here.
log "stripping what a copy must not carry…"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/copy-strips.sh
. "$SCRIPT_DIR/../lib/copy-strips.sh"
apply_copy_strips local_sql "$DATABASE" "[restore-into-local]"

# ── 5. Verify, do not assert ─────────────────────────────────────────────────
LOCAL_ROWS=$(local_sql_ro "SELECT count(*) FROM users;")
LOCAL_TOKENS=$(local_sql_ro "SELECT count(*) FROM push_token;")
LOCAL_STRIPE=$(local_sql_ro "SELECT count(*) FROM users WHERE \"stripeCustomerId\" IS NOT NULL;")

log "verification: users local=$LOCAL_ROWS (prod at dump time=${PROD_USERS:-unknown}) | push_token=$LOCAL_TOKENS | stripe ids=$LOCAL_STRIPE"

problems=0
if [ -n "$PROD_USERS" ]; then
  [ "$PROD_USERS" = "$LOCAL_ROWS" ] || {
    printf '[restore-into-local] ERROR user count differs: prod=%s local=%s\n' "$PROD_USERS" "$LOCAL_ROWS" >&2
    problems=1
  }
fi
[ "$LOCAL_TOKENS" = "0" ] || {
  printf '[restore-into-local] ERROR %s push tokens survived the truncate - they belong to production'"'"'s FCM sender\n' "$LOCAL_TOKENS" >&2
  problems=1
}
[ "$LOCAL_STRIPE" = "0" ] || {
  printf '[restore-into-local] ERROR %s Stripe customer ids survived, and the local Stripe key is production'"'"'s\n' "$LOCAL_STRIPE" >&2
  problems=1
}
[ "$problems" -eq 0 ] || fail "the restore completed but did not verify - the local database is NOT trustworthy"

log "restore verified"
