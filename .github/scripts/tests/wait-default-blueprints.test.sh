#!/usr/bin/env bash
#
# Asserts `infrastructure/authentik/wait-default-blueprints.sh` - what ends the wait for authentik's
# default blueprints, and what it says when one of them never applies.
#
# WHY IT IS A TEST AND NOT A COMMENT. The wait was a bare `until 31/31` bounded only by the job's
# 25-minute timeout, and on 2026-09-30 it sat at "WAIT 30/31" until the timeout killed three PRs with
# nothing naming the thirty-first. The stall has not been reproduced locally, so the mechanism is
# proved here against a FAKE `docker` that plays each shape the real one can take:
#   - a slow boot sitting at 0/N is NOT a stall and is not re-applied;
#   - a stall is re-applied once, with the leftovers named, and a re-apply that works ends the wait;
#   - a stall a re-apply does not fix FAILS, naming what is left, and re-applies exactly once;
#   - nothing applying at all fails at the deadline instead of hanging.
#
# Run by `make test-ci-scripts` and by CI.

# The assertions are strings `eval`ed by `assert`, so shellcheck sees neither the variables they read
# (SC2034) nor why they are single-quoted (SC2016): both are the design, not a slip.
# shellcheck disable=SC2016,SC2034
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 1

failures=0
checks=0
pass() { checks=$((checks + 1)); echo "  ok   $1"; }
fail() { checks=$((checks + 1)); failures=$((failures + 1)); echo "  FAIL  $1"; }
assert() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# The fake. STATES is a file of probe answers, one per poll, the last one repeating; a line
# `FIXED` answers READY once the resend has run. The resend is recognised by its task import, the
# worker's log by `logs`, and everything is recorded so the test can count calls.
docker() {
  case "$*" in
    logs*) echo "2026-09-30 worker: ERROR blueprint Default - Brand failed: lost a race" ;;
    *apply_blueprint*)
      echo x >>"$tmp/resends"
      echo "RESENT Default - Brand=error"
      ;;
    *)
      local n line
      n=$(($(cat "$tmp/poll" 2>/dev/null || echo 0) + 1))
      echo "$n" >"$tmp/poll"
      line="$(sed -n "${n}p" "$tmp/states")"
      [ -n "$line" ] || line="$(tail -n 1 "$tmp/states")"
      if [ "$line" = FIXED ]; then
        if [ -f "$tmp/resends" ]; then echo "READY 31/31"; else echo "WAIT 30/31 Default - Brand=error"; fi
      elif [ "$line" != "-" ]; then
        echo "$line"
      fi
      ;;
  esac
}

# shellcheck source-path=SCRIPTDIR
# shellcheck source=../../../infrastructure/authentik/wait-default-blueprints.sh
. infrastructure/authentik/wait-default-blueprints.sh

# scenario <states...>: runs the wait against the given probe answers and leaves the verdict in
# $rc, the output in $tmp/out and the number of resends in $resends. `-` is an empty answer.
scenario() {
  rm -f "$tmp/poll" "$tmp/resends"
  printf '%s\n' "$@" >"$tmp/states"
  WAIT_POLL=0 WAIT_STALL_POLLS=3 WAIT_DEADLINE=30 wait_for_default_blueprints worker >"$tmp/out" 2>&1
  rc=$?
  resends=0
  [ -f "$tmp/resends" ] && resends=$(wc -l <"$tmp/resends")
}

echo "a clean boot ends on READY and touches nothing"
scenario "WAIT 0/31 " "WAIT 12/31 " "WAIT 31/31 " "READY 31/31"
assert "it returns 0" '[ "$rc" = 0 ]'
assert "it re-applied nothing" '[ "$resends" = 0 ]'

echo "a slow first boot at 0/N is not a stall"
scenario - - "WAIT 0/31 a=unknown" "WAIT 0/31 a=unknown" "WAIT 0/31 a=unknown" "WAIT 0/31 a=unknown" "WAIT 0/31 a=unknown" "READY 31/31"
assert "it returns 0" '[ "$rc" = 0 ]'
assert "it re-applied nothing, however long the 0/N lasted" '[ "$resends" = 0 ]'
assert "it reported the worker not answering while it migrated" 'grep -q "worker not answering yet" "$tmp/out"'

echo "a stall a re-apply fixes (the 2026-09-30 shape)"
scenario "WAIT 10/31 " "WAIT 30/31 Default - Brand=error" "WAIT 30/31 Default - Brand=error" "WAIT 30/31 Default - Brand=error" "WAIT 30/31 Default - Brand=error" FIXED
assert "it returns 0" '[ "$rc" = 0 ]'
assert "it re-applied exactly once" '[ "$resends" = 1 ]'
assert "the warning names the blueprint and its status" 'grep -q "::warning::.*Default - Brand=error" "$tmp/out"'

echo "a stall a re-apply does not fix"
scenario "WAIT 30/31 Default - Brand=error"
assert "it returns 1" '[ "$rc" = 1 ]'
assert "it re-applied exactly once, not in a loop" '[ "$resends" = 1 ]'
assert "the error names what is left" 'grep -q "::error::.*stalled AGAIN.*Default - Brand=error" "$tmp/out"'
assert "and carries the worker's own error lines" 'grep -q "worker: .*lost a race" "$tmp/out"'

echo "nothing applying at all fails at the deadline instead of hanging"
rm -f "$tmp/poll" "$tmp/resends"
printf '%s\n' "WAIT 0/31 a=unknown" >"$tmp/states"
SECONDS=0
WAIT_POLL=1 WAIT_STALL_POLLS=3 WAIT_DEADLINE=2 wait_for_default_blueprints worker >"$tmp/out" 2>&1
rc=$?
assert "it returns 1" '[ "$rc" = 1 ]'
assert "it says how long it waited" 'grep -q "still not applied after 2s" "$tmp/out"'

echo
echo "$checks assertions, $failures failed"
[ "$failures" -eq 0 ]
