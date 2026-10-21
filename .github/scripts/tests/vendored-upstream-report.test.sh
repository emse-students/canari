#!/usr/bin/env bash
# =================================================================================================
# THE VENDORED-FORK WATCH, ON FIXTURES, WITH NO NETWORK.
#
# WHAT IS AT RISK. This report exists because a vendored fork is silent by construction, so its own
# failure mode is the same silence: a run that says "nothing newer" when nothing was compared. Every
# case below is one way that could happen - an unreachable registry, a refusal, a changed response
# shape, a stale allowlist, a pin that no longer names the fork - and each must come back as its own
# exit code and its own sentence. THE CONTROL CASE is a newer upstream release: if that ever passes,
# the whole job is a green light over nothing.
#
# `curl` is a fake that serves a status and a body from the environment and records its arguments;
# the tree is a minimal copy of `frontend/src-tauri`'s shape. One case runs against the REAL tree,
# because the premise (the pin names the fork's version) is a fact about this repository, not about
# the fixture.
# =================================================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT="$HERE/../vendored-upstream-report.sh"
REAL_ROOT="$(cd "$HERE/../../.." && pwd)"

PASS=0
FAIL=0
pass() {
  PASS=$((PASS + 1))
  printf '  ok    %s\n' "$1"
}
fail() {
  FAIL=$((FAIL + 1))
  printf '  FAIL  %s\n' "$1"
}

[ -r "$REPORT" ] || {
  printf 'cannot read %s\n' "$REPORT"
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  printf 'jq is required by the report and by this test\n'
  exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The fake curl. FAKE_EXIT non-zero is a transport failure; otherwise it prints the body and, as
# `-w '\n%{http_code}'` would, the status on its own last line.
cat >"$WORK/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_LOG"
if [ "${FAKE_EXIT:-0}" -ne 0 ]; then
  echo "curl: (6) Could not resolve host: crates.io" >&2
  exit "$FAKE_EXIT"
fi
printf '%s\n%s' "$FAKE_BODY" "$FAKE_STATUS"
EOF
chmod +x "$WORK/curl"
export FAKE_LOG="$WORK/curl.log"

# tree <name> <pin> <fork-version> [patched=yes] - a minimal frontend/src-tauri.
tree() {
  local root="$WORK/$1" pin="$2" ver="$3" patched="${4:-yes}"
  local t="$root/frontend/src-tauri"
  mkdir -p "$t/patches/tauri-plugin-websocket/src"
  {
    printf '[dependencies]\ntauri-plugin-websocket = "=%s"\n\n[patch.crates-io]\n' "$pin"
    [ "$patched" = yes ] && printf 'tauri-plugin-websocket = { path = "patches/tauri-plugin-websocket" }\n'
  } >"$t/Cargo.toml"
  printf '[package]\nname = "tauri-plugin-websocket"\nversion = "%s"\n\n[dependencies.serde]\nversion = "1"\n' \
    "$ver" >"$t/patches/tauri-plugin-websocket/Cargo.toml"
  printf '// CANARI PATCH: one\n// CANARI PATCH: two\n' >"$t/patches/tauri-plugin-websocket/src/lib.rs"
  printf '%s' "$root"
}

crate_json() { printf '{"crate":{"name":"tauri-plugin-websocket","max_version":"%s","max_stable_version":"%s"}}' "$1" "$2"; }

# run <root> <status> <body> [curl-exit] - sets CODE and OUT.
run() {
  : >"$FAKE_LOG"
  OUT="$(REPO_ROOT="$1" CURL="$WORK/curl" FAKE_STATUS="$2" FAKE_BODY="$3" FAKE_EXIT="${4:-0}" \
    bash "$REPORT" 2>&1)"
  CODE=$?
}

expect() { # expect <case> <code> <substring>
  if [ "$CODE" = "$2" ]; then
    case "$OUT" in
      *"$3"*) pass "$1" ;;
      *) fail "$1 - exit $CODE as expected but the output lacks '$3': $OUT" ;;
    esac
  else
    fail "$1 - expected exit $2, got $CODE: $OUT"
  fi
}

OK_TREE="$(tree ok 2.5.0 2.5.0)"

printf '\nthe verdicts\n'
run "$OK_TREE" 200 "$(crate_json 2.5.0 2.5.0)"
expect 'a fork on upstream'"'"'s latest stable release passes, and says what it compared' 0 'is 2.5.0, upstream'

