#!/usr/bin/env bash
#
# Does the upstream reachability report class every reading by cause and never read a transport
# failure as health? Run against a `curl` stub (no network).
#
#  - 200 is up; 530 with Cloudflare 1033 is tunnel-down; a 530 without it is "unclassified-530";
#    502 is origin-failing; no HTTP answer is unreachable, never up;
#  - one bad attempt followed by a good one is up (a blink is not a reading);
#  - a finding exits 0 (data, not a fault); only an empty target list exits 2;
#  - the probe sends a recognisable User-Agent and probes the targets in parallel.
#
# Run by `make test-ci-scripts`.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$REPO/.github/scripts/upstream-reachability-report.sh"
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

# The stub answers per URL from a file of "code|body" lines, one per attempt, consumed in order
# (the last line repeats). Code `fail` is a curl transport failure.
cat >"$TMP/curl" <<'STUB'
#!/usr/bin/env bash
url="${@: -1}"
out=""
while [ $# -gt 0 ]; do
  [ "$1" = -o ] && out="$2"
  shift
done
key="$(printf '%s' "$url" | tr -c 'a-z0-9\n' '_')"
f="$STUB_DIR/$key"
line="$(head -n1 "$f" 2>/dev/null)"
if [ "$(wc -l <"$f")" -gt 1 ]; then tail -n +2 "$f" >"$f.n" && mv "$f.n" "$f"; fi
code="${line%%|*}"
[ "$code" = fail ] && exit 7
printf '%s' "${line#*|}" >"$out"
printf '%s' "$code"
STUB
chmod +x "$TMP/curl"

set_stub() {
  local key
  key="$(printf '%s' "$1" | tr -c 'a-z0-9\n' '_')"
  shift
  printf '%s\n' "$@" >"$TMP/$key"
}
run() {
  local want="$1" label="$2" got
  OUT="$(CURL="$TMP/curl" STUB_DIR="$TMP" UPSTREAM_SPACING=0 UPSTREAM_RESULTS="$TMP/results.tsv" UPSTREAM_TARGETS="$TARGETS" bash "$SCRIPT" 2>&1)"
  got=$?
  if [ "$got" = "$want" ]; then ok "$label"; else fail "$label (exit $got, wanted $want): $OUT"; fi
}
class_of() { awk -F'\t' -v n="$1" '$1 == n {print $2}' "$TMP/results.tsv"; }
expect_class() {
  if [ "$(class_of "$1")" = "$2" ]; then ok "$1 is read as $2"; else fail "$1 read as '$(class_of "$1")', wanted $2"; fi
}

TARGETS='a|https://a.test/h
b|https://b.test/h'
set_stub https://a.test/h '200|ok'
set_stub https://b.test/h '200|ok'
run 0 'all up exits 0'
expect_class a up
expect_class b up

set_stub https://b.test/h '530|error code: 1033'
run 0 'a down target is a reading, not a fault of the script'
expect_class b tunnel-down
expect_class a up

set_stub https://b.test/h '530|some other body'
run 0 'a 530 without 1033'
expect_class b unclassified-530

set_stub https://b.test/h '502|bad'
run 0 'a 502'
expect_class b origin-failing

set_stub https://b.test/h 'fail|'
run 0 'no HTTP answer'
expect_class b unreachable

set_stub https://b.test/h 'fail|' '200|ok'
run 0 'one blink followed by an answer'
expect_class b up

set_stub https://b.test/h '404|nope'
run 0 'an unexpected status'
expect_class b unexpected

if grep -q 'canari-upstream-monitor' "$SCRIPT" && grep -qE -- '-A "\$UA"' "$SCRIPT"; then ok 'the probe sends a recognisable User-Agent'; else fail 'no User-Agent'; fi
if grep -qE 'probe_one .* &$' "$SCRIPT" && grep -q '^wait$' "$SCRIPT"; then ok 'targets are probed in parallel'; else fail 'targets are probed in sequence'; fi

TARGETS=''
run 2 'no target at all is a fault of the script'

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
