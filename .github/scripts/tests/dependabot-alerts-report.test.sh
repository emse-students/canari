#!/bin/bash
# =================================================================================================
# THE REPORT'S JUDGEMENT, ON FIXTURES, WITH NO NETWORK AND NO TOKEN.
#
# WHAT IS ACTUALLY AT RISK HERE. This report's failure mode is not a wrong error message, it is a
# report that says "no open alerts" when nothing looked. Every mechanism it replaces failed exactly
# that way: `cargo audit` exited 0 on a tree carrying GHSA-7gcf-g7xr-8hxj, and two cargo directories
# produced no Dependabot pull request for 25 days while looking exactly like directories with
# nothing to update. So the assertions below are mostly about the SILENT cases - a refusal, a
# disabled feature, an unreachable API, a response whose shape changed - and each one is pinned as a
# distinct sentence, because a reader who cannot tell them apart cannot act on any of them.
#
# The script separates `gather` (talks to GitHub) from `judge` (reads facts) exactly so this can
# exist: every case below is a facts file, and none of them needs a repository.
# =================================================================================================
set -uo pipefail

# shellcheck source-path=SCRIPTDIR
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT="$HERE/../dependabot-alerts-report.sh"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

[ -r "$REPORT" ] || {
  printf 'cannot read %s\n' "$REPORT"
  exit 1
}
# shellcheck disable=SC1090
. "$REPORT"

command -v jq >/dev/null 2>&1 || {
  printf 'jq is required by the report and by this test\n'
  exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# `facts <name> <transport> [alerts-json]` writes a facts file the way `gather` does, %q included -
# `judge` SOURCES this file, so an unquoted brace or quote in a JSON payload would be shell syntax
# rather than data.
facts() {
  local f="$WORK/$1" transport="$2" alerts="${3:-}"
  printf 'transport=%s\n' "$transport" >"$f"
  [ -n "$alerts" ] && printf 'alerts=%q\n' "$alerts" >>"$f"
  printf '%s' "$f"
}

# Runs `judge` in a subshell so the `.` of one facts file cannot leak into the next case.
code_of() { (judge "$1" >/dev/null 2>&1); printf '%s' "$?"; }
text_of() { (judge "$1" 2>&1) || true; }

# One alert, shaped as GitHub returns it - the real GHSA that started this, in the manifest
# Dependabot cannot open a pull request for. `--paginate` yields a stream of arrays, so the payload
# is an array and `judge` flattens with `jq -s`.
ONE_ALERT='[{"number":210,"state":"open",
  "security_advisory":{"ghsa_id":"GHSA-7gcf-g7xr-8hxj","severity":"medium"},
  "security_vulnerability":{"first_patched_version":{"identifier":"3.14.1"}},
  "dependency":{"package":{"ecosystem":"rust","name":"serde_with"},"manifest_path":"frontend/src-tauri/Cargo.lock"}}]'

UNPATCHED='[{"number":7,"state":"open",
  "security_advisory":{"ghsa_id":"GHSA-aaaa-bbbb-cccc","severity":"high"},
  "security_vulnerability":{},
  "dependency":{"package":{"ecosystem":"npm","name":"left-pad"},"manifest_path":"frontend/package.json"}}]'

printf 'the four causes of an empty answer, kept apart:\n'

f="$(facts clean ok '[]')"
[ "$(code_of "$f")" = "0" ] &&
  pass "an empty list from a request that SUCCEEDED is the only clean answer" ||
  fail "a genuinely empty alert list should pass"

case "$(text_of "$f")" in
  *'no open Dependabot alert'*) pass "and it says GitHub looked, not merely that nothing was found" ;;
  *) fail "the clean line does not say who looked" ;;
esac

f="$(facts forbidden forbidden)"
[ "$(code_of "$f")" = "1" ] &&
  pass "a 403 FAILS the run - a refusal is not a clean report" ||
  fail "a 403 must fail: nothing looked"

case "$(text_of "$f")" in
  *'security-events: read'*) pass "and it names the permission that would lift it" ;;
  *) fail "the 403 arm must name the missing permission, or nobody can act on it" ;;
esac

f="$(facts notfound not-found)"
[ "$(code_of "$f")" = "1" ] &&
  pass "a 404 FAILS the run - a DISABLED alert list reads exactly like a clean one" ||
  fail "a 404 must fail"

case "$(text_of "$f")" in
  *DISABLED*) pass "and it names the disabled feature as the first candidate" ;;
  *) fail "the 404 arm must say the feature may be off" ;;
esac

f="$(facts down unreachable)"
[ "$(code_of "$f")" = "1" ] &&
  pass "an unreachable API FAILS - a transport failure is not an answer" ||
  fail "an unreachable API must fail, since nothing is behind this run"

f="$(facts norepo no-repo)"
[ "$(code_of "$f")" = "1" ] &&
  pass "an unset GITHUB_REPOSITORY FAILS rather than reporting on nothing" ||
  fail "with no repository there is nothing to report and that must be loud"

printf '\nand a real finding is described well enough to act on:\n'

f="$(facts one ok "$ONE_ALERT")"
[ "$(code_of "$f")" = "1" ] &&
  pass "one open alert fails the run" ||
  fail "an open alert must fail the run"

out="$(text_of "$f")"
for needle in 'GHSA-7gcf-g7xr-8hxj' 'medium' 'serde_with' 'rust' 'frontend/src-tauri/Cargo.lock' '3.14.1'; do
  case "$out" in
    *"$needle"*) pass "the finding carries $needle" ;;
    *) fail "the finding does not carry $needle, and every one of them decides what to do next" ;;
  esac
done

case "$out" in
  *'::error::'*) pass "and it is an error annotation, so it is legible without opening the log" ;;
  *) fail "findings must be error annotations - a red run IS the report" ;;
esac

f="$(facts unpatched ok "$UNPATCHED")"
case "$(text_of "$f")" in
  *'NO patched version'*) pass "an alert with no fix available says so, instead of printing 'null'" ;;
  *) fail "an unpatched alert must be distinguishable from a patched one" ;;
esac

printf '\nand a response whose SHAPE changed is reported, never read as zero:\n'

f="$(facts garbage ok 'this is not json')"
[ "$(code_of "$f")" = "1" ] &&
  pass "an unparseable payload fails instead of counting as no alerts" ||
  fail "unparseable JSON must not be read as an empty list - that is the whole defect class"

# The counted-but-undescribable case: valid JSON, right count, none of the fields this reader wants.
# It is the shape that a future API change would produce, and reading it as "nothing to report"
# would be the same silence one layer deeper.
f="$(facts shifted ok '[{"number":1,"state":"open"}]')"
[ "$(code_of "$f")" = "1" ] &&
  pass "an alert that cannot be described still fails, and accuses this reader" ||
  fail "a described-nothing response must fail"

printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf 'all %s assertions passed\n' "$PASS"
else
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
