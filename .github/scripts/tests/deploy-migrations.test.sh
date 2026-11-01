#!/usr/bin/env bash
# Does the migration loop (`infrastructure/lib/migrations.sh`) apply EVERY migration, does it refuse
# a database the migrations cannot possibly build - and do BOTH things that change a schema run it?
#
# WHY THIS TEST EXISTS. On dev's first bootstrap (2026-09-02) the deploy reported
# `migrations: 1 applied, 0 already recorded` with 80 files on disk, and two services crash-looped
# on `relation "platform_config" does not exist`. The loop was correct in every line: the fault was
# that `psql` is `docker compose exec -T`, which ATTACHES AND DRAINS STDIN whatever arguments follow
# it, and the file list was on the loop's own stdin - so the ledger query in the first iteration
# swallowed the remaining 79 lines and `read` met EOF.
#
# THE SECOND SECTION EXISTS BECAUSE FIXING THAT EXPOSED THE LAYER UNDER IT. With all 80 files
# attempted, the same deploy died on `002_drop_group_member_left_at.sql` -> `relation
# "dm_group_members" does not exist`. The migration set is DELTAS, not a schema: only 14 of the 80
# files contain a CREATE TABLE and none creates the entities' own tables, which TypeORM builds
# through `synchronize` - disabled on both estates. So an empty database cannot be migrated, and the
# deploy must say so BEFORE applying anything rather than failing on whichever file happens to
# reference an ORM table first.
#
# THE SHAPE IS WHY BOTH ARE TESTED FUNCTIONALLY RATHER THAN BY GREP. "The loop reads on fd 3" is a
# sentence about the text; "all N files are applied even when the ledger query eats stdin" is a
# statement about the outcome, and only the second one still holds the day somebody adds a fourth
# psql call inside the loop. So the functions are extracted from the real script and run against a
# `psql` stub that drains stdin exactly as `docker compose exec -T` does.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$REPO/infrastructure/lib/migrations.sh"
DEPLOY="$REPO/infrastructure/deploy/deploy-environment.sh"
RESET="$REPO/infrastructure/dev/reset-dev-to-seed.sh"
PASS=0
FAIL=0
ok() {
  printf '  ok   %s\n' "$1"
  PASS=$((PASS + 1))
}
fail() {
  printf '  FAIL %s\n' "$1"
  FAIL=$((FAIL + 1))
}

[ -f "$SCRIPT" ] || {
  printf '::error::%s not found\n' "$SCRIPT" >&2
  exit 1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A tree shaped like the repository's: three services, several files each, so a loop that stops
# early stops at a countable place.
FILES=0
for svc in core-service social-service chat-delivery-service; do
  mkdir -p "$TMP/apps/$svc/src/migrations"
  for n in 001 002 003 004; do
    printf 'SELECT 1;\n' >"$TMP/apps/$svc/src/migrations/${n}_x.sql"
    FILES=$((FILES + 1))
  done
done

printf '\nevery migration file is applied, not just the first\n'

# `apply_migrations` verbatim from the script under test. Extracted rather than reimplemented: a
# copy of the loop would pass while the deploy failed, which is the whole failure mode of the four
# declarations that agreed with each other in `deploy-env.test.sh`.
fn="$(sed -n '/^apply_migrations() {/,/^}/p' "$SCRIPT")"
if [ -z "$fn" ]; then
  fail "apply_migrations() is not a function in infrastructure/lib/migrations.sh - it cannot be exercised at all"
  printf '\n%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
ok "apply_migrations() is extractable from the real script"

guard="$(sed -n '/^require_orm_schema() {/,/^}/p' "$SCRIPT")"
sentinel_decl="$(sed -n '/^readonly ORM_SENTINEL_TABLE=/p' "$SCRIPT")"
ledger_decl="$(sed -n '/^readonly MIGRATION_LEDGER_TABLE=/p' "$SCRIPT")"
SENTINEL="$(printf '%s' "$sentinel_decl" | sed "s/^readonly ORM_SENTINEL_TABLE='//; s/'$//")"
# The owner's hold: its three declarations and two functions, verbatim, evaluated by every runner
# below because `apply_migrations` calls the gate before it applies anything.
hold_parts="$(
  sed -n '/^readonly MIGRATION_APPROVALS_FILE=/p; /^readonly MIGRATION_HOLD_MARKER_PATTERN=/p; /^readonly MIGRATION_DESTRUCTIVE_PATTERN=/p' "$SCRIPT"
  sed -n '/^migration_hold_reason() {/,/^}/p; /^require_owner_approvals() {/,/^}/p' "$SCRIPT"
)"

