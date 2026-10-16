#!/usr/bin/env bash
# Asserts that the terms-of-use version is ONE value everywhere it is written:
#   - the policy `miconnect-consent-needed` in blueprints/45-consent.yaml (who is asked);
#   - the hidden prompt `miconnect-consent-prompt-version` in the same file (what is stored);
#   - the `updated` date of frontend/src/routes/legal/miconnect/+page.svelte (the text shown), as
#     DD/MM/YYYY there and YYYY-MM-DD here;
#   - VERSION in test-consent-flow.py (what the driven test expects).
# A policy and a prompt that disagree re-ask everyone at every sign-in, forever; a page whose date
# moved without them never asks anyone about the new text. Run first by test-blueprints.sh (CI job
# `test-miconnect-blueprints`), before any container starts, and runnable alone.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
blueprint="$here/blueprints/45-consent.yaml"
page="$root/frontend/src/routes/legal/miconnect/+page.svelte"
test_file="$here/test-consent-flow.py"

policy="$(grep -oE 'get\("cgu_version"\) != "[0-9]{4}-[0-9]{2}-[0-9]{2}"' "$blueprint" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)"
prompt="$(awk '/name: "miconnect-consent-prompt-version"/ {found=1} found && /initial_value:/ {gsub(/[" ]/, "", $2); print $2; exit}' "$blueprint")"
updated="$(grep -oE 'updated="[0-9]{2}/[0-9]{2}/[0-9]{4}"' "$page" | head -1 | grep -oE '[0-9/]{10}' || true)"
expected="$(grep -oE '^VERSION = "[0-9-]+"' "$test_file" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)"

if [ -z "$policy" ] || [ -z "$prompt" ] || [ -z "$updated" ] || [ -z "$expected" ]; then
  echo "::error::check-consent-version.sh could not read every version: policy='$policy' prompt='$prompt' page updated='$updated' test VERSION='$expected' - a file changed shape, fix this check with it"
  exit 1
fi

page_version="${updated:6:4}-${updated:3:2}-${updated:0:2}"
if [ "$policy" != "$prompt" ] || [ "$policy" != "$page_version" ] || [ "$policy" != "$expected" ]; then
  echo "::error::the terms-of-use version disagrees: policy miconnect-consent-needed=$policy, hidden prompt miconnect-consent-prompt-version=$prompt (45-consent.yaml), /legal/miconnect updated=$updated ($page_version), test-consent-flow.py VERSION=$expected - change all four together"
  exit 1
fi
echo "the terms-of-use version is $policy in the policy, the hidden prompt, the page and the test"
