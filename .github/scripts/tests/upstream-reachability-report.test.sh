#!/usr/bin/env bash
#
# Does the upstream report name every unreachable public name, class it by cause, and never read a
# transport failure as health? Run against a `curl` stub (no network).
#
#  - 200 passes; 530 with Cloudflare 1033 fails as tunnel-down; 502 as origin-failing;
#  - a connection with no HTTP answer fails as unreachable, never as up;
#  - one bad attempt followed by a good one passes (a blink is not a reading);
#  - one failing target among healthy ones fails the run and names only that target.
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
  OUT="$(CURL="$TMP/curl" STUB_DIR="$TMP" UPSTREAM_SPACING=0 UPSTREAM_TARGETS="$TARGETS" bash "$SCRIPT" 2>&1)"
  got=$?
  if [ "$got" = "$want" ]; then ok "$label"; else fail "$label (exit $got, wanted $want): $OUT"; fi
}
has() {
  if printf '%s' "$OUT" | grep -qF "$1"; then ok "output has: $1"; else fail "output lacks: $1 ($OUT)"; fi
}

TARGETS='a|https://a.test/h
b|https://b.test/h'
set_stub https://a.test/h '200|ok'
set_stub https://b.test/h '200|ok'
run 0 'all up passes'

set_stub https://b.test/h '530|error code: 1033'
run 1 'a tunnel without connector fails'
has 'upstream b is tunnel-down (HTTP 530'
if printf '%s' "$OUT" | grep -q 'upstream a '; then fail 'the healthy target was named'; else ok 'the healthy target is not named'; fi

set_stub https://b.test/h '530|some other body'
run 1 'a 530 that is not a 1033 is not called a tunnel'
has 'origin-failing'

set_stub https://b.test/h '502|bad'
run 1 'a 502 fails'
has 'origin-failing'

set_stub https://b.test/h 'fail|'
run 1 'no HTTP answer fails'
has 'unreachable'

set_stub https://b.test/h 'fail|' '200|ok'
run 0 'one blink followed by an answer passes'

set_stub https://b.test/h '404|nope'
run 1 'an unexpected status fails'
has 'unexpected'

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
