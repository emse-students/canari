#!/usr/bin/env bash
# =================================================================================================
# WHAT TO DO WITH A READING OF `upstream-reachability-report.sh`: SUSPECT IT, RECORD IT, CLOSE IT.
#
# WHY THE REPORT IS AN ISSUE AND NOT A RED RUN. A red scheduled run emails only the person who last
# edited the cron line, and a five-hour outage would be twenty red runs and twenty emails. An issue
# reaches everyone watching the repository, once, and says since when. The same split as
# `cargo-blocked-update-report.sh`: the issue says there is a finding, a red run says THIS reporter
# is broken (a gh call that failed, a missing results file).
#
# THE STATE MACHINE, per target, and every state is durable on GitHub - no clock, no cache:
#
#   up,   no outage issue open          -> nothing (and the target is cleared of suspicion)
#   up,   outage issue open             -> comment "back after <duration>", close it
#   down, outage issue open             -> nothing: the outage is already recorded, the run stays green
#   down, no issue, NOT yet suspected   -> record "suspect since <time>"
#   down, no issue, already suspected   -> open "Upstream <name> is down", saying since the first
#                                          failure, and clear the suspicion
#
# TWO CONSECUTIVE FAILURES BEFORE AN ISSUE, so a rolling deploy or a pre-release landing on dev, each
# of which answers 5xx for a minute, never alarms. The suspects live in the BODY of ONE standing
# issue ("Upstream monitor state"), edited in place: editing notifies nobody, and an issue per
# first failure would be the alarm this exists to avoid.
#
# Input: UPSTREAM_RESULTS, the TSV the reachability report wrote (name class code url).
# UPSTREAM_DRY_RUN=1 prints every decision and writes nothing. Needs REPO and GH_TOKEN (or
# `GH` pointing at a stub).
# =================================================================================================
set -uo pipefail

GH="${GH:-gh}"
REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
RESULTS="${UPSTREAM_RESULTS:-}"
DRY="${UPSTREAM_DRY_RUN:-0}"
NOW="${NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
readonly STATE_TITLE='Upstream monitor state'

die() {
  echo "::error::upstream-issues: $1"
  exit 1
}

[ -n "$REPO" ] || die 'REPO is unset - this reporter does not know which repository to file against.'
[ -r "$RESULTS" ] || die "no results file at '$RESULTS' - the reachability report did not run, so nothing was judged."

