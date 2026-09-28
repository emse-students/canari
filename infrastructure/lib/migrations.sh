# shellcheck shell=bash
#
# The migration ledger and its precondition, in ONE place, for the TWO things that change a schema.
#
# WHY THIS FILE EXISTS. `deploy-environment.sh` applied the migrations and nothing else did - and
# `infrastructure/dev/copy-prod-to-dev.sh` REPLACES dev's database with production's, schema and
# `schema_migrations` ledger included. Dev runs a PRE-RELEASE, which is newer than production by
# definition, so every refresh rolled dev's schema back to production's under images that expect
# the new one. Measured 2026-09-28: the weekly refresh ran at 10:42 against `0.18.28-alpha.1`, and
# from 10:46 `chat-delivery-service` failed every membership query on `column
# DeviceGroupMembership.admittedAtEpoch does not exist` - the pre-release under test, broken by the
# job that exists to make it a faithful rehearsal. Both callers now run THIS loop, so the refresh
# ends on the schema the deployed commit declares.
#
# The caller defines `psql` (its own guarded route to ITS database - a compose exec on a deploy, the
# label-checked `docker exec` on a copy) and `ENVIRONMENT`, and runs from the repository root, since
# the ledger is keyed by repo-relative path. Same split as `copy-strips.sh`: the allowlist of what
# may be written stays in the script that owns the target.
#
# Usage:
#   . "$ROOT/infrastructure/lib/migrations.sh"
#   apply_migrations

# The ledger, keyed by repo-relative path. Without it every file replays on every deploy, which
# silently reverts admin changes made after a one-shot data backfill - migrations 004 and 016 are
# exactly that. Files must still be idempotent: a deploy that fails mid-run leaves the rest
# unrecorded, so the next one re-runs them. See infrastructure/MIGRATION.md.
# THE LOOP READS ON FD 3, AND THAT IS THE WHOLE POINT OF THIS FUNCTION. `psql` here is
# `docker compose exec -T`, which ATTACHES AND DRAINS STDIN whatever arguments follow it - so with
# the file list on the loop's own stdin, the ledger query in the FIRST iteration swallowed every
# remaining line and `read` met EOF. Measured on dev's first bootstrap, 2026-09-02: 80 migration
# files present, `migrations: 1 applied, 0 already recorded`, and two services crash-looping on
# `relation "platform_config" does not exist`. Production never saw it because production still runs
# its own inlined shell - which is exactly why this script had to be exercised on dev first.
#
# A dedicated descriptor fixes the CLASS rather than the instance: `</dev/null` on each inner call
# would work today and would have to be remembered by whoever adds the next one.
# The one table that proves the ORM has built this database. THE 80 MIGRATION FILES ARE DELTAS, NOT
# A SCHEMA: only 14 of them contain a CREATE TABLE, and nothing in the set creates the tables the
# entities own - TypeORM does, through `synchronize`, which every service disables the moment
# `NODE_ENV=production`. So on BOTH estates the schema arrives from somewhere else: production's came
# from an ORM boot years ago, dev's comes from `infrastructure/dev/copy-prod-to-dev.sh`.
#
# WHY A SENTINEL AND NOT A TABLE COUNT. Dev's first bootstrap (2026-09-02) reached migration 002 and
# died on `relation "dm_group_members" does not exist`, having applied 001 - so "the database has no
# tables" was already false while the schema was still absent, and a count would have passed. A
# threshold would be a magic number. `dm_group_members` is REFERENCED by the migration set and
# created by no file in it, which is exactly the property being tested; `deploy-migrations.test.sh`
# DERIVES that set from the files and fails if this name ever leaves it, so a future migration that
# creates the table forces a new sentinel rather than silently disarming the guard.
readonly ORM_SENTINEL_TABLE='dm_group_members'

# Refuses a deploy whose migrations cannot possibly succeed, BEFORE applying any of them, and names
# the remedy for the estate it is running on. The alternative is what dev actually did: fail on an
# arbitrary file with a message about a column, which says nothing about the seeding step that was
# skipped. A fact known before the loop belongs before the loop.
require_orm_schema() {
  local present
  present="$(psql -At -c "SELECT to_regclass('public.${ORM_SENTINEL_TABLE}') IS NOT NULL" || true)"
  [ "$present" = "t" ] && return 0

  printf '::error::the %s database has no schema - %s is absent, and no migration in this repository creates it (the ORM does, and it is disabled outside development). The migration files are deltas; they cannot bootstrap an empty database.\n' \
    "$ENVIRONMENT" "$ORM_SENTINEL_TABLE"
  if [ "$ENVIRONMENT" = "dev" ]; then
    printf '::error::seed it first: run the "Refresh dev.canari-emse.fr from production" workflow, which restores production schema AND data, then deploy again.\n'
  else
    printf '::error::this is production and its schema is GONE. Do not deploy. Restore a backup.\n'
  fi
  return 1
}

apply_migrations() {
  psql -q -c "CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
  require_orm_schema || return 1

  local migrations applied skipped migration checksum recorded
  migrations="$(find apps/*/src/migrations -name '*.sql' 2>/dev/null | sort || true)"
  if [ -z "$migrations" ]; then
    printf 'no migration files found\n'
    return 0
  fi

  applied=0
  skipped=0
  while read -r migration <&3; do
    [ -z "$migration" ] && continue
    checksum="$(sha256sum "$migration" | cut -d' ' -f1)"
    recorded="$(psql -At -c "SELECT checksum FROM schema_migrations WHERE filename = '$migration'" || true)"

    if [ -n "$recorded" ]; then
      if [ "$recorded" != "$checksum" ]; then
        printf '::warning::%s changed after it was applied - the %s database still has the old version. Add a new migration instead of editing an applied one.\n' \
          "$migration" "$ENVIRONMENT"
        psql -q -c "UPDATE schema_migrations SET checksum = '$checksum' WHERE filename = '$migration'"
      fi
      skipped=$((skipped + 1))
      continue
    fi

    printf 'applying %s\n' "$migration"
    psql <"$migration"
    psql -q -c "INSERT INTO schema_migrations (filename, checksum) VALUES ('$migration', '$checksum') ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum"
    applied=$((applied + 1))
  done 3<<<"$migrations"
  printf 'migrations: %s applied, %s already recorded\n' "$applied" "$skipped"
}
