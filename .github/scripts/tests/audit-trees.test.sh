#!/usr/bin/env bash
#
# Self-tests for `lib/audit-trees.sh`, the one table of what each audited tree is asked. CANARI ONLY:
# it was the second half of `audit-dependencies.test.sh` until 2026-11-19, when the file had to be
# byte-identical in the four repositories (`tools/ecosystem-shape`) and the three siblings have no
# such table. What is pinned here is the table; the classifier stays in the shared file.
#
# Usage: .github/scripts/tests/audit-trees.test.sh   (no arguments, no network)
set -uo pipefail

wf_dir="$(cd "$(dirname "$0")/../../workflows" && pwd)"
failures=0

echo "=== the one table of what each tree is asked (lib/audit-trees.sh, owner 2026-11-17) ==="

# THE TABLE IS READ BY THREE CALLERS (the PR audit, the nightly, the stable gate), so what it
# answers is pinned here: a closure that silently stopped reaching `--prod`, a frontend that
# silently became `--prod` (its bundled devDependencies would stop being audited - #1229's hole), or
# an ignore that leaked to a tree nobody measured would each change a gate without a red test.
# shellcheck source-path=SCRIPTDIR source=../lib/audit-trees.sh
source "$(dirname "$0")/../lib/audit-trees.sh"

# flags <tree> <closure> <expected flags>
flags() {
  local got
  got="$(audit_flags "$1" "$2" 2>&1)"
  if [ "$got" = "$3" ]; then
    echo "PASS $1 ($2): ${3:-<no flags>}"
  else
    echo "FAIL $1 ($2): expected '$3', got '$got'"
    failures=$((failures + 1))
  fi
}
MINIO='--ignore=GHSA-vcc3-ghjq-m6fr --ignore=GHSA-qr28-fpjm-wq7f --ignore=GHSA-528h-pc64-c93x --ignore=GHSA-hqr4-qq8f-hg3x --ignore=GHSA-mjw6-4jj6-33hc'
flags frontend production ''
flags frontend full ''
flags apps/core-service production '--prod --audit-level=moderate'
flags apps/core-service full '--audit-level=moderate'
flags apps/social-service production '--prod --audit-level=moderate'
flags apps/chat-delivery-service production '--prod --audit-level=moderate'
flags apps/chat-delivery-service full '--audit-level=moderate'
flags apps/media-service production "--prod --audit-level=moderate $MINIO"
flags apps/media-service full "--audit-level=moderate $MINIO"
flags libs/handoff production '--prod --audit-level=moderate'
flags libs/handoff full '--audit-level=moderate'

if grep -q -- '--prod' <<<"$(audit_flags frontend production)"; then
  echo "FAIL the frontend is audited --prod: svelte, kit and protobufjs are devDependencies that SHIP"
  failures=$((failures + 1))
else
  echo "PASS the frontend is never --prod, so its bundled devDependencies stay audited"
fi
if audit_flags apps/nope production >/dev/null 2>&1; then
  echo "FAIL an unknown tree got flags instead of a refusal"
  failures=$((failures + 1))
else
  echo "PASS an unknown tree is refused, never audited with defaults"
fi
if audit_flags frontend prod >/dev/null 2>&1; then
  echo "FAIL a misspelt closure was accepted"
  failures=$((failures + 1))
else
  echo "PASS a misspelt closure is refused"
fi

# EVERY COMMITTED bun.lock IS IN THE TABLE, read from git rather than from a list a person keeps:
# `libs/handoff/bun.lock` (jose) sat unaudited until 2026-11-17 because the old matrix was such a
# list. A lockfile that must NOT be audited is excluded here BY NAME, with its reason on its line.
AUDIT_EXCLUDED_LOCKS=(
  # (none today)
)
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
locked_trees=$(git -C "$repo_root" ls-files '*bun.lock' | while IFS= read -r f; do
  d="$(dirname "$f")"
  [[ " ${AUDIT_EXCLUDED_LOCKS[*]} " == *" $d "* ]] || printf '%s\n' "$d"
done | sort)
table_trees=$(printf '%s\n' "${AUDIT_TREES[@]}" | sort)
if [ -n "$locked_trees" ] && [ "$locked_trees" = "$table_trees" ]; then
  echo "PASS the table audits every committed bun.lock ($(wc -l <<<"$locked_trees") trees)"
else
  echo "FAIL the committed lockfiles and the table disagree:"
  diff <(echo "$locked_trees") <(echo "$table_trees") | sed 's/^/     /'
  failures=$((failures + 1))
fi

# THE MATRIX AND THE TABLE NAME THE SAME TREES. A tree added to one and not the other is either
# never audited on a pull request or never asked at a stable.
matrix_trees=$(grep -E '^\s*tree: \[' "$wf_dir/code-analysis.yml" | sed -E 's/.*\[(.*)\].*/\1/; s/, */ /g')
if [ "$matrix_trees" = "${AUDIT_TREES[*]}" ]; then
  echo "PASS code-analysis.yml's matrix audits exactly the table's trees"
else
  echo "FAIL the matrix names '$matrix_trees', the table '${AUDIT_TREES[*]}'"
  failures=$((failures + 1))
fi
if grep -qE '^\s*closure: production\s*$' "$wf_dir/ci.yml"; then
  echo "PASS the pull-request audit asks for the production closure"
else
  echo "FAIL ci.yml's dependency-audit does not pass closure: production"
  failures=$((failures + 1))
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures assertion(s) failed."
  exit 1
fi
echo "audit-trees.sh: every assertion passed."
