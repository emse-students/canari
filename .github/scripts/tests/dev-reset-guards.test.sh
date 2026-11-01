#!/usr/bin/env bash
#
# Asserts the guards on `infrastructure/dev/reset-dev-to-seed.sh` - the script that EMPTIES the dev
# estate and loads the fictional seed - and that the production copy it replaced is gone for good.
#
# WHY THIS EXISTS. The script truncates every table of a database and flushes a Redis, on a machine
# that also runs production. What protects production is not that it is careful but that it CANNOT
# be aimed elsewhere: one target project, a readonly literal; every write through one function per
# datastore that re-reads the container's compose label; a dry run that changes nothing. Those are
# properties of the text AND of the behaviour, so both are asserted - the second by running the real
# script against a stub `docker` that records every call and answers like the estate would.
#
# AND THE COPY MUST STAY DELETED (owner, 2026-10-16, GDPR). Nothing may restore production's rows
# into dev again: not the old script, not a flag, not a workflow step that dumps `canari-prod`.
#
# Run by `make test-ci-scripts` and by CI.

set -euo pipefail

cd "$(dirname "$0")/../../.."

readonly SCRIPT=infrastructure/dev/reset-dev-to-seed.sh
readonly SEED=infrastructure/dev/seed.sql
readonly SCHEDULED=.github/workflows/scheduled.yml

failures=0
checks=0
fail() {
  printf '  FAIL  %s\n' "$1"
  failures=$((failures + 1))
}
ok() {
  printf '  ok   %s\n' "$1"
  checks=$((checks + 1))
}

# A script's executable lines: comments and blanks removed. The header EXPLAINS the deleted copy
# and names `pg_dump`; a check that cannot tell an invocation from an explanation punishes the
# explanation.
code_lines() {
  grep -vE '^[[:space:]]*#' "$1" | grep -vE '^[[:space:]]*$'
}

# The body of shell function "$2" in file "$1".
fn_body() {
  awk -v name="$2" '$0 ~ "^" name "\\(\\) \\{" { on = 1 } on { print } on && /^}/ { exit }' "$1"
}

printf 'Guards on %s\n' "$SCRIPT"
if [ ! -f "$SCRIPT" ] || [ ! -f "$SEED" ]; then
  fail "$SCRIPT or $SEED is missing"
  printf '\nFAILED\n'
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# 1. One target, and no way to name another
# ─────────────────────────────────────────────────────────────────────────────
printf '\nthe target is fixed:\n'

dev_project=$(awk -F'"' '/^readonly DEV_PROJECT=/ { print $2; exit }' "$SCRIPT")
if [ "$dev_project" = "canari-dev" ]; then
  ok "the one writable project is a readonly literal ($dev_project)"
else
  fail "DEV_PROJECT must be 'readonly DEV_PROJECT=\"canari-dev\"' (found '${dev_project}')"
fi

if code_lines "$SCRIPT" | grep -E 'canari-prod|PROD_|infrastructure-postgres' >/dev/null; then
  fail "the reset names a production project or container - it has no business knowing one"
else
  ok "no production project, container or variable appears in the code"
fi

if code_lines "$SCRIPT" | grep -E '(^|[^-[:alnum:]_])(pg_dump|pg_restore|ssh|scp)([[:space:]]|$)' >/dev/null; then
  fail "the reset INVOKES pg_dump, pg_restore, ssh or scp - it must read nothing from anywhere"
else
  ok "it invokes no dump, restore or remote copy"
fi