run_with_draining_psql() {
  (
    cd "$TMP" || exit 1
    # shellcheck disable=SC2034 # read by the `eval`ed guard and loop, which shellcheck cannot follow
    ENVIRONMENT=dev
    # THE STUB IS THE POINT: it drains stdin on every call, which is what `docker compose exec -T`
    # does. It answers nothing for the ledger SELECT, so every file counts as unapplied - and `t`
    # for the sentinel probe, because this section is about the loop and the precondition is the
    # subject of the next one. A stub answering nothing there would make every assertion here a
    # measurement of the guard instead.
    # shellcheck disable=SC2317,SC2329 # called only from `eval`ed code, so the body looks unreachable and the definition looks unused (SC2329 exists from shellcheck 0.11; CI pins 0.10)
    psql() {
      local args="$*"
      cat >/dev/null 2>&1 || true
      case "$args" in
      *to_regclass*) printf 't\n' ;;
      esac
      return 0
    }
    eval "$sentinel_decl"
    eval "$ledger_decl"
    eval "$guard"
    eval "$hold_parts"
    eval "$fn"
    apply_migrations
  )
}

# `</dev/null` binds the FUNCTION's stdin, not the loop's. With the loop reading fd 3 the stub
# returns at once; with the loop reading its own stdin the stub eats the file list, which is the
# defect this asserts against. Without the redirect the stub would block on a terminal that never
# sends EOF - a hang, not a verdict.
out="$(run_with_draining_psql </dev/null 2>&1)"
applied="$(printf '%s' "$out" | sed -n 's/^migrations: \([0-9]*\) applied.*/\1/p' | tail -1)"

if [ "$applied" = "$FILES" ]; then
  ok "all $FILES files applied with a stdin-draining psql (reported: $applied)"
else
  fail "only $applied of $FILES files applied - a command inside the loop is eating the file list"
fi

# The second half of the same property: the count of `applying` lines must match, because the
# summary is printed by the same function that could have been wrong about it.
lines="$(printf '%s\n' "$out" | grep -c '^applying ')"
if [ "$lines" = "$FILES" ]; then
  ok "$FILES 'applying' lines printed, so the summary is not the only witness"
else
  fail "$lines 'applying' lines for $FILES files"
fi

printf '\nthe schema precondition is STATED, not discovered by failing on an arbitrary file\n'

if [ -n "$guard" ]; then
  ok "require_orm_schema() is extractable from the real script"
else
  fail "require_orm_schema() is not a function in infrastructure/lib/migrations.sh - nothing states the migrations' precondition"
fi

if [ -n "$SENTINEL" ]; then
  ok "the script names an ORM sentinel table ($SENTINEL)"
else
  fail "the script names no ORM sentinel table"
fi

