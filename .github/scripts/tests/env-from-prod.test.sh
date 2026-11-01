#!/usr/bin/env bash
#
# Self-test for infrastructure/local/env-from-prod.sh: a LOCAL stack built from a production dump
# never holds production's Lydia pair, and never addresses the real Lydia (2026-10-23).
#
# Production's Provider tokens are Lydia's PRODUCTION pair and move real money, so copying them (the
# old KEEP list did, with LYDIA_ENV) put them on every laptop that ever made a local estate. The
# script is copied into a scratch tree first: it writes `infrastructure/.env` and `frontend/.env`
# next to itself, and a test must never touch the developer's own.

set -uo pipefail

cd "$(dirname "$0")/../../.." || exit 1

PASS=0
FAIL=0
pass() {
  PASS=$((PASS + 1))
  printf '  ok   %s\n' "$1"
}
fail() {
  FAIL=$((FAIL + 1))
  printf '  FAIL %s\n' "$1"
}

SCRIPT="infrastructure/local/env-from-prod.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/env-from-prod-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/infrastructure/local" "$TMP/frontend"
cp "$SCRIPT" "$TMP/infrastructure/local/env-from-prod.sh"

# WHAT PRODUCTION CARRIES IS READ FROM THE MANIFEST, NOT FROM THE SCRIPT. A snapshot built from the
# script's own five lists can only ever contain names the script classifies, so it passed while
# three variables production renders (LIVE_ENABLED, LYDIA_RECONCILE_ENABLED, ANDROID_APP_LINK_SHA256)
# were in no list and a real snapshot stopped the script. Every row of
# `infrastructure/deploy/env-manifest.tsv` whose PRODUCTION disposition is not `skip` is a variable
# the rendered production .env may hold, so each one must be classified - asserted name by name.
MANIFEST="infrastructure/deploy/env-manifest.tsv"
manifest_prod="$(awk -F'\t' '!/^#/ && NF >= 4 && $2 != "skip" { print $1 }' "$MANIFEST" | sort -u)"
assignments="$(awk '/^(KEEP|BLANK|REGENERATE|LOCAL|OIDC)=/ { on = 1 } on { print } on && /"$/ { on = 0 }' "$SCRIPT")"
classified="$(
  eval "$assignments"
  printf '%s\n' "$KEEP $BLANK $REGENERATE $LOCAL $OIDC" | tr ' ' '\n' | grep -v '^$' | sort -u
)"
if [ -z "$manifest_prod" ]; then
  fail "read no production row from $MANIFEST - wrong path, or the columns moved"
else
  unclassified="$(comm -23 <(printf '%s\n' "$manifest_prod") <(printf '%s\n' "$classified") | tr '\n' ' ')"
  if [ -z "$unclassified" ]; then
    pass "every one of the $(printf '%s\n' "$manifest_prod" | wc -l | tr -d ' ') production rows of the manifest is classified by the script"
  else
    fail "production renders variables the script does not classify: $unclassified"
  fi
fi

# The snapshot carries every production row of the manifest AND every name the script classifies
# (some, like the database's, come from outside the manifest), so a real-shaped snapshot is run.
snapshot="$TMP/prod.env"
: >"$snapshot"
for n in $(printf '%s\n%s\n' "$manifest_prod" "$classified" | sort -u); do
  printf '%s=value-of-%s\n' "$n" "$n" >>"$snapshot"
done
# The three that matter here, with values that must not survive.
# (grep and mv rather than `sed -i`, whose in-place flag differs between GNU and BSD sed.)
grep -vE '^(LYDIA_ENV|LYDIA_PROVIDER_TOKEN|LYDIA_PROVIDER_PRIVATE_TOKEN)=' "$snapshot" >"$snapshot.new"
mv "$snapshot.new" "$snapshot"
{
  printf 'LYDIA_ENV=production\n'
  printf 'LYDIA_PROVIDER_TOKEN=SECRET-PUBLIC-PAIR\n'
  printf 'LYDIA_PROVIDER_PRIVATE_TOKEN=SECRET-PRIVATE-PAIR\n'
} >>"$snapshot"

log="$TMP/run.log"
if bash "$TMP/infrastructure/local/env-from-prod.sh" "$snapshot" >"$log" 2>&1; then
  pass "the script classifies a snapshot that carries production's Lydia variables"
else
  fail "the script refused the snapshot: $(tail -3 "$log" | tr '\n' ' ')"
fi
out="$TMP/infrastructure/.env"

if [ -f "$out" ] && grep -q '^LYDIA_PROVIDER_TOKEN=$' "$out" && grep -q '^LYDIA_PROVIDER_PRIVATE_TOKEN=$' "$out"; then
  pass "both Lydia Provider tokens are written EMPTY"
else
  fail "a Lydia Provider token was carried from production into the local .env"
fi

if [ -f "$out" ] && ! grep -q 'SECRET-PUBLIC-PAIR\|SECRET-PRIVATE-PAIR' "$out" "$TMP/frontend/.env" "$log"; then
  pass "no production Lydia token value appears in either .env or in the script's output"
else
  fail "a production Lydia token value reached a local file or the log"
fi

if [ -f "$out" ] && grep -q '^LYDIA_ENV=homologation$' "$out" && [ "$(grep -c '^LYDIA_ENV=' "$out")" -eq 1 ]; then
  pass "LYDIA_ENV is homologation locally, once, whatever production's .env says"
else
  fail "the local .env does not pin LYDIA_ENV=homologation exactly once"
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
