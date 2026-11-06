#!/usr/bin/env bash
# =================================================================================================
# IS EVERY UPSTREAM THE ESTATE DEPENDS ON ANSWERING - AND IF NOT, SINCE WHEN, AND WHICH KIND OF NOT?
#
# WHY IT EXISTS. On 2026-11-05 two outages ran for 25 minutes and for five hours and nothing told
# anyone: the dev estate's tunnel connector lost every connection (Cloudflare answered `1033` for
# `dev` and the legacy name), and the gallery's own tunnel had no connector (`530` / `1033`, so
# every avatar was a `502`). Both were found by hand, a day late. Both are the SAME shape - a
# public name whose tunnel has no live connector - so ONE reader asks them all
# (docs/wiki/infrastructure/upstream-reachability.md).
#
# WHY IT RUNS ON A GITHUB-HOSTED RUNNER. The question is "does the PUBLIC name answer", which is
# what a user's phone asks; the self-hosted runner sits on the very network whose tunnel may be the
# thing that failed, so it could not tell. A red `scheduled.yml` run is the report, as everywhere
# in this repository (nothing else is read by anyone).
#
# WHAT A READING CARRIES. Each target is classed, never just "failed", because the cause decides
# who acts:
#
#   | reading                                   | class           | whose it is                        |
#   | ----------------------------------------- | --------------- | ---------------------------------- |
#   | 2xx                                       | up              | nobody                             |
#   | 530 + Cloudflare 1033                     | tunnel-down     | the connector's host               |
#   | 52x, 502/503/504 from the origin          | origin-failing  | the service behind the name        |
#   | any other status                          | unexpected      | read the target                    |
#   | no HTTP answer on every attempt           | unreachable     | a transport failure, not an answer |
#
# ONE FAILED ATTEMPT IS NOT A READING: a public runner's own network may blink. A target is down
# only when ALL `UPSTREAM_ATTEMPTS` attempts, spaced `UPSTREAM_SPACING` seconds apart, disagree
# with `up`. That is not a retry hiding a fault - the fault is reported when it persists, and a
# single dropped packet on GitHub's side is not the estate's fault.
#
# Targets are `name|url` lines in UPSTREAM_TARGETS (default below). Exit 0 when all are up, 1 when
# one is not. Every finding is an `::error::` annotation naming the target, class and status.
# =================================================================================================
set -uo pipefail

CURL="${CURL:-curl}"
ATTEMPTS="${UPSTREAM_ATTEMPTS:-3}"
SPACING="${UPSTREAM_SPACING:-10}"
DEFAULT_TARGETS='gallery|https://gallery.mitv.fr/api/health
dev|https://dev.canari-emse.fr/api/version
legacy|https://canari-emse.fr/api/version
production|https://canari.emse.fr/api/version'
TARGETS="${UPSTREAM_TARGETS:-$DEFAULT_TARGETS}"

# classify <http_code> <body> -> echoes the class
classify() {
  local code="$1" body="$2"
  case "$code" in
  2??) echo up ;;
  530)
    if printf '%s' "$body" | grep -qE '1033'; then echo tunnel-down; else echo origin-failing; fi
    ;;
  52? | 502 | 503 | 504) echo origin-failing ;;
  000) echo unreachable ;;
  *) echo unexpected ;;
  esac
}

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

# probe <url> -> sets CLASS and CODE from the last attempt; returns 0 when up on any attempt.
probe() {
  local url="$1" i
  for ((i = 1; i <= ATTEMPTS; i++)); do
    : >"$BODY_FILE"
    CODE="$($CURL -sS -m 15 -o "$BODY_FILE" -w '%{http_code}' "$url" 2>/dev/null || true)"
    CODE="${CODE:-000}"
    CLASS="$(classify "$CODE" "$(head -c 4096 "$BODY_FILE")")"
    [ "$CLASS" = up ] && return 0
    [ "$i" -lt "$ATTEMPTS" ] && sleep "$SPACING"
  done
  return 1
}

status=0
printf 'upstream reachability at %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
while IFS='|' read -r name url; do
  [ -z "$name" ] && continue
  if probe "$url"; then
    printf '  up    %-11s %s\n' "$name" "$CODE"
  else
    printf '::error::upstream %s is %s (HTTP %s after %s attempts): %s\n' "$name" "$CLASS" "$CODE" "$ATTEMPTS" "$url"
    status=1
  fi
done <<<"$TARGETS"
exit "$status"
