#!/usr/bin/env bash
#
# Empties the dev.canari-emse.fr estate and loads the FICTIONAL seed into it. Nothing here reads
# production, and nothing anywhere copies production into dev any more.
#
# WHY (owner, 2026-10-16, GDPR review). Until that day `copy-prod-to-dev.sh` restored a `pg_dump` of
# production into dev every Monday: every member's name, profile, posts, memberships and calendar,
# onto a second, publicly resolvable estate that exists to run unreleased code. It was deleted with
# no flag to bring it back. Dev now holds the data set `tools/dev-seed/seed.ts` generates - people
# whose last name is literally `Fictif`, associations named as fictional, addresses on the RFC 2606
# `.invalid` TLD - committed as `infrastructure/dev/seed.sql` so the box needs no toolchain to load it.
#
# WHAT IT KEEPS, AND WHY THAT IS NOT A PROD READ. The SCHEMA and the migration LEDGER stay: no
# migration file creates `users` or `posts` (TypeORM built them; `infrastructure/lib/migrations.sh`
# says why), so a reset that dropped the database could not rebuild it from this repository. Every
# other table in `public` is truncated, the dev Redis is flushed (its history streams, presence and
# pending frames all name rows that no longer exist), and the seed is loaded in the SAME transaction
# as the TRUNCATE - a seed that does not fit the schema rolls the whole reset back and dev is left
# exactly as it was. Garage is left alone: the old copy never carried a single object into it
# (`copy-strips.sh` cleared every media reference for that reason), so it holds only what testers
# uploaded on dev, and a reset leaves those blobs unreferenced rather than wrong.
#
# THE DIRECTION IS FIXED BY CONSTRUCTION. The one project this may write to is a readonly constant,
# not a parameter; containers are found by compose LABEL; and every write re-reads the target's
# `com.docker.compose.project` label and refuses unless it is exactly that constant - an ALLOWLIST,
# which is what a destructive control needs. There is no production name in this file to invert.
#
# Usage, on the box, from the dev checkout at `dev-deployed` (the `dev-reset` job of scheduled.yml):
#   infrastructure/dev/reset-dev-to-seed.sh [--dry-run]

set -euo pipefail

