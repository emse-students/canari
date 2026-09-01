#!/usr/bin/env bash
#
# Decides, for ONE Dependabot pull request, whether this repository has a gate that would see the
# update fail - and merges it when the whole check suite is green.
#
# IT IS A SCRIPT RATHER THAN INLINE YAML BECAUSE IT HAS TWO CALLERS, and they exist for different
# reasons. `dependabot-auto-merge.yml` runs it on a CI completion, which is the fast path, and again
# on a schedule, which is the only path that CONVERGES: a pull request whose checks finished before
# this workflow existed - or while it was disabled, or during a runner outage - will never receive
# another `workflow_run`, and on 2026-08-31 seven green ones sat exactly there. An automation that
# can only act on an event it happened to catch is not one that runs on its own.
#
# FAIL-CLOSED ON THE AUTHOR, HERE rather than in either caller: a guard written once in the place
# that does the merging cannot be bypassed by adding a third trigger later.
#
# Usage: dependabot-auto-merge.sh <pr-number>
# Prints `MERGED <pr>` on stdout when it merged, so the caller can dispatch ONE deploy for a sweep
# that merged several. Never exits non-zero for a pull request it declines to touch: a sweep must
# not be stopped by one unmergeable branch.
set -uo pipefail

pr="${1:?usage: dependabot-auto-merge.sh <pr-number>}"
: "${REPO:?REPO must be set}"
: "${GH_TOKEN:?GH_TOKEN must be set}"

# The staleness predicate lives beside this script so it can be exercised on inputs GitHub will
# not produce on demand; see `lib/gate-moves.sh` and its self-tests.
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/gate-moves.sh
. "$(dirname "$0")/lib/gate-moves.sh"

MARKER='<!-- canari-auto-merge-ceiling -->'

meta=$(gh pr view "$pr" --repo "$REPO" --json author,state,headRefOid,mergeable \
         --jq '"\(.author.login)|\(.state)|\(.headRefOid)|\(.mergeable)"') || {
  echo "#$pr: could not be read; skipping."
  exit 0
}

IFS='|' read -r author state head_sha mergeable <<< "$meta"

if [ "$author" != "app/dependabot" ] && [ "$author" != "dependabot[bot]" ]; then
  echo "#$pr: author is '$author', not Dependabot; refusing."
  exit 0
fi
if [ "$state" != "OPEN" ]; then
  echo "#$pr: state is $state; nothing to do."
  exit 0
fi

echo "#$pr: head=$head_sha mergeable=$mergeable"

# -----------------------------------------------------------------------------------------------
# THE CEILING
# -----------------------------------------------------------------------------------------------
# Dependabot writes one `updated-dependencies` block per dependency into the commit message, with
# typed fields. A grouped PR carries several, and EVERY one has to pass. The blocks are read AS
# BLOCKS rather than as three independent `sed` lists: an update Dependabot could not classify
# carries no `update-type` at all, and three lists pasted side by side would then pair the wrong
# name with the wrong version, silently.
message=$(gh api "repos/$REPO/commits/$head_sha" --jq '.commit.message') || {
  echo "#$pr: could not read its head commit; skipping."
  exit 0
}

