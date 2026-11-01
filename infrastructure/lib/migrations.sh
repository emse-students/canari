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
# A caller that may apply a migration the owner approved also defines `migration_backup <file>`,
# which takes a backup of ITS database and fails loudly when it cannot (the owner's rule: a backup
# right before). Without it, an approved held migration is refused, never applied unprotected.
#
# Usage:
#   . "$ROOT/infrastructure/lib/migrations.sh"
#   apply_migrations

# The owner's hold, shared with the release preflight.
# shellcheck source-path=SCRIPTDIR source=migration-hold.sh
. "$(dirname "${BASH_SOURCE[0]}")/migration-hold.sh"

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

# THE OWNER'S HOLD, applied to the files this database has not recorded. What holds a file, what
# approves it and why it is a committed line are in `migration-hold.sh`, shared with the release
# preflight. Only UNRECORDED files are examined: an applied migration is history, not a request.
#
# Refuses, before ANYTHING is applied, every unrecorded file that is held and not approved for its
# current content, and logs the decision on every one it examined. Sets MIGRATIONS_APPROVED_HELD to
# the files it let through on an approval, so the loop takes a backup right before each.
# $1 is the sorted file list, $2 the ledger's filenames. Relies on no errexit: every failure is
# checked where it happens.
MIGRATIONS_APPROVED_HELD=""
require_owner_approvals() {
  local migrations="$1" ledger="$2" migration verdict kind checksum rest reason sums
  local examined=0 held=0 approved=0 refused=0
  MIGRATIONS_APPROVED_HELD=""
  while IFS= read -r migration; do
    [ -z "$migration" ] && continue
    grep -qxF "$migration" <<<"$ledger" && continue
    examined=$((examined + 1))
    if ! verdict="$(migration_gate_verdict "$migration")"; then
      printf '::error::the hold could not be decided for %s - refusing, NOTHING was applied to the %s database.\n' \
        "$migration" "$ENVIRONMENT"
      return 1
    fi
    kind="${verdict%%|*}"
    [ "$kind" = plain ] && continue
    held=$((held + 1))
    rest="${verdict#*|}"
    checksum="${rest%%|*}"
    rest="${rest#*|}"
    case "$kind" in
    approved)
      approved=$((approved + 1))
      MIGRATIONS_APPROVED_HELD="${MIGRATIONS_APPROVED_HELD}${migration}"$'\n'
      printf 'migration %s is held because %s - APPROVED for this content (%s) in %s; a backup is taken right before it.\n' \
        "$migration" "$rest" "$checksum" "$MIGRATION_APPROVALS_FILE"
      ;;
    stale)
      refused=$((refused + 1))
      sums="${rest%%|*}"
      reason="${rest#*|}"
      printf '::error::%s is HELD: %s, and %s approves another content of it (%s), not this one (%s). It changed after the owner approved it.\n' \
        "$migration" "$reason" "$MIGRATION_APPROVALS_FILE" "$sums" "$checksum"
      migration_hold_remedy "$migration" "$checksum"
      ;;
    *)
      refused=$((refused + 1))
      printf '::error::%s is HELD for the owner: %s, and %s does not approve it.\n' \
        "$migration" "$rest" "$MIGRATION_APPROVALS_FILE"
      migration_hold_remedy "$migration" "$checksum"
      ;;
    esac
  done <<<"$migrations"

  printf 'owner hold: %s unrecorded file(s) examined, %s held, %s approved, %s refused\n' \
    "$examined" "$held" "$approved" "$refused"
  if [ "$refused" -gt 0 ]; then
    printf '::error::%s migration(s) held for the owner - NOTHING was applied, the %s database is unchanged.\n' \
      "$refused" "$ENVIRONMENT"
    return 1
  fi
  if [ "$approved" -gt 0 ] && ! declare -F migration_backup >/dev/null; then
    printf '::error::%s approved held migration(s) are due, and this caller defines no migration_backup - the owner'"'"'s rule is a backup right before, so NOTHING was applied to the %s database.\n' \
      "$approved" "$ENVIRONMENT"
    return 1
  fi
  return 0
}

# CALLED BARE, and every gate inside it checked with an explicit `if`: bash suspends errexit inside a
# function called under `||`, so `require_x || return 1` would let a failing command inside `require_x`
# pass unnoticed. Bare, a deploy under `set -e` stops on the first failure; a caller without errexit
# reads the status on the next line.
apply_migrations() {
  local migrations applied skipped migration checksum recorded ledger status
  psql -q -c "CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (filename TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
  require_orm_schema
  status=$?
  [ "$status" -eq 0 ] || return 1

  migrations="$(find apps/*/src/migrations -name '*.sql' 2>/dev/null | sort || true)"
  if [ -z "$migrations" ]; then
    printf 'no migration files found\n'
    return 0
  fi

  # THE LEDGER IS READ ONCE, AND AN UNREADABLE LEDGER IS A REFUSAL. Read as empty, it would make
  # every historic DROP a request - a refusal for the wrong reason, naming eighty files.
  if ! ledger="$(psql -At -c "SELECT filename FROM ${MIGRATION_LEDGER_TABLE}" </dev/null)"; then
    printf '::error::the %s ledger of the %s database could not be read, so nobody can say which migrations are new - refusing, NOTHING was applied.\n' \
      "$MIGRATION_LEDGER_TABLE" "$ENVIRONMENT"
    return 1
  fi
  require_owner_approvals "$migrations" "$ledger"
  status=$?
  [ "$status" -eq 0 ] || return 1

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

    # THE OWNER'S RULE, LAST HALF: a backup taken just before. The caller's `migration_backup` takes
    # it (the deploy reuses the nightly backup's own dump); a failed backup applies nothing more.
    if grep -qxF "$migration" <<<"$MIGRATIONS_APPROVED_HELD"; then
      printf 'taking a backup of the %s database right before %s\n' "$ENVIRONMENT" "$migration"
      migration_backup "$migration" </dev/null
      status=$?
      if [ "$status" -ne 0 ]; then
        printf '::error::the backup before %s failed - it is NOT applied, and nothing after it is.\n' "$migration"
        return 1
      fi
    fi

    printf 'applying %s\n' "$migration"
    psql <"$migration"
    psql -q -c "INSERT INTO ${MIGRATION_LEDGER_TABLE} (filename, checksum) VALUES ('$migration', '$checksum') ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum"
    applied=$((applied + 1))
  done 3<<<"$migrations"
  printf 'migrations: %s applied, %s already recorded\n' "$applied" "$skipped"
}
