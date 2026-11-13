#!/usr/bin/env bash
#
# No workflow writes a `${{ ... }}` expression INSIDE a shell script.
#
# An expression is substituted into the text of the script before the shell reads it, so its value
# becomes code. A value therefore reaches a script through `env:`, where it is data, and the script
# reads the variable. This test reads every workflow and every composite action, and fails on an
# expression found in a `run:`.
#
# Usage: .github/scripts/tests/workflow-expressions.test.sh [workflows-dir]   (no network)
#        The composite actions are read from `actions/` beside the workflows directory.
set -uo pipefail

dir="${1:-$(cd "$(dirname "$0")/../../workflows" && pwd)}"
failures=0

# Prints `file:line: text` for each expression inside a `run:`.
#
# A `run:` value is the rest of its own line AND every following line indented deeper than the
# `run` key - which covers a block scalar (`|`, `>`, with or without a chomping or an indentation
# indicator such as `|-` or `|2`), a plain scalar continued on indented lines, and a key written
# after a dash with any number of spaces (`-   run:`).
scan() {
  awk '
    function indent_of(s) { match(s, /^ */); return RLENGTH }
    FNR == 1 { in_run = 0 }
    {
      line = $0
      if (in_run) {
        if (line ~ /^ *$/) next
        if (indent_of(line) > key_indent) {
          if (line ~ /\$\{\{/) printf "%s:%d: %s\n", FILENAME, FNR, line
          next
        }
        in_run = 0
      }
      if (match(line, /^ *(- +)?run:( |$)/)) {
        key_indent = RLENGTH - 4
        if (line !~ /run: *$/) key_indent -= 1
        in_run = 1
        if (substr(line, RLENGTH + 1) ~ /\$\{\{/) printf "%s:%d: %s\n", FILENAME, FNR, line
      }
    }
  ' "$@"
}

# The scanner must be able to FIND each shape before its silence means anything.
probe=$(mktemp -d)
trap 'rm -rf "$probe"' EXIT
cat >"$probe/shapes.yml" <<'YAML'
jobs:
  a:
    steps:
      - name: in a block
        env:
          SAFE: ${{ github.ref }}
        run: |
          echo "$SAFE"
          echo '${{ planted.block }}'
      - run: echo ${{ planted.one_line }}
      - name: a plain scalar continued on an indented line
        run: echo one
          ${{ planted.continued }}
      - name: a block with an indentation indicator
        run: |2
            echo '${{ planted.indicator }}'
      -   run: echo ${{ planted.spaced_dash }}
      - name: after
        with:
          ref: ${{ github.sha }}
        if: ${{ github.event_name == 'push' }}
YAML
planted=5
found=$(scan "$probe/shapes.yml" | wc -l)
if [ "$found" -ne "$planted" ]; then
  echo "FAIL the scanner finds $found of the $planted expressions planted in a run"
  scan "$probe/shapes.yml"
  failures=$((failures + 1))
else
  echo "ok   the scanner finds all $planted planted shapes (block, one line, continued, indicator, spaced dash) and none in env, with or if"
fi

# Every workflow, under either extension, and every composite action.
files=()
while IFS= read -r file; do
  files+=("$file")
done < <(
  find "$dir" -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) | sort
  if [ -d "$dir/../actions" ]; then
    find "$dir/../actions" -type f \( -name 'action.yml' -o -name 'action.yaml' \) | sort
  fi
)

if [ "${#files[@]}" -eq 0 ]; then
  echo "FAIL no workflow was found under $dir - an empty scan reads like a clean one"
  failures=$((failures + 1))
else
  hits=$(scan "${files[@]}")
  if [ -n "$hits" ]; then
    echo "FAIL an expression is written inside a script; pass it through env: instead"
    printf '%s\n' "$hits"
    failures=$((failures + 1))
  else
    echo "ok   none of the ${#files[@]} workflow and action files writes an expression inside a script"
  fi
fi

[ "$failures" -eq 0 ]