parsed=$(awk '
  /^ *- dependency-name:/ {
    if (name != "") print name "|" type "|" version
    name = $0; sub(/^ *- dependency-name: */, "", name); type = ""; version = ""
    next
  }
  /^ *dependency-version:/ { version = $0; sub(/^ *dependency-version: */, "", version) }
  /^ *update-type:/ { type = $0; sub(/^ *update-type: *version-update:semver-/, "", type) }
  END { if (name != "") print name "|" type "|" version }
' <<< "$message")

reasons_file="${RUNNER_TEMP:-/tmp}/ceiling-reasons-$pr.md"
: > "$reasons_file"
refused=0

if [ -z "$parsed" ]; then
  echo "#$pr: no updated-dependencies block on $head_sha - refusing to guess."
  echo "- this commit carries no machine-readable updated-dependencies block, so nothing here can tell what it changes." >> "$reasons_file"
  refused=1
fi

# The loop reads from a redirection rather than a pipe, so the counters below belong to the CURRENT
# shell - a piped `while` runs in a subshell and its state is discarded.
while IFS='|' read -r name type version; do
  [ -z "$name" ] && continue
  # Dependabot YAML-quotes any dependency name that starts with `@`, so the trailer for a scoped npm
  # package reads `"@nestjs/common"`, quotes included. Matching without stripping them silently
  # misses the entire scope - which is how a first draft of this ceiling merged the exact
  # `@nestjs/common` major it was written to refuse.
  name="${name%\"}"
  name="${name#\"}"
  gate=""
  case "$name" in
    # `argon2`, `chacha20poly1305` and `ciborium` WERE REFUSED HERE UNTIL 2026-08-31, and they left
    # because `tests/cross_version_state.rs` now opens artefacts those three sealed and serialised in
    # v0.14.14. The reason a backward-only test is ENOUGH for them, and not for the crates below, is
    # the same fact in both cases: an at-rest envelope is read only by the device that WROTE it, so
    # "does today's code still open yesterday's blob" is the whole question. Measured, not assumed -
    # every `encrypt_blob` call site is state persistence, in `crypto.rs` and `pin_crypto.rs`.
#
# `aes-gcm` USED TO HAVE ITS OWN ARM HERE and no longer does, because its gate was written:
# `src-tauri/src/mobile/cross_version_push.rs` freezes a channel push and a Graine push, and
# asserts BOTH directions. The forward half needed no old binary the way `openmls` does - an
# AEAD is deterministic, so re-sealing the frozen plaintext under the frozen key and nonce must
# reproduce the frozen bytes, and equal bytes are equal in both directions.
    openmls | openmls_* | tls_codec | tls_codec_derive | hpke-rs* | libcrux*)
      # A WIRE FORMAT IS READ BY OTHER DEVICES, ON OTHER VERSIONS, so both directions matter and a
      # frozen fixture can only ever see one of them. `cross_version_state.rs` proves today's code
      # opens a group and a frame minted by v0.14.14; nothing here proves a frame minted TODAY is
      # readable by the v0.14.14 clients still in the fleet, and only an old binary could.
      gate="the FORWARD half of a cross-version test. \`tests/cross_version_state.rs\` now covers the backward half - today opening what v0.14.14 wrote - but a wire format is read by OTHER devices on OTHER versions, and nothing here runs an old binary against a frame minted by the new one"
      ;;
    webrtc | webrtc-* | str0m | sdp | ice | turn | stun)
      gate="one relay-path call. The SFU has ten tests and not one of them touches the ICE stack; that is campaign rung 15 CALL, which has no runner yet"
      ;;
    stripe)
      # THE COMPILER ALREADY DOES HALF OF THIS, AND THE HALF IT DOES IS THE SAFE HALF. The SDK types
      # `apiVersion` as the string LITERAL its release was cut against, and this service pins that
      # value in one exported constant (`src/payment/stripe-api-version.ts`). So an SDK bump that
      # still compiles cannot change which API the app talks to - the constant governs - and it
      # merges on its own like anything else. An SDK bump that CROSSES an API version stops the
      # tree compiling, in four files at once, which is exactly the coupling being made visible.
      #
      # What no gate here can answer is the other half: whether the app still reads what the new API
      # sends. An API version decides webhook payload shapes and object fields, so crossing one is a
      # decision about PAYMENTS, and today the only evidence is Stripe's changelog and somebody
      # reading it. That is not a semver judgement this script can make.
      gate="a test that pins this service's Stripe surface to FIXTURES per API version - the webhook events \`webhook.controller.ts\` handles and the fields \`stripe-payment-provider.ts\` and \`users.service.ts\` read - so that crossing an API version is PROVED rather than read in a changelog. The SDK's literal type already refuses a silent crossing: if this update stopped the tree compiling, \`STRIPE_API_VERSION\` and \`stripe\` have to move together, deliberately"
      ;;
    # `@nestjs/*` WAS REFUSED HERE UNTIL 2026-08-31, and the entry is gone because the test it named
    # now exists and is green on all four services: `boot-nest-apps` builds the real `AppModule`
    # against a real Postgres, Redis and S3 endpoint. That is what a refusal is for - it names a
    # missing gate, and it leaves when the gate arrives. It released 22 of the 28 refusals measured
    # that morning.
    #
    # BARE `typeorm` WAS REFUSED HERE UNTIL 2026-08-31 TOO, and it left the same way. The boot job
    # proved the schema BUILDS and stopped there; every unit suite mocks its repositories, so a major
    # changing how a query is BUILT would have passed all 1105 of them and failed on the first
    # request in production. `app-module.boot-spec.ts` now issues a real `find` through EVERY entity
    # the app registered - every one, not a named list, because a gate that picks its subject by name
    # does not cover the entity nobody added to it. Green on core, social and chat-delivery in CD run
    # 33403833044; media-service carries a tripwire asserting it still has no ORM at all.
  esac

  if [ -n "$gate" ]; then
    echo "  REFUSED: $name -> $version ($type): $gate"
    refused=$((refused + 1))
    echo "- \`$name\` -> \`$version\`: $gate." >> "$reasons_file"
  else
    echo "  ok: $name -> $version ($type) - the suite is evidence about this one"
  fi
