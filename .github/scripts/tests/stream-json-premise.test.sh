#!/usr/bin/env bash
#
# Self-tests for `stream-json-premise.sh`: the assertion behind media-service's stream-json
# ignores must pass on the shape it was measured on and FAIL on each way that shape can change. An
# assertion that has never been seen to fail is a comment.
#
# Usage: .github/scripts/tests/stream-json-premise.test.sh   (no arguments, no network)
set -uo pipefail

script=$(cd "$(dirname "$0")/.." && pwd)/stream-json-premise.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

# expect <name> <want exit> <dist content line or "">: builds a one-file dist and runs the script.
expect() {
  local name="$1" want="$2" line="$3" d="$work/$1"
  mkdir -p "$d"
  [ -n "$line" ] && printf '%s\n' "$line" >"$d/notification.js"
  bash "$script" "$d" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$want" ]; then echo "ok   $name"; else echo "FAIL $name: exit $got, want $want"; failures=$((failures + 1)); fi
}

expect cjs-jsonl-only 0 'var _Parser = require("stream-json/jsonl/Parser.js");'
expect esm-jsonl-only 0 "import jsonLineParser from 'stream-json/jsonl/Parser.js';"
expect assembler 1 "var A = require('stream-json/Assembler.js');"
expect root 1 'var S = require("stream-json");'
expect filter 1 'var P = require("stream-json/filters/Pick.js");'
expect jsonc 1 "import V from 'stream-json/jsonc/Verifier.js';"
expect jsonl-plus-extra 1 $'var _Parser = require("stream-json/jsonl/Parser.js");\nvar A = require("stream-json/Assembler.js");'
expect import-gone 1 'var x = 1;'
mkdir -p "$work/missing-parent"
bash "$script" "$work/missing-parent/nope" >/dev/null 2>&1
if [ $? -eq 1 ]; then echo "ok   dist-missing"; else echo "FAIL dist-missing"; failures=$((failures + 1)); fi

[ "$failures" -eq 0 ] || { echo "$failures failure(s)"; exit 1; }
echo "all passed"
