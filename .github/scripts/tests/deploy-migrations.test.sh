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
# The owner's hold: its library (shared with the release preflight) and the gate `apply_migrations`
# calls before it applies anything, verbatim, loaded by every runner below.
HOLD_LIB="$REPO/infrastructure/lib/migration-hold.sh"
hold_parts=". \"$HOLD_LIB\"
$(sed -n '/^MIGRATIONS_APPROVED_HELD=/p; /^require_owner_approvals() {/,/^}/p' "$SCRIPT")"

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

printf '\nwhat holds a migration: the marker, or any statement that is not plainly additive\n'

# WHY THIS SECTION EXISTS. Migrations 034, 038 and 042 were written as "owed the owner's yes" and
# reached production with the next release anyway, because the loop applies every unrecorded file
# and the yes was a sentence in the backlog (2026-11-01). The FIRST version of this gate matched
# spellings (`DROP TABLE|COLUMN`) and its review listed what walked past it; every one of those is a
# row below, so a regression to a denylist fails here by name.
CLS="$TMP/classify"
mkdir -p "$CLS"
# classify <held|plain> <name> <sql, printf-escaped>
classify() {
  local want="$1" name="$2" got reason
  # shellcheck disable=SC2059 # the SQL is a printf format on purpose: it carries \n and \r escapes
  printf -- "$3" >"$CLS/$name.sql"
  # shellcheck source-path=SCRIPTDIR source=../../../infrastructure/lib/migration-hold.sh
  reason="$(. "$HOLD_LIB" && migration_hold_reason "$CLS/$name.sql")"
  if [ -n "$reason" ]; then got=held; else got=plain; fi
  if [ "$got" = "$want" ]; then
    ok "$want: $name${reason:+ - $reason}"
  else
    fail "$name is $got, expected $want${reason:+ ($reason)}"
  fi
}
classify plain additive 'ALTER TABLE t ADD COLUMN IF NOT EXISTS a int;\nCREATE INDEX IF NOT EXISTS i ON t (a);\n'
classify plain recreate-idiom 'ALTER TABLE t DROP CONSTRAINT IF EXISTS c;\nDROP INDEX IF EXISTS i;\nDROP TRIGGER IF EXISTS x ON t;\nALTER TABLE t ALTER COLUMN a DROP DEFAULT, ALTER COLUMN a DROP NOT NULL;\n'
classify plain commented-drop '-- DROP TABLE t;\n/* DROP TABLE u; /* nested */ still a comment: DROP COLUMN v */\nSELECT 1;\n'
classify plain trigger-execute 'CREATE TRIGGER x AFTER DELETE ON t FOR EACH ROW EXECUTE FUNCTION f();\nCREATE TRIGGER y AFTER INSERT ON t FOR EACH ROW EXECUTE PROCEDURE g();\nGRANT EXECUTE ON FUNCTION f() TO r;\n'
classify plain identifier-named-drop 'CREATE TRIGGER "TRG_posts_drop_x" AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();\n'
classify plain not-the-marker '-- canari:hold-for-owners is another word\nUPDATE t SET a = 1;\n'
classify held drop-without-a-noun 'ALTER TABLE t DROP foo;\n'
classify held drop-over-lines 'ALTER TABLE t\n  DROP\n  COLUMN\n  b;\n'
classify held drop-type-cascade 'DROP TYPE IF EXISTS e CASCADE;\n'
classify held drop-extension 'DROP EXTENSION x CASCADE;\n'
classify held drop-materialized-view 'DROP MATERIALIZED VIEW v;\n'
classify held drop-sequence 'DROP SEQUENCE s;\n'
classify held drop-owned 'DROP OWNED BY someone;\n'
classify held rename-column 'ALTER TABLE t RENAME COLUMN a TO b;\n'
classify held dashes-in-a-string "INSERT INTO t VALUES ('a -- b'); DROP TABLE x;\n"
classify held escaped-quote-in-a-string "SELECT E'it\\\\'s -- not a comment'; DROP TABLE z;\n"
classify held dynamic-sql "DO \$\$ BEGIN EXECUTE 'SELECT 1'; END \$\$;\n"
classify held alter-type 'ALTER TABLE t ALTER b TYPE text;\n'
classify held alter-set-data-type 'ALTER TABLE t ALTER COLUMN "b"\n  SET DATA TYPE text;\n'
classify held delete-from 'DELETE   FROM t WHERE a = 1;\n'
classify held truncate 'TRUNCATE t;\n'
classify held unterminated-string "SELECT 'abc;\n"
classify held marker-any-case-trailing-text-crlf '-- Canari:Hold-For-Owner: the backfill of 2026-11-02\r\nUPDATE t SET a = 1;\r\n'
classify held marker-indented-no-space '  --canari:hold-for-owner\nUPDATE t SET a = 1;\n'