# ── The one project this may write to. A constant, deliberately: see the header. ──
readonly DEV_PROJECT="canari-dev"
readonly DATABASE="auth_db"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log() { printf '[reset-dev-to-seed] %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() {
  printf '[reset-dev-to-seed] ERROR %s\n' "$*" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly SEED_SQL="$SCRIPT_DIR/seed.sql"

# ── Locate a service's container by compose label ────────────────────────────
# The label is written by compose itself. `status=running` matters: a stale exited container of the
# same name would otherwise be selected and every later check would describe something not serving.
container_for() {
  local service="$1" found
  found=$(docker ps --filter "label=com.docker.compose.project=${DEV_PROJECT}" \
    --filter "label=com.docker.compose.service=${service}" \
    --filter "status=running" --format '{{.Names}}')
  [ -n "$found" ] || fail "no running '${service}' container in project '${DEV_PROJECT}'"
  if [ "$(printf '%s\n' "$found" | wc -l)" -ne 1 ]; then
    fail "several running '${service}' containers in project '${DEV_PROJECT}': $(echo "$found" | tr '\n' ' ')"
  fi
  printf '%s' "$found"
}

project_of() {
  docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$1" 2>/dev/null
}

# Re-verified per call rather than once at startup: a check that ran minutes ago describes the
# container that was there minutes ago.
require_dev() {
  local actual
  actual=$(project_of "$1")
  [ "$actual" = "$DEV_PROJECT" ] || fail "$1 reports project '${actual}', not '${DEV_PROJECT}' - refusing to write"
}

# Read a variable out of the container's own environment, so the credential used is the one the
# cluster was started with.
container_env() {
  docker inspect -f "{{range .Config.Env}}{{println .}}{{end}}" "$1" |
    awk -v k="$2" -F= '$1 == k { sub(/^[^=]*=/, ""); print; exit }'
}

DEV_PG=$(container_for postgres)
DEV_REDIS=$(container_for redis)
DEV_USER=$(container_env "$DEV_PG" POSTGRES_USER)
[ -n "$DEV_USER" ] || fail "could not read POSTGRES_USER from $DEV_PG"
require_dev "$DEV_PG"
require_dev "$DEV_REDIS"

# ── The seed, and the three facts its header states ──────────────────────────
[ -f "$SEED_SQL" ] || fail "$SEED_SQL is missing - regenerate it with 'bun tools/dev-seed/seed.ts --write'"
seed_header() { sed -n "s/^-- seed-$1: //p" "$SEED_SQL" | head -1; }
SEED_USERS=$(seed_header users)
SEED_MARKER=$(seed_header marker)
SEED_TABLES=$(seed_header tables)
# Each is spliced into SQL below, so each is held to the alphabet it may use before it is.
[[ "$SEED_USERS" =~ ^[0-9]+$ ]] || fail "the seed header states no user count"
[[ "$SEED_MARKER" =~ ^[A-Za-z]+$ ]] || fail "the seed header states no marker"
[[ "$SEED_TABLES" =~ ^[a-z_]+( [a-z_]+)*$ ]] || fail "the seed header states no table list"

# The ledger's name comes from the file that writes it, never typed here.
# shellcheck source-path=SCRIPTDIR source=../lib/migrations.sh
. "$SCRIPT_DIR/../lib/migrations.sh"
[[ "$MIGRATION_LEDGER_TABLE" =~ ^[a-z_]+$ ]] || fail "the migration ledger name is not a plain identifier"

log "target: $DEV_PG and $DEV_REDIS (project $DEV_PROJECT, user $DEV_USER) - WILL BE EMPTIED"
log "seed: $SEED_USERS fictional users, tables: $SEED_TABLES"

# ── The routes every statement takes ─────────────────────────────────────────
# The ONE write path into Postgres. Arguments are passed straight to psql inside the container, so
# a caller hands it `-c "..."` or a stream on stdin.
dev_psql() {
  require_dev "$DEV_PG"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] would run psql against %s: %s\n' "$DEV_PG" "$*" >&2
    return 0
  fi
  docker exec -i "$DEV_PG" psql -v ON_ERROR_STOP=1 -U "$DEV_USER" -d "$DATABASE" "$@"
}

# Read-only, and allowed in a dry run: it is what the dry run reports with. A separate function so
# that no read can acquire the write path above by accident.
dev_psql_ro() {
  require_dev "$DEV_PG"
  docker exec -i "$DEV_PG" psql -X -v ON_ERROR_STOP=1 -U "$DEV_USER" -d "$DATABASE" "$@"
}
dev_count() { dev_psql_ro -tA -c "$1"; }

# The ONE write path into Redis.
dev_redis() {
  require_dev "$DEV_REDIS"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] would run redis-cli against %s: %s\n' "$DEV_REDIS" "$*" >&2
    return 0
  fi
  docker exec -i "$DEV_REDIS" redis-cli "$@"
}

dev_redis_ro() {
  require_dev "$DEV_REDIS"
  docker exec -i "$DEV_REDIS" redis-cli "$@"
}

# ── 0. The precondition, stated before anything moves ────────────────────────
# A database with no schema cannot be reset - TRUNCATE has nothing to empty and the seed has no
# table to fill - and the library's guard names the remedy (the owner's schema-only restore). Asked
# through the READ route, so a dry run asks it too.
# shellcheck disable=SC2034 # read by require_orm_schema, which picks the remedy per estate
ENVIRONMENT=dev
# shellcheck disable=SC2317,SC2329 # called by the sourced guard, which shellcheck does not follow into
psql() { dev_psql_ro "$@"; }
require_orm_schema

