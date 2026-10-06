#!/usr/bin/env bash
#
# THE PREMISE BEHIND EVERY `stream-json` IGNORE IN media-service: minio's dist pulls in exactly ONE
# module of the package, the JSONL parser, and nothing else.
#
# It is an ALLOWLIST of what minio may import, not a denylist of the vulnerable modules, because
# the advisories name different modules (`filters/*`, the JSONC parser and verifier, `Assembler`)
# and the next one will name another. Anything minio imports from `stream-json` other than
# `jsonl/Parser.js` - the package root included, which loads the others - voids every reachability
# argument at once and refuses the ignores.
#
# Usage: stream-json-premise.sh <minio dist dir>
# Exit:  0 the premise holds; 1 it does not (or cannot be measured: an unmeasurable premise grants nothing).
set -uo pipefail

dist="${1:?usage: stream-json-premise.sh <minio dist dir>}"
if [ ! -d "$dist" ]; then
  echo "::error::$dist is not there, so what minio imports from stream-json cannot be checked. The ignores are not granted."
  exit 1
fi

# Every module specifier naming the package, from `require("...")` and `from '...'` alike. Source
# maps are excluded: they quote the source and are not loaded.
specs=$(grep -rhoE "(require\(|from )[\"']stream-json[^\"']*[\"']" "$dist" --exclude='*.map' 2>/dev/null |
  sed -E "s/^(require\(|from )[\"']//; s/[\"']\$//" | sort -u || true)

if [ -z "$specs" ]; then
  echo "::error::minio no longer imports stream-json at all - the call site the ignores were measured on is gone, so the measurement no longer describes this tree."
  exit 1
fi

others=$(printf '%s\n' "$specs" | grep -vxF 'stream-json/jsonl/Parser.js' || true)
if [ -n "$others" ]; then
  echo "::error::minio now imports stream-json modules beyond jsonl/Parser.js, so the filters, the JSONC parser/verifier or the Assembler may be reachable (GHSA-528h-pc64-c93x, GHSA-hqr4-qq8f-hg3x, GHSA-mjw6-4jj6-33hc): $(echo "$others" | tr '\n' ' ')"
  exit 1
fi
echo "    minio imports only stream-json/jsonl/Parser.js; the stream-json premise holds."