# THE SECOND REVIEW (2026-11-01) walked past the allowlist by naming a column after one of its forms:
# the forms were matched as string PREFIXES and the word class had no digit. Each verified bypass is
# a row, matched on whole tokens now.
classify held column-named-like-index 'ALTER TABLE users DROP indexed_at;\n'
classify held column-named-like-default 'ALTER TABLE users DROP default_role;\n'
classify held columns-named-like-trigger-and-constraint 'ALTER TABLE users DROP trigger_count, DROP constraint_note;\n'
classify held column-with-a-digit 'ALTER TABLE users DROP index2;\n'
classify held dynamic-sql-from-a-variable-named-on 'DO $$ DECLARE on_cmd text; BEGIN SELECT cmd INTO on_cmd FROM pending_ddl LIMIT 1; EXECUTE on_cmd; END $$;\n'
classify held column-named-index 'ALTER TABLE users DROP index;\n'
classify held column-named-index-cascade 'ALTER TABLE users DROP index CASCADE;\n'
classify held dynamic-sql-from-a-variable-named-function 'DO $$ DECLARE function text; BEGIN EXECUTE function USING 1; END $$;\n'
classify plain drop-index-concurrently 'DROP INDEX CONCURRENTLY IF EXISTS public.i;\nGRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA s TO r;\nCREATE TRIGGER x AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION public.f();\n'

# DOLLAR QUOTES: the outer lexer closes `$x$` wherever it stands, a `--` inside included. The first
# lexer read that `--` as a comment and stripped the DROP after the closing tag.
# shellcheck disable=SC2016 # the dollar quotes are SQL, kept literal on purpose
{
  classify held dashes-in-a-dollar-literal 'SELECT $x$ -- $x$; DROP TABLE users;\n'
  classify held block-comment-in-a-dollar-literal 'SELECT $$ /* $$; DROP TABLE users; -- */\n'
  classify held drop-glued-to-a-dollar-tag 'DO $x$BEGIN DROP TABLE users; END$x$;\n'
  classify held drop-in-a-dollar-body-over-lines 'DO $body$\nBEGIN\n  DROP TABLE users;\nEND\n$body$;\n'
  classify held unterminated-dollar-quote 'DO $$ BEGIN PERFORM 1;\n'
  classify plain dollar-body-additive 'DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = $q$e$q$) THEN CREATE TYPE e AS ENUM ($q$a$q$); END IF; END $$;\n'
  classify plain dollar-sign-in-an-identifier 'ALTER TABLE t ADD COLUMN IF NOT EXISTS a$b$ int;\n'
}

# A DOUBLE QUOTE INSIDE A STRING opened a quoted identifier in the token pass and swallowed every
# statement after it (final review of #2873): both were plain, applied without approval or backup.
classify held double-quote-in-a-comment-string 'COMMENT ON COLUMN t.size IS '"'"'screen size in inches, e.g. 6.1"'"'"';\nALTER TABLE users DROP COLUMN email;\n'
classify held double-quotes-in-two-strings 'SELECT '"'"'x"'"'"'; DROP TABLE users; SELECT '"'"'"'"'"';\n'
classify held double-quote-in-a-dollar-body 'DO $$ BEGIN RAISE NOTICE '"'"'6.1"'"'"'; END $$;\nDROP TABLE users;\n'
classify plain backslash-and-quote-in-strings 'COMMENT ON COLUMN t.a IS E'"'"'a \\\\ b "'"'"';\nALTER TABLE t ADD COLUMN IF NOT EXISTS "b" int;\n'

