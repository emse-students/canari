#!/usr/bin/env bash
#
# Does the witness of the upstream monitor report a monitor that stopped, and only that? Run
# against a `gh` stub (no network, no wall clock: NOW is injected).
#
#  - a successful reading inside the window is fresh: nothing opens, and an open report closes;
#  - no successful reading inside it opens ONE "has stopped reading" issue, naming the last one;
#  - a reading by a run that FAILED its monitor job, or a run with no monitor job (another cron),
#    is not a reading;
#  - the walk stops at the first run older than the window (bounded calls);
#  - a refused gh call fails the run; a dry run writes nothing;
#  - the job name it looks for IS the `upstream` job's name in scheduled.yml, and ci.yml runs it on
#    a push to `main` - the one trigger that does not depend on the scheduler.
#
# Run by `make test-ci-scripts`.
# `A && ok || fail` is the whole idiom of this file: `ok` cannot fail, so C never runs after a true A.
# shellcheck disable=SC2015
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/upstream-monitor-freshness.sh"
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

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export FIX="$TMP/fix"

# The stub. `api .../workflows/scheduled.yml/runs` prints FIX/runs ("id created_at" lines, newest
# first, as the real --jq would); `api .../runs/<id>/jobs` prints FIX/jobs-<id> (the --jq answer:
# a completion time or nothing) and logs the call; issues are files as in upstream-issues.test.sh.
cat >"$TMP/gh" <<'STUB'
#!/usr/bin/env bash
[ -z "${GH_FAIL:-}" ] || { echo 'HTTP 403' >&2; exit 1; }
arg() {
  local f="$1"
  shift
  while [ $# -gt 0 ]; do
    [ "$1" = "$f" ] && { printf '%s' "$2"; return; }
    shift
  done
}
if [ "$1" = api ]; then
  case "$2" in
  */workflows/scheduled.yml/runs*) cat "$FIX/runs" ;;
  */jobs)
    id="${2%/jobs}"
    id="${id##*/}"
    echo "$id" >>"$FIX/calls"
    cat "$FIX/jobs-$id" 2>/dev/null
    ;;
  esac
  exit 0
fi
cmd="$1 $2"
shift 2
case "$cmd" in
"issue list")
  for d in "$FIX"/issue-*/; do
    [ -d "$d" ] && [ "$(cat "$d/state")" = open ] && basename "$d" | sed 's/issue-//'
  done
  ;;
"issue create")
  n=$(($(ls -d "$FIX"/issue-*/ 2>/dev/null | wc -l) + 1))
  mkdir -p "$FIX/issue-$n"
  arg --body "$@" >"$FIX/issue-$n/body"
  echo open >"$FIX/issue-$n/state"
  echo "https://github.com/x/y/issues/$n"
  ;;
"issue comment") arg --body "$@" >>"$FIX/issue-$1/comments" ;;
"issue close") echo closed >"$FIX/issue-$1/state" ;;
esac
exit 0
STUB
chmod +x "$TMP/gh"

reset() {
  rm -rf "$FIX"
  mkdir -p "$FIX"
  : >"$FIX/runs"
}
run() {
  OUT="$(GH="$TMP/gh" REPO=x/y NOW="$1" bash "$SCRIPT" 2>&1)"
  RC=$?
}
open_count() {
  local n=0 d
  for d in "$FIX"/issue-*/; do
    [ -d "$d" ] && [ "$(cat "$d/state")" = open ] && n=$((n + 1))
  done
  echo "$n"
}

NOW=2026-11-09T12:00:00Z

reset
printf '%s\n' '30 2026-11-09T09:00:00Z' '20 2026-11-09T07:30:00Z' '10 2026-11-09T06:57:00Z' >"$FIX/runs"
echo 2026-11-09T06:58:00Z >"$FIX/jobs-10"
run "$NOW"
[ "$RC" = 0 ] && [ "$(open_count)" = 0 ] && ok 'a reading 5 hours old, behind two runs of other crons, is fresh' || fail "exit $RC, open $(open_count): $OUT"