run "$OK_TREE" 200 "$(crate_json 2.6.0 2.6.0)"
expect 'CONTROL: a newer upstream release FAILS the run under its own title' 1 'title=Upstream tauri-plugin-websocket released past the vendored fork'
case "$OUT" in
  *"'=2.6.0'"*'2 CANARI PATCH hunk(s)'* | *'2 CANARI PATCH hunk(s)'*"'=2.6.0'"*) pass 'and it names the rebase: the hunk count and the pin to move' ;;
  *) fail "the finding does not name the rebase it asks for: $OUT" ;;
esac

run "$OK_TREE" 200 "$(crate_json 2.10.0 2.10.0)"
expect 'versions compare as numbers, not text (2.10.0 is past 2.5.0)' 1 'released past'

run "$OK_TREE" 200 "$(crate_json 3.0.0-alpha.2 2.5.0)"
expect 'an upstream PRE-release is not a rebase owed by a fork of a stable one' 0 'ok:'

run "$OK_TREE" 200 "$(crate_json 2.4.9 2.4.9)"
expect 'upstream'"'"'s latest OLDER than the fork means the forked release was yanked, and says so' 1 'title=Upstream withdrew the release'

printf '\nthe registry did not answer: 75, never a pass and never a finding\n'
run "$OK_TREE" '' '' 6
expect 'a transport failure exits 75 under its own title' 75 'title=crates.io unreachable - not a finding'

run "$OK_TREE" 503 'Service Unavailable'
expect 'a 503 is unavailability, not an answer: 75' 75 'not a finding'

run "$OK_TREE" 429 ''
expect 'a 429 is unavailability, not an answer: 75' 75 'not a finding'

printf '\nan answer that is not a version is a broken reporter, never a pass\n'
run "$OK_TREE" 404 '{"errors":[{"detail":"crate not found"}]}'
expect 'a 404 names the allowlist entry as the suspect' 1 'no crate named tauri-plugin-websocket'

run "$OK_TREE" 200 '{"crate":{"name":"tauri-plugin-websocket"}}'
expect 'a 200 with no max_stable_version is a changed shape' 1 'response shape changed'

run "$OK_TREE" 200 '<html>maintenance</html>'
expect 'a 200 that is not JSON is a changed shape' 1 'response shape changed'

run "$OK_TREE" 403 'Forbidden'
expect 'any other status is reported, not read as nothing newer' 1 'HTTP 403'

printf '\nthe premise, asserted against the tree\n'
run "$(tree stale 2.5.0 2.5.0 no)" 200 "$(crate_json 2.6.0 2.6.0)"
expect 'an allowlisted crate the manifest no longer patches is a stale entry' 1 'title=Stale vendored-fork allowlist entry'
if [ -s "$FAKE_LOG" ]; then
  fail 'a stale entry still asked crates.io'
else
  pass 'and a stale entry asks crates.io nothing'
fi

run "$(tree drift 2.5.1 2.5.0)" 200 "$(crate_json 2.5.0 2.5.0)"
expect 'a pin that does not name the fork'"'"'s version is reported' 1 'title=Vendored fork and its pin disagree'

run "$(tree pre 2.5.0-rc.1 2.5.0-rc.1)" 200 "$(crate_json 2.5.0 2.5.0)"
expect 'a fork of a pre-release has no comparison rule and says so' 1 'not a plain X.Y.Z'

printf '\nwhat it asks, and the real tree\n'
run "$OK_TREE" 200 "$(crate_json 2.5.0 2.5.0)"
case "$(cat "$FAKE_LOG")" in
  *'canari-ci'*'/tauri-plugin-websocket'*) pass 'it asks for the crate by name, with a User-Agent crates.io accepts' ;;
  *) fail "the request was not what crates.io needs: $(cat "$FAKE_LOG")" ;;
esac

REAL_VER="$(awk '/^\[/{p=($0=="[package]");next} p&&/^version/{gsub(/^version *= *"|".*$/,"");print;exit}' \
  "$REAL_ROOT/frontend/src-tauri/patches/tauri-plugin-websocket/Cargo.toml")"
run "$REAL_ROOT" 200 "$(crate_json "$REAL_VER" "$REAL_VER")"
expect "THIS repository's pin names its fork ($REAL_VER), so the watch reads the real tree" 0 'ok:'

printf '\n'
if [ "$FAIL" -ne 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
