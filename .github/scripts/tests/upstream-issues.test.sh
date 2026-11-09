#!/usr/bin/env bash
#
# Does the upstream state machine alarm exactly once per outage, and never on one bad reading?
# Run against a `gh` stub holding issues as files (no network).
#
#  - the FIRST failure opens no issue (a deploy blip): it is recorded as a suspect;
#  - the SECOND consecutive failure opens ONE issue, with the first failure's time;
#  - a THIRD failure with the issue open does nothing (one issue, not twenty);
#  - a success while an issue is open comments with the downtime and closes it;
#  - a success between two failures clears the suspicion (the failures were not consecutive);
#  - an `edge-refused` reading (the edge refused the MONITOR) opens "cannot read", never "is down",
#    with its evidence; it neither closes nor confirms an open outage; any answer the name wrote
#    closes it, no answer at all does not;
#  - a gh refusal or a missing results file is a failure of the reporter (exit 1);
#  - a dry run writes nothing.
#
# Run by `make test-ci-scripts`.
# `A && ok || fail` is the whole idiom of this file: `ok` cannot fail, so C never runs after a true A.
# shellcheck disable=SC2015
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/upstream-issues.sh"
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
export DB="$TMP/db"
mkdir -p "$DB"

# The stub. Issues are directories DB/<n>/{title,body,state,comments}. `list` answers the number of
# the open issue whose title is the one searched; `view` prints a body; `create` prints a URL.
cat >"$TMP/gh" <<'STUB'
#!/usr/bin/env bash
[ -z "${GH_FAIL:-}" ] || { echo 'HTTP 403' >&2; exit 1; }
cmd="$1 $2"
shift 2
arg() { # value of --<flag>
  local f="$1"
  shift
  while [ $# -gt 0 ]; do
    [ "$1" = "$f" ] && { printf '%s' "$2"; return; }
    shift
  done
}
case "$cmd" in
"issue list")
  want="$(arg --search "$@")"
  want="${want% in:title}"
  for d in "$DB"/*/; do
    [ -f "$d/state" ] && [ "$(cat "$d/state")" = open ] && [ "$(cat "$d/title")" = "$want" ] && basename "$d"
  done
  exit 0
  ;;
"issue view")
  cat "$DB/$1/body"
  ;;
"issue create")
  n=$(($(ls "$DB" | wc -l) + 1))
  mkdir -p "$DB/$n"
  arg --title "$@" >"$DB/$n/title"
  arg --body "$@" >"$DB/$n/body"
  echo open >"$DB/$n/state"
  echo "https://github.com/x/y/issues/$n"
  ;;
"issue edit")
  arg --body "$@" >"$DB/$1/body"
  ;;
"issue comment")
  arg --body "$@" >>"$DB/$1/comments"
  ;;
"issue close")
  echo closed >"$DB/$1/state"
  ;;
esac
STUB
chmod +x "$TMP/gh"

# step <class> <label>: one reading of the target `svc`, then the script.
step() {
  local class="$1" code=530
  case "$class" in up) code=200 ;; edge-refused) code=403 ;; origin-failing) code=502 ;; esac
  printf 'svc\t%s\t%s\thttps://svc.test/h\tserver=cloudflare cf-mitigated=challenge body=Just a moment...\n' "$class" "$code" >"$TMP/r.tsv"
  OUT="$(GH="$TMP/gh" REPO=x/y UPSTREAM_RESULTS="$TMP/r.tsv" NOW="$2" bash "$SCRIPT" 2>&1)"
  RC=$?
}
count_open() {
  local n=0 d
  for d in "$DB"/*/; do
    [ "$(cat "$d/state")" = open ] && [ "$(cat "$d/title")" = "$1" ] && n=$((n + 1))
  done
  echo "$n"
}
reset() {
  rm -rf "$DB"
  mkdir -p "$DB"
}

T=Upstream\ svc\ is\ down

reset
step tunnel-down 2026-11-06T10:00:00Z
[ "$RC" = 0 ] && ok 'first failure: exit 0' || fail "first failure exit $RC: $OUT"
[ "$(count_open "$T")" = 0 ] && ok 'first failure opens no issue (a deploy must not alarm)' || fail 'an issue opened on the first failure'
grep -q 'suspect svc 2026-11-06T10:00:00Z' "$DB"/*/body && ok 'the first failure is recorded as a suspect' || fail 'no suspect recorded'

step tunnel-down 2026-11-06T10:15:00Z
[ "$(count_open "$T")" = 1 ] && ok 'second consecutive failure opens ONE issue' || fail "issues open: $(count_open "$T")"
grep -q 'first failed reading: 2026-11-06T10:00:00Z' "$DB"/*/body && ok 'the issue says since the FIRST failure' || fail 'wrong since'
grep -q 'suspect svc' "$DB/1/body" && fail 'the suspect was not cleared once the issue opened' || ok 'the suspicion is cleared once the issue is open'

