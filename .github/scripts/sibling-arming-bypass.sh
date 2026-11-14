#!/bin/bash
# =================================================================================================
# DOES THE ARMING APP BYPASS A SIBLING'S RULESET WHILE THAT SIBLING STILL ARMS WITH `gh pr merge --auto`?
#
# WHY THE QUESTION EXISTS. The four repositories share `arm-auto-merge.yml` minus one declared
# difference (`# canari-only:shared`, tools/ecosystem-shape/shape.mjs): Canari arms with GitHub's
# `enablePullRequestAutoMerge` mutation, the three others with `gh pr merge --auto`. `gh` reads the
# merge state itself and, when a pull request looks mergeable to it, MERGES instead of arming. That
# is harmless where the App is an ordinary actor - the ruleset judges the merge, so `CI passed`
# does - and it is why the siblings keep the short step. It stops being harmless the day the App
# becomes a bypass actor of a sibling's ruleset: the merge `gh` chooses is then judged by nothing.
# Measured 2026-11-14: the App bypasses Canari's ruleset and none of the three others'.
# docs/wiki/ecosystem-convergence.md has the numbers.
#
# WHAT IS READ. `current_user_can_bypass` of every ACTIVE BRANCH ruleset, asked WITH THE APP'S OWN
# TOKEN - so the answer is about the actor that arms, not about a list this script would have to
# interpret. Then, only where the App can bypass, the sibling's workflow text.
#
# AN ANSWER NOBODY GAVE IS NEVER A PASS. Each of these fails the run under its own title:
#   - the API refused, or a ruleset did not carry the field;
#   - a repository has no active branch ruleset (nothing was read, so nothing was judged);
#   - THE CONTROL: the same token must answer `always` on Canari's own ruleset, where the bypass is
#     known to exist. A token that cannot see a bypass there cannot be believed when it sees none
#     elsewhere. If Canari's bypass is ever removed on purpose, this control goes red and is the
#     reminder to rewrite this script's premise, not to delete the line.
#
# Environment: GH_TOKEN (the App's token, valid on every repository named), CONTROL_REPO
# (owner/name of the repository whose bypass is known), SIBLINGS (space-separated owner/name).
# =================================================================================================
set -euo pipefail

: "${CONTROL_REPO:?CONTROL_REPO is required}"
: "${SIBLINGS:?SIBLINGS is required}"

ARM_PATH='.github/workflows/arm-auto-merge.yml'
# The same search as `arm-auto-merge-app.test.sh` B32: the flag wherever it sits, never
# `--disable-auto`.
AUTO_RE='gh pr merge( .*)? --auto([^-[:alnum:]]|$)'

PROBLEMS=0
problem() {
  printf '::error title=%s::%s\n' "$1" "$2"
  PROBLEMS=$((PROBLEMS + 1))
}

# One `<ruleset id> <answer>` line per active branch ruleset of a repository; `absent` when the
# field is missing. Fails when GitHub does not answer.
# `tr -d '\r'`: a jq built for Windows ends its lines with CRLF, and this runs there in the self-test.
bypass_answers() {
  local repo="$1" list ids id one
  list="$(gh api "repos/$repo/rulesets?per_page=100")" || return 1
  ids="$(jq -r '.[] | select(.target == "branch" and .enforcement == "active") | .id' <<<"$list" | tr -d '\r')" || return 1
  for id in $ids; do
    one="$(gh api "repos/$repo/rulesets/$id")" || return 1
    printf '%s %s\n' "$id" "$(jq -r '.current_user_can_bypass // "absent"' <<<"$one" | tr -d '\r')" || return 1
  done
}

# 0: the repository's arming step still calls `gh pr merge --auto`; 1: it does not; 2: unreadable.
arms_with_auto() {
  local repo="$1" text
  text="$(gh api "repos/$repo/contents/$ARM_PATH" -H 'Accept: application/vnd.github.raw')" || return 2
  [ -n "$text" ] || return 2
  # Comments are not code, and a `\` continuation is one command.
  if grep -vE '^ *#' <<<"$text" | sed -e ':a' -e '/\\$/N; s/\\\n */ /; ta' | grep -qE "$AUTO_RE"; then
    return 0
  fi
  return 1
}

printf 'control: %s\n' "$CONTROL_REPO"
if ! control="$(bypass_answers "$CONTROL_REPO")"; then
  problem 'Ruleset unreadable' "GitHub did not answer for $CONTROL_REPO's rulesets - nothing below can be believed."
elif ! grep -qE ' always$' <<<"$control"; then
  problem 'Control failed' "This token sees no ruleset bypass on $CONTROL_REPO (read: ${control//$'\n'/, }), where the arming App is a bypass actor. Either the token is not the App's, or the bypass was removed: in both cases a 'never' read on a sibling proves nothing."
else
  printf '  the token sees the bypass known to exist there (%s)\n' "${control//$'\n'/, }"
fi

for repo in $SIBLINGS; do
  printf '%s\n' "$repo"
  if ! answers="$(bypass_answers "$repo")"; then
    problem 'Ruleset unreadable' "GitHub did not answer for $repo's rulesets - its bypass was not read."
    continue
  fi
  if [ -z "$answers" ]; then
    problem 'No ruleset read' "$repo has no active branch ruleset this token can see - nothing was read, so nothing judges a merge there."
    continue
  fi
  if grep -qvE ' (never|always|pull_requests_only|exempt)$' <<<"$answers"; then
    problem 'Ruleset unreadable' "$repo answered something else than a bypass mode (${answers//$'\n'/, }) - its bypass was not read."
    continue
  fi
  if ! grep -qvE ' never$' <<<"$answers"; then
    printf '  the App bypasses nothing (%s)\n' "${answers//$'\n'/, }"
    continue
  fi
  rc=0
  arms_with_auto "$repo" || rc=$?
  case "$rc" in
    0)
      problem 'Unjudged merge possible' "The arming App can bypass a ruleset of $repo (${answers//$'\n'/, }) and its $ARM_PATH still calls 'gh pr merge --auto', which merges by itself when the pull request looks mergeable. Port Canari's arming step (the mutation and its gated merge) to $repo, or remove the App from the bypass actors."
      ;;
    1)
      printf '  the App can bypass (%s), and the arming step no longer calls gh pr merge --auto\n' "${answers//$'\n'/, }"
      ;;
    *)
      problem 'Workflow unreadable' "The arming App can bypass a ruleset of $repo (${answers//$'\n'/, }) and its $ARM_PATH could not be read - whether it still calls 'gh pr merge --auto' is unknown."
      ;;
  esac
done

if [ "$PROBLEMS" -gt 0 ]; then
  printf '%s problem(s).\n' "$PROBLEMS"
  exit 1
fi
printf 'No sibling lets the arming App bypass its ruleset while arming with gh pr merge --auto.\n'