done <<< "$parsed"

# -----------------------------------------------------------------------------------------------
# A REFUSAL THAT SAYS NOTHING IS THE QUEUE NOBODY DRAINS
# -----------------------------------------------------------------------------------------------
# The comment names the missing test, so the pull request carries its own reason for sitting there.
# It is posted ONCE: this runs on every check-suite completion AND on a schedule, and a marker line
# is cheaper and more reliable than reasoning about how many passes a branch has seen.
if [ "$refused" -ne 0 ]; then
  echo "#$pr: $refused update(s) have no gate here; it waits for one to be written."
  if gh api "repos/$REPO/issues/$pr/comments" --paginate --jq '.[].body' | grep -qF "$MARKER"; then
    echo "#$pr: already explained."
    exit 0
  fi
  gh pr comment "$pr" --repo "$REPO" --body "$MARKER
**Not auto-merged: this repository has no gate that would see this one fail.**

$(cat "$reasons_file")

This is not a semver judgement - a break that stops the tree compiling is caught by the suite and
merges on its own. It is a statement that a TEST IS MISSING. Write the one named above and this
whole class of update starts merging by itself; the list is in \`docs/wiki/backlog.md\`."
  exit 0
fi

# -----------------------------------------------------------------------------------------------
# A GREEN CHECK IS EVIDENCE ABOUT THE WORKFLOW THAT PRODUCED IT
# -----------------------------------------------------------------------------------------------
# NOT about the workflow on `main` today, and `lib/gate-moves.sh` carries the incident that says so
# along with the predicate itself. What belongs HERE is the consequence for a caller that merges:
#
# Until 2026-09-01 this asked `base_sha != main_sha`, and that made the queue undrainable rather
# than careful. Every merge moves `main`, so every remaining pull request went stale in the same
# instant, and the only exit was a rebuild NOTHING HERE CAN PERFORM: `PUT /update-branch` poisons
# the branch (see the section below), and `@dependabot recreate` is refused when the caller is
# `github-actions[bot]` - measured on #303, three seconds after the ask, "Sorry, only users with
# push access can use that command." A gate whose only remedy is unavailable is not a gate, it is
# a stop, and it stopped seven mergeable pull requests.
main_sha=$(gh api "repos/$REPO/commits/main" --jq '.sha') || {
  echo "#$pr: could not read main; skipping rather than merging on an unknown base."
  exit 0
}
base_sha=$(gh pr view "$pr" --repo "$REPO" --json baseRefOid --jq '.baseRefOid')

if [ "$base_sha" != "$main_sha" ]; then
  # One call: the changed-file count on the first line, then one filename per line - which is
  # exactly the payload `classify_gate_moves` is specified and tested against.
  compare=$(gh api "repos/$REPO/compare/$base_sha...$main_sha" \
    --jq '((.files // []) | length), ((.files // []) | .[].filename)') || compare="gh: compare failed"

  verdict=$(printf '%s\n' "$compare" | classify_gate_moves)
  case "$verdict" in
    settled\ *)
      echo "#$pr: built on ${base_sha:0:8}, main is ${main_sha:0:8} - ${verdict#settled } file(s) changed, none of them a gate definition; its checks still describe today's gates."
      ;;
    moved\ *)
      echo "#$pr: built on ${base_sha:0:8}, main is ${main_sha:0:8}, and the gate definitions moved between them: ${verdict#moved }"
      echo "STALE $pr"
      exit 0
      ;;
    *)
      echo "#$pr: cannot compare ${base_sha:0:8}..${main_sha:0:8} - ${verdict#undecidable }. Treating the gates as moved."
      echo "STALE $pr"
      exit 0
      ;;
  esac
fi

# A HEAD DEPENDABOT DID NOT WRITE IS UNMERGEABLE BY EVERY PATH, AND NOTHING ELSE HERE WOULD SAY SO.
# GitHub parks the `pull_request` run of a branch pushed by anything other than Dependabot in
# `action_required` - waiting for a human to click Approve - and Dependabot then declines the branch
# for good ("this PR has been edited by someone other than Dependabot"). Such a branch is not stale:
# its base can be current `main`, so the check above passes it straight through to a merge decision
# that reads checks which will never complete. It would sit there forever.
#
# This is measured rather than inferred, on the state itself and not on how the state came about, so
# a branch touched by a maintainer, by a bad rebase, or by an earlier version of this very workflow
# converges the same way: it is rebuilt, and the rebuild is Dependabot's.
head_author=$(gh api "repos/$REPO/commits/$head_sha" --jq '.author.login // ""')
if [ "$head_author" != "dependabot[bot]" ]; then
  echo "#$pr: head ${head_sha:0:8} was written by '${head_author:-unknown}', not dependabot[bot] - its checks cannot run unattended."
  echo "STALE $pr"
  exit 0
fi

# -----------------------------------------------------------------------------------------------
# THE MERGE
# -----------------------------------------------------------------------------------------------
# Inspect every check-run on the head commit rather than trusting one workflow's conclusion: the
# repository has several PR-gating workflows and path-filtered matrix jobs, so the only safe reading
# is "at least one check exists, all are completed, none reported a bad conclusion".
runs=$(gh api "repos/$REPO/commits/$head_sha/check-runs" --paginate \
  --jq '.check_runs[] | "\(.name)|\(.status)|\(.conclusion // "")"')

total=0
pending=0
bad=0
while IFS='|' read -r name status conclusion; do
  [ -z "$name" ] && continue
  # Ignore this workflow's own run if it ever surfaces as a check.
  case "$name" in "Dependabot auto-merge"*) continue ;; esac
  total=$((total + 1))
  [ "$status" != "completed" ] && pending=$((pending + 1))
  case "$conclusion" in
    success | skipped | neutral | "") ;;
    *)
      bad=$((bad + 1))
      echo "  FAIL: $name -> $conclusion"
      ;;
  esac
done <<< "$runs"

echo "#$pr: checks total=$total pending=$pending bad=$bad"
if [ "$total" -eq 0 ]; then
  echo "#$pr: no checks yet; skip."
  exit 0
fi
if [ "$bad" -ne 0 ]; then
  echo "#$pr: a check failed; not merging."
  exit 0
fi
if [ "$pending" -ne 0 ]; then
  echo "#$pr: checks still running; a later pass will take it."
  exit 0
fi

# CONFLICTING is a fact about the branch, not a verdict on the update: Dependabot rebases it and the
# next sweep takes it. UNKNOWN means GitHub has not finished computing mergeability - which it does
# lazily, and always does eventually - so waiting one pass is right and guessing is not.
case "$mergeable" in
  MERGEABLE) ;;
  CONFLICTING)
    echo "#$pr: conflicts with main; Dependabot must rebase it first."
    exit 0
    ;;
  *)
    echo "#$pr: mergeability still $mergeable; a later pass will take it."
    exit 0
    ;;
esac

echo "#$pr: all checks green -> merging"
if gh pr merge "$pr" --repo "$REPO" --squash --delete-branch; then
  echo "MERGED $pr"
else
  # Not fatal, and deliberately not retried here: whatever refused the merge is durable state that
  # the next pass reads fresh.
  echo "#$pr: the merge itself was refused; leaving it open."
fi
