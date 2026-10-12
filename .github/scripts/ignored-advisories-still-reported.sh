#!/usr/bin/env bash
#
# AN `--ignore` THAT NOTHING REPORTS ANY MORE IS A SUPPRESSION OUTLIVING ITS REASON, and no audit
# says so: a bun/npm audit that no longer finds an advisory simply prints nothing about it, so the
# ignore sits in the workflow for ever. The four media-service ignores waited on "minio publishes a
# release" and were re-checked BY HAND (five dated entries in cicd.md) - a queue nobody drains.
# This is the machine form of that check: audit the tree WITHOUT its ignores and require every
# ignored id to still be in the output. One that is not has retired itself, and CI says delete it.
#
# Usage: ignored-advisories-still-reported.sh <audit output file> <GHSA id>...
# Exit:  0 every ignored id is still reported; 1 one is not, or the output is empty (an audit that
#        said nothing at all is a silent registry, never proof that the advisories are gone).
set -uo pipefail

out="${1:?usage: ignored-advisories-still-reported.sh <audit output file> <GHSA id>...}"
shift
[ "$#" -gt 0 ] || { echo "::error::no ignored advisory was named, so there is nothing to check"; exit 1; }

if [ ! -s "$out" ]; then
  echo "::error::the un-ignored audit printed nothing, so it cannot say whether the ignores are still needed. Not granted."
  exit 1
fi

stale=""
for id in "$@"; do
  if ! grep -qF "$id" "$out"; then stale="$stale $id"; fi
done

if [ -n "$stale" ]; then
  echo "::error::the audit no longer reports:$stale - the dependency moved, so the suppression is dead. Delete that --ignore, its premise assertion if it has one, and its backlog entry."
  exit 1
fi
echo "    every ignored advisory is still reported; the ignores are still needed."