log "before: $(dev_count 'SELECT count(*) FROM users;') user row(s), $(dev_redis_ro DBSIZE) redis key(s)"

# ── 1. Quiesce the dev application services ──────────────────────────────────
# Not the datastores: postgres and redis are the targets. Anything that writes has to stop, or the
# truncate waits on its locks and the flush races its writes.
DEV_APPS=$(docker ps --filter "label=com.docker.compose.project=${DEV_PROJECT}" \
  --filter "status=running" --format '{{.Names}}\t{{.Label "com.docker.compose.service"}}' |
  awk -F'\t' '$2 != "postgres" && $2 != "redis" && $2 != "garage" { print $1 }')

restart_dev_apps() {
  if [ -n "$DEV_APPS" ] && [ "$DRY_RUN" -eq 0 ]; then
    log "restarting dev services"
    xargs -r docker start >/dev/null <<<"$DEV_APPS" || log "WARNING: a dev service did not restart - check 'docker ps -a' for project $DEV_PROJECT"
  fi
}

if [ -n "$DEV_APPS" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] would stop dev services: $(echo "$DEV_APPS" | tr '\n' ' ')"
  else
    log "stopping dev services: $(echo "$DEV_APPS" | tr '\n' ' ')"
    trap restart_dev_apps EXIT
    xargs -r docker stop >/dev/null <<<"$DEV_APPS"
  fi
else
  log "no dev application services running"
fi

# A stopped service can still hold a backend for a moment, and TRUNCATE needs every lock.
dev_psql -q -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DATABASE' AND pid <> pg_backend_pid();" >/dev/null

# ── 2. Forward to the schema dev's images expect ─────────────────────────────
# The workflow checks this tree out at `dev-deployed`, so these are the migrations dev's last deploy
# applied and the loop normally finds nothing. It matters after a schema-only restore, which brings
# an older schema than a pre-release needs. The loop is the deploy's own; `psql` is routed through
# the same label check as every write - and now through the WRITE route, which is the one the loop
# needs and the one a dry run turns into a printed line.
# shellcheck disable=SC2317,SC2329 # called by the sourced loop, which shellcheck does not follow into
psql() { dev_psql "$@"; }
if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] skipping the migrations"
else
  log "applying the migrations of $(git -C "$REPO_ROOT" rev-parse --short HEAD)…"
  # CALLED BARE, NEVER `apply_migrations || fail`: under `||` bash suspends errexit inside the whole
  # function, so a failing file would be recorded in the ledger and the loop would carry on. Bare,
  # the first failure exits here and the EXIT trap restarts the services.
  cd "$REPO_ROOT"
  apply_migrations
fi

# ── 3. Truncate and seed, in ONE transaction ─────────────────────────────────
# The table list is read from the catalogue inside the transaction, never typed: a table added by
# next month's migration is emptied by construction. `--single-transaction` with ON_ERROR_STOP means
# a seed that does not fit rolls the TRUNCATE back with it.
# shellcheck disable=SC2016 # `$reset$` is a PostgreSQL dollar quote, not a shell expansion
TRUNCATE_SQL=$(printf '%s\n' \
  'DO $reset$' \
  'DECLARE targets text;' \
  'BEGIN' \
  "  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ' ORDER BY tablename) INTO targets" \
  "    FROM pg_tables WHERE schemaname = 'public' AND tablename <> '${MIGRATION_LEDGER_TABLE}';" \
  "  IF targets IS NULL THEN RAISE EXCEPTION 'no table to reset in public'; END IF;" \
  "  EXECUTE 'TRUNCATE TABLE ' || targets || ' RESTART IDENTITY CASCADE';" \
  'END $reset$;')

