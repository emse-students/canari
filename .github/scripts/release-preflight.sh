#!/usr/bin/env bash
#
# MAY THIS RELEASE START? Answered once, before anything moves.
#
# THE FAIL-SAFE THIS USES ALREADY EXISTED. `cd.yml`, `android-release.yml` and `ios-release.yml` all
# gate on the bump run's `conclusion == 'success'`, so a refusal here refuses every deployment,
# every store upload and the version bump itself. That property was discovered by accident on
# 2026-09-03, when the bump's push was rejected and the whole chain quietly declined to run. This is
# the same mechanism, used on purpose.
#
# THE FIVE QUESTIONS, in the order that makes a refusal cheapest to read:
#
#   1. Is the version a version?          - a typo must not reach a store band computation
#   2. Is the released commit on `main`?  - everything downstream reads the trunk
#   3. Did the tests pass ON THAT COMMIT? - "if the tests are green" was written nowhere at all
#   4. Has dev already served it?         - stable releases only, and the reason this file exists
#   5. Are the release notes written?     - stable releases only; Apple REFUSES a submission
#                                           without them, and finding that out at the end costs
#                                           the bump, production, Play and a macOS build first
#
# WHY THERE IS NO BYPASS INPUT. A skip flag is a fallback path, and reaching one means the primary
# path failed - so the fix belongs there. The emergency path is unchanged and is not in software: a
# human with admin rights acting by other means, written into `CHANGELOG.md` when taken. The cost of
# question 4 in a real emergency is one extra pre-release, which deploys dev in minutes.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# `source-path` IS PER-COMMAND AND NOT PER-FILE - a copy elsewhere in the file does not reach this
# source, and shellcheck answers SC1091 for it.
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/release-preconditions.sh
source "$HERE/lib/release-preconditions.sh"

REPO="${REPO:-${GITHUB_REPOSITORY:-emse-students/canari}}"
VERSION="${VERSION:-}"
TARGET_SHA="${TARGET_SHA:-}"

# The check the branch ruleset already trusts as the single gate on a pull request. Asking for the
# same NAME here means the release and the merge agree on what "the tests passed" means, instead of
# this file keeping a second opinion about which jobs matter.
REQUIRED_CHECK="${REQUIRED_CHECK:-CI passed}"
export REQUIRED_CHECK

FAILED=0
step()   { printf '\n%s\n' "$1"; }
ok()     { printf '  ok      %s\n' "$1"; }
refuse() { FAILED=1; printf '  REFUSE  %s\n' "$1"; }
hint()   { printf '          %s\n' "$1"; }

[ -n "$VERSION" ]    || { printf 'VERSION is not set\n' >&2; exit 2; }
[ -n "$TARGET_SHA" ] || { printf 'TARGET_SHA is not set\n' >&2; exit 2; }

printf 'release preflight - %s at %s\n' "$VERSION" "${TARGET_SHA:0:8}"

# -- 1 -------------------------------------------------------------------------------------------
step 'the version is a version'
KIND_VERDICT="$(release_kind "$VERSION")"
KIND="${KIND_VERDICT%% *}"
case "$KIND" in
  stable)
    ok "$VERSION is a STABLE release - production and both store production channels"
    ;;
  prerelease)
    ok "$VERSION is a PRE-RELEASE (${KIND_VERDICT#prerelease }) - the dev estate and the tester programmes"
    ;;
  *)
    refuse "${KIND_VERDICT#invalid }"
    hint 'A release name decides the store version band and the target estate, and a typo cannot be'
    hint 'guessed at. Delete the release and publish it with a version this project can read.'
    printf '\npreflight REFUSED\n'
    exit 1
    ;;
esac

# -- 2 -------------------------------------------------------------------------------------------
step 'the released commit is on main, and the bump can still push'
# base = the released commit, head = main. `identical` or `ahead` both mean main contains it.
ON_MAIN="$(gh api "repos/$REPO/compare/$TARGET_SHA...main" --jq '.status' 2>/dev/null)" || ON_MAIN=""
case "$ON_MAIN" in
  identical|ahead)
    # THE SECOND HALF OF THIS GATE, and it exists because the first half passing was not enough.
    # `main` containing the commit is what "on main" means, but the bump pushes a commit built ON
    # the released commit, and that push fast-forwards only while `main` has not moved. The
    # released tree's own version tells the harmless no-op apart from the release that would die at
    # its second job; the preflight has that tree checked out, so the fact is free.
    TREE_VERSION="$(node -p "require('./frontend/package.json').version" 2>/dev/null)" || TREE_VERSION=''
    case "$(classify_main_position "$ON_MAIN" "$TREE_VERSION" "$VERSION")" in
      'pushable head')
        ok 'it is main HEAD, so the bump commit fast-forwards'
        ;;
      'pushable noop')
        ok "main has moved past it, but the tree already carries $VERSION - the bump writes nothing and pushes nothing"
        ;;
      'unpushable '*)
        refuse "main has moved past ${TARGET_SHA:0:8}, and this release still has to bump $TREE_VERSION -> $VERSION"
        hint 'The bump commits ON the released commit and pushes it to main, which is a fast-forward'
        hint 'only while main still points there. Something merged after this commit, so the push'
        hint 'would be rejected and the release would stop at its second job. Publish the release'
        hint 'from the current main instead - or, for a stable, publish a pre-release at that commit'
        hint 'first so dev serves it and the fourth gate is satisfied too.'
        ;;
      *)
        refuse 'could not tell whether the bump would be able to push to main'
        hint 'An undecidable answer is not permission. The released tree must state a version in'
        hint 'frontend/package.json - it is the file that decides what kind of release this is.'
        ;;
    esac
    ;;
  behind|diverged)
    refuse "main does not contain ${TARGET_SHA:0:8} - the compare says $ON_MAIN"
    hint 'Everything downstream reads main. A commit the trunk does not carry has not been through a'
    hint 'pull request, and the bump would push a history nobody reviewed.'
    ;;
  *)
    refuse 'could not compare the released commit against main'
    hint 'An unreadable answer is not permission. If it persists, the API or the token is the'
    hint 'problem, and no release should be started on a guess.'
    ;;
