#!/usr/bin/env bash
# Does `deploy-environment.sh` apply EVERY migration, or only the first one?
#
# WHY THIS TEST EXISTS. On dev's first bootstrap (2026-09-02) the deploy reported
# `migrations: 1 applied, 0 already recorded` with 80 files on disk, and two services crash-looped
# on `relation "platform_config" does not exist`. The loop was correct in every line: the fault was
# that `psql` is `docker compose exec -T`, which ATTACHES AND DRAINS STDIN whatever arguments follow
# it, and the file list was on the loop's own stdin - so the ledger query in the first iteration
# swallowed the remaining 79 lines and `read` met EOF.
#
# THE SHAPE IS WHY IT IS TESTED FUNCTIONALLY RATHER THAN BY GREP. "The loop reads on fd 3" is a
# sentence about the text; "all N files are applied even when the ledger query eats stdin" is a
# statement about the outcome, and only the second one still holds the day somebody adds a fourth
# psql call inside the loop. So the function is extracted from the real script and run against a
# `psql` stub that drains stdin exactly as `docker compose exec -T` does.
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/../../.." && pwd)/infrastructure/deploy/deploy-environment.sh"
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

run_with_draining_psql() {
  (
    cd "$TMP" || exit 1
    ENVIRONMENT=dev
    # THE STUB IS THE POINT: it drains stdin on every call, which is what `docker compose exec -T`
    # does. It answers nothing for the ledger SELECT, so every file counts as unapplied.
    psql() {
      cat >/dev/null 2>&1 || true
      return 0
    }
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

printf '\n'
if [ "$FAIL" -gt 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
