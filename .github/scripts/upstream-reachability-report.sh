#!/usr/bin/env bash
# =================================================================================================
# DOES EVERY PUBLIC NAME THE ESTATE DEPENDS ON ANSWER - AND IF NOT, WHICH KIND OF NOT?
#
# WHY IT EXISTS. On 2026-11-05 two outages ran for 25 minutes and for five hours and nothing told
# anyone: both were a public name whose tunnel had no live connector (Cloudflare answers `530` with
# error `1033`), and both were found by hand, a day late. One reader asks every name
# (docs/wiki/infrastructure/upstream-reachability.md). It only MEASURES: what to do with a reading
# (suspect it, open an issue, close it) is `upstream-issues.sh`'s, because a measurement that also
# alarms would alarm on every deploy.
#
# WHY A GITHUB-HOSTED RUNNER. The question is "does the PUBLIC name answer", which is what a user's
# phone asks; a runner inside the estate's own network could not tell.
#
# WHAT A READING CARRIES. Each target is classed, never just "failed", because the cause decides
# who acts:
#
#   | reading                                   | class            | whose it is                       |
#   | ----------------------------------------- | ---------------- | --------------------------------- |
#   | 2xx                                       | up               | nobody                            |
#   | 530 whose body names Cloudflare's 1033    | tunnel-down      | the connector's host              |
#   | 530 without a 1033                        | unclassified-530 | read the body                     |
#   | other 52x, 502, 503, 504                  | origin-failing   | the service behind the name       |
#   | 4xx the EDGE wrote (`cf-mitigated`, a     | edge-refused     | the zone's security settings: the |
#   | Cloudflare block or challenge page)       |                  | MONITOR is refused, not the name  |
#   | any other status                          | unexpected       | read the target                   |
#   | no HTTP answer on every attempt           | unreachable      | a transport failure, not an answer|
#
# ONE FAILED ATTEMPT IS NOT A READING: a runner's own network may blink. A target is down only when
# ALL `UPSTREAM_ATTEMPTS` attempts, `UPSTREAM_SPACING` seconds apart, disagree with `up`. Targets are
# probed IN PARALLEL, so the worst case of the run is one target's (attempts x 15 s + spacings),
# about 65 s, never the sum.
#
# `edge-refused` IS NOT AN OUTAGE AND NOT HEALTH: the edge answered for itself, so the reading says
# nothing about the name and everything about this probe - it is BLINDNESS, reported as such by
# `upstream-issues.sh`. Measured 2026-11-06..09: every reading of the three Cloudflare-fronted names
# from a GitHub-hosted runner was a 403 while a phone read 200; classed `unexpected`, it opened
# three "is down" issues that no reading could ever close.
#
# EVERY READING CARRIES ITS EVIDENCE (the `evidence` column: the `server` and `cf-mitigated`
# headers, and the first words of the body), because a class this script cannot decide must still
# leave a reader able to.
#
# OUTPUT. A human line per target on stdout, and when `UPSTREAM_RESULTS` is set one TSV line per
# target (`name class code url evidence`) for `upstream-issues.sh`. Exit 0 whether or not a target is down
# (a finding is data, not a fault of this script); exit 2 only when the script cannot run.
# =================================================================================================
set -uo pipefail

CURL="${CURL:-curl}"
ATTEMPTS="${UPSTREAM_ATTEMPTS:-3}"
SPACING="${UPSTREAM_SPACING:-10}"
RESULTS="${UPSTREAM_RESULTS:-}"
# A recognisable client, so an operator reading the edge's or the origin's log can tell this probe.
UA='canari-upstream-monitor (+https://github.com/emse-students/canari)'
DEFAULT_TARGETS='gallery|https://gallery.mitv.fr/api/health
dev|https://dev.canari-emse.fr/api/version
legacy|https://canari-emse.fr/api/version
production|https://canari.emse.fr/api/version'
TARGETS="${UPSTREAM_TARGETS-$DEFAULT_TARGETS}"

