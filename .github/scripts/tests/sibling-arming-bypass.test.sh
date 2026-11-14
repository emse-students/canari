#!/bin/bash
# =================================================================================================
# THE GUARD'S JUDGEMENT, AGAINST A FAKE `gh`, WITH NO NETWORK AND NO TOKEN.
#
# What is at risk is a green run that read nothing: a refused API, a missing field, a repository
# with no ruleset or whose ruleset requires nothing, a token that is not the App's, no sibling at
# all. Each is its own case and must fail under its own title; the real verdicts (bypass with
# `--auto` fails, no bypass passes, a ported step passes on positive evidence only) frame them.
#
# The fake answers `gh api <path>` from a directory of fixture files named after the path; a path
# with no fixture is a refusal (exit 1), exactly what `gh api` does on a 403 or a 404.
# =================================================================================================
# The workflow fixtures are shell TEXT the guard reads, so their `$PR` must stay unexpanded.
# shellcheck disable=SC2016
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
# gh api <path> [--paginate] [-H ...]
[ "$1" = api ] || { echo "fake gh: unexpected call: $*" >&2; exit 2; }
key="$(printf '%s' "$2" | tr '/?=&' '____')"
[ -f "$FIXTURES/$key" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
cat "$FIXTURES/$key"
FAKE
chmod +x "$WORK/bin/gh"

CONTROL='o/control'
SIB='o/sib'

# `ruleset <dir> <repo> <id> <target> <enforcement> <bypass|-> [check] [ref]` adds one ruleset to a
# repository's list and its detail. `-` leaves `current_user_can_bypass` out of the detail; `check`
# is the status check it requires (`CI passed` by default, `-` for none); `ref` is what it applies
# to (`~DEFAULT_BRANCH` by default).
ruleset() {
  local dir="$1" repo="$2" id="$3" target="$4" enforcement="$5" bypass="$6"
  local check="${7:-CI passed}" ref="${8:-~DEFAULT_BRANCH}"
  local base="$dir/repos_${repo//\//_}_rulesets"
  local list="${base}_per_page_100"
  [ -f "$list" ] || printf '[]' >"$list"
  jq --argjson id "$id" --arg t "$target" --arg e "$enforcement" \
    '. + [{id: $id, target: $t, enforcement: $e}]' "$list" >"$list.new" && mv "$list.new" "$list"
  jq -n --argjson id "$id" --arg bypass "$bypass" --arg check "$check" --arg ref "$ref" '
    {id: $id, conditions: {ref_name: {include: [$ref], exclude: []}},
     rules: ([{type: "deletion"}] + (if $check == "-" then [] else
       [{type: "required_status_checks", parameters: {required_status_checks: [{context: $check}]}}] end))}
    + (if $bypass == "-" then {} else {current_user_can_bypass: $bypass} end)' >"${base}_$id"
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

SIBLINGS_FOR_RUN="$SIB"
run() { # <fixture dir> -> sets OUT and CODE
  OUT="$(FIXTURES="$1" PATH="$WORK/bin:$PATH" GH_TOKEN=x CONTROL_REPO="$CONTROL" SIBLINGS="$SIBLINGS_FOR_RUN" bash "$GUARD" 2>&1)"
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

printf 'the verdicts:\n'

d="$(fixtures no-bypass)"
ruleset "$d" "$SIB" 7 branch active never
run "$d"
expect 'no bypass on the sibling, the check required: green, and its workflow is not even asked for' 0 'the App bypasses nothing, and CI passed is required (7 never judges)'
expect 'and the green line counts what it judged' 0 'Judged 1 sibling(s)'

d="$(fixtures bypass-auto)"
ruleset "$d" "$SIB" 7 branch active always
workflow "$d" "$SIB" "$WITH_AUTO"
run "$d"
expect 'bypass and gh pr merge --auto: red, accusing' 1 '::error title=Unjudged merge possible::'

for mode in pull_requests_only exempt; do
  d="$(fixtures "bypass-$mode")"
  ruleset "$d" "$SIB" 7 branch active "$mode"
  workflow "$d" "$SIB" "$WITH_AUTO"
  run "$d"
  expect "a '$mode' answer is a bypass" 1 '::error title=Unjudged merge possible::'
done

d="$(fixtures bypass-one-of-two)"
ruleset "$d" "$SIB" 7 branch active never
ruleset "$d" "$SIB" 8 branch active always
workflow "$d" "$SIB" "$WITH_AUTO"
run "$d"
expect 'one bypassed ruleset among several is enough' 1 '::error title=Unjudged merge possible::'

d="$(fixtures bypass-continued)"
ruleset "$d" "$SIB" 7 branch active always
workflow "$d" "$SIB" '          gh pr merge "$PR" \
            --squash --auto'
run "$d"
expect 'the flag on a continued line is found' 1 '::error title=Unjudged merge possible::'

d="$(fixtures bypass-ported)"
ruleset "$d" "$SIB" 7 branch active always
workflow "$d" "$SIB" '          # it used to be: gh pr merge "$PR" --auto --squash
          gh api graphql -f query="mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }"
          gh pr merge "$PR" --disable-auto --repo "$REPO"'
run "$d"
expect 'bypass, and the step sends the mutation (a comment and --disable-auto do not count): green' 0 'sends the mutation and no gh pr merge --auto'

d="$(fixtures bypass-both)"
ruleset "$d" "$SIB" 7 branch active always
workflow "$d" "$SIB" "          gh api graphql -f query='mutation { enablePullRequestAutoMerge }'
$WITH_AUTO"
run "$d"
expect 'the mutation beside a remaining --auto is still red' 1 '::error title=Unjudged merge possible::'

d="$(fixtures bypass-unrecognised)"
ruleset "$d" "$SIB" 7 branch active always
workflow "$d" "$SIB" '          gh pr merge "$PR" --squash --admin
          # enablePullRequestAutoMerge is only named in this comment'
run "$d"
expect 'bypass and a step that is neither spelling: red, never taken for ported' 1 '::error title=Arming unrecognised::'

d="$(fixtures bypass-not-a-workflow)"
ruleset "$d" "$SIB" 7 branch active always
workflow "$d" "$SIB" '{"message": "something that is not a workflow"}'
run "$d"
expect 'bypass and a text that is no arming step at all: red' 1 '::error title=Arming unrecognised::'

printf '\nthe ruleset must still judge something:\n'

d="$(fixtures no-check)"
ruleset "$d" "$SIB" 7 branch active never -
run "$d"
expect 'no bypass, but no required check: red' 1 '::error title=Nothing requires the check::'

d="$(fixtures other-check)"
ruleset "$d" "$SIB" 7 branch active never 'lint'
run "$d"
expect 'another check than the one named is not the check' 1 '::error title=Nothing requires the check::'

d="$(fixtures other-branch)"
ruleset "$d" "$SIB" 7 branch active never 'CI passed' 'refs/heads/release'
run "$d"
expect 'the check required on another branch than the default: red' 1 '::error title=Nothing requires the check::'

d="$(fixtures all-branches)"
ruleset "$d" "$SIB" 7 branch active never 'CI passed' '~ALL'
run "$d"
expect 'the check required on every branch covers the default one: green' 0 '(7 never judges)'

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
expect 'the field is absent from the answer: red, not "never"' 1 '(7 absent judges)'

d="$(fixtures field-unknown)"
ruleset "$d" "$SIB" 7 branch active maybe
run "$d"
expect 'a value that is no bypass mode: red' 1 "::error title=Ruleset unreadable::$SIB answered something else"

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

d="$(fixtures no-sibling)"
SIBLINGS_FOR_RUN=' '
run "$d"
SIBLINGS_FOR_RUN="$SIB"
expect 'a SIBLINGS that names nobody: red, although the control is sound' 1 '::error title=No sibling named::'

d="$WORK/control-blind"
mkdir -p "$d"
ruleset "$d" "$CONTROL" 1 branch active never
ruleset "$d" "$SIB" 7 branch active never
run "$d"
expect 'the control sees no bypass where one is known: red although the sibling reads never' 1 '::error title=Control failed::'

d="$WORK/control-partial"
mkdir -p "$d"
ruleset "$d" "$CONTROL" 1 branch active pull_requests_only
ruleset "$d" "$SIB" 7 branch active never
run "$d"
expect 'a control that is a bypass but not "always" is not the known one: red' 1 '::error title=Control failed::'

d="$WORK/control-refused"
mkdir -p "$d"
ruleset "$d" "$SIB" 7 branch active never
run "$d"
expect 'the control itself is refused: red' 1 "::error title=Ruleset unreadable::GitHub did not answer for $CONTROL"

printf '\nthe guard is wired:\n'
SCHED="$HERE/../../workflows/scheduled.yml"
JOB="$(sed -n '/^  arming-bypass:$/,/^  [a-z][a-z0-9-]*:$/p' "$SCHED")"
if grep -qF 'bash .github/scripts/sibling-arming-bypass.sh' <<<"$JOB"; then
  pass 'scheduled.yml has an arming-bypass job that runs the guard'
else
  fail 'scheduled.yml has no arming-bypass job running .github/scripts/sibling-arming-bypass.sh'
fi
# The token must reach every repository the script is told to read: the control and each sibling.
missing=''
read -r -a named <<<"$(grep -oE "SIBLINGS: '[^']+'" <<<"$JOB" | sed "s/SIBLINGS: '//; s/'$//")"
for name in "${named[@]}"; do
  grep -qE "^ +${name#*/}\$" <<<"$JOB" || missing="$missing $name"
done
if [ -z "$missing" ] && [ "$(grep -oE "emse-students/(Sky|MiGallery|refonte-portail-etu)" <<<"$JOB" | sort -u | wc -l | tr -d ' ')" = 3 ]; then
  pass 'it names the three siblings, and the token is minted for each of them'
else
  fail "scheduled.yml's SIBLINGS must name the three siblings, each in the token's repositories (missing:$missing)"
fi
if grep -qE '^ +canari$' <<<"$JOB" && grep -qF 'permission-contents: read' <<<"$JOB"; then
  pass 'the token also covers the control repository, and is narrowed to reading'
else
  fail 'the token must list the control repository (canari) and carry permission-contents: read'
fi

printf '\n'
if [ "$FAIL" -gt 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