# Every `docker exec` lives in one of the four routes, and each route re-reads the label.
outside=$(awk '
  /^(dev_psql|dev_psql_ro|dev_redis|dev_redis_ro)\(\) \{/ { inside = 1 }
  inside && /^}/ { inside = 0; next }
  !inside && /docker exec/ && !/^[[:space:]]*#/ { print NR": "$0 }
' "$SCRIPT")
if [ -z "$outside" ]; then
  ok "every docker exec goes through dev_psql, dev_psql_ro, dev_redis or dev_redis_ro"
else
  fail "a docker exec outside the guarded routes: $outside"
fi
for route in dev_psql dev_psql_ro dev_redis dev_redis_ro; do
  if fn_body "$SCRIPT" "$route" | grep 'require_dev' >/dev/null; then
    ok "$route() re-checks the target's project label per call"
  else
    fail "$route() does not call require_dev"
  fi
done
if fn_body "$SCRIPT" require_dev | grep 'project_of' >/dev/null; then
  ok "require_dev() reads the label Docker reports, not a name"
else
  fail "require_dev() does not read the compose project label"
fi
for route in dev_psql dev_redis; do
  if fn_body "$SCRIPT" "$route" | grep 'DRY_RUN' >/dev/null; then
    ok "$route() honours --dry-run"
  else
    fail "$route() ignores --dry-run, so the dry run is not dry"
  fi
done

# ─────────────────────────────────────────────────────────────────────────────
# 2. What it empties is derived, and the ledger is the one exception
# ─────────────────────────────────────────────────────────────────────────────
printf '\nthe truncate reaches every table but the ledger, by derivation:\n'

if code_lines "$SCRIPT" | grep 'FROM pg_tables WHERE schemaname = .public.' >/dev/null; then
  ok "the table list is read from the catalogue, never typed"
else
  fail "the truncate does not derive its table list from pg_tables"
fi
if code_lines "$SCRIPT" | grep 'schema_migrations' >/dev/null; then
  fail "the ledger's name is typed in the reset - it must come from infrastructure/lib/migrations.sh"
else
  ok "the ledger's name is read from infrastructure/lib/migrations.sh"
fi
if grep -q "^readonly MIGRATION_LEDGER_TABLE='schema_migrations'" infrastructure/lib/migrations.sh; then
  ok "infrastructure/lib/migrations.sh declares the ledger once"
else
  fail "infrastructure/lib/migrations.sh does not declare MIGRATION_LEDGER_TABLE"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. The copy is gone, and nothing calls it
# ─────────────────────────────────────────────────────────────────────────────
printf '\nthe production copy stays deleted:\n'

if [ -e infrastructure/dev/copy-prod-to-dev.sh ]; then
  fail "infrastructure/dev/copy-prod-to-dev.sh exists again - production rows must never be restored into dev"
else
  ok "infrastructure/dev/copy-prod-to-dev.sh is gone"
fi
# Executable lines only: the reset's header and the wiki-facing comments EXPLAIN the deletion.
callers=$(grep -rnE 'copy-prod-to-dev' .github/workflows infrastructure --include='*.yml' --include='*.sh' 2>/dev/null |
  grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)
if [ -n "$callers" ]; then
  fail "a workflow or script still invokes copy-prod-to-dev: $(printf '%s' "$callers" | cut -d: -f1,2 | tr '\n' ' ')"
else
  ok "no workflow or infrastructure script invokes it"
fi
# A dev job that dumps production would be the copy rebuilt under another name.
if awk '/^  dev-reset:/,/^  [a-z-]+:$/ { if ($0 !~ /^  dev-reset:/ && $0 ~ /^  [a-z-]+:$/) exit; print }' "$SCHEDULED" |
  grep -vE '^[[:space:]]*#' | grep -E 'pg_dump|canari-prod' >/dev/null; then
  fail "the dev-reset job reads production"
else
  ok "the dev-reset job reads nothing from production"
fi

job=$(awk '/^  dev-reset:/ { on = 1; print; next } on && /^  [a-z][a-z0-9-]*:$/ { exit } on { print }' "$SCHEDULED")
if printf '%s' "$job" | grep -q 'bash infrastructure/dev/reset-dev-to-seed.sh --dry-run' &&
  printf '%s' "$job" | grep -qE 'bash infrastructure/dev/reset-dev-to-seed.sh$'; then
  ok "scheduled.yml's dev-reset job runs the reset, and passes --dry-run when asked"
else
  fail "scheduled.yml's dev-reset job does not run reset-dev-to-seed.sh with and without --dry-run"
fi
if printf '%s' "$job" | grep -q 'if: inputs.dry_run != true'; then
  ok "the 'estate answers' gate is skipped on a dry run, which proves nothing about the estate"
else
  fail "the dev-reset job asserts the estate answers even after a dry run"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. Behaviour, against a stub docker
# ─────────────────────────────────────────────────────────────────────────────
# The stub answers like the dev estate: two datastores and one application container in project
# `$STUB_PROJECT`, a schema present, and counts that verify. It records every call, and keeps the
# stream of the one --single-transaction call, so the assertions read what the script DID.
printf '\nthe script behaves as it claims, against a stub docker:\n'

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
seed_users=$(sed -n 's/^-- seed-users: //p' "$SEED")
cat >"$TMP/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$STUB_LOG"
case "$1" in
ps)
  args="$*"
  case "$args" in
  *service=postgres*) echo stub-pg ;;
  *service=redis*) echo stub-redis ;;
  *) printf 'stub-pg\tpostgres\nstub-redis\tredis\nstub-app\tcore-service\n' ;;
  esac
  ;;