# The markers of a response Cloudflare's edge wrote ITSELF instead of forwarding the origin's: a
# managed or JavaScript challenge (`cf-mitigated: challenge`, "Just a moment..."), a block page
# ("Attention Required! | Cloudflare", "Sorry, you have been blocked") or the plain-text form a
# non-browser client gets (`error code: 1010`, `1020`...). 1033 is excluded: it is a 530, and it is
# about the tunnel, not about the client.
readonly EDGE_BODY_MARKERS='Attention Required! \| Cloudflare|Sorry, you have been blocked|Just a moment\.\.\.|/cdn-cgi/challenge-platform/|cf-error-code|error code: 10(0[0-9]|1[0-9]|2[0-9])([^0-9]|$)'

# classify <http_code> <body> <headers> -> echoes the class
classify() {
  local code="$1" body="$2" headers="${3:-}"
  case "$code" in
  2??) echo up ;;
  530)
    if grep -qE '1033' <<<"$body"; then echo tunnel-down; else echo unclassified-530; fi
    ;;
  52? | 502 | 503 | 504) echo origin-failing ;;
  000) echo unreachable ;;
  4??)
    if grep -qiE '^cf-mitigated:' <<<"$headers" || grep -qE "$EDGE_BODY_MARKERS" <<<"$body"; then
      echo edge-refused
    else
      echo unexpected
    fi
    ;;
  *) echo unexpected ;;
  esac
}

# evidence <headers file> <body file> -> one line, no tab: what a reader needs to class it by hand.
evidence() {
  local server mitigated words
  server="$(grep -iE '^server:' "$1" 2>/dev/null | tail -1 | cut -d: -f2- | tr -d '\r\t' | sed 's/^ *//')"
  mitigated="$(grep -iE '^cf-mitigated:' "$1" 2>/dev/null | tail -1 | cut -d: -f2- | tr -d '\r\t' | sed 's/^ *//')"
  words="$(head -c 4096 "$2" 2>/dev/null | tr -s '\r\n\t ' ' ' | sed 's/<style[^>]*>[^<]*<\/style>/ /g; s/<[^>]*>/ /g' | tr -s ' ' | sed 's/^ //' | cut -c1-120)"
  printf 'server=%s cf-mitigated=%s body=%s' "${server:--}" "${mitigated:--}" "${words:--}"
}

TMP="$(mktemp -d)" || exit 2
trap 'rm -rf "$TMP"' EXIT

# probe_one <name> <url> <out>: writes "name<TAB>class<TAB>code<TAB>url<TAB>evidence" to <out>.
probe_one() {
  local name="$1" url="$2" out="$3" i code class body hdr
  body="$out.body"
  hdr="$out.headers"
  for ((i = 1; i <= ATTEMPTS; i++)); do
    : >"$body"
    : >"$hdr"
    code="$($CURL -sS -m 15 -A "$UA" -D "$hdr" -o "$body" -w '%{http_code}' "$url" 2>/dev/null || true)"
    code="${code:-000}"
    class="$(classify "$code" "$(head -c 4096 "$body")" "$(cat "$hdr")")"
    [ "$class" = up ] && break
    [ "$i" -lt "$ATTEMPTS" ] && sleep "$SPACING"
  done
  printf '%s	%s	%s	%s	%s
' "$name" "$class" "$code" "$url" "$(evidence "$hdr" "$body")" >"$out"
}

n=0
names=()
while IFS='|' read -r name url; do
  [ -z "$name" ] && continue
  n=$((n + 1))
  names+=("$name")
  probe_one "$name" "$url" "$TMP/$n" &
done <<<"$TARGETS"
wait

[ "$n" -gt 0 ] || {
  echo '::error::upstream: no target to probe - UPSTREAM_TARGETS is empty' >&2
  exit 2
}

printf 'upstream reachability at %s
' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[ -z "$RESULTS" ] || : >"$RESULTS"
for ((i = 1; i <= n; i++)); do
  if [ ! -s "$TMP/$i" ]; then
    echo "::error::upstream: the probe of ${names[$((i - 1))]} left no reading" >&2
    exit 2
  fi
  IFS=$'	' read -r name class code url ev <"$TMP/$i"
  printf '  %-17s %-11s HTTP %s  %s
' "$class" "$name" "$code" "$url"
  [ "$class" = up ] || printf '      %s
' "$ev"
  [ -z "$RESULTS" ] || cat "$TMP/$i" >>"$RESULTS"
done
exit 0