# THE DEPLOY PIPES EACH FILE INTO psql, which runs its own meta-commands (`\gexec` executes every
# row a query returns as SQL; `\!` runs a shell command). No reader can judge either: held. And
# MERGE (PostgreSQL 15+) deletes through `WHEN MATCHED THEN DELETE`.
classify held psql-gexec 'SELECT format('"'"'DROP TABLE %%I'"'"', tablename) FROM pg_tables WHERE false\n\\gexec\n'
classify held psql-shell '\\! rm -rf /tmp/x\nSELECT 1;\n'
classify held merge 'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE;\n'

# A BYTE-ORDER MARK before `--` hid the marker from the line match: held now, wherever it stands.
classify held bom-before-the-marker '\357\273\277-- canari:hold-for-owner\nUPDATE t SET a = 1;\n'
classify held bom-alone '\357\273\277ALTER TABLE t ADD COLUMN IF NOT EXISTS a int;\n'

# A MARKER IS READ ON A LARGE FILE TOO. The first version piped `tr | grep -q`, and under pipefail
# grep's early exit SIGPIPE'd tr on anything above ~64 KB: 30 misses in 30 on Linux. One MB, the
# marker on the LAST line, so the whole file is read.
big="$CLS/large.sql"
awk 'BEGIN { for (i = 0; i < 20000; i++) printf "INSERT INTO t (a) VALUES (%d); -- padding padding padding\n", i }' >"$big"
printf -- '-- canari:hold-for-owner\n' >>"$big"
size="$(wc -c <"$big" | tr -d ' ')"
for attempt in 1 2 3; do
  # shellcheck source-path=SCRIPTDIR source=../../../infrastructure/lib/migration-hold.sh
  reason="$(. "$HOLD_LIB" && migration_hold_reason "$big")"
  if [ "$reason" = 'it carries the hold marker' ]; then
    ok "a $size-byte file with the marker on its last line is held (attempt $attempt)"
  else
    fail "a $size-byte marked file was not held on attempt $attempt (got: ${reason:-nothing})"
  fi
done

printf '\na held migration is REFUSED until a committed line approves its content, and a backup precedes it\n'

HOLD="$TMP/hold"
HMIG="apps/core-service/src/migrations"
mkdir -p "$HOLD/$HMIG" "$HOLD/infrastructure"
printf 'ALTER TABLE t ADD COLUMN IF NOT EXISTS a int;\n' >"$HOLD/$HMIG/001_plain.sql"
printf -- '-- Migration 002: a backfill the owner must see.\n-- canari:hold-for-owner\nUPDATE t SET a = 1;\n' >"$HOLD/$HMIG/002_held.sql"
printf -- '-- dropping nothing in a comment: DROP TABLE t;\nALTER TABLE t DROP COLUMN IF EXISTS b;\n' >"$HOLD/$HMIG/003_drop.sql"
printf -- '-- a real commented DROP, in a file nothing else holds: DROP TABLE t;\nALTER TABLE t DROP CONSTRAINT IF EXISTS c;\nSELECT 1;\n' >"$HOLD/$HMIG/004_plain.sql"
held_sum="$(sha256sum "$HOLD/$HMIG/002_held.sql" | cut -d' ' -f1)"
drop_sum="$(sha256sum "$HOLD/$HMIG/003_drop.sql" | cut -d' ' -f1)"
HELD_SUM_UPPER="$(printf '%s' "$held_sum" | tr '[:lower:]' '[:upper:]')"
# The deploy's backup hook, as it ships, and the directory the stub crontab names for it.
deploy_backup="$(sed -n '/^migration_backup() {/,/^}/p' "$DEPLOY")"
BACKUPS="$TMP/backups"
export POSTGRES_USER=canari

