#!/usr/bin/env bash
#
# DOES THIS REPOSITORY HAVE A GATE THAT WOULD SEE THIS DEPENDENCY UPDATE FAIL?
#
# Answered as a CHECK, which makes the answer BINDING. Until 2026-09-03 this question was asked
# only inside `dependabot-auto-merge.yml` (deleted 2026-09-04), a SECOND merge mechanism beside
# GitHub's own
# auto-merge - so a Dependabot pull request and a human's took different routes to `main` (user,
# 2026-09-03: *"le auto-merge et les CI doivent considerer toutes les PR, les miennes ou
# dependabot"*).
#
# **THE OLD MECHANISM DID POST ITS REFUSAL, AND SAYING OTHERWISE WAS WRONG.** The first version of
# this header claimed the refusal was "recorded nowhere a reader could see"; #309 carries a
# detailed `github-actions` comment naming the exact missing test. The real difference is narrower
# and still worth the change: **a comment is ADVISORY.** It does not appear in the checks list,
# which is where a reader looks for what blocks a pull request; the merge machinery cannot read it,
# so anything that armed GitHub's auto-merge would merge straight past it; and it was not part of
# `ci-passed`, the one check the branch ruleset requires. Advisory -> binding is the improvement,
# not invisible -> visible.
#
# THIS IS STAGE ONE OF TWO, AND THE ORDER IS NOT ARBITRARY. This change is purely ADDITIVE: the
# ceiling becomes a job of `pull-request.yml` feeding `ci-passed`, which is the one check the branch
# ruleset requires - so an update with no gate here cannot merge even if something armed it. The
# sweep is untouched and still merges on its own reading of "green", which now INCLUDES this check,
# so the two agree rather than compete.
#
# Stage two - the sweep ARMS GitHub's auto-merge instead of merging, and sheds its own check
# counting - must come AFTER this is on `main` and observed on a real Dependabot pull request.
# **Doing them in the other order re-creates the outage**: arming a pull request whose ceiling
# refusal is not yet a required check would merge `postgres 15-alpine -> 18-alpine` on a fully green
# suite, which is exactly what cost 33 minutes of production on 2026-09-01.
#
# WHY A CEILING EXISTS AT ALL, and it cost 33 minutes of production to learn. On 2026-09-01
# `postgres 15-alpine -> 18-alpine` merged on a FULLY GREEN suite: every gate in this repository -
# `make run-ci`, `boot-nest-apps`, every compose stack - starts from an EMPTY volume, so green
# proves the new major can create a fresh cluster and says NOTHING about the cluster production
# has. PostgreSQL 18 refused production's data directory, and `auth_db` is the only database, so
# eight services lost their store. **A green suite is exactly what those updates look like**, which
# is why a check is needed and why it cannot be derived from severity or from semver.
#
# THE CRITERION IS NOT SEVERITY AND IT IS NOT SEMVER - it is whether a gate HERE would see the
# update fail. A major that breaks the tree stops it compiling and the suite refuses it without
# help; `update-type` is parsed and deliberately decides nothing. The table is `lib/ceiling.sh`,
# with its own self-tests, and every entry NAMES THE TEST that would retire it - because a refusal
# that names nothing is a queue nobody drains (user, 2026-08-31).
#
# THIS SCRIPT DOES NOT MERGE ANYTHING. It reports. `ci-passed` aggregates it, the branch ruleset
# requires `ci-passed`, and GitHub's auto-merge does the merging - one merge path for every pull
# request in the repository.
set -uo pipefail

REPO="${REPO:-${GITHUB_REPOSITORY:-emse-students/canari}}"
PR="${PR:-}"
HEAD_SHA="${HEAD_SHA:-}"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/ceiling.sh
. "$(dirname "$0")/lib/ceiling.sh"

[ -n "$PR" ]       || { printf 'PR is not set\n' >&2; exit 2; }
[ -n "$HEAD_SHA" ] || { printf 'HEAD_SHA is not set\n' >&2; exit 2; }

printf 'dependency ceiling - pull request #%s at %s\n' "$PR" "${HEAD_SHA:0:8}"

message="$(gh api "repos/$REPO/commits/$HEAD_SHA" --jq '.commit.message' 2>/dev/null)" || message=''
if [ -z "$message" ]; then
  # AN UNREADABLE ANSWER IS NOT PERMISSION. Every other refusal here names a missing test; this one
  # names a broken instrument, and both must stop the merge.
  echo "::error::Could not read the head commit of #$PR, so nothing here can tell what it changes."
  exit 1
fi

# Dependabot writes a machine-readable block into its commit message. It is the only description of
# the update that is not prose.
parsed="$(awk '
  /^ *- dependency-name:/ {
    if (name != "") print name "|" type "|" version
    name = $0; sub(/^ *- dependency-name: */, "", name); type = ""; version = ""
    next
  }
  /^ *dependency-version:/ { version = $0; sub(/^ *dependency-version: */, "", version) }
  /^ *update-type:/ { type = $0; sub(/^ *update-type: *version-update:semver-/, "", type) }
  END { if (name != "") print name "|" type "|" version }
' <<< "$message")"

if [ -z "$parsed" ]; then
  echo "::error::This commit carries no updated-dependencies block, so nothing here can tell what it changes. Refusing to guess."
  exit 1
fi

refused=0
while IFS='|' read -r name type version; do
  [ -z "$name" ] && continue
  # DEPENDABOT YAML-QUOTES ANY NAME STARTING WITH `@`, so a scoped npm package arrives as
  # `"@nestjs/common"`, quotes included. Matching without stripping them misses the entire scope -
  # which is how a first draft of this ceiling merged the exact `@nestjs/common` major it was
  # written to refuse.
  name="${name%\"}"
  name="${name#\"}"

  # The VERSION is passed because one arm needs it: a datastore is refused only when the update
  # crosses the major production runs, a patch WITHIN a major being exactly what the digest pin
  # exists to let through.
  gate="$(gate_for_dependency "$name" "$version")"

  if [ -n "$gate" ]; then
    refused=$((refused + 1))
    echo "::error title=No gate would see this fail::$name -> $version ($type): $gate"
  else
    printf '  ok      %s -> %s (%s) - the suite is evidence about this one\n' "$name" "$version" "$type"
  fi
done <<< "$parsed"

printf '\n'
if [ "$refused" -ne 0 ]; then
  printf '%s update(s) have no gate here, so this pull request waits for one to be written.\n' "$refused"
  printf 'Each line above names the test that would retire the refusal. Writing that test is the\n'
  printf 'fix; merging past it is not, and neither is a human deciding it looks fine - the suite\n'
  printf 'was green when postgres 18 took production down for 33 minutes.\n'
  exit 1
fi
printf 'every update here is one the suite is evidence about.\n'
