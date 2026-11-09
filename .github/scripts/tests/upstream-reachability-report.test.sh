#!/usr/bin/env bash
#
# Does the upstream reachability report class every reading by cause and never read a transport
# failure as health? Run against a `curl` stub (no network).
#
#  - 200 is up; 530 with Cloudflare 1033 is tunnel-down; a 530 without it is "unclassified-530";
#    502 is origin-failing; no HTTP answer is unreachable, never up;
#  - a 4xx the EDGE wrote (a `cf-mitigated` header, a Cloudflare block or challenge page, its
#    plain-text `error code: 1010`) is edge-refused - blindness, never "down" - while a 4xx the
#    origin wrote stays unexpected; every reading carries its evidence (server, cf-mitigated, body);
#  - one bad attempt followed by a good one is up (a blink is not a reading);
#  - a finding exits 0 (data, not a fault); only an empty target list exits 2;
#  - the probe sends a recognisable User-Agent and probes the targets in parallel.
#
# Run by `make test-ci-scripts`.
# `A && ok || fail` is the idiom of this file: `ok` cannot fail, so C never runs after a true A.
# shellcheck disable=SC2015
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
# (the last line repeats). Code `fail` is a curl transport failure. Headers come from the optional
# file <key>.h, written where `-D` asks.
cat >"$TMP/curl" <<'STUB'
#!/usr/bin/env bash
url="${@: -1}"
out=""
hdr=""
while [ $# -gt 0 ]; do
  [ "$1" = -o ] && out="$2"
  [ "$1" = -D ] && hdr="$2"
  shift
done
key="$(printf '%s' "$url" | tr -c 'a-z0-9\n' '_')"
f="$STUB_DIR/$key"
if [ -n "$hdr" ]; then cat "$f.h" >"$hdr" 2>/dev/null || : >"$hdr"; fi
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
  rm -f "$TMP/$key.h"
}
# set_headers <url> <header lines...>: what the stub writes where `-D` asks, CRLF like a server.
set_headers() {
  local key
  key="$(printf '%s' "$1" | tr -c 'a-z0-9\n' '_')"
  shift
  printf '%s\r\n' "$@" >"$TMP/$key.h"
}
run() {
  local want="$1" label="$2" got
  OUT="$(CURL="$TMP/curl" STUB_DIR="$TMP" UPSTREAM_SPACING=0 UPSTREAM_RESULTS="$TMP/results.tsv" UPSTREAM_TARGETS="$TARGETS" bash "$SCRIPT" 2>&1)"
  got=$?
  if [ "$got" = "$want" ]; then ok "$label"; else fail "$label (exit $got, wanted $want): $OUT"; fi
}
class_of() { awk -F'\t' -v n="$1" '$1 == n {print $2}' "$TMP/results.tsv"; }
evidence_of() { awk -F'\t' -v n="$1" '$1 == n {print $5}' "$TMP/results.tsv"; }
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

# The measured case of 2026-11-06..09: the edge refuses the runner, the name is up for a phone.
set_stub https://b.test/h '403|<!DOCTYPE html><html><head><title>Just a moment...</title>'
set_headers https://b.test/h 'HTTP/2 403' 'server: cloudflare' 'cf-mitigated: challenge'
run 0 'a challenge the edge wrote'
expect_class b edge-refused
case "$(evidence_of b)" in
*'server=cloudflare cf-mitigated=challenge body=Just a moment...'*) ok 'the reading carries its evidence: server, cf-mitigated, the body without its tags' ;;
*) fail "evidence: '$(evidence_of b)'" ;;
esac
grep -q 'cf-mitigated=challenge' <<<"$OUT" && ok 'and the human line shows it too' || fail "no evidence on stdout: $OUT"

set_stub https://b.test/h '403|error code: 1010'
set_headers https://b.test/h 'HTTP/2 403' 'server: cloudflare'
run 0 'the plain-text block a non-browser client gets'
expect_class b edge-refused

set_stub https://b.test/h '403|<title>Attention Required! | Cloudflare</title>'
run 0 'a block page'
expect_class b edge-refused

set_stub https://b.test/h '403|{"message":"Forbidden"}'
set_headers https://b.test/h 'HTTP/2 403' 'server: cloudflare'
run 0 'a 403 the ORIGIN wrote, through the same edge'
expect_class b unexpected

set_stub https://b.test/h '530|error code: 1033'
run 0 'a 1033 is still the tunnel, never the client'
expect_class b tunnel-down

# The pattern is a literal `$UA` in the script under test, not an expansion here.
# shellcheck disable=SC2016
if grep -q 'canari-upstream-monitor' "$SCRIPT" && grep -qE -- '-A "\$UA"' "$SCRIPT"; then ok 'the probe sends a recognisable User-Agent'; else fail 'no User-Agent'; fi
if grep -qE 'probe_one .* &$' "$SCRIPT" && grep -q '^wait$' "$SCRIPT"; then ok 'targets are probed in parallel'; else fail 'targets are probed in sequence'; fi

TARGETS=''
run 2 'no target at all is a fault of the script'

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
