#!/usr/bin/env bash
#
# Does the daily resolver report name every DNS failure of the two proxies that no design explains,
# and only those - and does it tell an unreadable log apart from a clean one?
#
# WHY THIS EXISTS. Since the replica lists became variable targets, every proxied request waits on
# Docker's resolver (docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to), and
# `report_resolver_failures` (infrastructure/lib/resolver-report.sh) is what reads the failures. Run
# against a `docker` stub:
#
#  - a proxy whose log names no failure passes, and so does an estate with no proxy;
#  - "Host not found" for an `exclusive` service passes, counted;
#  - "Host not found" for an `overlap` service, or for a take-out's container name, fails, naming
#    the proxy, the host and the count;
#  - a timeout fails as Docker's DNS itself, whatever the host;
#  - a log the CLI cannot read fails as UNREADABLE, never as clean;
#  - the question asked is `--since <RESOLVER_REPORT_HOURS>h`.
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
# shellcheck source-path=SCRIPTDIR source=../../../infrastructure/lib/resolver-report.sh
. "$REPO/infrastructure/lib/resolver-report.sh"

# The stub: `ps` lists $STUB_IDS for the proxy `frontend` (none for the edge), and the container
# `media` for an exclusive query on media-service; `inspect` names a container after its id; `logs`
# answers by id.
cat >"$TMP/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$STUB_CALLS"
case "$1" in
ps)
  case "$*" in
  *service=frontend*) printf '%s\n' $STUB_IDS ;;
  *service=media-service*canari.deploy.replace=exclusive*) echo media ;;
  esac
  ;;
inspect) printf '/%s\n' "${@: -1}" ;;
logs)
  e='2026/11/02 03:00:00 [error] 30#30: *12'
  case "${@: -1}" in
  clean) echo "$e GET /api/version" ;;
  gap) printf '%s media-service could not be resolved (3: Host not found), client: 192.0.2.1\n' "$e" "$e" ;;
  absent) echo "$e core-service could not be resolved (3: Host not found), client: 192.0.2.1" ;;
  stale) echo "$e canari-core-service-2 could not be resolved (3: Host not found), client: 192.0.2.1" ;;
  slow) echo "$e media-service could not be resolved (110: Operation timed out), client: 192.0.2.1" ;;
  broken) echo 'Error response from daemon: configured logging driver does not support reading' >&2; exit 1 ;;
  mute) exit 1 ;;
  esac
  ;;
esac
EOF
chmod +x "$TMP/docker"
export STUB_CALLS="$TMP/calls"

run() {
  STUB_IDS="$1" report_resolver_failures "$TMP/docker" proj >"$TMP/out" 2>&1
}

if run ""; then ok "an estate with no proxy passes"; else fail "an empty estate failed: $(cat "$TMP/out")"; fi

if run "clean"; then ok "a proxy log naming no resolution failure passes"; else fail "a clean log failed: $(cat "$TMP/out")"; fi
if grep -q -- "logs --since ${RESOLVER_REPORT_HOURS}h clean" "$TMP/calls"; then
  ok "the log is asked for the last ${RESOLVER_REPORT_HOURS}h"
else
  fail "docker logs was not asked --since ${RESOLVER_REPORT_HOURS}h: $(grep logs "$TMP/calls" | sed -n 1p)"
fi

if run "gap" && grep -q 'gap - media-service x2 "Host not found": an exclusive service' "$TMP/out"; then
  ok "an exclusive service absent from DNS passes, counted"
else
  fail "an exclusive service's gap was misreported: $(cat "$TMP/out")"
fi

if ! run "absent" && grep -q 'absent could not resolve core-service 1 time(s)' "$TMP/out"; then
  ok "an overlap service absent from DNS fails, naming the proxy, the host and the count"
else
  fail "an absent overlap service was not reported: $(cat "$TMP/out")"
fi

if ! run "stale" && grep -q 'stale could not resolve canari-core-service-2 .*outlived its container' "$TMP/out"; then
  ok "a take-out's container name that no longer resolves fails"
else
  fail "a stale take-out name was not reported: $(cat "$TMP/out")"
fi

if ! run "slow" && grep -q "could not resolve media-service .*(110: Operation timed out) - Docker's DNS itself failed" "$TMP/out"; then
  ok "a timeout fails as Docker's DNS itself, even for an exclusive service"
else
  fail "a resolver timeout was not reported: $(cat "$TMP/out")"
fi

run "broken clean"
status=$?
if [ "$status" -ne 0 ] && grep -q "could not read the log of broken" "$TMP/out" && grep -q "clean - no resolution failure" "$TMP/out"; then
  ok "an unreadable log fails as UNREADABLE, and the next container is still read"
else
  fail "an unreadable log was misreported (status=$status): $(cat "$TMP/out")"
fi

if ! run "mute" && grep -q "could not read the log of mute" "$TMP/out"; then
  ok "a CLI that fails with NO output is unreadable, not a clean log"
else
  fail "a silent docker failure passed as a clean log: $(cat "$TMP/out")"
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