# find_open <exact title> -> prints the issue number or nothing. A refusal is not "none".
find_open() {
  local title="$1" out
  if ! out="$("$GH" issue list --repo "$REPO" --state open --search "$title in:title" \
    --json number,title --jq "[.[] | select(.title == \"$title\")] | .[0].number // empty" 2>&1)"; then
    printf '%s\n' "$out" | tail -5
    die "could not read the issue list. A refusal is not an answer: without it this run cannot tell an open report from none."
  fi
  printf '%s' "$out"
}

# act <description> <command...>: runs it, or only says it in a dry run.
act() {
  local what="$1"
  shift
  if [ "$DRY" = 1 ]; then
    echo "dry-run: would $what"
    return 0
  fi
  "$@" >/dev/null || die "could not $what."
}

# seconds between two ISO UTC stamps, rendered as "Xh Ym".
since_text() {
  local a b secs
  a="$(date -u -d "$1" +%s 2>/dev/null)" || {
    echo 'an unknown time'
    return
  }
  b="$(date -u -d "$2" +%s)"
  secs=$((b - a))
  [ "$secs" -lt 0 ] && secs=0
  printf '%sh %sm' $((secs / 3600)) $(((secs % 3600) / 60))
}

# --- the suspects: the body of the standing issue ---------------------------------------------------
state_no="$(find_open "$STATE_TITLE")"
suspects=''
if [ -z "$state_no" ]; then
  if [ "$DRY" = 1 ]; then
    echo "dry-run: would create the standing issue '$STATE_TITLE'"
  else
    url="$("$GH" issue create --repo "$REPO" --title "$STATE_TITLE" --body \
      'Written by `upstream-issues.sh`; do not close or edit. One line per target that failed its LAST reading: `suspect <name> <since>`. A second consecutive failure opens an issue; a success clears the line.' 2>&1)" ||
      die "could not create the standing state issue: $url"
    state_no="${url##*/}"
  fi
else
  suspects="$("$GH" issue view "$state_no" --repo "$REPO" --json body --jq .body 2>&1)" ||
    die "could not read the standing state issue #$state_no: $suspects"
fi
suspect_since() { printf '%s\n' "$suspects" | awk -v n="$1" '$1 == "suspect" && $2 == n {print $3; exit}'; }
suspects_without() { printf '%s\n' "$suspects" | awk -v n="$1" '!($1 == "suspect" && $2 == n)'; }
suspects_with() { { suspects_without "$1"; printf 'suspect %s %s\n' "$1" "$2"; } | grep -v '^$' || true; }

# --- one decision per target --------------------------------------------------------------------------
while IFS=$'\t' read -r name class code url; do
  [ -n "$name" ] || continue
  title="Upstream $name is down"
  open_no="$(find_open "$title")"

  if [ "$class" = up ]; then
    if [ -n "$open_no" ]; then
      since="$("$GH" issue view "$open_no" --repo "$REPO" --json body --jq .body 2>/dev/null | sed -n 's/.*<!-- since=\([^ ]*\) -->.*/\1/p' | head -1)"
      act "comment on #$open_no that $name is back, then close it" \
        bash -c '"$0" issue comment "$1" --repo "$2" --body "$3" && "$0" issue close "$1" --repo "$2"' \
        "$GH" "$open_no" "$REPO" "$name answers again (HTTP $code) at $NOW, after $(since_text "${since:-}" "$NOW"). Closing; a new outage opens a new issue."
      echo "ok: $name is back; closed #$open_no"
    else
      echo "ok: $name is up"
    fi
    [ -z "$(suspect_since "$name")" ] || suspects="$(suspects_without "$name")"
    continue
  fi

  if [ -n "$open_no" ]; then
    echo "ok: $name is $class and already recorded in #$open_no"
    continue
  fi

  first="$(suspect_since "$name")"
  if [ -z "$first" ]; then
    echo "suspect: $name is $class (HTTP $code); an issue opens if the next reading agrees"
    suspects="$(suspects_with "$name" "$NOW")"
    continue
  fi

  body="$name has failed two consecutive readings of the upstream monitor.

- target: $url
- class: $class (HTTP $code)
- first failed reading: $first
- confirmed: $NOW

Classes: \`tunnel-down\` is Cloudflare's 530/1033 (the name's tunnel has no live connector), \`origin-failing\` is the service behind the name answering 5xx, \`unreachable\` is no HTTP answer at all. See [upstream-reachability](https://github.com/emse-students/canari/blob/main/docs/wiki/infrastructure/upstream-reachability.md).

This issue is closed automatically, with the downtime, by the first reading that finds the name up. While it is open the monitor stays quiet.
<!-- since=$first -->"
  act "open '$title' (since $first)" "$GH" issue create --repo "$REPO" --title "$title" --body "$body"
  echo "down: $name is $class; opened an issue (since $first)"
  suspects="$(suspects_without "$name")"
done <"$RESULTS"

# --- write the suspects back, only when they changed ------------------------------------------------
if [ -n "$state_no" ] && [ "$DRY" != 1 ]; then
  current="$("$GH" issue view "$state_no" --repo "$REPO" --json body --jq .body 2>&1)" ||
    die "could not re-read the standing state issue #$state_no: $current"
  header='Written by `upstream-issues.sh`; do not close or edit. One line per target that failed its LAST reading: `suspect <name> <since>`. A second consecutive failure opens an issue; a success clears the line.'
  new="$header
$(printf '%s\n' "$suspects" | grep '^suspect ' || true)"
  if [ "$(printf '%s' "$new" | sed '/^$/d')" != "$(printf '%s' "$current" | sed '/^$/d')" ]; then
    "$GH" issue edit "$state_no" --repo "$REPO" --body "$new" >/dev/null ||
      die "could not record the suspects in #$state_no, so the next run would forget them and never open an issue."
  fi
fi
exit 0
