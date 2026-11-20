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
# THE EIGHT QUESTIONS, in the order that makes a refusal cheapest to read:
#
#   1. Is the version a version?          - a typo must not reach a store band computation
#   2. Is the released commit on `main`?  - it reached the trunk through a pull request; where
#                                           `main` points NOW is not asked (nothing pushes there);
#                                           a pre-release must also be the newest release
#                                           (a rerun of a stale alpha would move dev back)
#   3. Did the tests pass ON THAT COMMIT? - "if the tests are green" was written nowhere at all
#   4. Has dev already served it?         - stable releases only, and the reason this file exists;
#                                           first, is it EXACTLY the latest pre-release's commit
#                                           (owner, 2026-11-14: built from the last alpha, never main)
#   5. Are the release notes written?     - stable releases only; Apple REFUSES a submission
#                                           without them, and finding that out at the end costs
#                                           the bump, production, Play and a macOS build first
#   6. Does it ship a held migration      - one the owner must approve (a marker, or a statement
#      without the owner's approval?        that is not plainly additive) and has not; the deploy
#                                           would refuse it, after the store builds
#   7. Does an advisory touch what it     - stable releases only (owner, 2026-11-17); the PR
#      ships?                               audit's production closure, asked again at shipping
#   8. Would production MiConnect take    - stable releases only (review of #3486, 2026-11-19): its
#      this release's authentik pin?        step runs after both stores took the version, so the
#                                           morning's read-only verdict is read here instead
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
# The owner's hold on a migration - the deploy's own judge, read here by gate 6.
# shellcheck source-path=SCRIPTDIR source=../../infrastructure/lib/migration-hold.sh
source "$HERE/../../infrastructure/lib/migration-hold.sh"
# What each tree's shipped closure is, and what it ignores - the PR audit's own table, read by gate 7.
# shellcheck source-path=SCRIPTDIR source=lib/audit-trees.sh
source "$HERE/lib/audit-trees.sh"

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
step 'the released commit is on main'
# NO RELEASE PUSHES TO `main` ANY MORE (2026-10-30): every bump goes to `release/vX.Y.Z`, so `main`
# moving on after the cut is the ordinary case and refuses nothing. Containment is the whole
# question; `classify_on_main` carries why.
ON_MAIN_STATUS="$(gh api "repos/$REPO/compare/$TARGET_SHA...main" --jq '.status' 2>/dev/null)" || ON_MAIN_STATUS=""
ON_MAIN="$(classify_on_main "$ON_MAIN_STATUS")"
case "$ON_MAIN" in
  'on-main '*)
    ok "main contains ${TARGET_SHA:0:8} (${ON_MAIN#on-main }) - main may move on freely, the bump goes to release/v${VERSION%%-*}"
    ;;
  'off-main '*)
    refuse "main does not contain ${TARGET_SHA:0:8} - the compare says ${ON_MAIN#off-main }"
    hint 'A commit the trunk does not carry has not been through a pull request, and the release'
    hint 'would build and ship a history nobody reviewed.'
    ;;
  *)
    refuse "could not compare the released commit against main - ${ON_MAIN#undecidable }"
    hint 'An unreadable answer is not permission. If it persists, the API or the token is the'
    hint 'problem, and no release should be started on a guess.'
    ;;
esac

# Gate 2's second question, pre-releases only: nothing newer has already shipped. The `main still
# points at it` half used to refuse a stale pre-release by accident; `classify_prerelease_currency`
# carries why it is now asked on purpose (a rerun of a refused alpha after a later one shipped).
if [ "$KIND" = 'prerelease' ]; then
  # THE LIST IS CAPTURED FIRST AND ITS EXIT READ. Refs come back in NAME order, so `v1.10.*` sorts
  # before `v1.5.*` and the higher release can sit on a later page: a pagination that failed after
  # page one would hand the classifier a partial list, and it would answer `current` on missing
  # evidence. This script has no `set -e`, so a pipe would have ignored the failure.
  if TAGS="$(gh api --paginate "repos/$REPO/git/matching-refs/tags/v" --jq '.[].ref | sub("^refs/tags/"; "")' 2>&1)"; then
    CURRENCY="$(printf '%s\n' "$TAGS" | classify_prerelease_currency "$VERSION" "$HERE/../../scripts/bump-app-version.sh")"
  else
    CURRENCY="undecidable the tag list could not be read: $(printf '%s' "$TAGS" | tail -3 | tr '\n' ' ')"
  fi
  case "$CURRENCY" in
    "superseded v${VERSION%%-*}")
      # This version's own STABLE shipped, so no alpha of it can follow: the next one is the next
      # patch's first.
      CORE="${VERSION%%-*}"
      refuse "v$CORE, the stable of this version, has already been released"
      hint 'Both stores refuse a build number lower than one they already took, and a rerun re-reads'
      hint "the same tag. Cut the next patch's first pre-release at the current head of main instead:"
      hint "gh release create v${CORE%.*}.$(( ${CORE##*.} + 1 ))-alpha.1 --prerelease"
      ;;
    current)
      ok "no release carries a higher store build number than $VERSION"
      ;;
    'stale '*|'superseded '*)
      refuse "${CURRENCY#* } is newer than $VERSION and has already been released"
      hint 'Shipping this one now would move release/v'"${VERSION%%-*}"' and dev-deployed BACK to older'
      hint 'code, and both stores refuse a build number lower than one they already took. A rerun'
      hint 'of this run re-reads the same tag and is refused again: cut a NEW pre-release at the'
      hint "current head of main, numbered above ${CURRENCY#* } (gh release create vX.Y.Z-alpha.N --prerelease)."
      ;;
    *)
      refuse "could not tell whether a newer release exists - ${CURRENCY#undecidable }"
      hint 'An unreadable answer is not permission.'
      ;;
  esac
