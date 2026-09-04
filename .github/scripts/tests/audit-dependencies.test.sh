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

# AND THE THIRD SHAPE, WHICH CARRIES NO STATUS AT ALL. `Timeout: audit request failed` turned every
# pull request in Portail-etu red on 2026-09-04 against a clean tree, because the pattern required a
# `(status NNN)`. The phrase alone is the transport failure; the decoration around it is not.
expect "a timeout with no status is silence, not a finding" 2 1 \
  'Timeout: audit request failed' REGISTRY_OUTAGE_IS_FAILURE=false

expect "and the nightly pass calls that same timeout a failure" 1 1 \
  'Timeout: audit request failed' REGISTRY_OUTAGE_IS_FAILURE=true
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

echo "=== the attempt budget is the caller's to lower ==="

# AN OUTAGE IS A PROPERTY OF THE REGISTRY, NOT OF THE DIRECTORY, and Canari audits five trees in one
# job. Without this, a registry that is down costs five separate three-attempt discoveries of the
# same fact - fifteen `bun audit` calls, each carrying bun's own multi-minute timeout. The verdict
# still has to be the same 2, so both halves are asserted: the number of attempts changes, the
# CLASSIFICATION does not.
attempts_out=$(PATH="$work/bin:$PATH" FAKE_BUN_STATUS=1 FAKE_BUN_OUTPUT="$OUTAGE_503" \
  AUDIT_ATTEMPTS=1 bash "$script" "$work/tree" 2>&1)
attempts_rc=$?
tries=$(grep -c 'bun audit in' <<<"$attempts_out")
if [ "$attempts_rc" -eq 2 ] && [ "$tries" -eq 1 ]; then
  echo "PASS AUDIT_ATTEMPTS=1 asks once and still answers 2"
else
  echo "FAIL AUDIT_ATTEMPTS=1: expected exit 2 after 1 attempt, got exit $attempts_rc after $tries"
  indent "$attempts_out"
  failures=$((failures + 1))
fi

default_out=$(PATH="$work/bin:$PATH" FAKE_BUN_STATUS=1 FAKE_BUN_OUTPUT="$OUTAGE_503" \
  bash "$script" "$work/tree" 2>&1)
tries=$(grep -c 'bun audit in' <<<"$default_out")
if [ "$tries" -eq 3 ]; then
  echo "PASS the default is still three attempts"
else
  echo "FAIL the default budget is $tries attempts, expected 3"
  failures=$((failures + 1))
fi

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


echo "=== the caller's seam: a run: block is bash -e, and the callers must survive it ==="

# THE CLASSIFIER IS ONLY HALF THE MECHANISM. It answers 0 / 1 / 2, and every assertion above proves
# it answers correctly - but a correct answer nobody can read is worth nothing, and the reading
# happens in `code-analysis.yml` under a shell this file cannot see. GitHub runs a `run:` block as
# `bash --noprofile --norc -e -o pipefail`, and the `set -uo pipefail` those blocks open with does
# NOT clear that `-e`. So a bare call to this script ENDS THE STEP the moment it exits non-zero, and
# any `rc=$?` on the following line is unreachable for exactly the two statuses the design exists to
# tell apart.
#
# That shipped on 2026-09-04 and a real npm 503 turned the security pass red four hours later - the
# precise failure this script was written to prevent, reintroduced one layer up. The classifier's
# own tests could not see it: they run the script, and the defect was in the caller.
#
# So the caller is asserted here, by PATTERN rather than by execution: a `run:` block cannot be
# invoked outside Actions without reimplementing it, and a reimplementation drifts. What is checked
# is that no workflow reads `$?` on a line of its own, which is the shape that cannot work.
wf_dir="$(cd "$(dirname "$0")/../../workflows" && pwd)"
bare=$(grep -rn '^[[:space:]]*rc=\$?[[:space:]]*$' "$wf_dir" || true)
if [ -z "$bare" ]; then
  echo "PASS no workflow captures \$? on a line of its own, where bash -e can never reach it"
else
  echo "FAIL a workflow reads \$? on its own line; under bash -e that line is unreachable when the"
  echo "     command failed. Write 'rc=0' then 'cmd || rc=\$?' instead:"
  indent "$bare"
  failures=$((failures + 1))
fi

# AND THE CORRECT SHAPE IS ASSERTED TO WORK, so the rule above is not merely a spelling preference.
cat > "$work/caller.sh" <<'CALLER'
set -uo pipefail
rc=0
"$FAKE_CLASSIFIER" || rc=$?
echo "caller saw rc=$rc"
[ "$rc" -eq 0 ] || [ "$rc" -eq 2 ]
CALLER
printf '#!/usr/bin/env bash\nexit 2\n' > "$work/bin/classifier-2"
chmod +x "$work/bin/classifier-2"
caller_out=$(FAKE_CLASSIFIER="$work/bin/classifier-2" bash -e -o pipefail "$work/caller.sh" 2>&1)
caller_rc=$?
if [ "$caller_rc" -eq 0 ] && grep -qF 'caller saw rc=2' <<<"$caller_out"; then
  echo "PASS under bash -e the 'cmd || rc=\$?' shape reads a 2 and tolerates it"
else
  echo "FAIL the tolerated-outage shape did not survive bash -e (exit $caller_rc):"
  indent "$caller_out"
  failures=$((failures + 1))
fi
echo
if [ "$failures" -gt 0 ]; then
  echo "$failures assertion(s) failed."
  exit 1
fi
echo "audit-dependencies.sh: every assertion passed."
