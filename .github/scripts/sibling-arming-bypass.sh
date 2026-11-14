#!/bin/bash
# =================================================================================================
# DOES THE ARMING APP BYPASS A SIBLING'S RULESET WHILE THAT SIBLING STILL ARMS WITH `gh pr merge --auto`?
#
# WHY THE QUESTION EXISTS. The four repositories share `arm-auto-merge.yml` minus one declared
# difference (`# canari-only:shared`, tools/ecosystem-shape/shape.mjs): Canari arms with GitHub's
# `enablePullRequestAutoMerge` mutation, the three others with `gh pr merge --auto`. `gh` reads the
# merge state itself and, when a pull request looks mergeable to it, MERGES instead of arming. That
# is harmless where the App is an ordinary actor - the ruleset judges the merge, so the required
# check does - and it is why the siblings keep the short step. It stops being harmless the day the
# App becomes a bypass actor of a sibling's ruleset, or the day that ruleset stops requiring the
# check: the merge `gh` chooses is then judged by nothing.
# Measured 2026-11-14: the App bypasses Canari's ruleset and none of the three others', and all
# four require the check on the default branch. docs/wiki/ecosystem-convergence.md has the numbers.
#
# WHAT IS READ, per sibling, from every ACTIVE BRANCH ruleset:
#   - `current_user_can_bypass`, asked WITH THE APP'S OWN TOKEN - the answer is about the actor that
#     arms, not about a list this script would have to interpret;
#   - whether one of them requires the check on the default branch (`~DEFAULT_BRANCH` or `~ALL`);
#   - and, only where the App can bypass, the sibling's workflow text: red if it still calls
#     `gh pr merge --auto`, green ONLY on positive evidence that it arms with the mutation.
# Classic branch protection is not read: none of the four repositories uses it, and a repository
# that moved its required check there would read "nothing requires the check" here - red, on purpose.
#
# AN ANSWER NOBODY GAVE IS NEVER A PASS. Each of these fails the run under its own title:
#   - the API refused, or a ruleset did not carry the field, or carried a value that is no bypass mode;
#   - a repository has no active branch ruleset, or none that requires the check on its default branch;
#   - no sibling was named at all;
#   - THE CONTROL: the same token must answer `always` on Canari's own ruleset, where the bypass is
#     known to exist. A token that cannot see a bypass there cannot be believed when it sees none
#     elsewhere. If Canari's bypass is ever removed on purpose, this control goes red and is the
#     reminder to rewrite this script's premise, not to delete the line.
#
# Environment: GH_TOKEN (the App's token, valid on every repository named), CONTROL_REPO
# (owner/name of the repository whose bypass is known), SIBLINGS (space-separated owner/name),
# REQUIRED_CHECK (the status check a ruleset must require; `CI passed` when unset).
# =================================================================================================
set -euo pipefail

: "${CONTROL_REPO:?CONTROL_REPO is required}"
: "${SIBLINGS:?SIBLINGS is required}"
REQUIRED_CHECK="${REQUIRED_CHECK:-CI passed}"

ARM_PATH='.github/workflows/arm-auto-merge.yml'
# The same search as `arm-auto-merge-app.test.sh` B32: the flag wherever it sits, never
# `--disable-auto`.
AUTO_RE='gh pr merge( .*)? --auto([^-[:alnum:]]|$)'

PROBLEMS=0
problem() {
  printf '::error title=%s::%s\n' "$1" "$2"
  PROBLEMS=$((PROBLEMS + 1))
}

