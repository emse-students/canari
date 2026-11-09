#!/usr/bin/env bash
# =================================================================================================
# IS THE UPSTREAM MONITOR STILL READING? - ASKED BY SOMETHING THAT DOES NOT DEPEND ON IT.
#
# WHY IT EXISTS. The `upstream` job of `scheduled.yml` asks for a reading every 15 minutes, and
# GitHub's scheduler delivers what it likes: measured 2026-11-06 19:19 -> 2026-11-09 06:57, it ran
# 13 times out of ~240 slots, 3.4 to 7.2 hours apart. A monitor that stops altogether (a workflow
# disabled, a job renamed away from its cron, the scheduler dropping every slot) says nothing - its
# silence looks exactly like "everything is up". A monitor cannot report its own absence, and
# neither can anything else that runs on the same scheduler.
#
# SO THIS RUNS ON A PUSH TO `main` (the `upstream-monitor-freshness` job of `ci.yml`): every merge,
# raised by people and agents, independent of the scheduler and of the monitor. It reads the
# monitor's own liveness clock - the completion time of the last SUCCESSFUL `Public names answer`
# job, written by GitHub when the monitor actually read and decided - and:
#
#   last reading within STALE_AFTER_HOURS   -> close "Upstream monitor has stopped reading" if open
#   none within it                          -> open it (once), naming the last reading it found
#
# THE THRESHOLD is a report threshold, never a correctness one: wrong, it costs a late or an early
# issue. 12 hours is above the worst gap measured above (7.2 h), so the scheduler's ordinary drops
# never alarm, and a monitor gone for half a day always does - at the next merge.
#
# A refused `gh` call is a failure of THIS reporter (exit 1), never "fresh". Needs REPO and
# GH_TOKEN (or `GH` pointing at a stub); NOW is injectable so no test reads a wall clock.
# UPSTREAM_DRY_RUN=1 prints the decision and writes nothing.
# =================================================================================================
set -uo pipefail

GH="${GH:-gh}"
REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
DRY="${UPSTREAM_DRY_RUN:-0}"
NOW="${NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
STALE_AFTER_HOURS="${STALE_AFTER_HOURS:-12}"
# The `name:` of the `upstream` job in scheduled.yml; `upstream-monitor-freshness.test.sh` holds the
# two equal, because a rename would otherwise read as a monitor that stopped.
readonly MONITOR_JOB='Public names answer'
readonly TITLE='Upstream monitor has stopped reading'

die() {
  echo "::error::upstream-monitor-freshness: $1"
  exit 1
}

[ -n "$REPO" ] || die 'REPO is unset - this reporter does not know which repository to read.'

now_s="$(date -u -d "$NOW" +%s)" || die "NOW is not a date: '$NOW'"
horizon_s=$((now_s - STALE_AFTER_HOURS * 3600))

# Newest first. A run created before the horizon cannot hold a reading inside it, so the walk stops
# there: the number of calls is bounded by the runs of the window, not by the history.
runs="$("$GH" api "repos/$REPO/actions/workflows/scheduled.yml/runs?status=completed&per_page=100" \
  --jq '.workflow_runs[] | "\(.id) \(.created_at)"' 2>&1)" ||
  die "could not list the scheduled runs: $(printf '%s' "$runs" | tail -3)"

last=''
last_run=''
while read -r id created; do
  [ -n "$id" ] || continue
  # The run started before the horizon: a reading it made may still have completed inside it
  # (the job lasts about a minute), so it is read, and it is the last one read.
  done_at="$("$GH" api "repos/$REPO/actions/runs/$id/jobs" \
    --jq "[.jobs[] | select(.name == \"$MONITOR_JOB\" and .conclusion == \"success\") | .completed_at] | .[0] // empty" 2>&1)" ||
    die "could not read the jobs of run $id: $(printf '%s' "$done_at" | tail -3)"
  if [ -n "$done_at" ]; then
    last="$done_at"
    last_run="$id"
    break
  fi
  [ "$(date -u -d "$created" +%s)" -ge "$horizon_s" ] || break
done <<<"$runs"

open_no="$("$GH" issue list --repo "$REPO" --state open --search "$TITLE in:title" \
  --json number,title --jq "[.[] | select(.title == \"$TITLE\")] | .[0].number // empty" 2>&1)" ||
  die "could not read the issue list: $(printf '%s' "$open_no" | tail -3)"

fresh=0
if [ -n "$last" ] && [ "$(date -u -d "$last" +%s)" -ge "$horizon_s" ]; then
  fresh=1
fi

if [ "$fresh" = 1 ]; then
  echo "ok: the upstream monitor last read at $last (run $last_run), within ${STALE_AFTER_HOURS}h of $NOW"
  [ -n "$open_no" ] || exit 0
  if [ "$DRY" = 1 ]; then
    echo "dry-run: would close #$open_no"
    exit 0
  fi
  "$GH" issue comment "$open_no" --repo "$REPO" --body "The upstream monitor reads again: last reading at $last (run $last_run), seen at $NOW. Closing." >/dev/null ||
    die "could not comment on #$open_no"
  "$GH" issue close "$open_no" --repo "$REPO" >/dev/null || die "could not close #$open_no"
  echo "ok: closed #$open_no"
  exit 0
fi

echo "stale: no successful '$MONITOR_JOB' job within ${STALE_AFTER_HOURS}h of $NOW (last found: ${last:-none in the window})"
if [ -n "$open_no" ]; then
  echo "ok: already recorded in #$open_no"
  exit 0
fi
body="The upstream monitor (the \`upstream\` job of \`scheduled.yml\`, \"$MONITOR_JOB\") has not completed a reading in the last ${STALE_AFTER_HOURS} hours, seen at $NOW by a push to \`main\`.

- last successful reading found: ${last:-none in the window}${last_run:+ (run $last_run)}

While this is open, an outage of a public name goes unreported. Read \`gh run list --workflow scheduled.yml\`: no run at all is the scheduler (or a disabled workflow); runs whose \`$MONITOR_JOB\` job fails or skips are the monitor itself. See [upstream-reachability](https://github.com/emse-students/canari/blob/main/docs/wiki/infrastructure/upstream-reachability.md#who-watches-the-monitor).

Closed automatically by the first push to \`main\` that finds a reading within the window."
if [ "$DRY" = 1 ]; then
  echo "dry-run: would open '$TITLE'"
  exit 0
fi
url="$("$GH" issue create --repo "$REPO" --title "$TITLE" --body "$body" 2>&1)" ||
  die "could not open '$TITLE': $url"
echo "stale: opened $url"
exit 0
