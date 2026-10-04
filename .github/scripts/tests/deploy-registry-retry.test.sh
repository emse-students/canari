#!/usr/bin/env bash
# Does the deploy tell an UNREACHABLE REGISTRY from a BROKEN CHANGE?
#
# Run 33633156004 (2026-09-02) failed in 16 s on a TLS handshake timeout to ghcr.io and read exactly
# like a broken release. `with_registry_retry` in `infrastructure/deploy/deploy-environment.sh` is
# what separates them: it re-attempts the login and the pull a bounded number of times, and when the
# registry still does not answer it exits 75 under its own annotation title. Extracted from the real
# script and run against stub commands, so the assertions are about the outcome, not the text.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DEPLOY="$REPO/infrastructure/deploy/deploy-environment.sh"
PASS=0
FAIL=0
ok() {
  printf '  ok   %s\n' "$1"
  PASS=$((PASS + 1))
}
fail() {
  printf '  FAIL %s\n' "$1"
  FAIL=$((FAIL + 1))
}

fn="$(sed -n '/^with_registry_retry() {/,/^}/p' "$DEPLOY")"
if [ -z "$fn" ]; then
  printf '::error::with_registry_retry() is not a function in %s - it cannot be exercised\n' "$DEPLOY" >&2
  exit 1
fi
ok "with_registry_retry() is extractable from the real script"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# `run <failures-before-success>` - a stub command that fails N times then succeeds, counted in a
# file because each attempt runs in the same subshell. No sleeping: the delays are zeros.
run() {
  (
    # shellcheck disable=SC2034 # read by the eval'ed function
    REGISTRY=ghcr.io
    # shellcheck disable=SC2034
    REGISTRY_RETRY_DELAYS="0 0 0"
    printf '0' >"$TMP/count"
    # shellcheck disable=SC2317,SC2329 # called only from the eval'ed function
    flaky() {
      local n
      n="$(cat "$TMP/count")"
      printf '%s' "$((n + 1))" >"$TMP/count"
      [ "$n" -ge "$1" ]
    }
    eval "$fn"
    with_registry_retry "image pull" flaky "$1"
    printf 'continued\n'
  )
}

out="$(run 0 2>&1)"
code=$?
if [ "$code" = "0" ] && [ "$(cat "$TMP/count")" = "1" ] && printf '%s' "$out" | grep -q continued; then
  ok "a pull that succeeds is run once and the deploy continues"
else
  fail "a first-time success must not retry (exit $code, $(cat "$TMP/count") attempts)"
fi

out="$(run 2 2>&1)"
code=$?
if [ "$code" = "0" ] && [ "$(cat "$TMP/count")" = "3" ] && printf '%s' "$out" | grep -q continued; then
  ok "a registry hiccup is re-attempted and the deploy continues"
else
  fail "two transient failures must be absorbed (exit $code, $(cat "$TMP/count") attempts)"
fi

out="$(run 99 2>&1)"
code=$?
if [ "$code" = "75" ]; then
  ok "a registry that never answers exits 75, not the 1 of a broken change"
else
  fail "an unreachable registry must exit 75 (got $code)"
fi
if [ "$(cat "$TMP/count")" = "4" ]; then
  ok "and it stops after one attempt per delay plus the first - it terminates by construction"
else
  fail "expected 4 attempts, got $(cat "$TMP/count")"
fi
case "$out" in
  *'::error title=Registry unreachable - not a broken change::'*) ok "and its annotation says which kind of failure it is" ;;
  *) fail "the annotation must name the registry, not the change" ;;
esac
case "$out" in
  *continued*) fail "nothing may run after the registry gave up" ;;
  *) ok "and nothing after it runs" ;;
esac

# Both registry steps of the real script must go through it - a bare `dc pull` would bring the
# conflation back in silence.
if grep -Eq '^[[:space:]]*with_registry_retry "image pull" dc pull' "$DEPLOY" &&
  grep -Eq '^[[:space:]]*with_registry_retry "docker login" ghcr_login' "$DEPLOY"; then
  ok "the login and the pull both go through it"
else
  fail "the login or the pull no longer goes through with_registry_retry"
fi
if grep -Eq '^[[:space:]]*dc pull' "$DEPLOY"; then
  fail "a bare dc pull is back in the deploy script"
else
  ok "no bare dc pull is left"
fi

printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf 'all %s assertions passed\n' "$PASS"
else
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
