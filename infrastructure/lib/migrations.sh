# shellcheck shell=bash
#
# The migration ledger and its precondition, in ONE place, for the TWO things that change a schema.
#
# WHY THIS FILE EXISTS. `deploy-environment.sh` applied the migrations and nothing else did - and
# the weekly copy of production into dev (deleted 2026-10-16) REPLACED dev's database with
# production's, schema and ledger included, so every refresh rolled a pre-release's schema back
# under images that expected the new one (2026-09-28: `DeviceGroupMembership.admittedAtEpoch does
# not exist` on every membership query). The loop became a library so both callers ran it. Its
# callers today are the deploy and `infrastructure/dev/reset-dev-to-seed.sh`, which runs it before
# it truncates, so a reset always ends on the schema of the commit dev's images were built from.
#
# The caller defines `psql` (its own guarded route to ITS database - a compose exec on a deploy, the
# label-checked `docker exec` on a reset) and `ENVIRONMENT`, and runs from the repository root,
# since the ledger is keyed by repo-relative path. The allowlist of what may be written stays in the
# script that owns the target.
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
# from an ORM boot years ago, dev's from a copy of production that carried rows too until 2026-10-16
# - a virgin dev now gets a SCHEMA-ONLY restore, owner-run, documented in dev-environment.md.
#
# WHY A SENTINEL AND NOT A TABLE COUNT. Dev's first bootstrap (2026-09-02) reached migration 002 and
# died on `relation "dm_group_members" does not exist`, having applied 001 - so "the database has no
# tables" was already false while the schema was still absent, and a count would have passed. A
# threshold would be a magic number. `dm_group_members` is REFERENCED by the migration set and
# created by no file in it, which is exactly the property being tested; `deploy-migrations.test.sh`
# DERIVES that set from the files and fails if this name ever leaves it, so a future migration that
# creates the table forces a new sentinel rather than silently disarming the guard.
readonly ORM_SENTINEL_TABLE='dm_group_members'

# The ledger itself, named ONCE. `reset-dev-to-seed.sh` truncates every table but this one, so it
# reads the name from here rather than typing it: a ledger renamed in one place and not the other
# would be truncated, and the next deploy would replay every one-shot data migration over the seed.
readonly MIGRATION_LEDGER_TABLE='schema_migrations'

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
    printf '::error::give it a schema first: the owner runs the SCHEMA-ONLY restore in docs/wiki/infrastructure/dev-environment.md (no production row is copied, only the schema and the %s ledger), then the "dev-reset" job of scheduled.yml loads the fictional seed.\n' \
      "$MIGRATION_LEDGER_TABLE"
  else
    printf '::error::this is production and its schema is GONE. Do not deploy. Restore a backup.\n'
  fi
  return 1
}

# THE OWNER'S HOLD (owner, 2026-11-01: "a migration is applied only if it is additive, reviewed, and
# with a backup taken just before"). Migrations 034, 038 and 042 were each written as "owed the
# owner's yes" and reached production with the next release anyway: the yes was a sentence in the
# backlog, and this loop applies every unrecorded file. So a migration that needs the owner is now
# REFUSED until a committed line approves it - the deploy fails closed, naming the file, BEFORE any
# file is applied. Two things make a migration need it, and both estates are held alike:
#
# - the marker, a line of its own reading `-- canari:hold-for-owner`, written by the author of any
#   migration the owner must see (a backfill, a lock on a hot table, anything not plainly additive);
# - a statement that destroys data, read from the SQL with its `--` comments stripped: DROP of a
#   TABLE, COLUMN, SCHEMA or DATABASE, TRUNCATE, DELETE FROM, or a column TYPE change. A statement
#   the author forgot to mark is still caught. An UPDATE backfill is NOT matched - it is the author's
#   to mark; a DROP CONSTRAINT/INDEX/TRIGGER IF EXISTS before a re-create is not destructive either.
#
# THE APPROVAL IS A COMMITTED LINE, `<repo-relative path> <sha256 of the file>`, in
# MIGRATION_APPROVALS_FILE - reviewed in a pull request, kept in history, and bound to the CONTENT:
# a file edited after its approval is held again. A release has no input to carry it (`gh release
# create` takes none), and an environment flag would be a switch nobody reads. Only files the ledger
# has NOT recorded are examined: an applied migration is history, not a request.
readonly MIGRATION_APPROVALS_FILE='infrastructure/migration-approvals.txt'
readonly MIGRATION_HOLD_MARKER_PATTERN='^--[[:space:]]*canari:hold-for-owner[[:space:]]*$'
readonly MIGRATION_DESTRUCTIVE_PATTERN='\b(DROP[[:space:]]+(TABLE|COLUMN|SCHEMA|DATABASE)|TRUNCATE|DELETE[[:space:]]+FROM)\b|\bALTER[[:space:]]+COLUMN[^;]*[[:space:]](SET[[:space:]]+DATA[[:space:]]+)?TYPE\b'

