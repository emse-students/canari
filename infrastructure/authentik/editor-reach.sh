#!/usr/bin/env bash
# WHAT CAN CANARI'S MICONNECT EDITOR ACCOUNT REACH, AND WHAT HAS IT WRITTEN? Read-only.
#
#   editor-reach.sh <80-profile-editor.yaml> [worker container]
#
# Runs editor-reach.py in the worker's `ak shell`, with the given blueprint's role list (production:
# the RELEASED tree's file, since that is what the stable applied; CI: this tree's) and the event ids
# of editor-reach-known.txt, plus the SAME tree's 50-providers.yaml (beside the given file) for the
# refresh-grant check on gated providers (part 4 of editor-reach.py). Prints `EDITOR-REACH-OK` or one `FINDING` per problem. Run daily by
# `scheduled.yml` (job `drift`) against production, and by test-blueprints.sh after the editor's
# token test. docs/wiki/infrastructure/authentik.md, "The profile editor's one write path".
#
# Exit: 0 clean; 1 a finding or no verdict.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
blueprint="${1:?usage: editor-reach.sh <80-profile-editor.yaml> [worker container]}"
container="${2:-}"
if [ -z "$container" ]; then
  # As blueprint-drift.sh: production's worker, found by its compose labels.
  container="$(docker ps -q --filter label=com.docker.compose.project=miconnect --filter label=com.docker.compose.service=worker 2>/dev/null || true)"
  if [ "$(printf '%s\n' "$container" | grep -c .)" -ne 1 ]; then
    echo "::error title=MiConnect editor reach::expected exactly one running worker in compose project miconnect, found $(printf '%s\n' "$container" | grep -c .) - no verdict"
    exit 1
  fi
fi

# shellcheck source-path=SCRIPTDIR
# shellcheck source=ak-shell.sh
. "$here/ak-shell.sh"

# The providers blueprint of the same tree: the released one on production, this tree's in CI.
providers="$(dirname "$blueprint")/50-providers.yaml"
if [ ! -f "$providers" ]; then
  echo "::error title=MiConnect editor reach::no 50-providers.yaml beside $blueprint - no verdict"
  exit 1
fi

# One event id per line, then what it was; `#` starts a comment.
known="$(sed -e 's/#.*//' "$here/editor-reach-known.txt" | awk 'NF { printf "\"%s\",", $1 }')"

output="$({
  echo "import base64"
  printf "BLUEPRINT = base64.b64decode('%s').decode('utf-8')\n" "$(base64 -w0 "$blueprint")"
  printf "PROVIDERS = base64.b64decode('%s').decode('utf-8')\n" "$(base64 -w0 "$providers")"
  echo "KNOWN = [${known}]"
  cat "$here/editor-reach.py"
} | run_ak_shell "$container" 2>&1)" || true
printf '%s\n' "$output" | grep -E '^(FINDING|ERROR|EDITOR-REACH-OK|the blueprint|the older PATCH path|the write flow is|the refresh grant is|[0-9]+ (write event|finding))' || true
if grep -qx 'EDITOR-REACH-OK' <<<"$output"; then
  exit 0
fi
if grep -q '^FINDING' <<<"$output"; then
  echo "::error title=MiConnect editor reach::the profile editor account holds or used more than its one write path, or a gated provider offers a refresh - read the FINDING lines above"
else
  # The program's own last lines (a traceback names code, not data), so a no-verdict is diagnosable.
  printf '%s\n' "$output" | tail -n 15
  echo "::error title=MiConnect editor reach::no verdict - the check did not run to its end"
fi
exit 1
