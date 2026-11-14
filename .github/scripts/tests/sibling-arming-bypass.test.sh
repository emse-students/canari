#!/bin/bash
# =================================================================================================
# THE GUARD'S JUDGEMENT, AGAINST A FAKE `gh`, WITH NO NETWORK AND NO TOKEN.
#
# What is at risk is a green run that read nothing: a refused API, a missing field, a repository
# with no ruleset, a token that is not the App's. Each is its own case and must fail under its own
# title; the two real verdicts (bypass with `--auto` fails, no bypass passes) frame them.
#
# The fake answers `gh api <path>` from a directory of fixture files named after the path; a path
# with no fixture is a refusal (exit 1), exactly what `gh api` does on a 403 or a 404.
# =================================================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/../sibling-arming-bypass.sh"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

[ -r "$GUARD" ] || { printf 'cannot read %s\n' "$GUARD"; exit 1; }
command -v jq >/dev/null 2>&1 || { printf 'jq is required by the guard and by this test\n'; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
cat >"$WORK/bin/gh" <<'FAKE'
#!/bin/bash
# gh api <path> [-H ...]
[ "$1" = api ] || { echo "fake gh: unexpected call: $*" >&2; exit 2; }
key="$(printf '%s' "$2" | tr '/?=&' '____')"
[ -f "$FIXTURES/$key" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
cat "$FIXTURES/$key"
FAKE
chmod +x "$WORK/bin/gh"

CONTROL='o/control'
SIB='o/sib'

# `ruleset <dir> <repo> <id> <target> <enforcement> <bypass|->` adds one ruleset to a repository's
# list and its detail; `-` leaves `current_user_can_bypass` out of the detail.
ruleset() {
  local dir="$1" repo="$2" id="$3" target="$4" enforcement="$5" bypass="$6"
  local list="$dir/repos_${repo//\//_}_rulesets_per_page_100"
  [ -f "$list" ] || printf '[]' >"$list"
  jq --argjson id "$id" --arg t "$target" --arg e "$enforcement" \
    '. + [{id: $id, target: $t, enforcement: $e}]' "$list" >"$list.new" && mv "$list.new" "$list"
  if [ "$bypass" = '-' ]; then
    printf '{"id": %s}' "$id" >"$dir/repos_${repo//\//_}_rulesets_$id"
  else
    printf '{"id": %s, "current_user_can_bypass": "%s"}' "$id" "$bypass" >"$dir/repos_${repo//\//_}_rulesets_$id"
  fi
}
# `workflow <dir> <repo> <text>` is the sibling's arming workflow.
workflow() { printf '%s\n' "$3" >"$1/repos_${2//\//_}_contents_.github_workflows_arm-auto-merge.yml"; }

# A fresh fixture directory whose control is sound: the token sees Canari's bypass.
fixtures() {
  local dir="$WORK/$1"
  mkdir -p "$dir"
  ruleset "$dir" "$CONTROL" 1 branch active always
  printf '%s' "$dir"
}

run() { # <fixture dir> -> sets OUT and CODE
  OUT="$(FIXTURES="$1" PATH="$WORK/bin:$PATH" GH_TOKEN=x CONTROL_REPO="$CONTROL" SIBLINGS="$SIB" bash "$GUARD" 2>&1)"
  CODE=$?
}
# `expect <name> <code> <text that must be in the output>`
expect() {
  if [ "$CODE" = "$2" ] && grep -qF -- "$3" <<<"$OUT"; then
    pass "$1"
  else
    fail "$1 (exit $CODE, wanted $2 and '$3'): $(tr '\n' ' ' <<<"$OUT" | cut -c1-300)"
  fi
}

WITH_AUTO='          if gh pr merge "$PR" --auto --squash --repo "$REPO"; then'

printf 'the two verdicts:\n'

d="$(fixtures no-bypass)"
ruleset "$d" "$SIB" 7 branch active never
run "$d"
expect 'no bypass on the sibling: green, and its workflow is not even asked for' 0 'the App bypasses nothing (7 never)'

d="$(fixtures bypass-auto)"
ruleset "$d" "$SIB" 7 branch active always
workflow "$d" "$SIB" "$WITH_AUTO"
run "$d"
expect 'bypass and gh pr merge --auto: red, accusing' 1 '::error title=Unjudged merge possible::'

d="$(fixtures bypass-pr-only)"
ruleset "$d" "$SIB" 7 branch active pull_requests_only
workflow "$d" "$SIB" "$WITH_AUTO"
run "$d"
expect 'a bypass limited to pull requests is a bypass' 1 '::error title=Unjudged merge possible::'

d="$(fixtures bypass-one-of-two)"
ruleset "$d" "$SIB" 7 branch active never
ruleset "$d" "$SIB" 8 branch active always
workflow "$d" "$SIB" "$WITH_AUTO"
run "$d"
expect 'one bypassed ruleset among several is enough' 1 '::error title=Unjudged merge possible::'

d="$(fixtures bypass-ported)"
ruleset "$d" "$SIB" 7 branch active always
workflow "$d" "$SIB" '          # it used to be: gh pr merge "$PR" --auto --squash
          if arm_only; then
          gh pr merge "$PR" --disable-auto --repo "$REPO"'
run "$d"
expect 'bypass, but the step no longer calls --auto (a comment and --disable-auto do not count): green' 0 'no longer calls gh pr merge --auto'

d="$(fixtures bypass-continued)"
ruleset "$d" "$SIB" 7 branch active always
workflow "$d" "$SIB" '          gh pr merge "$PR" \
            --squash --auto'
run "$d"
expect 'the flag on a continued line is found' 1 '::error title=Unjudged merge possible::'

printf '\nan answer nobody gave is never a pass:\n'

d="$(fixtures api-refused)"
run "$d"
expect 'the sibling ruleset list is refused: red' 1 "::error title=Ruleset unreadable::GitHub did not answer for $SIB"

d="$(fixtures detail-refused)"
ruleset "$d" "$SIB" 7 branch active never
rm "$d/repos_o_sib_rulesets_7"
run "$d"
expect 'one ruleset detail is refused: red' 1 "::error title=Ruleset unreadable::GitHub did not answer for $SIB"

d="$(fixtures field-absent)"
ruleset "$d" "$SIB" 7 branch active -
run "$d"
expect 'the field is absent from the answer: red, not "never"' 1 '(7 absent)'

d="$(fixtures no-ruleset)"
printf '[]' >"$d/repos_o_sib_rulesets_per_page_100"
run "$d"
expect 'no ruleset at all: red' 1 '::error title=No ruleset read::'

d="$(fixtures only-inactive)"
ruleset "$d" "$SIB" 7 branch disabled never
ruleset "$d" "$SIB" 8 tag active never
run "$d"
expect 'only a disabled ruleset and a tag ruleset: nothing judges a branch, red' 1 '::error title=No ruleset read::'

d="$(fixtures workflow-refused)"
ruleset "$d" "$SIB" 7 branch active always
run "$d"
expect 'bypass and an unreadable workflow: red under its own title' 1 '::error title=Workflow unreadable::'

d="$WORK/control-blind"
mkdir -p "$d"
ruleset "$d" "$CONTROL" 1 branch active never
ruleset "$d" "$SIB" 7 branch active never
run "$d"
expect 'the control sees no bypass where one is known: red although the sibling reads never' 1 '::error title=Control failed::'

d="$WORK/control-refused"
mkdir -p "$d"
ruleset "$d" "$SIB" 7 branch active never
run "$d"
expect 'the control itself is refused: red' 1 "::error title=Ruleset unreadable::GitHub did not answer for $CONTROL"

printf '\nthe guard is wired:\n'
SCHED="$HERE/../../workflows/scheduled.yml"
if grep -qF 'bash .github/scripts/sibling-arming-bypass.sh' "$SCHED"; then
  pass 'scheduled.yml runs the guard'
else
  fail 'scheduled.yml does not run .github/scripts/sibling-arming-bypass.sh'
fi
# The three siblings the shape tool compares are the three this guard reads.
SHAPE="$HERE/../../../tools/ecosystem-shape/shape.mjs"
missing=''
for name in Sky MiGallery refonte-portail-etu; do
  grep -qE "SIBLINGS:.*emse-students/$name( |$|')" "$SCHED" || missing="$missing $name"
done
if [ -z "$missing" ] && [ -r "$SHAPE" ]; then
  pass 'it names the three sibling repositories'
else
  fail "scheduled.yml's SIBLINGS does not name:$missing"
fi

printf '\n'
if [ "$FAIL" -gt 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
