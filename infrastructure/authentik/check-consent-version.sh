#!/usr/bin/env bash
# Asserts that the terms-of-use version is ONE value everywhere it is written:
#   - the policy `miconnect-consent-needed` in blueprints/45-consent.yaml (who is asked);
#   - the hidden prompt `miconnect-consent-prompt-version` in the same file (what is stored);
#   - `acceptedVersion` in frontend/src/routes/legal/miconnect/+page.svelte (the version the page says
#     is in force), whose `updated` date (the last revision of the text, DD/MM/YYYY) may be LATER but
#     never earlier: a minor revision moves `updated` alone and asks nobody again (owner, 2026-11-27);
#   - VERSION in test-consent-flow.py (what the driven test expects);
#   - CONSENT_VERSION in core-service's miconnect-reader.client.ts (what the handoff mint requires of a
#     person it passes through the consent flow).
# A policy and a prompt that disagree re-ask everyone at every sign-in, forever; a page whose
# acceptedVersion moved without them never asks anyone about the material change it announces. Run first by test-blueprints.sh (CI job
# `test-miconnect-blueprints`), before any container starts, and runnable alone.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# The flow is built everywhere since 2026-11-18; which providers ask for it is 50-providers.yaml.
blueprint="$here/blueprints/45-consent.yaml"
page="$root/frontend/src/routes/legal/miconnect/+page.svelte"
test_file="$here/test-consent-flow.py"
reader="$root/apps/core-service/src/auth/handoff/miconnect-reader.client.ts"

policy="$(grep -oE 'get\("cgu_version"\) != "[0-9]{4}-[0-9]{2}-[0-9]{2}"' "$blueprint" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)"
prompt="$(awk '/name: "miconnect-consent-prompt-version"/ {found=1} found && /initial_value:/ {gsub(/[" ]/, "", $2); print $2; exit}' "$blueprint")"
updated="$(grep -oE 'updated="[0-9]{2}/[0-9]{2}/[0-9]{4}"' "$page" | sed -n 1p | grep -oE '[0-9/]{10}' || true)"
accepted="$(grep -oE "const acceptedVersion = '[0-9]{4}-[0-9]{2}-[0-9]{2}'" "$page" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)"
expected="$(grep -oE '^VERSION = "[0-9-]+"' "$test_file" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)"

handoff="$(grep -oE "^export const CONSENT_VERSION = '[0-9-]+'" "$reader" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)"

if [ -z "$policy" ] || [ -z "$prompt" ] || [ -z "$updated" ] || [ -z "$accepted" ] || [ -z "$expected" ] || [ -z "$handoff" ]; then
  echo "::error::check-consent-version.sh could not read every version: policy='$policy' prompt='$prompt' page updated='$updated' page acceptedVersion='$accepted' test VERSION='$expected' handoff CONSENT_VERSION='$handoff' - a file changed shape, fix this check with it"
  exit 1
fi

revised="${updated:6:4}-${updated:3:2}-${updated:0:2}"
if [ "$policy" != "$prompt" ] || [ "$policy" != "$accepted" ] || [ "$policy" != "$expected" ] || [ "$policy" != "$handoff" ]; then
  echo "::error::the terms-of-use version disagrees: policy miconnect-consent-needed=$policy, hidden prompt miconnect-consent-prompt-version=$prompt (45-consent.yaml), /legal/miconnect acceptedVersion=$accepted, test-consent-flow.py VERSION=$expected, core-service CONSENT_VERSION=$handoff (miconnect-reader.client.ts) - change all five together"
  exit 1
fi
# ISO dates compare as strings. A revision dated before the version it carries is a version moved
# without the page saying so.
if [[ "$revised" < "$policy" ]]; then
  echo "::error::/legal/miconnect says it was last revised on $updated, before the version in force ($policy) - move updated with acceptedVersion"
  exit 1
fi
echo "the terms-of-use version is $policy in the policy, the hidden prompt, the page, the test and the handoff gate; the text was last revised on $revised"