fi

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
    hint 'An ADMIN-MERGED commit (the emergency path) is this case too: the bypass skipped the check on'
    hint 'the pull request, and main'"'"'s own CI (~8 min after the merge) is what supplies it. Wait for'
    hint "'gh run list --branch main', then 'gh run rerun' this run - no new tag is needed."
    ;;
  *)
    refuse "$REQUIRED_CHECK concluded $CHECK_CONCLUSION on ${TARGET_SHA:0:8}"
    hint 'This is what shipped on 2026-09-03: the run was red and production deployed anyway,'
    hint 'because the chain required the BUMP to succeed and never the tests.'
    ;;
esac

# -- 4 -------------------------------------------------------------------------------------------
step 'the stable is its latest pre-release, and the dev estate has already served it'
if [ "$KIND" != 'stable' ]; then
  ok 'not asked of a pre-release - deploying dev IS what a pre-release is for'
else
  # FIRST: the stable builds EXACTLY its latest pre-release's commit, whatever `main` holds (owner,
  # 2026-11-14). Re-derived here from the API rather than trusted from the resolve step, so the
  # commit the arms build is asserted and not only computed; `classify_stable_source` carries why.
  if ALPHA_TAGS="$(gh api "repos/$REPO/git/matching-refs/tags/v${VERSION}-" --jq '.[].ref | sub("^refs/tags/"; "")' 2>&1)"; then
    ALPHA_TAG="$(printf '%s\n' "$ALPHA_TAGS" | latest_prerelease_tag "$VERSION")"
  else
    ALPHA_TAG=''
  fi
  ALPHA_SHA=''
  [ -n "$ALPHA_TAG" ] && { ALPHA_SHA="$(gh api "repos/$REPO/commits/$ALPHA_TAG" --jq '.sha' 2>/dev/null)" || ALPHA_SHA=''; }
  SOURCE="$(classify_stable_source "$TARGET_SHA" "$ALPHA_TAG" "$ALPHA_SHA")"
  case "$SOURCE" in
    'exact '*)
      ok "the stable builds ${TARGET_SHA:0:8}, precisely ${SOURCE#exact }'s commit - main is not read"
      ;;
    'mismatch '*)
      refuse "the stable would build ${TARGET_SHA:0:8}, but the latest pre-release $ALPHA_TAG is ${ALPHA_SHA:0:8}"
      hint 'A stable ships the latest pre-release of its version and nothing else - never the commit its'
      hint 'own tag names, never main. The resolve step of release.yml and this gate disagree, which is'
      hint 'a defect of the workflow: fix it there, then publish the stable again.'
      ;;
    *)
      refuse "could not tell which commit the stable must build - ${SOURCE#undecidable }"
      hint "A stable ships the latest v${VERSION}-alpha.N; cut one first: gh release create v${VERSION}-alpha.1 --prerelease"
      ;;
  esac

  # AND THE STABLE'S OWN TAG WAS PUBLISHED ON THAT SAME COMMIT (lead, 2026-11-14). GitHub runs a
  # release event's workflow files - `release.yml` and every `workflow_call` callee, `serve-prod.yml`
  # included - from the commit the tag named AT PUBLICATION (`github.sha`, handed in as
  # PUBLISHED_SHA), not from what the arms build. `v1.6.12` was typed against `main` and its
  # production deploy ran `main`'s `serve-prod.yml` around the alpha's tree. Same classifier, same
  # equality: the pipeline's code must be the alpha's too.
  PUBLISHED="$(classify_stable_source "${PUBLISHED_SHA:-}" "$ALPHA_TAG" "$ALPHA_SHA")"
  case "$PUBLISHED" in
    'exact '*)
      ok "the stable's tag was published on ${PUBLISHED_SHA:0:8}, so its workflow files are ${PUBLISHED#exact }'s too"
      ;;
    'mismatch '*)
      refuse "the tag v$VERSION was published on ${PUBLISHED_SHA:0:8}, not on $ALPHA_TAG's commit ${ALPHA_SHA:0:8}"
      hint 'GitHub runs this release'"'"'s workflow files from the commit the tag named when it was published,'
      hint 'so a stable typed against main deploys with main'"'"'s pipeline around the alpha'"'"'s tree. Delete'
      hint "this release AND its tag (gh release delete v$VERSION --cleanup-tag), then publish it on the alpha:"
      hint "gh release create v$VERSION --target $ALPHA_SHA --generate-notes"
      ;;
    *)
      refuse "could not tell which commit the stable's tag was published on - ${PUBLISHED#undecidable }"
      ;;
  esac

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
        hint 'check reads. Then publish the stable: it ships the latest pre-release of this version, which dev served.'
        ;;
      'uncovered diverged '*)
        refuse "dev is at ${DEV_SHA:0:8} and neither commit contains the other - ${COVER#uncovered diverged }"
        hint 'The marker names a BUMP commit, which lives on a release branch since 2026-10-30, so dev'
        hint 'serving an OLDER pre-release reads as diverged rather than behind. Either way dev never'
        hint 'served this code: publish a pre-release at this commit first, then the stable.'
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
  if NOTES_OUT="$(MARKETING_VERSION="$VERSION" bun tools/app-store/submit.mjs --check-notes 2>&1)"; then
    ok "$NOTES_OUT"
  else
    refuse "$NOTES_OUT"
    hint 'Apple refuses a submission with no release notes, and the notes file names its own version'
    hint 'so it cannot silently describe the release before last. Write it, first line'
    hint "\"version: $VERSION\", then publish this release again."
  fi