# Prints why the migration file $1 needs the owner's approval, or nothing when it does not.
migration_hold_reason() {
  local migration="$1" statement
  if tr -d '\r' <"$migration" | grep -qE "$MIGRATION_HOLD_MARKER_PATTERN"; then
    printf 'it carries the hold marker'
    return 0
  fi
  statement="$(sed 's/--.*$//' "$migration" | grep -oiE "$MIGRATION_DESTRUCTIVE_PATTERN" | head -1 || true)"
  if [ -n "$statement" ]; then
    printf 'it contains a destructive statement (%s)' "$statement"
  fi
}

# Refuses, before anything is applied, every unrecorded migration that needs the owner's approval
# and has none for its current content. $1 is the sorted file list, $2 the ledger's filenames.
require_owner_approvals() {
  local migrations="$1" ledger="$2" migration reason checksum approved refused=0
  while read -r migration; do
    [ -z "$migration" ] && continue
    grep -qxF "$migration" <<<"$ledger" && continue
    reason="$(migration_hold_reason "$migration")"
    [ -z "$reason" ] && continue

    checksum="$(sha256sum "$migration" | cut -d' ' -f1)"
    approved=""
    if [ -f "$MIGRATION_APPROVALS_FILE" ]; then
      approved="$(tr -d '\r' <"$MIGRATION_APPROVALS_FILE" | awk -v f="$migration" '$1 == f { print $2 }')"
    fi
    if grep -qxF "$checksum" <<<"$approved"; then
      printf 'migration %s needs the owner because %s - APPROVED in %s for this content\n' \
        "$migration" "$reason" "$MIGRATION_APPROVALS_FILE"
      continue
    fi

    refused=$((refused + 1))
    if [ -n "$approved" ]; then
      printf '::error::%s is HELD: %s, and %s approves another version of it (%s), not this one (%s). The file changed after the owner approved it.\n' \
        "$migration" "$reason" "$MIGRATION_APPROVALS_FILE" "$(printf '%s' "$approved" | tr '\n' ' ' | sed 's/ $//')" "$checksum"
    else
      printf '::error::%s is HELD for the owner: %s, and %s does not approve it.\n' \
        "$migration" "$reason" "$MIGRATION_APPROVALS_FILE"
    fi
    printf '::error::to apply it, the owner (additive, reviewed, a backup taken just before) merges the line "%s %s" into %s, then re-runs this deploy.\n' \
      "$migration" "$checksum" "$MIGRATION_APPROVALS_FILE"
  done <<<"$migrations"

  if [ "$refused" -gt 0 ]; then
    printf '::error::%s migration(s) held for the owner - NOTHING was applied, the %s database is unchanged.\n' \
      "$refused" "$ENVIRONMENT"
    return 1
  fi
}

apply_migrations() {
  psql -q -c "CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (filename TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
  require_orm_schema || return 1

  local migrations applied skipped migration checksum recorded ledger
  migrations="$(find apps/*/src/migrations -name '*.sql' 2>/dev/null | sort || true)"
  if [ -z "$migrations" ]; then
    printf 'no migration files found\n'
    return 0
  fi

  # A ledger that cannot be read is read as empty, so every file is examined: the gate fails closed.
  ledger="$(psql -At -c "SELECT filename FROM ${MIGRATION_LEDGER_TABLE}" </dev/null || true)"
  require_owner_approvals "$migrations" "$ledger" || return 1

  applied=0
  skipped=0
  while read -r migration <&3; do
    [ -z "$migration" ] && continue
    checksum="$(sha256sum "$migration" | cut -d' ' -f1)"
    recorded="$(psql -At -c "SELECT checksum FROM ${MIGRATION_LEDGER_TABLE} WHERE filename = '$migration'" || true)"

    if [ -n "$recorded" ]; then
      if [ "$recorded" != "$checksum" ]; then
        printf '::warning::%s changed after it was applied - the %s database still has the old version. Add a new migration instead of editing an applied one.\n' \
          "$migration" "$ENVIRONMENT"
        psql -q -c "UPDATE ${MIGRATION_LEDGER_TABLE} SET checksum = '$checksum' WHERE filename = '$migration'"
      fi
      skipped=$((skipped + 1))
      continue
    fi

    printf 'applying %s\n' "$migration"
    psql <"$migration"
    psql -q -c "INSERT INTO ${MIGRATION_LEDGER_TABLE} (filename, checksum) VALUES ('$migration', '$checksum') ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum"
    applied=$((applied + 1))
  done 3<<<"$migrations"
  printf 'migrations: %s applied, %s already recorded\n' "$applied" "$skipped"
}
