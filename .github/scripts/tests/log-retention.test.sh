#!/usr/bin/env bash
#
# Does the daily log-retention report name every container whose live log is past the ceiling, and
# only those - and does it tell an unreadable log apart from an old one?
#
# WHY THIS EXISTS. The privacy policy promises technical logs are kept 90 days at most; a
# size-capped container log is no bound in time, so `report_live_log_age` (infrastructure/lib/
# log-retention.sh) asks each log for a line older than LOG_LIVE_MAX_DAYS and turns the run red on
# one (docs/wiki/infrastructure/logging.md). Run against a `docker` stub:
#
#  - a log with nothing that old passes, and an EMPTY estate passes;
#  - a log holding an old line fails, and the report names the container and the line's date;
#  - a line older than the promise itself is reported as the promise BROKEN, not merely near it;
#  - a log the CLI cannot read fails as UNREADABLE, never as old (an inability to measure is not a
#    failing measurement) - judged by docker's exit status, so a failure that prints nothing counts;
#  - the question asked is `--until <LOG_LIVE_MAX_DAYS x 24>h`, and the window leaves slack under
#    the promise.
#
# Run by `make test-ci-scripts`.
set -uo pipefail

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

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# shellcheck source-path=SCRIPTDIR source=../../../infrastructure/lib/archive-logs.sh
. "$REPO/infrastructure/lib/archive-logs.sh"
# shellcheck source-path=SCRIPTDIR source=../../../infrastructure/lib/log-retention.sh
. "$REPO/infrastructure/lib/log-retention.sh"

# The stub: `ps` lists $STUB_IDS, `inspect` names a container after its id, and `logs` answers by
# id - `old` with a dated line inside the promise, `ancient` with one past it, `broken` with a CLI
# error, anything else with nothing.
RECENT_OLD="$(date -u -d "-$((LOG_LIVE_MAX_DAYS + 5)) days" +%Y-%m-%dT%H:%M:%S)"
PAST_PROMISE="$(date -u -d "-$((LOG_PROMISE_DAYS + 5)) days" +%Y-%m-%dT%H:%M:%S)"
export RECENT_OLD PAST_PROMISE
cat >"$TMP/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$STUB_CALLS"
case "$1" in
ps) printf '%s\n' $STUB_IDS ;;
inspect) printf '/%s\n' "${@: -1}" ;;
logs)
  case "${@: -1}" in
  old) printf '%s.123456789Z GET /api/version\n' "$RECENT_OLD" ;;
  ancient) printf '%s.000000001Z GET /\n' "$PAST_PROMISE" ;;
  broken) printf 'Error response from daemon: configured logging driver does not support reading\n' >&2; exit 1 ;;
  mute) exit 1 ;;
  # What a real old log does: `head` takes the first line and closes, and docker dies of SIGPIPE.
  piped) printf '%s.123456789Z GET /api/version\n' "$RECENT_OLD"; kill -PIPE $$ ;;
  esac
  ;;
esac
EOF
chmod +x "$TMP/docker"
export STUB_CALLS="$TMP/calls"

run() {
  STUB_IDS="$1" report_live_log_age "$TMP/docker" proj >"$TMP/out" 2>&1
}

if run ""; then ok "an estate with no container passes"; else fail "an empty estate failed: $(cat "$TMP/out")"; fi

if run "fresh"; then ok "a log with nothing past $LOG_LIVE_MAX_DAYS days passes"; else fail "a fresh log failed: $(cat "$TMP/out")"; fi

if grep -q -- "--until $((LOG_LIVE_MAX_DAYS * 24))h" "$TMP/calls"; then
  ok "the log is asked for lines older than $((LOG_LIVE_MAX_DAYS * 24))h"
else
  fail "docker logs was not asked --until $((LOG_LIVE_MAX_DAYS * 24))h: $(grep logs "$TMP/calls" | sed -n 1p)"
fi

run "fresh old"
status=$?
if [ "$status" -ne 0 ] && grep -q "old holds a line from ${RECENT_OLD}Z" "$TMP/out" && ! grep -q "fresh holds a line" "$TMP/out"; then
  ok "a log past the ceiling fails, naming that container and the line's date, and only it"
else
  fail "the old log was not reported as expected (status=$status): $(cat "$TMP/out")"
fi
if grep -q "near the 90-day ceiling" "$TMP/out" && ! grep -q "Privacy policy broken" "$TMP/out"; then
  ok "a line between the ceiling and the promise is reported as NEAR the promise"
else
  fail "the old line was classified wrongly: $(cat "$TMP/out")"
fi

if ! run "ancient" && grep -q "Privacy policy broken" "$TMP/out"; then
  ok "a line older than $LOG_PROMISE_DAYS days is reported as the promise BROKEN"
else
  fail "a line past the promise was not called broken: $(cat "$TMP/out")"
fi

run "broken fresh"
status=$?
if [ "$status" -ne 0 ] && grep -q "could not read the log of broken" "$TMP/out" && ! grep -q "broken holds a line" "$TMP/out"; then
  ok "an unreadable log fails as UNREADABLE, not as old, and the next container is still read"
else
  fail "an unreadable log was misreported (status=$status): $(cat "$TMP/out")"
fi
if grep -q "fresh holds nothing older" "$TMP/out"; then ok "a container after an unreadable one is still judged"; else fail "the report stopped at the unreadable log"; fi

run "mute"
status=$?
if [ "$status" -ne 0 ] && grep -q "could not read the log of mute" "$TMP/out" && ! grep -q "mute holds nothing" "$TMP/out"; then
  ok "a CLI that fails with NO output is unreadable, not a log holding nothing old"
else
  fail "a silent docker failure passed as a clean log (status=$status): $(cat "$TMP/out")"
fi

run "piped"
status=$?
if [ "$status" -ne 0 ] && grep -q "piped holds a line from ${RECENT_OLD}Z" "$TMP/out" && ! grep -q "could not read the log of piped" "$TMP/out"; then
  ok "docker killed by SIGPIPE after its first line (141) is a READ, reported as old"
else
  fail "a SIGPIPE'd read was misreported (status=$status): $(cat "$TMP/out")"
fi

if [ "$LOG_LIVE_MAX_DAYS" -lt "$LOG_PROMISE_DAYS" ]; then
  ok "the ceiling ($LOG_LIVE_MAX_DAYS days) leaves $((LOG_PROMISE_DAYS - LOG_LIVE_MAX_DAYS)) days to act before the promise"
else
  fail "LOG_LIVE_MAX_DAYS ($LOG_LIVE_MAX_DAYS) is not under LOG_PROMISE_DAYS ($LOG_PROMISE_DAYS)"
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
