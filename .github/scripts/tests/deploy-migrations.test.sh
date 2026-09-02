#!/usr/bin/env bash
# Does `deploy-environment.sh` apply EVERY migration, and does it refuse a database the migrations
# cannot possibly build?
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

SCRIPT="$(cd "$(dirname "$0")/../../.." && pwd)/infrastructure/deploy/deploy-environment.sh"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
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
  fail "apply_migrations() is not a function in deploy-environment.sh - it cannot be exercised at all"
  printf '\n%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
ok "apply_migrations() is extractable from the real script"

guard="$(sed -n '/^require_orm_schema() {/,/^}/p' "$SCRIPT")"
sentinel_decl="$(sed -n '/^readonly ORM_SENTINEL_TABLE=/p' "$SCRIPT")"
SENTINEL="$(printf '%s' "$sentinel_decl" | sed "s/^readonly ORM_SENTINEL_TABLE='//; s/'$//")"

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
    eval "$guard"
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
  fail "require_orm_schema() is not a function in deploy-environment.sh - nothing states the migrations' precondition"
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
    eval "$guard"
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

if printf '%s' "$dev_out" | grep -q 'Refresh dev.canari-emse.fr from production'; then
  ok "the dev refusal NAMES the workflow that seeds the database"
else
  fail "the dev refusal does not name the seeding workflow - the reader is left to find it"
fi

prod_out="$(run_without_schema prod </dev/null 2>&1)"
if printf '%s' "$prod_out" | grep -qi 'restore a backup'; then
  ok "the production refusal says the schema is GONE and to restore a backup"
else
  fail "production and dev get the same remedy, and only one of them has anything to copy from"
fi

if printf '%s' "$prod_out" | grep -q 'Refresh dev.canari-emse.fr'; then
  fail "the production refusal points at the DEV refresh workflow - it would copy production onto itself in the reader's mind"
else
  ok "and it does not point production at a dev-only remedy"
fi

printf '\n'
if [ "$FAIL" -gt 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