# run_hold <approvals file content> <ledger filenames>   (BACKUP=ok|fail|none, CRON=ok|none, LEDGER=ok|fail)
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
      *"SELECT filename FROM"*)
        [ "${LEDGER:-ok}" = fail ] && return 2
        [ -n "$LEDGER_ROWS" ] && printf '%s\n' "$LEDGER_ROWS"
        ;;
      *"SELECT checksum FROM"*)
        name="${args#*filename = \'}"
        name="${name%\'*}"
        grep -qxF "$name" <<<"$LEDGER_ROWS" && sha256sum "$name" | cut -d' ' -f1
        ;;
      esac
      return 0
    }
    # THE DEPLOY'S OWN `migration_backup`, verbatim, over the real dump library - not a stub (review
    # of #2873: the stub this replaced hid that the real one wrote to a directory the host does not
    # have). Stubbed are only what a laptop lacks: the account's crontab, which names the backup
    # directory (CRON=ok|none), and the compose command `dc`, whose pg_dump answers or fails.
    if [ "${BACKUP:-ok}" != none ]; then
      # shellcheck disable=SC2034 # read by the deploy's migration_backup, eval'ed below
      PROJECT=canari-prod
      # shellcheck disable=SC2317,SC2329 # called only from `eval`ed code
      crontab() {
        [ "${CRON:-ok}" = ok ] && printf 'MAILTO=""\nBACKUP_DIR=%s\n30 3 * * * backup.sh\n' "$BACKUPS"
        [ "${CRON:-ok}" = ok ] || printf 'MAILTO=""\n'
      }
      # shellcheck disable=SC2317,SC2329 # called through dump_auth_db's "$@"
      dc() {
        [ "${BACKUP:-ok}" = ok ] || return 1
        printf 'CREATE TABLE t (a int);\n'
      }
      # shellcheck source-path=SCRIPTDIR source=../../../infrastructure/backup/dump-auth-db.sh
      . "$REPO/infrastructure/backup/dump-auth-db.sh"
      eval "$deploy_backup"
    fi
    eval "$sentinel_decl"
    eval "$ledger_decl"
    eval "$guard"
    eval "$hold_parts"
    eval "$fn"
    apply_migrations
  )
}
# shellcheck disable=SC2031 # `out` is set by the caller's own assignment; the subshell writes are the sourced dump library's locals
applied_list() { printf '%s\n' "$out" | sed -n 's/^applying //p' | tr '\n' ' '; }

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
if printf '%s\n' "$out" | grep -q 'cuts a NEW pre-release tag' && ! printf '%s\n' "$out" | grep -qi 're-runs this deploy'; then
  ok "the remedy is a NEW pre-release tag - a rerun re-reads the release's own commit, which carries no approval"
else
  fail "the remedy does not send the owner to a new pre-release tag"
fi
if printf '%s\n' "$out" | grep -q '^owner hold: 4 unrecorded file(s) examined, 2 held, 0 approved, 2 refused$'; then
  ok "the decision is logged: 4 examined, 2 held, 2 refused"
else
  fail "no decision line counts what the gate examined and held"
fi
if [ -z "$(applied_list)" ] && ! printf '%s\n' "$out" | grep -q '^backup taken before' && [ ! -e "$BACKUPS" ]; then
  ok "and NOTHING is applied or backed up, not even the plain files before the held one"
else
  fail "files were touched before the refusal: $(applied_list)"
fi
if printf '%s\n' "$out" | grep -qE '00[14]_plain\.sql is HELD'; then
  fail "a plain migration (or the re-create idiom, or a DROP in a comment) was held"
else
  ok "the plain files, the DROP CONSTRAINT IF EXISTS idiom and a real commented DROP are not held"
fi

# Approved for their content - one sum in upper case, which is still the same sum.
out="$(run_hold "$HMIG/002_held.sql $HELD_SUM_UPPER
$HMIG/003_drop.sql $drop_sum
" '' </dev/null 2>&1)"
rc=$?
if [ "$rc" -eq 0 ] && [ "$(applied_list)" = "$HMIG/001_plain.sql $HMIG/002_held.sql $HMIG/003_drop.sql $HMIG/004_plain.sql " ]; then
  ok "once both are approved for their content (one sum in upper case), all 4 files apply, plain ones as before"
else
  fail "approved held migrations did not apply (exit $rc, applied: $(applied_list))"
fi
order="$(printf '%s\n' "$out" | grep -E '^(backup taken before|applying) ' | sed 's/^\(backup taken before [^:]*\):.*/\1/' | tr '\n' '|')"
want="applying $HMIG/001_plain.sql|backup taken before $HMIG/002_held.sql|applying $HMIG/002_held.sql|backup taken before $HMIG/003_drop.sql|applying $HMIG/003_drop.sql|applying $HMIG/004_plain.sql|"
if [ "$order" = "$want" ]; then
  ok "a backup is taken RIGHT BEFORE each approved held file, and only before those"
