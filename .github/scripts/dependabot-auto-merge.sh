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
    openmls | openmls_* | tls_codec | tls_codec_derive | hpke-rs* | libcrux* | chacha20poly1305 | aes-gcm | argon2 | ciborium)
      # Not only the protocol crates: everything that WRITES A FORMAT SOMEONE ELSE MUST STILL READ
      # belongs here. `argon2` derives the at-rest device key, `chacha20poly1305` seals it,
      # `ciborium` serialises the keystore. A parameter or encoding change in any of them compiles
      # perfectly and locks every existing device out of its own data.
      gate="a cross-version state test. Nothing here opens a group, or a keystore, written by the PREVIOUS version, so a wire, encoding or key-derivation change compiles clean, passes every suite, and is discovered by a member whose conversation stopped decrypting"
      ;;
    webrtc | webrtc-* | str0m | sdp | ice | turn | stun)
      gate="one relay-path call. The SFU has ten tests and not one of them touches the ICE stack; that is campaign rung 15 CALL, which has no runner yet"
      ;;
    # `@nestjs/*` WAS REFUSED HERE UNTIL 2026-08-31, and the entry is gone because the test it named
    # now exists and is green on all four services: `boot-nest-apps` builds the real `AppModule`
    # against a real Postgres, Redis and S3 endpoint. That is what a refusal is for - it names a
    # missing gate, and it leaves when the gate arrives. It released 22 of the 28 refusals measured
    # that morning.
    typeorm)
      # BARE `typeorm`, not `@nestjs/typeorm`: the wrapper is exercised by the boot, which resolves
      # `forRootAsync`, builds every entity's metadata and synchronises a schema. The ORM ITSELF is
      # not: no test in this repository issues a real query, because the unit suites mock every
      # repository. A major that changes how a query is BUILT would pass all 1105 of them and fail
      # in production. (Its migrations are not the gap - they are raw `.sql` files TypeORM never runs.)
      #
      # `major` OR unknown: a "update the requirement to permit the latest version" pull request
      # carries NO update-type trailer at all - PR #297 is one.
      if [ "$type" = "major" ] || [ -z "$type" ]; then
        gate="a test that issues a REAL query. The boot job proves the schema builds; every unit suite mocks its repositories, so nothing here has ever watched this ORM return a row"
      fi
      ;;
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