# DERIVED FROM THE REAL MIGRATION FILES, so this assertion cannot rot into a tautology: the tables
# the set ALTERs and never CREATEs are exactly the tables it depends on the ORM for. The sentinel
# must be one of them. The day a migration creates it, this fails and forces a new sentinel rather
# than leaving a guard that passes on a database with no schema.
tables_matching() {
  grep -rhoiE "$1"'[[:space:]]+(IF[[:space:]]+(NOT[[:space:]]+)?EXISTS[[:space:]]+)?"?[a-z_][a-z_0-9]*"?' \
    "$REPO"/apps/*/src/migrations/*.sql 2>/dev/null |
    sed -E 's/.*[[:space:]]"?([a-z_][a-z_0-9]*)"?$/\1/' | tr '[:upper:]' '[:lower:]' | sort -u
}
altered="$(tables_matching 'ALTER[[:space:]]+TABLE')"
created="$(tables_matching 'CREATE[[:space:]]+TABLE')"
orm_owned="$(comm -23 <(printf '%s\n' "$altered") <(printf '%s\n' "$created"))"

if [ -z "$orm_owned" ]; then
  fail "no table is referenced-but-never-created by the migration set - its premise may have changed and the guard needs rethinking, not a new sentinel"
elif grep -qx "$SENTINEL" <<<"$orm_owned"; then
  ok "$SENTINEL is referenced by the migration set and created by no file in it, which is the property the guard tests"
else
  fail "$SENTINEL is NOT in the derived set of ORM-owned tables ($(printf '%s' "$orm_owned" | tr '\n' ' ')) - pick the sentinel from that set"
fi

# The refusal itself, per estate.
run_without_schema() {
  (
    cd "$TMP" || exit 1
    # shellcheck disable=SC2034 # read by the `eval`ed guard, which decides the message per estate
    ENVIRONMENT="$1"
    # `to_regclass` answers `f`: the sentinel is absent, which is a virgin database.
    # shellcheck disable=SC2317,SC2329 # called only from `eval`ed code, so the body looks unreachable and the definition looks unused (SC2329 exists from shellcheck 0.11; CI pins 0.10)
    psql() {
      local args="$*"
      cat >/dev/null 2>&1 || true
      case "$args" in
      *to_regclass*) printf 'f\n' ;;
      esac
      return 0
    }
    eval "$sentinel_decl"
    eval "$ledger_decl"
    eval "$guard"
    eval "$hold_parts"
    eval "$fn"
    apply_migrations
  )
}

dev_out="$(run_without_schema dev </dev/null 2>&1)"
dev_rc=$?
if [ "$dev_rc" -ne 0 ]; then
  ok "a schemaless dev database is REFUSED (exit $dev_rc) instead of half-migrated"
else
  fail "a schemaless dev database was accepted - the deploy will die on whichever file references an ORM table first"
fi

if [ "$(printf '%s\n' "$dev_out" | grep -c '^applying ')" = "0" ]; then
  ok "and it applies NOTHING, so the refusal leaves the database as it found it"
else
  fail "it applied files before refusing"
fi

# The remedy changed on 2026-10-16: dev no longer has a copy of production to fall back on, so a
# virgin dev database gets a SCHEMA-ONLY restore (no row of production) and then the fictional seed.
if printf '%s' "$dev_out" | grep -q 'SCHEMA-ONLY restore' && printf '%s' "$dev_out" | grep -q 'dev-reset'; then
  ok "the dev refusal NAMES the schema-only restore and the job that seeds the database"
else
  fail "the dev refusal does not name the schema-only restore and the dev-reset job - the reader is left to find them"
fi
if printf '%s' "$dev_out" | grep -qi 'from production'; then
  fail "the dev refusal still sends the reader to a copy of production"
else
  ok "and it sends nobody to a copy of production's data"
fi

prod_out="$(run_without_schema prod </dev/null 2>&1)"
if printf '%s' "$prod_out" | grep -qi 'restore a backup'; then
  ok "the production refusal says the schema is GONE and to restore a backup"
else
  fail "production and dev get the same remedy, and only one of them may be rebuilt from a seed"
fi

if printf '%s' "$prod_out" | grep -q 'dev-reset'; then
  fail "the production refusal points at the DEV reset job - a reader could empty the wrong estate"
else
  ok "and it does not point production at a dev-only remedy"
fi

printf '\na migration the owner must approve is HELD until a committed line approves its content\n'

# WHY THIS SECTION EXISTS. Migrations 034, 038 and 042 were written as "owed the owner's yes" and
# reached production with the next release anyway, because this loop applies every unrecorded file
# and the yes was a sentence in the backlog (2026-11-01). The gate is exercised end to end through
# the real `apply_migrations`, never by grepping the library for its message.
HOLD="$TMP/hold"
HMIG="apps/core-service/src/migrations"
mkdir -p "$HOLD/$HMIG" "$HOLD/infrastructure"
printf 'ALTER TABLE t ADD COLUMN IF NOT EXISTS a int;\n' >"$HOLD/$HMIG/001_plain.sql"
printf -- '-- Migration 002: a backfill the owner must see.\n-- canari:hold-for-owner\nUPDATE t SET a = 1;\n' >"$HOLD/$HMIG/002_held.sql"
printf -- '-- dropping nothing in a comment: DROP TABLE t;\nALTER TABLE t DROP COLUMN IF EXISTS b;\n' >"$HOLD/$HMIG/003_drop.sql"
printf -- '-- the re-create idiom is not destructive\nALTER TABLE t DROP CONSTRAINT IF EXISTS c;\nSELECT 1;\n' >"$HOLD/$HMIG/004_plain.sql"
held_sum="$(sha256sum "$HOLD/$HMIG/002_held.sql" | cut -d' ' -f1)"
drop_sum="$(sha256sum "$HOLD/$HMIG/003_drop.sql" | cut -d' ' -f1)"

# $1: the approvals file's content; $2: the filenames the ledger already records, one per line.
run_hold() {
  (
    cd "$HOLD" || exit 1
    printf '%s' "$1" >infrastructure/migration-approvals.txt
    LEDGER_ROWS="$2"
    # shellcheck disable=SC2034 # read by the `eval`ed gate, which names the estate in its refusal
    ENVIRONMENT=prod
    # shellcheck disable=SC2317,SC2329 # called only from `eval`ed code, so the body looks unreachable and the definition looks unused (SC2329 exists from shellcheck 0.11; CI pins 0.10)
    psql() {
      local args="$*" name
      cat >/dev/null 2>&1 || true
      case "$args" in
      *to_regclass*) printf 't\n' ;;
      *"SELECT filename FROM"*) [ -n "$LEDGER_ROWS" ] && printf '%s\n' "$LEDGER_ROWS" ;;
      *"SELECT checksum FROM"*)
        name="${args#*filename = \'}"
        name="${name%\'*}"
        grep -qxF "$name" <<<"$LEDGER_ROWS" && sha256sum "$name" | cut -d' ' -f1
        ;;
      esac
      return 0
    }
    eval "$sentinel_decl"
    eval "$ledger_decl"
    eval "$guard"
    eval "$hold_parts"
    eval "$fn"
    apply_migrations
  )
}

if [ -n "$(sed -n '/^require_owner_approvals() {/,/^}/p' "$SCRIPT")" ]; then
  ok "require_owner_approvals() is extractable from the real script"
else
  fail "require_owner_approvals() is not a function in infrastructure/lib/migrations.sh - nothing holds a migration for the owner"
fi

out="$(run_hold '' '' </dev/null 2>&1)"
rc=$?
if [ "$rc" -ne 0 ]; then
  ok "with no approval the deploy FAILS (exit $rc), it does not skip the held file and carry on"
else
  fail "with no approval the deploy succeeded - a held migration would reach production unread"
fi
if printf '%s\n' "$out" | grep -q '^::error::.*002_held\.sql is HELD.*hold marker'; then
  ok "the refusal is an ::error:: naming the marked file and why it is held"
else
  fail "no ::error:: names 002_held.sql and its marker"
fi
if printf '%s\n' "$out" | grep -q '^::error::.*003_drop\.sql is HELD.*DROP COLUMN'; then
  ok "an UNMARKED destructive statement is held too, and the statement is named"
else
  fail "003_drop.sql (DROP COLUMN, no marker) was not held"
fi
if printf '%s\n' "$out" | grep -qF "$HMIG/002_held.sql $held_sum"; then
  ok "the refusal prints the exact approval line, path and checksum"
else
  fail "the refusal does not print the approval line the owner would commit"
fi
if [ "$(printf '%s\n' "$out" | grep -c '^applying ')" = "0" ]; then
  ok "and NOTHING is applied, not even the plain files before the held one"
else
  fail "files were applied before the refusal: $(printf '%s\n' "$out" | grep '^applying ' | tr '\n' ' ')"
fi
if printf '%s\n' "$out" | grep -qE '00[14]_plain\.sql is HELD'; then
  fail "a plain migration (or a DROP CONSTRAINT IF EXISTS re-create, or a DROP in a comment) was held"
else
  ok "the plain files, the DROP CONSTRAINT IF EXISTS idiom and a DROP in a comment are not held"
fi

out="$(run_hold "$HMIG/002_held.sql $held_sum
$HMIG/003_drop.sql $drop_sum
" '' </dev/null 2>&1)"
rc=$?
applied_lines="$(printf '%s\n' "$out" | grep -c '^applying ')"
if [ "$rc" -eq 0 ] && [ "$applied_lines" = "4" ]; then
  ok "once both are approved for their content, all 4 files apply (plain ones exactly as before)"
else
  fail "approved held migrations did not apply (exit $rc, $applied_lines of 4 applied)"
fi
if printf '%s\n' "$out" | grep -q '002_held\.sql needs the owner.*APPROVED'; then
  ok "and the log says which approval let each one through"
else
  fail "an approved held migration applied without a line saying so"
fi

stale="0000000000000000000000000000000000000000000000000000000000000000"
out="$(run_hold "# a comment line
$HMIG/002_held.sql $stale
$HMIG/003_drop.sql $drop_sum
" '' </dev/null 2>&1)"
rc=$?
if [ "$rc" -ne 0 ] && printf '%s\n' "$out" | grep -q '002_held\.sql is HELD.*approves another version'; then
  ok "an approval of ANOTHER version of the file does not apply this one - an edit after approval re-holds it"
else
  fail "an approval with a stale checksum let the edited migration through (exit $rc)"
fi
if printf '%s\n' "$out" | grep -q '003_drop\.sql is HELD'; then
  fail "a correctly approved migration was held alongside the stale one"
else
  ok "and the other approval still holds - each file is judged on its own line"
fi

out="$(run_hold '' "$HMIG/002_held.sql
$HMIG/003_drop.sql" </dev/null 2>&1)"
rc=$?
applied_lines="$(printf '%s\n' "$out" | grep -c '^applying ')"
if [ "$rc" -eq 0 ] && [ "$applied_lines" = "2" ]; then
  ok "a held migration the ledger already records is history, not a request: the 2 others apply"
else
  fail "recorded held migrations blocked the deploy or were replayed (exit $rc, $applied_lines applied)"
fi

if [ -f "$REPO/infrastructure/migration-approvals.txt" ]; then
  ok "infrastructure/migration-approvals.txt is committed, so the place to approve is not a guess"
else
  fail "infrastructure/migration-approvals.txt is missing - the refusal names a file nobody can find"
fi

printf '\nboth callers run the loop, and the reset runs it BEFORE it truncates\n'

# THE SECOND CALLER IS WHY THE LOOP IS A LIBRARY. It was the copy of production into dev until
# 2026-10-16, which rolled a pre-release's schema back under its images (2026-09-28,
# `admittedAtEpoch does not exist`); it is the reset now, which brings an older schema forward after
# a schema-only restore. Order is asserted by line: the seed is written for the CURRENT entities, so
# a loop run after it would load the seed into the schema it was not written for.
for caller in "$DEPLOY" "$RESET"; do
  name="${caller#"$REPO"/}"
  if grep -qE '^[[:space:]]*\. .*lib/migrations\.sh"' "$caller"; then
    ok "$name sources the shared loop"
  else
    fail "$name does not source infrastructure/lib/migrations.sh"
  fi
  # Bare, never under `||` or `&&`: bash suspends errexit inside a function called that way, so a
  # failing file would be recorded in the ledger and the loop would carry on.
  if grep -qE '^[[:space:]]*apply_migrations[[:space:]]*$' "$caller"; then
    ok "$name calls apply_migrations bare, so errexit holds inside it"
  else
    fail "$name does not call apply_migrations on a line of its own"
  fi
done
migrate_line="$(grep -nE '^[[:space:]]*apply_migrations[[:space:]]*$' "$RESET" | sed -n 1p | cut -d: -f1)"
# shellcheck disable=SC2016 # the pattern is the script's literal text, variables unexpanded
seed_line="$(grep -nE 'cat "\$SEED_SQL"' "$RESET" | sed -n 1p | cut -d: -f1)"
if [ -n "$seed_line" ] && [ -n "$migrate_line" ] && [ "$migrate_line" -lt "$seed_line" ]; then
  ok "the reset migrates before it seeds (line $migrate_line < $seed_line)"
else
  fail "the reset does not migrate before the seed (migrate ${migrate_line:-?}, seed ${seed_line:-?})"
fi

printf '\n'
if [ "$FAIL" -gt 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