inspect)
  case "$*" in
  *Labels*) echo "$STUB_PROJECT" ;;
  *Env*) echo "POSTGRES_USER=canari" ;;
  esac
  ;;
exec)
  args="$*"
  case "$args" in
  *--single-transaction*) cat >"$STUB_STREAM" ;;
  *) [ -t 0 ] || cat >/dev/null ;;
  esac
  case "$args" in
  *to_regclass*) echo t ;;
  *DBSIZE*) echo 0 ;;
  *'"lastName" IS DISTINCT FROM'*) echo 0 ;;
  *'count(*) FROM users;'*) echo "$STUB_USERS" ;;
  *'count(*) FROM push_token'*) echo 0 ;;
  *string_agg*) echo "" ;;
  *'SELECT filename FROM'*) [ -n "$STUB_LEDGER" ] && printf '%s\n' "$STUB_LEDGER" ;;
  *'SELECT checksum FROM'*) echo "" ;;
  *'SELECT'*'(SELECT count(*)'*) echo 0 ;;
  esac
  ;;
esac
exit 0
STUB
chmod +x "$TMP/bin/docker"

# The ledger the owner's hold reads: every migration file of the tree, as on a dev estate whose
# schema-only restore carried production's ledger - so the historic DROP COLUMN files are history,
# not requests, and this test stays about the reset's ORDER. The hold itself is
# deploy-migrations.test.sh's subject. The per-file checksum query still answers nothing, so the
# loop applies (and records) every file, which is what the order assertion below reads.
stub_ledger="$(find apps/*/src/migrations -name '*.sql' | sort)"

run_stubbed() {
  STUB_LEDGER="$stub_ledger" STUB_LOG="$TMP/$1.log" STUB_STREAM="$TMP/$1.stream" STUB_PROJECT="$2" STUB_USERS="$seed_users" \
    PATH="$TMP/bin:$PATH" bash "$SCRIPT" "${@:3}" </dev/null >"$TMP/$1.out" 2>&1
}

if run_stubbed dry canari-dev --dry-run; then
  ok "a dry run exits 0"
else
  fail "a dry run failed: $(tail -3 "$TMP/dry.out")"
fi
# The write route runs `psql -v ...`; the read route runs `psql -X -v ...`. So any exec of the first
# shape, any stop or start, any Redis write, or any stream at all is the dry run writing.
writes='^(stop|start) |FLUSHALL|BGREWRITEAOF|^exec -i stub-pg psql -v '
if grep -qE "$writes" "$TMP/dry.log" || [ -s "$TMP/dry.stream" ]; then
  fail "the dry run stopped a service or wrote to a datastore: $(grep -E "$writes" "$TMP/dry.log" | sed -n 1,3p | tr '\n' ' ')"
