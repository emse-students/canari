#!/usr/bin/env bash
#
# ARMS GitHub's auto-merge on ONE Dependabot pull request, and asks Dependabot to rebuild a branch
# whose gates have moved under it.
#
# IT USED TO MERGE, AND THAT WAS THE PROBLEM (stage 2 of 2, 2026-09-03). Until today this script
# read every check-run on the head commit, decided for itself whether the pull request was green,
# and squash-merged it - a SECOND merge mechanism running beside GitHub's own auto-merge, so a
# Dependabot pull request and a human's took different routes to `main` (user: *"le auto-merge et
# les CI doivent considerer toutes les PR, les miennes ou dependabot"*). Three things followed from
# that and all three are gone with it:
#
#   * A SECOND OPINION ABOUT WHICH JOBS MATTER. "at least one check exists, all completed, none
#     bad" is not the same statement as `CI passed`, the one check the branch ruleset requires, and
#     nothing compared the two. The ruleset's answer is now the only answer.
#   * A MERGE THAT RAISED NO `push`. It merged with `GITHUB_TOKEN`, and GitHub's anti-recursion
#     rule means such a merge emits no `push` event - so `main` got no CI run, carried no
#     `CI passed` check, and `release-preflight.sh`'s third gate would refuse every release built
#     on it. The workaround was a manual `gh workflow run pull-request.yml` dispatch, which is
#     deleted with the merge that needed it. **Arming with the App token is what makes the merge
#     raise the event**, exactly as it does for a human's pull request.
#   * A CEILING ASKED TWICE. `dependency-ceiling.sh` is a job of `pull-request.yml` feeding
#     `ci-passed` since stage 1, so an update with no gate cannot merge by ANY route - measured on
#     the rebased #309: `Dependency ceiling -> FAILURE`, then `CI passed -> FAILURE`. A copy of
#     that decision here would be a duplicate of a binding check, and the annotation the check
#     emits carries the same text - the name of the missing test - that the comment used to.
#
# WHAT THIS SCRIPT IS STILL FOR, because GitHub's auto-merge does neither:
#
#   CONVERGENCE  the caller enumerates every open Dependabot pull request and arms each, so the
#                correct state is reached from ANY starting state. On 2026-08-31 seven mergeable
#                green pull requests sat untouched: their checks had finished days earlier, so no
#                future event would ever name them again. An automation that acts only on what it
#                happened to catch is not one that runs on its own.
#   STALENESS    GitHub re-evaluates a pull request when the PULL REQUEST changes, never when the
#                BASE does. A green suite is evidence about the gates that produced it; when those
#                move, the branch has to be rebuilt, and only Dependabot can rebuild it.
#
# Usage: dependabot-auto-merge.sh <pr-number>
# Prints `ARMED <pr>` when auto-merge is set, and `STALE <pr>` when the branch needs rebuilding.
# Never exits non-zero for a pull request it declines to touch: a sweep must not be stopped by one
# branch.
#
# FAIL-CLOSED ON THE AUTHOR, HERE rather than in the caller: a guard written once in the place that
# does the arming cannot be bypassed by adding a third trigger later.
set -uo pipefail

pr="${1:?usage: dependabot-auto-merge.sh <pr-number>}"
: "${REPO:?REPO must be set}"
: "${GH_TOKEN:?GH_TOKEN must be set}"

# The staleness predicate lives beside this script so it can be exercised on inputs GitHub will
# not produce on demand; see `lib/gate-moves.sh` and its self-tests.
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/gate-moves.sh
. "$(dirname "$0")/lib/gate-moves.sh"

# `baseRefName` IS READ HERE AND NOT ASSUMED. It stopped being constant once Dependabot briefly
# targeted a second branch, and everything downstream that used to name `main` as a literal - the
# staleness comparison, the conflict message - is about THIS pull request's own base.
meta=$(gh pr view "$pr" --repo "$REPO" --json author,state,headRefOid,mergeable,baseRefName \
  --jq '"\(.author.login)|\(.state)|\(.headRefOid)|\(.mergeable)|\(.baseRefName)"') || {
  echo "#$pr: could not be read; skipping."
  exit 0
}

IFS='|' read -r author state head_sha mergeable base_ref <<<"$meta"

if [ "$author" != "app/dependabot" ] && [ "$author" != "dependabot[bot]" ]; then
  echo "#$pr: author is '$author', not Dependabot; refusing."
  exit 0
fi
if [ "$state" != "OPEN" ]; then
  echo "#$pr: state is $state; nothing to do."
  exit 0
fi

echo "#$pr: head=$head_sha mergeable=$mergeable base=$base_ref"