# One `<ruleset id> <bypass answer> <judges|silent>` line per active branch ruleset of a
# repository. `absent` when the bypass field is missing; `judges` when the ruleset requires
# REQUIRED_CHECK on the default branch. Fails when GitHub does not answer.
# `tr -d '\r'`: a jq built for Windows ends its lines with CRLF, and this runs there in the self-test.
ruleset_answers() {
  local repo="$1" list ids id one
  # `--paginate` yields one array per page, and jq reads each of them.
  list="$(gh api "repos/$repo/rulesets?per_page=100" --paginate)" || return 1
  ids="$(jq -r '.[] | select(.target == "branch" and .enforcement == "active") | .id' <<<"$list" | tr -d '\r')" || return 1
  for id in $ids; do
    one="$(gh api "repos/$repo/rulesets/$id")" || return 1
    printf '%s %s\n' "$id" "$(jq -r --arg check "$REQUIRED_CHECK" '
      [ (.current_user_can_bypass // "absent"),
        (if (((.conditions.ref_name.include // []) | map(select(. == "~DEFAULT_BRANCH" or . == "~ALL")) | length) > 0)
            and (([.rules[]? | select(.type == "required_status_checks")
                   | .parameters.required_status_checks[]?.context] | index($check)) != null)
         then "judges" else "silent" end)
      ] | join(" ")' <<<"$one" | tr -d '\r')" || return 1
  done
}

# How a repository's arming step arms: `auto` (it still calls `gh pr merge --auto`), `mutation`
# (it does not, and sends `enablePullRequestAutoMerge`), `unknown` (neither was found). Fails when
# the file cannot be read.
arming_of() {
  local repo="$1" text code
  text="$(gh api "repos/$repo/contents/$ARM_PATH" -H 'Accept: application/vnd.github.raw')" || return 1
  # Comments are not code, and a `\` continuation is one command.
  code="$(grep -vE '^ *#' <<<"$text" | sed -e ':a' -e '/\\$/N; s/\\\n */ /; ta')" || return 1
  if grep -qE "$AUTO_RE" <<<"$code"; then
    printf 'auto'
  elif grep -qF 'enablePullRequestAutoMerge' <<<"$code"; then
    printf 'mutation'
  else
    printf 'unknown'
  fi
}

flat() { printf '%s' "${1//$'\n'/, }"; }

printf 'control: %s\n' "$CONTROL_REPO"
if ! control="$(ruleset_answers "$CONTROL_REPO")"; then
  problem 'Ruleset unreadable' "GitHub did not answer for $CONTROL_REPO's rulesets - nothing below can be believed."
elif ! grep -qE '^[^ ]+ always ' <<<"$control"; then
  problem 'Control failed' "This token sees no ruleset bypass on $CONTROL_REPO (read: $(flat "$control")), where the arming App is a bypass actor. Either the token is not the App's, or the bypass was removed: in both cases a 'never' read on a sibling proves nothing."
else
  printf '  the token sees the bypass known to exist there (%s)\n' "$(flat "$control")"
fi

JUDGED=0
for repo in $SIBLINGS; do
  JUDGED=$((JUDGED + 1))
  printf '%s\n' "$repo"
  if ! answers="$(ruleset_answers "$repo")"; then
    problem 'Ruleset unreadable' "GitHub did not answer for $repo's rulesets - its bypass was not read."
    continue
  fi
  if [ -z "$answers" ]; then
    problem 'No ruleset read' "$repo has no active branch ruleset this token can see - nothing was read, so nothing judges a merge there."
    continue
  fi
  if grep -qvE '^[^ ]+ (never|always|pull_requests_only|exempt) (judges|silent)$' <<<"$answers"; then
    problem 'Ruleset unreadable' "$repo answered something else than a bypass mode ($(flat "$answers")) - its bypass was not read."
    continue
  fi
  if ! grep -qE ' judges$' <<<"$answers"; then
    problem 'Nothing requires the check' "No active branch ruleset of $repo requires '$REQUIRED_CHECK' on its default branch ($(flat "$answers")) - a merge its arming step chooses is judged by nothing, whoever bypasses."
    continue
  fi
  if ! grep -qvE '^[^ ]+ never ' <<<"$answers"; then
    printf '  the App bypasses nothing, and %s is required (%s)\n' "$REQUIRED_CHECK" "$(flat "$answers")"
    continue
  fi
  if ! arming="$(arming_of "$repo")"; then
    problem 'Workflow unreadable' "The arming App can bypass a ruleset of $repo ($(flat "$answers")) and its $ARM_PATH could not be read - how it arms is unknown."
    continue
  fi
  case "$arming" in
    auto)
      problem 'Unjudged merge possible' "The arming App can bypass a ruleset of $repo ($(flat "$answers")) and its $ARM_PATH still calls 'gh pr merge --auto', which merges by itself when the pull request looks mergeable. Port Canari's arming step (the mutation and its gated merge) to $repo, or remove the App from the bypass actors."
      ;;
    mutation)
      printf '  the App can bypass (%s), and the arming step sends the mutation and no gh pr merge --auto\n' "$(flat "$answers")"
      ;;
    *)
      problem 'Arming unrecognised' "The arming App can bypass a ruleset of $repo ($(flat "$answers")) and its $ARM_PATH neither calls 'gh pr merge --auto' nor sends enablePullRequestAutoMerge - what it does instead was not recognised, so it is not vouched for."
      ;;
  esac
done

if [ "$JUDGED" -eq 0 ]; then
  problem 'No sibling named' 'SIBLINGS names no repository - nothing was judged.'
fi

if [ "$PROBLEMS" -gt 0 ]; then
  printf '%s problem(s).\n' "$PROBLEMS"
  exit 1
fi
printf 'Judged %s sibling(s): none lets the arming App bypass its ruleset while arming with gh pr merge --auto.\n' "$JUDGED"