log "truncating every public table but ${MIGRATION_LEDGER_TABLE}, and loading the seed…"
# The dry run does not pipe into dev_psql: a stream nobody reads is a SIGPIPE, which pipefail would
# report as this script's failure. It states what the stream would have been instead.
if [ "$DRY_RUN" -eq 1 ]; then
  dev_psql --single-transaction -q -f - "<<< the TRUNCATE above + $(grep -c '^INSERT INTO' "$SEED_SQL") INSERT statement(s) from $(basename "$SEED_SQL")"
else
  { printf '%s\n' "$TRUNCATE_SQL"; cat "$SEED_SQL"; } | dev_psql --single-transaction -q -f - >/dev/null
fi
# The truncated relation files are unlinked at commit; a checkpoint retires the WAL that still
# describes the rows they held.
dev_psql -q -c "CHECKPOINT;"

# ── 4. Flush the dev Redis ───────────────────────────────────────────────────
# FLUSHALL, then an AOF rewrite: this Redis runs `--appendonly yes`, and until the log is rewritten
# the keys it just deleted are still written in it.
log "flushing $DEV_REDIS…"
dev_redis FLUSHALL
dev_redis BGREWRITEAOF

# ── 5. Verify, do not assert ─────────────────────────────────────────────────
if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] nothing was changed"
  exit 0
fi

DEV_ROWS=$(dev_count "SELECT count(*) FROM users;")
DEV_UNMARKED=$(dev_count "SELECT count(*) FROM users WHERE \"lastName\" IS DISTINCT FROM '${SEED_MARKER}';")
DEV_TOKENS=$(dev_count "SELECT count(*) FROM push_token;")
# The copy's own question about media, reused rather than re-typed: it is the one list of every
# column that can name an object, kept beside the strips that clear them for the local copy.
# shellcheck source-path=SCRIPTDIR source=../lib/copy-strips.sh
. "$SCRIPT_DIR/../lib/copy-strips.sh"
DEV_MEDIA=$(dev_count "$COPY_STRIPS_MEDIA_RESIDUE_SQL" | tr -d '[:space:]')
# Every table the seed does NOT write must be empty - the proof the truncate reached all of them.
seeded_list="'${MIGRATION_LEDGER_TABLE}', '$(printf '%s' "$SEED_TABLES" | sed "s/ /', '/g")'"
DEV_LEFTOVER=$(dev_count "SELECT coalesce(string_agg(tablename, ' '), '') FROM pg_tables
  WHERE schemaname = 'public' AND tablename NOT IN (${seeded_list})
    AND (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename), false, true, '')))[1]::text::bigint > 0;")
DEV_KEYS=$(dev_redis_ro DBSIZE | tr -d '[:space:]')

log "verification: users=$DEV_ROWS (seed $SEED_USERS) unmarked=$DEV_UNMARKED push_token=$DEV_TOKENS media=$DEV_MEDIA non-seed tables with rows=[${DEV_LEFTOVER}] redis keys=$DEV_KEYS"

problems=0
report() {
  printf '[reset-dev-to-seed] ERROR %s\n' "$1" >&2
  problems=1
}
[ "$DEV_ROWS" = "$SEED_USERS" ] || report "users: $DEV_ROWS row(s), the seed writes $SEED_USERS"
[ "$DEV_UNMARKED" = "0" ] || report "$DEV_UNMARKED user row(s) do not carry the '${SEED_MARKER}' marker"
[ "$DEV_TOKENS" = "0" ] || report "$DEV_TOKENS push token(s) survived the truncate"
[ "$DEV_MEDIA" = "0" ] || report "$DEV_MEDIA row(s) reference media objects the seed never wrote"
[ -z "$DEV_LEFTOVER" ] || report "tables the seed does not write still hold rows: $DEV_LEFTOVER"
[ "$DEV_KEYS" = "0" ] || report "$DEV_KEYS redis key(s) survived the flush"
[ "$problems" -eq 0 ] || fail "the reset completed but did not verify - the dev environment is NOT trustworthy"

log "reset verified - dev holds the fictional seed and nothing else"