# -----------------------------------------------------------------------------------------------
# A GREEN CHECK IS EVIDENCE ABOUT THE WORKFLOW THAT PRODUCED IT
# -----------------------------------------------------------------------------------------------
# NOT about the workflow on the base branch today, and `lib/gate-moves.sh` carries the incident
# that says so along with the predicate itself.
#
# THIS IS THE PROPERTY GITHUB'S AUTO-MERGE DOES NOT HAVE, which is the whole reason this script
# survives stage 2. GitHub re-evaluates when the pull request changes; a base that moves under a
# branch invalidates its evidence without touching it, and nothing on GitHub's side notices.
#
# Until 2026-09-01 this asked `base_sha != main_sha`, which made the queue undrainable rather than
# careful: every merge moves the base, so every remaining pull request went stale in the same
# instant, and the only exit was a rebuild NOTHING HERE CAN PERFORM - `PUT /update-branch` poisons
# the branch, and `@dependabot recreate` is refused when the caller is `github-actions[bot]`
# (measured on #303: *"Sorry, only users with push access can use that command."*). A gate whose
# only remedy is unavailable is not a gate, it is a stop, and it stopped seven mergeable pull
# requests.
tip_sha=$(gh api "repos/$REPO/commits/$base_ref" --jq '.sha') || {
  echo "#$pr: could not read $base_ref; skipping rather than arming on an unknown base."
  exit 0
}
base_sha=$(gh pr view "$pr" --repo "$REPO" --json baseRefOid --jq '.baseRefOid')

if [ "$base_sha" != "$tip_sha" ]; then
  # One call: the changed-file count on the first line, then one filename per line - exactly the
  # payload `classify_gate_moves` is specified and tested against.
  compare=$(gh api "repos/$REPO/compare/$base_sha...$tip_sha" \
    --jq '((.files // []) | length), ((.files // []) | .[].filename)') || compare="gh: compare failed"

  verdict=$(printf '%s\n' "$compare" | classify_gate_moves)
  case "$verdict" in
    settled\ *)
      echo "#$pr: built on ${base_sha:0:8}, $base_ref is ${tip_sha:0:8} - ${verdict#settled } file(s) changed, none of them a gate definition; its checks still describe today's gates."
      ;;
    moved\ *)
      echo "#$pr: built on ${base_sha:0:8}, $base_ref is ${tip_sha:0:8}, and the gate definitions moved between them: ${verdict#moved }"
      echo "STALE $pr"
      exit 0
      ;;
    *)
      echo "#$pr: cannot compare ${base_sha:0:8}..${tip_sha:0:8} - ${verdict#undecidable }. Treating the gates as moved."
      echo "STALE $pr"
      exit 0
      ;;
  esac
fi

# A HEAD DEPENDABOT DID NOT WRITE IS UNMERGEABLE BY EVERY PATH, AND NOTHING ELSE HERE WOULD SAY SO.
# GitHub parks the `pull_request` run of a branch pushed by anything other than Dependabot in
# `action_required` - waiting for a human to click Approve - and Dependabot then declines the branch
# for good ("this PR has been edited by someone other than Dependabot"). Such a branch is not stale:
# its base can be current, so the check above passes it straight through, and arming it would wait
# on checks that never complete. #299 is the live example.
#
# Measured on the STATE and not on how the state came about, so a branch touched by a maintainer, by
# a bad rebase, or by an earlier version of this very workflow converges the same way: it is
# rebuilt, and the rebuild is Dependabot's.
head_author=$(gh api "repos/$REPO/commits/$head_sha" --jq '.author.login // ""')
if [ "$head_author" != "dependabot[bot]" ]; then
  echo "#$pr: head ${head_sha:0:8} was written by '${head_author:-unknown}', not dependabot[bot] - its checks cannot run unattended."
  echo "STALE $pr"
  exit 0
fi

# -----------------------------------------------------------------------------------------------
# THE ARMING
# -----------------------------------------------------------------------------------------------
# NO CHECK READING AT ALL, AND THAT IS THE POINT. `--auto` hands the decision to GitHub, which
# merges the instant the required check passes and never before. Arming is a declaration of intent,
# not a verdict - so this asks nothing about green, and the repository keeps exactly one answer to
# "did the tests pass": `CI passed`, which the branch ruleset requires.
#
# `mergeable` IS NOT CONSULTED EITHER. `CONFLICTING` is a fact about the branch rather than a
# verdict on the update: Dependabot rebases, and GitHub merges the armed pull request when it
# becomes mergeable. `UNKNOWN` means GitHub has not finished computing it, which it always does
# eventually. Both used to cost a whole pass; neither costs anything now.
#
# NO `--delete-branch`: it is a NO-OP alongside `--auto` - `gh` deletes after a merge IT made, and
# `--auto` makes none. `delete_branch_on_merge` does the work, and is inventoried in
# `infrastructure/MIGRATION.md` section 3bis.
echo "#$pr: arming GitHub's auto-merge"
if arm_out=$(gh pr merge "$pr" --repo "$REPO" --auto --squash 2>&1); then
  echo "ARMED $pr"
  exit 0
fi

# ALREADY ARMED IS NOT A FAILURE, and it is the ordinary case: this runs on every check-suite
# completion AND on a schedule, so most passes meet pull requests that are already armed.
if printf '%s' "$arm_out" | grep -qiE 'already enabled|already set'; then
  echo "#$pr: already armed."
  exit 0
fi

# ANYTHING ELSE IS A REAL PROBLEM AND SAYS SO, without stopping the sweep - the next pull request
# may well arm cleanly, and a whole pass lost to one branch is the queue nobody drains. The two
# causes worth recognising on sight: `allow_auto_merge` turned off on the repository, and an App
# token that has lost `Pull requests: write`.
echo "#$pr: arming was refused - $arm_out"
echo "#$pr: if this is repo-wide, check allow_auto_merge and the canari-auto-merge App's Pull requests: write (MIGRATION.md section 3bis)."
exit 0