esac

# -- 3 -------------------------------------------------------------------------------------------
step "the tests passed on that commit - $REQUIRED_CHECK"
# The aggregate BY NAME, and its conclusion - not "no failing checks", which is also true of a
# commit nothing ever ran on. The name reaches jq through the environment rather than through a
# nested quote, which is one less thing to get wrong in a shell inside a YAML string.
# shellcheck disable=SC2016  # `$ENV.REQUIRED_CHECK` is a jq expression and MUST NOT be expanded by
# the shell - that is the whole point of passing the name through the environment. Double quotes
# here would substitute it before jq ever saw it, and the filter would then be a bare string.
CHECK_CONCLUSION="$(gh api "repos/$REPO/commits/$TARGET_SHA/check-runs?per_page=100" \
  --jq '.check_runs[] | select(.name == $ENV.REQUIRED_CHECK) | .conclusion' 2>/dev/null | tail -1)" \
  || CHECK_CONCLUSION=""
case "$CHECK_CONCLUSION" in
  success)
    ok "$REQUIRED_CHECK is green"
    ;;
  '')
    refuse "$REQUIRED_CHECK never ran on ${TARGET_SHA:0:8}"
    hint 'An ABSENT result is not a passing one. A commit that reached main through a pull request'
    hint 'carries this check; one that arrived another way does not - which is the case to refuse.'
    ;;
  *)
    refuse "$REQUIRED_CHECK concluded $CHECK_CONCLUSION on ${TARGET_SHA:0:8}"
    hint 'This is what shipped on 2026-09-03: the run was red and production deployed anyway,'
    hint 'because the chain required the BUMP to succeed and never the tests.'
    ;;
esac

# -- 4 -------------------------------------------------------------------------------------------
step 'the dev estate has already served this commit'
if [ "$KIND" != 'stable' ]; then
  ok 'not asked of a pre-release - deploying dev IS what a pre-release is for'
else
  DEV_SHA="$(gh api "repos/$REPO/git/ref/tags/dev-deployed" --jq '.object.sha' 2>/dev/null)" || DEV_SHA=""
  if [ -z "$DEV_SHA" ]; then
    refuse 'there is no dev-deployed marker, so nothing says the dev estate ever ran anything'
    hint 'Publish a pre-release first. The marker is written by the dev deploy itself.'
  else
    COVER="$(gh api "repos/$REPO/compare/$TARGET_SHA...$DEV_SHA" \
      --jq '.status, .ahead_by, .behind_by' 2>/dev/null | classify_dev_coverage)"
    case "$COVER" in
      'covered identical')
        ok "dev is at precisely ${DEV_SHA:0:8} - this exact commit"
        ;;
      'covered ahead '*)
        ok "dev is at ${DEV_SHA:0:8}, ${COVER#covered ahead } commit(s) further on, so this code went through it"
        ;;
      'uncovered behind '*)
        refuse "dev is at ${DEV_SHA:0:8} and is missing ${COVER#uncovered behind } commit(s) this release carries"
        hint 'PRODUCTION CANNOT BE AHEAD OF DEV. Publish a pre-release at this commit first: it'
        hint 'deploys dev.canari-emse.fr and the tester programmes, and it moves the marker this'
        hint 'check reads. Then publish the stable from the SAME commit, and it will be identical.'
        ;;
      'uncovered diverged '*)
        refuse "dev is at ${DEV_SHA:0:8} and neither commit contains the other - ${COVER#uncovered diverged }"
        hint 'Both markers are supposed to name commits on main, so one was written from a history'
        hint 'that is no longer reachable. Do not release until that is understood.'
        ;;
      *)
        refuse "could not tell whether dev has served this commit - ${COVER#undecidable }"
        hint 'An absent measurement is not permission.'
        ;;
    esac
  fi
fi

# -- 5 -------------------------------------------------------------------------------------------
step 'the App Store release notes are written for this version'
if [ "$KIND" != 'stable' ]; then
  ok 'not asked of a pre-release - a pre-release goes to TestFlight, which takes no release notes'
else
  # THE SAME CODE THE SUBMISSION RUNS, on purpose. Apple REQUIRES release notes and refuses the
  # submission without them, so the question has to be asked somewhere; asking it here costs a
  # second on an ubuntu runner, and asking it at the end costs the whole release - the bump, the
  # production deploy, the Play publish and a twenty-minute macOS build all happen first, and the
  # iOS half then fails alone, leaving a release that is shipped on one store and not the other.
  #
  # `--check-notes` is a MODE of the submission script rather than a rule restated in bash, because
  # two implementations of "valid release notes" drift and the drift is invisible: the preflight
  # would pass and Apple would refuse.
  if NOTES_OUT="$(MARKETING_VERSION="$VERSION" node tools/app-store/submit.mjs --check-notes 2>&1)"; then
    ok "$NOTES_OUT"
  else
    refuse "$NOTES_OUT"
    hint 'Apple refuses a submission with no release notes, and the notes file names its own version'
    hint 'so it cannot silently describe the release before last. Write it, first line'
    hint "\"version: $VERSION\", then publish this release again."
  fi
fi

printf '\n'
if [ "$FAILED" -ne 0 ]; then
  printf 'preflight REFUSED - nothing is bumped, nothing is deployed, no store receives anything.\n'
  exit 1
fi
printf 'preflight PASSED - %s may proceed.\n' "$VERSION"