else
  fail "the backups are not right before the approved files: $order"
fi
if printf '%s\n' "$out" | grep -q '002_held\.sql is held because.*APPROVED'; then
  ok "and the log says which approval let each one through"
else
  fail "an approved held migration applied without a line saying so"
fi
dumps="$(find "$BACKUPS/pre-migration" -type f -name 'canari-prod-*Z-00[23]_*.sql.gz' 2>/dev/null | sort)"
# shellcheck disable=SC2086 # two paths with no space, split on purpose
if [ "$(grep -c . <<<"$dumps")" = 2 ] && [ "$(gzip -dc $dumps | sort -u)" = 'CREATE TABLE t (a int);' ]; then
  ok "the REAL deploy hook wrote 2 whole dumps into pre-migration/ under the directory the crontab names"
else
  fail "the deploy's migration_backup did not write its dumps where the crontab says: $(find "$BACKUPS" -type f 2>/dev/null)"
fi
rm -rf "$BACKUPS"

out="$(BACKUP=fail run_hold "$HMIG/002_held.sql $held_sum
$HMIG/003_drop.sql $drop_sum
" '' </dev/null 2>&1)"
rc=$?
if [ "$rc" -ne 0 ] && [ "$(applied_list)" = "$HMIG/001_plain.sql " ] && printf '%s\n' "$out" | grep -q '^::error::the backup before .*002_held\.sql failed'; then
  ok "a FAILED backup refuses the approved file and everything after it (only the plain 001 ran)"
else
  fail "a failed backup did not stop the approved migration (exit $rc, applied: $(applied_list))"
fi
if [ -z "$(find "$BACKUPS" -type f 2>/dev/null)" ]; then
  ok "and the failed dump leaves no partial file behind"
else
  fail "a failed dump left a file that looks like a restore point: $(find "$BACKUPS" -type f)"
fi
rm -rf "$BACKUPS"

out="$(CRON=none run_hold "$HMIG/002_held.sql $held_sum
$HMIG/003_drop.sql $drop_sum
" '' </dev/null 2>&1)"
rc=$?
if [ "$rc" -ne 0 ] && [ "$(applied_list)" = "$HMIG/001_plain.sql " ] && printf '%s\n' "$out" | grep -q '^::error::the crontab of this account .* has no BACKUP_DIR= line' && [ ! -e "$BACKUPS" ]; then
  ok "a crontab that names NO backup directory refuses the approved file - no default directory is guessed"
else
  fail "the backup ran without a named directory, or did not refuse (exit $rc, applied: $(applied_list)): $out"
fi

out="$(BACKUP=none run_hold "$HMIG/002_held.sql $held_sum
$HMIG/003_drop.sql $drop_sum
" '' </dev/null 2>&1)"
rc=$?
if [ "$rc" -ne 0 ] && [ -z "$(applied_list)" ] && printf '%s\n' "$out" | grep -q 'defines no migration_backup'; then
  ok "a caller that cannot take a backup applies NO approved held file - and nothing else"
else
  fail "an approved held file was applicable without a backup route (exit $rc, applied: $(applied_list))"
fi

stale="0000000000000000000000000000000000000000000000000000000000000000"
out="$(run_hold "# a comment line
$HMIG/002_held.sql $stale
$HMIG/003_drop.sql $drop_sum
" '' </dev/null 2>&1)"
rc=$?
if [ "$rc" -ne 0 ] && printf '%s\n' "$out" | grep -q '002_held\.sql is HELD.*approves another content'; then
  ok "an approval of ANOTHER content of the file does not apply this one - an edit after approval re-holds it"
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
if [ "$rc" -eq 0 ] && [ "$(applied_list)" = "$HMIG/001_plain.sql $HMIG/004_plain.sql " ]; then
  ok "a held migration the ledger already records is history, not a request: the 2 others apply"
else
  fail "recorded held migrations blocked the deploy or were replayed (exit $rc, applied: $(applied_list))"
fi

