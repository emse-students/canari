#!/usr/bin/env bash
#
# Copies production's database into the dev.canari-emse.fr environment, strips the two things a copy
# must never carry, and leaves alone the one thing it cannot express.
#
# WHY A FULL COPY. Decided with the user on 2026-09-01, against the recommendation, for usability:
# an empty dev environment is one nobody can log into or interact with meaningfully. Two facts were
# put to the user first and did not change it - the server holds only ciphertext, so copied
# conversations are UNREADABLE on a fresh dev client (the MLS keys live on the device and the media
# CEK is client-generated), and login ease comes from the Authentik directory rather than from this
# database. So the copy buys realistic users, communities, posts, forms, calendar and shop, and
# nothing at all for chat.
#
# WHAT IT DOES NOT BUY, AND AN EARLIER VERSION OF THIS HEADER CLAIMED IT DID. The claim was that this
# leaves "a dev Postgres holding a data directory really written by production's 15", making it the
# honest test of the major upgrade that took production down on 2026-09-01. It is not. `pg_dump` reads
# ROWS; the restore below writes a NEW cluster, initialised by whichever major dev is running. The one
# thing a major upgrade has to survive - production's own PGDATA on disk - is exactly what a logical
# copy never produces, which is why `infrastructure/dev/version-gap.yml` accepts `logical_restore` as
# a KIND of evidence and lifts no ceiling for it. Only `in_place_upgrade`, on a binary copy of PGDATA,
# retires a refusal. See docs/wiki/infrastructure/dev-environment.md and docs/wiki/backlog.md.
#
# THE DIRECTION CANNOT INVERT, AND THAT IS ENFORCED, NOT DOCUMENTED. Every destructive statement
# goes through dev_sql(), which re-reads the target container's `com.docker.compose.project` label
# and refuses unless it is exactly the dev project. The two projects are hardcoded constants here,
# not parameters, so there is no argument a caller can pass to point this at production. That is an
# ALLOWLIST of what may be written to, which is what a destructive control needs - a denylist of
# what it must avoid fails by omission.
#
# Containers are found by compose LABEL and the database user is read from the container's own
# environment, so this script needs no compose file, no .env and no path to be correct. What it
# operates on is what Docker says is running.
#
# Usage, on the box:
#   infrastructure/dev/copy-prod-to-dev.sh [--dry-run]

set -euo pipefail

# ── The two projects. Constants, deliberately: see the header. ────────────────
readonly PROD_PROJECT="infrastructure"
readonly DEV_PROJECT="canari-dev"
readonly DATABASE="auth_db"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log() { printf '[copy-prod-to-dev] %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() {
  printf '[copy-prod-to-dev] ERROR %s\n' "$*" >&2
  exit 1
}

if [ "$PROD_PROJECT" = "$DEV_PROJECT" ]; then
  fail "the source and target projects are the same name - refusing before touching anything"
fi

# ── Locate a service's container by compose label ────────────────────────────
# The label is written by compose itself and is the only identifier here that cannot be a typo in a
# path. `--filter status=running` matters: a stale exited container of the same name would otherwise
# be selected and every later check would describe a container that is not serving anything.
container_for() {
  local project="$1" service="$2" found
  found=$(docker ps --filter "label=com.docker.compose.project=${project}" \
    --filter "label=com.docker.compose.service=${service}" \
    --filter "status=running" --format '{{.Names}}')
  if [ -z "$found" ]; then
    fail "no running '${service}' container in project '${project}'"
  fi
  if [ "$(printf '%s\n' "$found" | wc -l)" -ne 1 ]; then
    fail "several running '${service}' containers in project '${project}': $(echo "$found" | tr '\n' ' ')"
  fi
  printf '%s' "$found"
}

project_of() {
  docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$1" 2>/dev/null
}

# Read a variable out of the container's own environment rather than from a file on disk, so the
# credential used is the one the cluster was actually started with.
container_env() {
  docker inspect -f "{{range .Config.Env}}{{println .}}{{end}}" "$1" |
    awk -v k="$2" -F= '$1 == k { sub(/^[^=]*=/, ""); print; exit }'
}

PROD_PG=$(container_for "$PROD_PROJECT" postgres)
DEV_PG=$(container_for "$DEV_PROJECT" postgres)

if [ "$PROD_PG" = "$DEV_PG" ]; then
  fail "source and target resolved to the SAME container ($PROD_PG) - refusing"
fi

PROD_USER=$(container_env "$PROD_PG" POSTGRES_USER)
DEV_USER=$(container_env "$DEV_PG" POSTGRES_USER)
[ -n "$PROD_USER" ] || fail "could not read POSTGRES_USER from $PROD_PG"
[ -n "$DEV_USER" ] || fail "could not read POSTGRES_USER from $DEV_PG"

log "source: $PROD_PG (project $PROD_PROJECT, user $PROD_USER) - READ ONLY"
log "target: $DEV_PG (project $DEV_PROJECT, user $DEV_USER) - WILL BE REPLACED"

# ── The guard every write passes through ─────────────────────────────────────
# Re-verified per call rather than once at startup: a check that ran minutes ago describes the
# container that was there minutes ago.
dev_sql() {
  local actual
  actual=$(project_of "$DEV_PG")
  if [ "$actual" != "$DEV_PROJECT" ]; then
    fail "target $DEV_PG reports project '${actual}', not '${DEV_PROJECT}' - refusing to write"
  fi
  if [ "$DEV_PG" = "$PROD_PG" ]; then
    fail "target and source are the same container - refusing to write"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] would run against %s: %s\n' "$DEV_PG" "$1"
    return 0
  fi
  docker exec -i "$DEV_PG" psql -v ON_ERROR_STOP=1 -U "$DEV_USER" -d "$2" -c "$1"
}