step tunnel-down 2026-11-06T10:30:00Z
step unreachable 2026-11-06T10:45:00Z
[ "$RC" = 0 ] && [ "$(count_open "$T")" = 1 ] && ok 'further failures change nothing: still one issue, still green' || fail "issues open: $(count_open "$T"), exit $RC"

step up 2026-11-06T15:30:00Z
[ "$(count_open "$T")" = 0 ] && ok 'a success closes the issue' || fail 'the issue stayed open'
grep -q 'after 5h 30m' "$DB"/*/comments && ok 'and says how long it was down' || fail "no downtime in: $(cat "$DB"/*/comments)"

step up 2026-11-06T15:45:00Z
[ "$(count_open "$T")" = 0 ] && ok 'a further success opens nothing' || fail 'opened on success'

reset
step origin-failing 2026-11-06T10:00:00Z
step up 2026-11-06T10:15:00Z
step origin-failing 2026-11-06T10:30:00Z
[ "$(count_open "$T")" = 0 ] && ok 'fail, ok, fail is not two CONSECUTIVE failures: no issue' || fail 'alarmed on non-consecutive failures'

# --- edge-refused: the monitor is blind, which is neither an outage nor health ---------------------
B='Upstream monitor cannot read svc'
reset
step edge-refused 2026-11-06T19:20:00Z
step edge-refused 2026-11-06T23:45:00Z
[ "$(count_open "$B")" = 1 ] && ok 'two refused readings open ONE "cannot read" issue' || fail "blind issues open: $(count_open "$B")"
[ "$(count_open "$T")" = 0 ] && ok 'and never an "is down" issue (the 2026-11-06 defect)' || fail 'a refused reading opened an outage issue'
grep -q 'evidence: `server=cloudflare cf-mitigated=challenge' "$DB"/*/body && ok 'the issue carries the evidence of the reading' || fail 'no evidence in the issue'
step edge-refused 2026-11-07T03:45:00Z
[ "$(count_open "$B")" = 1 ] && [ "$RC" = 0 ] && ok 'a further refusal changes nothing' || fail "blind issues open: $(count_open "$B"), exit $RC"
step up 2026-11-07T07:45:00Z
[ "$(count_open "$B")" = 0 ] && ok 'the first answer from the name closes it' || fail 'the blind issue stayed open'
grep -q 'after 12h 25m without a reading' "$DB"/*/comments && ok 'and says how long the monitor was blind' || fail "comments: $(cat "$DB"/*/comments)"

reset
step tunnel-down 2026-11-06T10:00:00Z
step tunnel-down 2026-11-06T10:15:00Z
step edge-refused 2026-11-06T10:30:00Z
step edge-refused 2026-11-06T10:45:00Z
[ "$(count_open "$T")" = 1 ] && ok 'a refused reading neither closes nor confirms an open outage' || fail 'a blind reading closed an outage'
[ "$(count_open "$B")" = 1 ] && ok 'and the blindness is reported beside it, not swallowed' || fail "blind issues open: $(count_open "$B")"
step origin-failing 2026-11-06T11:00:00Z
[ "$(count_open "$B")" = 0 ] && [ "$(count_open "$T")" = 1 ] && ok 'an answer the origin wrote ends the blindness and keeps the outage' || fail "down $(count_open "$T"), blind $(count_open "$B")"

reset
step edge-refused 2026-11-06T10:00:00Z
step up 2026-11-06T10:15:00Z
step edge-refused 2026-11-06T10:30:00Z
[ "$(count_open "$B")" = 0 ] && ok 'refused, ok, refused is not two consecutive: no issue' || fail 'alarmed on non-consecutive refusals'

reset
step edge-refused 2026-11-06T10:00:00Z
step edge-refused 2026-11-06T10:15:00Z
step unreachable 2026-11-06T10:30:00Z
[ "$(count_open "$B")" = 1 ] && ok 'no answer at all does not prove the monitor sees again' || fail 'unreachable closed the blind issue'

reset
GH_FAIL=1 step tunnel-down 2026-11-06T10:00:00Z
export GH_FAIL=
[ "$RC" = 1 ] && ok 'a refused gh call fails the run (a reporter that cannot report is broken)' || fail "gh refused but exit $RC"

OUT="$(GH="$TMP/gh" REPO=x/y UPSTREAM_RESULTS="$TMP/absent.tsv" bash "$SCRIPT" 2>&1)"
[ $? = 1 ] && ok 'a missing results file fails the run' || fail 'missing results read as clean'

reset
printf 'svc\ttunnel-down\t530\thttps://svc.test/h\n' >"$TMP/r.tsv"
OUT="$(GH="$TMP/gh" REPO=x/y UPSTREAM_RESULTS="$TMP/r.tsv" UPSTREAM_DRY_RUN=1 bash "$SCRIPT" 2>&1)"
[ -z "$(ls "$DB")" ] && ok 'a dry run writes nothing' || fail 'a dry run created an issue'

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
