#!/usr/bin/env bash
#
# DID THE RELEASE THAT WAS JUST PUBLISHED ACTUALLY REACH PRODUCTION?
#
# WHAT IT COST TO LEARN. `Production estate` is a SUCCESS dependency on both store arms in
# `release.yml`, which is correct and is NOT weakened by this. But a skipped job does not fail a
# run: on v0.16.2 and v0.16.3 an arm did not succeed, the estate was skipped, and both releases
# reported themselves shipped while production went on serving v0.16.1 - from 2026-09-03 until the
# next deploy broke, which is the only reason anybody found out. Two versions were published,
# announced, and served to nobody.
#
# IT READS THE MARKER, NOT THE JOB RESULT, and that distinction is the whole value. A job result
# says what the workflow DID; `prod-released` is a tag the deploy writes on the box itself, once
# the deploy has really succeeded - it says what production SERVES. They are the same answer right
# up until they are not: a tag push that fails after a green deploy, an emergency deploy by hand, a
# re-run that half-succeeded. This repository already states the rule - a liveness record must be
# written by the thing whose liveness it measures - and this is that record.
#
# IT CHANGES NOTHING ABOUT WHAT SHIPS. It deploys nothing and undoes nothing; the stores have the
# version either way. It refuses to let the run go green on a claim that is not true, which is the
# difference between finding this in a minute and finding it in five days.
#
# A SCRIPT AND NOT INLINE SHELL, for the reason the release-notes composition gives next to it: it
# is a pure function of its inputs, and its interesting cases are ones a live release never
# produces. `.github/scripts/tests/release-shipped.test.sh` produces them.
#
# Inputs, all from the environment: REPO, RELEASED_SHA, VERSION, ESTATE_RESULT (and GH_TOKEN for
# `gh`). Exit 0 if production serves the released commit, 1 otherwise.
set -uo pipefail

REPO="${REPO:?REPO is not set}"
RELEASED_SHA="${RELEASED_SHA:?RELEASED_SHA is not set}"
VERSION="${VERSION:?VERSION is not set}"
ESTATE_RESULT="${ESTATE_RESULT:-unknown}"

# AN UNREADABLE MARKER IS NOT A PASS. Every other refusal in this chain names a missing thing; this
# one names a broken instrument, and both must stop the run going green.
if ! marker="$(gh api "repos/$REPO/git/ref/tags/prod-released" --jq '.object.sha' 2>/dev/null)" ||
   [ -z "$marker" ]; then
  echo "::error title=Cannot tell whether $VERSION shipped::The prod-released marker could not be read, so nothing here knows what production serves."
  exit 1
fi

printf 'released commit  %s\n' "$RELEASED_SHA"
printf 'prod-released    %s\n' "$marker"
printf 'estate job       %s\n' "$ESTATE_RESULT"

if [ "$marker" = "$RELEASED_SHA" ]; then
  printf '\nproduction serves %s.\n' "$VERSION"
  exit 0
fi

echo "::error title=$VERSION was published and did NOT reach production::prod-released still points at ${marker:0:8}, not at ${RELEASED_SHA:0:8}. The estate job was '$ESTATE_RESULT'."
echo ""
echo "The stores may already have this version; production does not. NOTHING WAS ROLLED BACK -"
echo "production is still serving the previous release, which is the designed behaviour when a"
echo "store arm does not succeed."
echo ""
echo "THE RECOVERY IS 'Re-run failed jobs' ON THIS RUN, once the reason the arm did not succeed is"
echo "fixed. Do not cut a new tag: the release already exists, and the preflight refuses a second"
echo "one at the same commit."
echo ""
echo "This check exists because v0.16.2 and v0.16.3 both reported themselves shipped while"
echo "production served v0.16.1 for five days."
exit 1