reset
printf '%s\n' '30 2026-11-09T09:00:00Z' '10 2026-11-08T20:00:00Z' '5 2026-11-08T10:00:00Z' >"$FIX/runs"
echo 2026-11-08T20:01:00Z >"$FIX/jobs-10"
echo 2026-11-08T10:01:00Z >"$FIX/jobs-5"
run "$NOW"
[ "$RC" = 0 ] && [ "$(open_count)" = 1 ] && ok 'no reading in 12 hours opens ONE report, and the run stays green' || fail "exit $RC, open $(open_count): $OUT"
grep -q 'last successful reading found: 2026-11-08T20:01:00Z (run 10)' "$FIX"/issue-1/body && ok 'it names the last reading it found' || fail "body: $(cat "$FIX"/issue-1/body)"
run "$NOW"
[ "$(open_count)" = 1 ] && ok 'a second stale push does not open a second report' || fail "open $(open_count)"

printf '%s\n' '40 2026-11-09T11:00:00Z' '30 2026-11-09T09:00:00Z' >"$FIX/runs"
echo 2026-11-09T11:01:00Z >"$FIX/jobs-40"
run "$NOW"
[ "$(open_count)" = 0 ] && grep -q 'reads again' "$FIX"/issue-1/comments && ok 'a fresh reading closes the report, with a comment' || fail "open $(open_count)"

reset
printf '%s\n' '30 2026-11-09T11:00:00Z' >"$FIX/runs"
: >"$FIX/jobs-30"
run "$NOW"
[ "$(open_count)" = 1 ] && ok 'a run whose monitor job failed or skipped is not a reading' || fail "open $(open_count): $OUT"

reset
printf '%s\n' '30 2026-11-09T11:00:00Z' '10 2026-11-08T20:00:00Z' '5 2026-11-08T10:00:00Z' >"$FIX/runs"
echo 2026-11-08T10:01:00Z >"$FIX/jobs-5"
run "$NOW"
grep -qx 10 "$FIX/calls" && ok 'the first run older than the window is still read (its job may end inside it)' || fail "calls: $(cat "$FIX/calls")"
grep -qx 5 "$FIX/calls" && fail 'the walk went past the first run older than the window' || ok 'and the walk stops there: bounded calls'
grep -q 'last successful reading found: none in the window' "$FIX"/issue-1/body && ok 'a reading older than that is not searched for' || fail "body: $(cat "$FIX"/issue-1/body)"

reset
GH_FAIL=1 run "$NOW"
[ "$RC" = 1 ] && ok 'a refused gh call fails the run - never read as fresh' || fail "exit $RC"

reset
UPSTREAM_DRY_RUN=1 run "$NOW"
[ "$RC" = 0 ] && [ "$(open_count)" = 0 ] && grep -q 'dry-run: would open' <<<"$OUT" && ok 'a dry run writes nothing' || fail "exit $RC, open $(open_count): $OUT"

# The name it reads must be the job's name, and the trigger must not be the scheduler.
SCHED="$REPO_ROOT/.github/workflows/scheduled.yml"
CI="$REPO_ROOT/.github/workflows/ci.yml"
want="$(sed -n "s/^readonly MONITOR_JOB='\(.*\)'$/\1/p" "$SCRIPT")"
got="$(sed -n '/^  upstream:$/,/^    name:/p' "$SCHED" | sed -n 's/^    name: //p')"
[ -n "$want" ] && [ "$want" = "$got" ] && ok "the job it reads ('$want') is the upstream job's name" || fail "script reads '$want', scheduled.yml names '$got'"
block="$(sed -n '/^  upstream-monitor-freshness:$/,/^  [a-z0-9-]*:$/p' "$CI")"
grep -q "if: github.event_name == 'push'" <<<"$block" && grep -q 'upstream-monitor-freshness.sh' <<<"$block" &&
  ok 'ci.yml runs it on a push to main' || fail 'ci.yml does not run the witness on push'

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
