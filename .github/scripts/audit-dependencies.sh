#!/usr/bin/env bash
# =================================================================================================
# `bun audit` IN ONE DIRECTORY, WITH THE REGISTRY'S SILENCE TOLD APART FROM ITS ANSWER
#
# WHY THIS FILE EXISTS. On 2026-09-03 the whole security pass went red on:
#
#     error: POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - 503
#
# Nothing was wrong with the tree. npm's advisory endpoint was unavailable for five minutes, and
# `bun audit` exits 1 for that exactly as it exits 1 for a real advisory - so a registry outage was
# reported as a vulnerability, and (since the pass now feeds `CI passed`) it walled every merge in
# the repository behind an incident in somebody else's datacentre. **A status code is an ANSWER, a
# transport failure is not**, and this gate asks precisely one question: *does this tree contain a
# known advisory?* When the registry does not answer, the gate has NO VERDICT - which is a different
# thing from a bad one, and must be reported as a different thing.
#
# THE DIRECTION OF THE UNKNOWN CASE IS DELIBERATE. Only a NARROW, recognised transport failure is
# classified as silence; anything the patterns below do not match is a failure. So the day bun
# rewords its errors this gate goes RED and somebody fixes the pattern - it does not quietly go
# green on an outage it stopped recognising. A classifier that fails open on its own blind spot is
# not a gate.
#
# WHY IT IS NOT AN ERROR-MESSAGE BRANCH IN THE SENSE THE RULES FORBID. That rule is about carrying a
# distinction in prose ACROSS CODE WE OWN, where it belongs in a type at the throw. `bun` is a
# separate process: its exit code conflates the two outcomes and its stdout is the only channel that
# separates them. The classification is therefore made ONCE, here, and handed on as an exit code -
# which is exactly what the rule asks for, at the only seam where it can be done.
#
# EXIT CODES, and every caller reads them:
#     0  the registry answered and the tree is clean
#     1  the registry answered and named at least one advisory - a real finding
#     2  the registry never answered, after every attempt. NO verdict.
#
# WHETHER 2 IS A FAILURE IS THE CALLER'S POLICY, AND IT DIFFERS. A pull request cannot wait for npm
# to recover and must not be walled by an incident nobody in this repository can fix - a refusal
# whose only remedy is unavailable is a stop, not a gate. The NIGHTLY pass has no merge behind it, so
# there it IS a failure: that is the report saying this tree has now gone a day unaudited, and it is
# what stops a tolerated outage from becoming a permanent hole with a warning over it. The policy
# arrives as `REGISTRY_OUTAGE_IS_FAILURE=true`, which turns the 2 above into a 1.
#
# USAGE: audit-dependencies.sh <directory> [extra `bun audit` arguments...]
# =================================================================================================
set -uo pipefail

DIR="${1:?usage: audit-dependencies.sh <directory> [bun audit args...]}"
shift

# A directory that is not there would otherwise be audited as "the registry answered and named
# something", because the `cd` failure lands in the same exit status the audit uses. Caught here so
# the report names the actual problem.
if [ ! -d "$DIR" ]; then
  echo "::error::$DIR does not exist, so nothing was audited."
  exit 1
fi

# THREE ATTEMPTS, NOT MORE. `bun audit` carries its own internal timeout and took five minutes to
# give up on the 503 above, so attempts are expensive; three of them spread over a couple of minutes
# of backoff covers a blip, and a longer outage is not something a pull request should sit through.
ATTEMPTS=3
BACKOFF_BASE_S=20

# The registry did not answer. Narrow on purpose - see the header. `- [45]0[0-9]$` is bun's shape for
# an HTTP failure against the advisory endpoint; the named errors are its transport failures.
TRANSPORT_RE='(registry\.npmjs\.org.* - [45][0-9][0-9]$|ConnectionRefused|ConnectionClosed|ConnectionTimedOut|SocketNotConnected|FailedToOpenSocket|DNSResolveFailed|error: (Timeout|socket hang up))'

for attempt in $(seq 1 "$ATTEMPTS"); do
  echo "--- bun audit in $DIR (attempt $attempt/$ATTEMPTS)"
  out="$( cd "$DIR" && bun audit "$@" 2>&1 )"
  status=$?
  echo "$out"

  if [ "$status" -eq 0 ]; then
    exit 0
  fi

  if ! grep -qE "$TRANSPORT_RE" <<<"$out"; then
    # The registry answered, and what it said is a finding. Reported as-is, first time, no retry:
    # re-asking a question that WAS answered only hides the answer behind three copies of itself.
    echo "::error::bun audit named at least one advisory in $DIR."
    exit 1
  fi

  echo "::warning::The npm advisory endpoint did not answer for $DIR (attempt $attempt/$ATTEMPTS)."
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep $(( BACKOFF_BASE_S * attempt ))
  fi
done

if [ "${REGISTRY_OUTAGE_IS_FAILURE:-false}" = 'true' ]; then
  echo "::error::The npm advisory endpoint never answered for $DIR after $ATTEMPTS attempts, so this tree was NOT audited - and this caller treats an unaudited tree as a failure. No verdict was reached; nothing here says the tree is bad."
  exit 1
fi

echo "::warning::The npm advisory endpoint never answered for $DIR after $ATTEMPTS attempts, so this tree was NOT audited. This is not a verdict about the tree, and the nightly pass asks again."
exit 2
