#!/usr/bin/env bash
#
# Self-tests for `lib/gate-moves.sh`, the predicate that decides whether a pull request's green
# check suite still describes the gates `main` carries.
#
# IT EXISTS BECAUSE THE HALF THAT MATTERS NEVER RUNS IN PRODUCTION. A live sweep sees small, tidy
# compare payloads; the branches that decide correctness - a truncated file list, a malformed count
# - appear on the day something is already wrong, and a predicate that failed OPEN there would merge
# a dependency bump on a suite nothing checked. So they are produced here instead.
#
# Usage: .github/scripts/tests/gate-moves.test.sh   (no arguments, no network, no dependencies)
set -uo pipefail

# shellcheck source-path=SCRIPTDIR
# shellcheck source=../lib/gate-moves.sh
. "$(dirname "$0")/../lib/gate-moves.sh"

failures=0
check() {
  local name="$1" expected="$2" payload="$3" actual
  actual=$(printf '%s' "$payload" | classify_gate_moves)
  if [ "$actual" = "$expected" ]; then
    echo "  ok   $name"
  else
    echo "  FAIL $name"
    echo "       expected: $expected"
    echo "       actual:   $actual"
    failures=$((failures + 1))
  fi
}

echo "classify_gate_moves:"

# The case the whole repair is for: `main` moved by two dependency merges, which is what every
# auto-merge produces, and neither file defines a gate. Measured on 6a356d7e...39551dc4.
check "two dependency merges do not move the gates" \
  "settled 2" \
  '2
frontend/bun.lock
frontend/package.json'

# The case the predicate was written for. Measured on a09fbe54...39551dc4.
check "a workflow edit moves the gates" \
  "moved .github/scripts/dependabot-auto-merge.sh .github/workflows/ci.yml .github/workflows/dependabot-auto-merge.yml" \
  '5
.github/scripts/dependabot-auto-merge.sh
.github/workflows/ci.yml
.github/workflows/dependabot-auto-merge.yml
CHANGELOG.md
docs/wiki/cicd.md'

check "a script alone is enough to move them" \
  "moved .github/scripts/dependabot-auto-merge.sh" \
  '1
.github/scripts/dependabot-auto-merge.sh'

# `.github/` is not by itself a gate: an issue template or a Dependabot config changes what is
# PROPOSED, never what is asserted about it, and treating those as gate moves would re-create the
# undrainable queue in a narrower disguise.
check "other .github files are not gate definitions" \
  "settled 3" \
  '3
.github/dependabot.yml
.github/ISSUE_TEMPLATE/bug.md
.github/CODEOWNERS'

# A path merely CONTAINING the fragment is not one of ours. Anchored, so it stays that way.
check "a lookalike path elsewhere in the tree is not a gate" \
  "settled 2" \
  '2
docs/.github/workflows/example.yml
frontend/src/lib/.github/scripts/note.md'

check "main has not moved at all" \
  "settled 0" \
  '0'

# --- the branches a live run never reaches ---

check "a truncated file list is not evidence" \
  "undecidable 300 files changed and the compare API truncates its list at 300" \
  "$(printf '300\n'; for i in $(seq 1 300); do echo "src/file-$i.ts"; done)"

# 300 exactly is the truncation boundary, and it is INSIDE the refusal: a list of exactly 300 is
# the one length that cannot be told from a longer one.
check "301 files is undecidable too" \
  "undecidable 301 files changed and the compare API truncates its list at 300" \
  '301
frontend/bun.lock'

check "299 files still decides" \
  "settled 299" \
  '299
frontend/bun.lock'

check "an empty payload is not evidence" \
  "undecidable the changed-file count is 'empty', not a number" \
  ''

check "a non-numeric first line is not evidence" \
  "undecidable the changed-file count is 'null', not a number" \
  'null'

# The shape a failed `gh api --jq` leaves behind: the error text where the count belongs.
check "an error message where the count belongs is not evidence" \
  "undecidable the changed-file count is 'gh: Not Found (HTTP 404)', not a number" \
  'gh: Not Found (HTTP 404)'

# A truncated list that HAPPENS to contain a gate is still undecidable rather than `moved`: both
# refuse the merge, but only one of them says why truthfully, and the report the caller posts is
# read by a person.
check "truncation is answered before the file list is read" \
  "undecidable 400 files changed and the compare API truncates its list at 300" \
  '400
.github/workflows/ci.yml'

echo
if [ "$failures" -eq 0 ]; then
  echo "gate-moves: all checks passed"
else
  echo "gate-moves: $failures check(s) failed"
  exit 1
fi
