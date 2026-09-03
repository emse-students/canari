#!/usr/bin/env bash
#
# COMPOSES THE BODY OF A GITHUB RELEASE FROM THE NOTES THAT ALREADY WENT TO THE STORES.
#
# `store/whats-new.txt` is the one text a stable release owes a human, and since 2026-09-03 it
# reaches three destinations: the App Store, Google Play, and the GitHub release (user: the changelog
# can be the same on every platform, and in the GitHub console at the version bump). This is the
# third one's composition, and it is a PURE FUNCTION of two files - which is the whole reason it is
# not inline in `release.yml`.
#
# KEPT APART FROM ITS CALLER so it can be exercised on inputs GitHub will not produce on demand: a
# body somebody edited between two runs, a body that already carries a STALE block, a body with the
# markers but nothing between them. Those are the branches a live release never reaches, which is
# exactly why `.github/scripts/tests/release-notes-body.test.sh` produces them instead.
#
# TWO PROPERTIES, AND BOTH ARE THE POINT:
#
#   IDEMPOTENT   the notes live between two markers, so a re-run REPLACES that block rather than
#                appending a second copy. Idempotence comes from the durable state in the body
#                itself, never from a count of how many times this has run.
#   NON-DESTRUCTIVE  everything OUTSIDE the block is kept verbatim. A human who typed a body keeps
#                it; the notes are added under it. Overwriting what somebody wrote in order to
#                achieve "one source" would be trading one lost text for another.
#
# Usage: release-notes-body.sh <current-body-file> <notes-file>
# Prints the next body on stdout. Exits non-zero only when an argument is unusable.
set -euo pipefail

BEGIN_MARKER='<!-- canari-release-notes -->'
END_MARKER='<!-- /canari-release-notes -->'

current="${1:?usage: release-notes-body.sh <current-body-file> <notes-file>}"
notes="${2:?usage: release-notes-body.sh <current-body-file> <notes-file>}"

[ -r "$current" ] || { echo "cannot read the current body: $current" >&2; exit 1; }
[ -r "$notes" ] || { echo "cannot read the notes: $notes" >&2; exit 1; }

# THE MARKED BLOCK IS DROPPED, MARKERS INCLUDED. `index()` and not a regex, because the markers are
# HTML comments: `<!--` and `-->` carry no regex meaning here, but a future marker containing a `.`
# or a `*` would, and a predicate that only works for today's literal is one nobody re-reads.
#
# The order of the three rules is what makes both marker lines disappear: the opening line sets
# `skip` BEFORE the print rule sees it, and the closing line is printed-or-not while `skip` is still
# 1 and only then clears it.
kept="$(
  awk -v b="$BEGIN_MARKER" -v e="$END_MARKER" '
    index($0, b) { skip = 1 }
    !skip { print }
    index($0, e) { skip = 0 }
  ' "$current"
)"

# A BODY OF NOTHING BUT WHITESPACE IS AN EMPTY BODY, which is the ordinary case: the human left the
# box alone, or an earlier run of this wrote the block and nothing else. Emitting the blank line
# then would put the notes one line lower on every single release.
if [ -n "$(printf '%s' "$kept" | tr -d '[:space:]')" ]; then
  printf '%s\n\n' "$kept"
fi

printf '%s\n' "$BEGIN_MARKER"
cat "$notes"
printf '\n%s\n' "$END_MARKER"