fi

# -- 6 -------------------------------------------------------------------------------------------
step 'no migration the owner must approve ships without the approval'
# THE DEPLOY'S QUESTION, ASKED OF THE TREE: "which files has production's ledger not recorded?"
# becomes "which files changed since the commit production SERVES?". That commit is `prod-released`,
# the tag the production deploy moves itself once it has succeeded - after `apply_migrations`, so
# every migration of that commit is in the ledger (`release-shipped.sh` reads the same marker). The
# latest stable TAG was the first version's base, and it asks less: a stable whose deploy failed is not
# in production's ledger, and its held files would have passed here (review of #2873). For a
# pre-release, dev's ledger is at or ahead of production's, so this asks at least what the dev deploy
# will. The commit is fetched shallow: the comparison needs two trees, not the history between them.
PROD_SHA="$(gh api "repos/$REPO/git/ref/tags/prod-released" --jq '.object.sha')" || PROD_SHA=""
if ! [[ "$PROD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  refuse "could not read the prod-released marker, so nothing names what production has applied (read: '${PROD_SHA:-nothing}')"
elif ! git fetch -q --depth 1 origin "$PROD_SHA" && ! git rev-parse -q --verify "$PROD_SHA^{commit}" >/dev/null; then
  refuse "could not fetch ${PROD_SHA:0:8} (prod-released) to compare its migrations with this release's"
else
  HELD_OUT="$(held_migrations_since "$PROD_SHA" HEAD)"
  HELD_RC=$?
  case "$HELD_RC" in
    0)
      ok "nothing held and unapproved since production's ${PROD_SHA:0:8} (prod-released; $(grep -c . <<<"$HELD_OUT") migration file(s) examined, $(grep -c '^approved ' <<<"$HELD_OUT") approved by the owner)"
      ;;
    1)
      while read -r _ file sum reason; do
        refuse "$file is held for the owner - $reason - and infrastructure/migration-approvals.txt does not approve this content ($sum)"
      done < <(grep '^refused ' <<<"$HELD_OUT")
      hint 'The deploy would refuse it after the bump and the store builds. The OWNER merges the line'
      hint '"<file> <sha256>" into infrastructure/migration-approvals.txt by hand (such a pull request'
      hint 'is never armed for auto-merge), then cuts a NEW tag: a rerun re-reads this same commit.'
      ;;
    *)
      refuse "could not decide - ${HELD_OUT##*undecidable }"
      ;;
  esac
fi

# -- 7 -------------------------------------------------------------------------------------------
step 'no advisory touches what this stable ships'
if [ "$KIND" != 'stable' ]; then
  ok 'not asked of a pre-release - dev and the tester tracks are where a fresh advisory is found'
else
  # THE PULL-REQUEST AUDIT, ASKED AGAIN AT THE MOMENT OF SHIPPING (owner, 2026-11-17). The commit
  # passed `CI passed`, which audited its production closure - but an advisory published since is
  # what that run could not see, and it is exactly what production would receive. Same table
  # (`lib/audit-trees.sh`, `production`), same script, so the merge and the release cannot disagree
  # on what counts; the ignores' premises were asserted by that same `CI passed` on this commit.
  shipped_closure_gate
fi

# -- 8 -------------------------------------------------------------------------------------------
step "production MiConnect would take this stable's authentik pin"
if [ "$KIND" != 'stable' ]; then
  ok "not asked of a pre-release - its own first step refuses what would stop the test stack's upgrade"
else
  # THE MORNING'S VERDICT, CARRIED TO WHERE THE DECISION IS MADE: `serve-prod` puts MiConnect on the
  # pin only after both stores took the version, so a refusal there ships half a stable.
  # `miconnect_preflight_gate` carries how the run is found and why a pin, not a date, decides.
  miconnect_preflight_gate
fi

printf '\n'
if [ "$FAILED" -ne 0 ]; then
  printf 'preflight REFUSED - nothing is bumped, nothing is deployed, no store receives anything.\n'
  exit 1
fi
printf 'preflight PASSED - %s may proceed.\n' "$VERSION"