# Read-only, against production. Separate function so that no production call can accidentally
# acquire the write path above.
prod_sql_ro() {
  docker exec -i "$PROD_PG" psql -tAX -U "$PROD_USER" -d "$DATABASE" -c "$1"
}

dev_sql_ro() {
  docker exec -i "$DEV_PG" psql -tAX -U "$DEV_USER" -d "$DATABASE" -c "$1"
}

# ── 1. Dump production ───────────────────────────────────────────────────────
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/canari-copy.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
DUMP="$STAGE/auth_db.sql.gz"

PROD_ROWS=$(prod_sql_ro "SELECT count(*) FROM users;")
log "production reports $PROD_ROWS users; dumping $DATABASE…"

if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] skipping the dump"
else
  # --clean --if-exists so the restore replaces objects rather than colliding with them. The same
  # flags backup.sh uses, deliberately: one dump format for both paths.
  docker exec -i "$PROD_PG" sh -c "pg_dump -U '$PROD_USER' -d '$DATABASE' --clean --if-exists" |
    gzip >"$DUMP"
  log "dump written ($(du -h "$DUMP" | cut -f1))"
fi

# ── 2. Quiesce the dev application services ──────────────────────────────────
# Not the datastores: postgres is the target and must stay up. Anything that writes has to stop, or
# the restore races a service that is still serving the old data.
DEV_APPS=$(docker ps --filter "label=com.docker.compose.project=${DEV_PROJECT}" \
  --filter "status=running" --format '{{.Names}}\t{{.Label "com.docker.compose.service"}}' |
  awk -F'\t' '$2 != "postgres" && $2 != "redis" && $2 != "garage" { print $1 }')

if [ -n "$DEV_APPS" ]; then
  log "stopping dev services: $(echo "$DEV_APPS" | tr '\n' ' ')"
  [ "$DRY_RUN" -eq 1 ] || xargs -r docker stop >/dev/null <<<"$DEV_APPS"
else
  log "no dev application services running"
fi

restart_dev_apps() {
  if [ -n "$DEV_APPS" ]; then
    log "restarting dev services"
    [ "$DRY_RUN" -eq 1 ] || xargs -r docker start >/dev/null <<<"$DEV_APPS" || true
  fi
}
trap 'restart_dev_apps; rm -rf "$STAGE"' EXIT

# ── 3. Replace the dev database ──────────────────────────────────────────────
log "recreating $DATABASE on the target…"
# Terminating first: DROP DATABASE fails while a single connection remains, and a stopped service
# can still have a socket in the cluster's view for a moment.
dev_sql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DATABASE' AND pid <> pg_backend_pid();" postgres
dev_sql "DROP DATABASE IF EXISTS $DATABASE;" postgres
dev_sql "CREATE DATABASE $DATABASE OWNER \"$DEV_USER\";" postgres

if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] skipping the restore"
else
  log "restoring…"
  gunzip -c "$DUMP" | docker exec -i "$DEV_PG" psql -q -U "$DEV_USER" -d "$DATABASE" >/dev/null
  log "restore complete"
fi

# ── 4. The strips ────────────────────────────────────────────────────────────
# Each one is here because a copied value points at something REAL, and each reports what it
# changed - a strip that silently matched nothing is how a schema change disarms this step.
#
# THE LIST MOVED TO `infrastructure/lib/copy-strips.sh` ON 2026-09-02, when a SECOND copy of
# production appeared: the on-demand one into a developer's local stack. The list's failure mode is
# an absence, `dev-copy-guards.test.sh` derives it from the entity declarations to catch that, and a
# second hand-written copy would have been covered by nothing. `dev_sql` is passed BY NAME so the
# allowlist of what may be written stays here, in the script that owns the target.
log "stripping what a copy must not carry…"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# `source-path=SCRIPTDIR` is what makes the `source=` line below resolve at all: shellcheck reads a
# relative path against ITS OWN working directory, not against the script's, so `source=` alone left
# it reporting SC1091 "does not exist" for a file that is right there.
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../lib/copy-strips.sh
. "$SCRIPT_DIR/../lib/copy-strips.sh"
apply_copy_strips dev_sql "$DATABASE" "[copy-prod-to-dev]"

# ── 5. Verify, do not assert ─────────────────────────────────────────────────
if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] nothing was changed"
  exit 0
fi

DEV_ROWS=$(dev_sql_ro "SELECT count(*) FROM users;")
DEV_TOKENS=$(dev_sql_ro "SELECT count(*) FROM push_token;")
DEV_STRIPE=$(dev_sql_ro "SELECT count(*) FROM users WHERE \"stripeCustomerId\" IS NOT NULL;")

log "verification: users prod=$PROD_ROWS dev=$DEV_ROWS | push_token dev=$DEV_TOKENS | stripe ids dev=$DEV_STRIPE"

problems=0
[ "$PROD_ROWS" = "$DEV_ROWS" ] || {
  printf '[copy-prod-to-dev] ERROR user count differs: prod=%s dev=%s\n' "$PROD_ROWS" "$DEV_ROWS" >&2
  problems=1
}
[ "$DEV_TOKENS" = "0" ] || {
  printf '[copy-prod-to-dev] ERROR %s push tokens survived the truncate\n' "$DEV_TOKENS" >&2
  problems=1
}
[ "$DEV_STRIPE" = "0" ] || {
  printf '[copy-prod-to-dev] ERROR %s Stripe customer ids survived\n' "$DEV_STRIPE" >&2
  problems=1
}
[ "$problems" -eq 0 ] || fail "the copy completed but did not verify - the dev environment is NOT trustworthy"

log "copy verified"