else
  ok "the dry run stops nothing, flushes nothing and streams nothing"
fi
if grep -q 'nothing was changed' "$TMP/dry.out"; then
  ok "and it says so"
else
  fail "the dry run does not say it changed nothing"
fi

if run_stubbed wrong canari-prod --dry-run; then
  fail "the script ran against a container labelled canari-prod"
else
  if grep -q "not 'canari-dev' - refusing" "$TMP/wrong.out" && ! grep -qE '^exec ' "$TMP/wrong.log"; then
    ok "a container labelled with another project is refused before a single exec"
  else
    fail "the refusal of a foreign label is not the label check, or came after an exec"
  fi
fi

if run_stubbed real canari-dev; then
  ok "a real run against an estate that verifies exits 0"
else
  fail "a real run failed: $(tail -3 "$TMP/real.out")"
fi
line_of() { grep -nE "$1" "$TMP/real.log" | sed -n 1p | cut -d: -f1; }
stop_at=$(line_of '^stop ')
ledger_at=$(grep -nE 'INSERT INTO schema_migrations' "$TMP/real.log" | tail -1 | cut -d: -f1)
reset_at=$(grep -nF -e '--single-transaction' "$TMP/real.log" | sed -n 1p | cut -d: -f1)
flush_at=$(line_of 'FLUSHALL')
start_at=$(grep -nE '^start ' "$TMP/real.log" | tail -1 | cut -d: -f1)
if [ -n "$stop_at" ] && [ -n "$ledger_at" ] && [ -n "$reset_at" ] && [ -n "$flush_at" ] && [ -n "$start_at" ] &&
  [ "$stop_at" -lt "$ledger_at" ] && [ "$ledger_at" -lt "$reset_at" ] && [ "$reset_at" -lt "$flush_at" ] &&
  [ "$flush_at" -lt "$start_at" ]; then
  ok "the order holds: stop, migrate, truncate+seed, flush, restart (lines $stop_at < $ledger_at < $reset_at < $flush_at < $start_at)"
else
  fail "the order is wrong: stop=$stop_at migrate=$ledger_at reset=$reset_at flush=$flush_at start=$start_at"
fi
if grep -q 'TRUNCATE TABLE' "$TMP/real.stream" && grep -q "tablename <> 'schema_migrations'" "$TMP/real.stream" &&
  grep -q '^INSERT INTO "users"' "$TMP/real.stream"; then
  ok "the truncate and the seed travel in ONE --single-transaction stream, the ledger excluded"
else
  fail "the transaction stream does not hold both the truncate (ledger excluded) and the seed"
fi
if cmp -s <(sed -n '/^-- The dev.canari-emse.fr seed/,$p' "$TMP/real.stream") "$SEED"; then
  ok "the seed is streamed byte for byte as committed"
else
  fail "the stream does not end with the committed seed.sql"
fi
if grep -q 'reset verified' "$TMP/real.out"; then
  ok "the run verified its own result"
else
  fail "the run did not verify"
fi

if STUB_LOG="$TMP/short.log" STUB_STREAM="$TMP/short.stream" STUB_PROJECT=canari-dev STUB_USERS=3 \
  PATH="$TMP/bin:$PATH" bash "$SCRIPT" </dev/null >"$TMP/short.out" 2>&1; then
  fail "a reset that left the wrong number of users reported success"
else
  if grep -q 'is NOT trustworthy' "$TMP/short.out" && grep -qE '^start ' "$TMP/short.log"; then
    ok "a reset that does not verify fails loudly, and still restarts the services"
  else
    fail "a failed verification is not reported, or the services were left stopped"
  fi
fi

printf '\n'
if [ "$failures" -gt 0 ]; then
  printf 'FAILED: %d problem(s) across %d assertion(s)\n' "$failures" "$((checks + failures))"
  exit 1
fi
printf 'all %d assertions passed\n' "$checks"