out="$(LEDGER=fail run_hold '' '' </dev/null 2>&1)"
rc=$?
if [ "$rc" -ne 0 ] && [ -z "$(applied_list)" ] && printf '%s\n' "$out" | grep -q '^::error::the schema_migrations ledger .* could not be read'; then
  ok "an UNREADABLE ledger is refused with an accusing line, never read as empty"
else
  fail "an unreadable ledger was not refused as one (exit $rc, applied: $(applied_list))"
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

printf '\nthe backup before an approved migration is the nightly backup'"'"'s own dump\n'

# ONE RECIPE, TWO TAKERS. The owner's rule wants a backup right before an approved held migration;
# a second pg_dump recipe in the deploy would be a backup a restore has never read. So the deploy's
# `migration_backup` and `backup.sh` both call `dump_auth_db`, which is exercised here against a
# compose stub: a whole dump passes, a failed pg_dump and a truncated stream are refused.
DUMP_LIB="$REPO/infrastructure/backup/dump-auth-db.sh"
dump_with() { # <ok|fail|truncated> <out>
  (
    # shellcheck disable=SC2317,SC2329 # called through dump_auth_db's "$@"
    stub_compose() {
      case "$MODE" in
      ok) printf 'CREATE TABLE t (a int);\n' ;;
      fail) return 1 ;;
      esac
    }
    MODE="$1"
    # shellcheck disable=SC2034 # read by dump_auth_db, sourced below
    POSTGRES_USER=canari
    # shellcheck source-path=SCRIPTDIR source=../../../infrastructure/backup/dump-auth-db.sh
    . "$DUMP_LIB"
    dump_auth_db "$2" stub_compose
    rc=$?
    # A truncated stream: a gzip whose tail is gone, as a killed pipe leaves it.
    if [ "$MODE" = truncated ]; then
      printf 'CREATE TABLE t (a int);\n%.0s' {1..200} | gzip | head -c 40 >"$2"
      gzip -t "$2" 2>/dev/null
      return $?
    fi
    return "$rc"
  )
}
if dump_with ok "$TMP/ok.sql.gz" && [ "$(gzip -dc "$TMP/ok.sql.gz")" = 'CREATE TABLE t (a int);' ]; then
  ok "dump_auth_db writes a whole, readable dump"
else
  fail "dump_auth_db did not write the dump it was given"
fi
if dump_with fail "$TMP/fail.sql.gz"; then
  fail "a failed pg_dump was reported as a backup"
elif [ -e "$TMP/fail.sql.gz" ]; then
  fail "a failed pg_dump left a partial file beside the real dumps"
else
  ok "a failed pg_dump is a failed backup, and it leaves no file that looks like one"
fi
if dump_with truncated "$TMP/cut.sql.gz"; then
  fail "a truncated dump stream passed gzip -t"
else
  ok "a truncated stream is caught by the same gzip -t the dump runs"
fi
# shellcheck disable=SC2016 # the patterns are the scripts' literal text
if grep -qE '^[[:space:]]*pre_migration_backup "\$1" "\$PROJECT" dc$' "$DEPLOY" && grep -qE '^migration_backup\(\) \{' "$DEPLOY" &&
  grep -qE '^[[:space:]]*if ! dump_auth_db "\$out" "\$@"; then' "$DUMP_LIB"; then
  ok "the deploy defines migration_backup, and it takes the dump through pre_migration_backup and dump_auth_db"
else
  fail "the deploy takes no backup through dump_auth_db before an approved migration"
fi
# shellcheck disable=SC2016 # the pattern is the script's literal text
if grep -qE '^dump_auth_db "\$STAGE/postgres_auth_db\.sql\.gz"' "$REPO/infrastructure/backup/backup.sh"; then
  ok "the nightly backup takes its database member through the same dump_auth_db"
else
  fail "backup.sh does not use dump_auth_db - two dump recipes can drift"
fi
if grep -qE '^[[:space:]]*migration_backup\(\)' "$RESET"; then
  fail "the dev reset defines a migration_backup - it truncates dev, so it must never be the one to apply an approved held migration"
else
  ok "the dev reset defines no migration_backup, so an approved held migration is applied by a deploy, never by a reset"
fi

printf '\n'
if [ "$FAIL" -gt 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
