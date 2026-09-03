#!/usr/bin/env bash
#
# Self-tests for `audit-dependencies.sh`, the one place that tells the npm advisory endpoint's
# ANSWER apart from its SILENCE.
#
# IT EXISTS BECAUSE THE TWO OUTCOMES ARRIVE AS THE SAME EXIT CODE. `bun audit` exits 1 for
# `POST .../advisories/bulk - 503` exactly as it exits 1 for a real advisory, and on 2026-09-03 that
# turned a five-minute npm outage into a red `Check Dependencies Vulnerabilities`, a red `CI passed`,
# and a repository where nothing could merge - over a tree in which nothing was wrong. A classifier
# whose whole job is a distinction has to be asserted on both sides of it, and on the case it does
# not recognise.
#
# THE FAKE `bun` IS THE POINT. Every case below runs the real script against a `bun` on `PATH` that
# prints a recorded shape of bun's own output. No network, no install, no registry - so the outage
# case is reproducible, which the incident itself was not.
#
# Usage: .github/scripts/tests/audit-dependencies.test.sh   (no arguments, no network)
set -uo pipefail

script=$(cd "$(dirname "$0")/.." && pwd)/audit-dependencies.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin" "$work/tree"
failures=0

# Indented with parameter expansion rather than `| sed`, which shellcheck reports as SC2001 - and
# CI's pinned 0.10.0 runs at default severity, so a style report there is a red pipeline.
indent() { local t="$1"; echo "     ${t//$'
'/$'
'     }"; }

# The fake reads what to print, and its exit code, out of the environment - so a case is one call
# with two variables, and the script under test sees an ordinary `bun` on `PATH`.
cat >"$work/bin/bun" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$FAKE_BUN_OUTPUT"
exit "$FAKE_BUN_STATUS"
FAKE
chmod +x "$work/bin/bun"

# Every case runs with the backoff collapsed: what is asserted is the CLASSIFICATION, and three real
# sleeps of 20s and 40s per outage case would put four minutes of nothing into every `make test`.
cat >"$work/bin/sleep" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE
chmod +x "$work/bin/sleep"

# $1 what it is, $2 expected exit code, $3 bun's exit code, $4 bun's output, $5.. environment
expect() {
  local what="$1" want="$2" bun_status="$3" bun_output="$4"
  shift 4
  local got out
  out=$(PATH="$work/bin:$PATH" FAKE_BUN_STATUS="$bun_status" FAKE_BUN_OUTPUT="$bun_output" \
    env "$@" bash "$script" "$work/tree" 2>&1)
  got=$?
  if [ "$got" -eq "$want" ]; then
    echo "PASS $what (exit $got)"
  else
    echo "FAIL $what: expected exit $want, got $got"
    echo "     ---- output ----"
    indent "$out"
    failures=$((failures + 1))
  fi
}

echo "=== the registry ANSWERED ==="

expect "a clean tree is a pass" 0 0 "No vulnerabilities found" REGISTRY_OUTAGE_IS_FAILURE=false

expect "a named advisory is a FINDING, not an outage" 1 1 \
  "GHSA-528h-pc64-c93x  moderate  stream-json  <=3.4.0" REGISTRY_OUTAGE_IS_FAILURE=false

echo "=== the registry was SILENT ==="

# The exact line the 2026-09-03 incident produced, character for character.
OUTAGE_503='error: POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - 503'

expect "a 503 is NOT a finding - a pull request is not walled by npm's downtime" 2 1 \
  "$OUTAGE_503" REGISTRY_OUTAGE_IS_FAILURE=false

expect "the SAME 503 IS a failure for the nightly pass" 1 1 \
  "$OUTAGE_503" REGISTRY_OUTAGE_IS_FAILURE=true

# THE SAME OUTAGE, WORDED BY A DIFFERENT BUN. The portal runs bun 1.3.8 and Canari runs 1.4.0, and on
# the evening of 2026-09-03 the same npm 503 produced two different lines. The classifier knew only
# the first and correctly reported the second as a finding - loudly, which is how it got fixed. Both
# shapes are asserted here so a repository's bun version stops being able to decide the verdict.
expect "bun 1.3.8's wording of the same outage" 2 1 \
  'error: audit request failed (status 503)' REGISTRY_OUTAGE_IS_FAILURE=false

expect "and bun 1.3.8's wording is a failure for the nightly pass too" 1 1 \
  'error: audit request failed (status 503)' REGISTRY_OUTAGE_IS_FAILURE=true

expect "the policy defaults to tolerating an outage when nobody sets it" 2 1 \
  "$OUTAGE_503" IGNORED=1

expect "a refused connection is silence too" 2 1 \
  "error: ConnectionRefused" REGISTRY_OUTAGE_IS_FAILURE=false

expect "a 429 is silence too - rate limiting is not a verdict about the tree" 2 1 \
  'error: POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - 429' \
  REGISTRY_OUTAGE_IS_FAILURE=false

echo "=== the case the classifier does NOT recognise ==="

# THE DIRECTION OF THE UNKNOWN CASE, asserted rather than trusted to the comment that states it. The
# day bun rewords its transport errors this gate must go RED and be fixed - a classifier that fails
# OPEN on its own blind spot silently stops auditing and reports success for ever.
expect "an unrecognised failure fails CLOSED" 1 1 \
  "error: something nobody has seen before" REGISTRY_OUTAGE_IS_FAILURE=false

echo "=== the arguments and the tree ==="

# The backend loop passes `--audit-level=moderate` and, for one service, a list of `--ignore=` flags.
# They have to REACH bun: an ignore that is silently dropped turns the one suppressed advisory back
# into a red pull request, and an `--audit-level` that is dropped changes what counts as a finding.
cat >"$work/bin/bun" <<'FAKE'
#!/usr/bin/env bash
printf 'ARGS: %s\n' "$*"
exit 0
FAKE
chmod +x "$work/bin/bun"
args_out=$(PATH="$work/bin:$PATH" bash "$script" "$work/tree" --audit-level=moderate --ignore=GHSA-x 2>&1)
if grep -qF 'ARGS: audit --audit-level=moderate --ignore=GHSA-x' <<<"$args_out"; then
  echo "PASS every extra argument reaches bun, in order"
else
  echo "FAIL the extra arguments did not reach bun:"
  indent "$args_out"
  failures=$((failures + 1))
fi

# A missing directory must name ITSELF. Without this guard the failing `cd` lands in the same exit
# status the audit uses, and a typo in a service name reads as "this service has a vulnerability".
missing_out=$(PATH="$work/bin:$PATH" bash "$script" "$work/no-such-directory" 2>&1)
missing_rc=$?
if [ "$missing_rc" -eq 1 ] && grep -qF 'does not exist' <<<"$missing_out"; then
  echo "PASS a directory that is not there is named, not audited"
else
  echo "FAIL a missing directory was not reported as such (exit $missing_rc):"
  indent "$missing_out"
  failures=$((failures + 1))
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures assertion(s) failed."
  exit 1
fi
echo "audit-dependencies.sh: every assertion passed."
