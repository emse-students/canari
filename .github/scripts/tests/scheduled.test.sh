#!/usr/bin/env bash
#
# THE CRON STRING IS THE ROUTING, SO A TYPO IS A JOB THAT NEVER RUNS AND SAYS NOTHING.
#
# `scheduled.yml` holds everything this repository does on a clock, in one file, and each job picks
# itself out with `github.event.schedule == '<cron>'`. That literal appears TWICE - once in the
# `schedule:` list, once in the job's `if:` - and nothing in GitHub compares them. A cron declared
# and named by nobody fires a run in which every job skips: a green run that did nothing. A job
# naming a cron that is not declared simply never runs, for ever, and its absence is the only
# symptom.
#
# Both directions are asserted here, which is the whole point of the file.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WF="$(cd "$HERE/../../workflows" && pwd)"
SCHED="$WF/scheduled.yml"

PASS=0
FAIL=0
pass() {
  PASS=$((PASS + 1))
  printf '  ok    %s\n' "$1"
}
fail() {
  FAIL=$((FAIL + 1))
  printf '  FAIL  %s\n' "$1"
}

printf '\nevery cron is claimed by exactly one job, and every job names a declared cron\n'
# =================================================================================================
if [ ! -r "$SCHED" ]; then
  fail 'scheduled.yml is gone - the clock work is back to one workflow per job, which is what flooded the Actions list'
  printf '\n1 of 1 assertions FAILED\n'
  exit 1
fi

# The `schedule:` block, and only it: `- cron: '...'` lines above `workflow_dispatch:`.
DECLARED="$(sed -n "/^  schedule:$/,/^  workflow_dispatch:$/p" "$SCHED" |
  grep -oE "cron: '[^']+'" | sed "s/cron: '//; s/'$//" | sort)"

# What the jobs claim. The comparison is against `github.event.schedule`, so that is what is read -
# not any cron-looking string that happens to be in a comment.
CLAIMED="$(grep -oE "github\.event\.schedule == '[^']+'" "$SCHED" |
  sed "s/.*== '//; s/'$//" | sort)"

if [ -z "$DECLARED" ]; then
  fail 'scheduled.yml declares no cron at all - nothing on a clock runs any more'
else
  pass "it declares $(echo "$DECLARED" | wc -l | tr -d ' ') cron(s)"
fi

# COMPARED AS SETS, DEDUPED - and the duplicate is examined on its own below. `comm` takes sorted
# input and answers per LINE rather than per value, so a cron legally claimed by TWO jobs puts a
# second copy in `CLAIMED` and comes back from `comm -13` as a cron "no schedule declares". That
# fired the day a second job joined the 02:00 slot, and the test contradicted itself inside one
# run: it failed for an undeclared cron, then passed the note saying that very cron was
# deliberately shared. A test that refuses what it declares legal five lines later is wrong, not
# strict.
CLAIMED_SET="$(echo "$CLAIMED" | uniq)"

ORPHAN_CRON="$(comm -23 <(echo "$DECLARED") <(echo "$CLAIMED_SET") | tr '\n' ' ')"
if [ -z "${ORPHAN_CRON// /}" ]; then
  pass 'every declared cron is claimed by a job'
else
  fail "cron(s) declared and claimed by nobody:$ORPHAN_CRON - that slot wakes a run in which every job skips, and the run is GREEN"
fi

ORPHAN_JOB="$(comm -13 <(echo "$DECLARED") <(echo "$CLAIMED_SET") | tr '\n' ' ')"
if [ -z "${ORPHAN_JOB// /}" ]; then
  pass 'every cron a job names is declared'
else
  fail "job(s) waiting on undeclared cron(s):$ORPHAN_JOB - they never run, and the only symptom is an absence"
fi

# AND NO TWO JOBS ON THE SAME SLOT UNLESS THAT IS DELIBERATE. Two jobs claiming one cron is legal
# and may be wanted; what is never wanted is a cron claimed twice by ACCIDENT, which is what a
# copy-pasted `if:` looks like. Reported rather than refused.
DUPES="$(echo "$CLAIMED" | uniq -d | tr '\n' ' ')"
if [ -z "${DUPES// /}" ]; then
  pass 'each cron wakes exactly one job'
else
  pass "note: cron(s) claimed by more than one job:$DUPES (legal - check it is deliberate)"
fi

printf '\nthe hand dispatch can reach every job, and only the jobs that exist\n'
# =================================================================================================
# A `choice` input is a closed list, so a job whose name is missing from it cannot be run by hand at
# all - and the only way to find that out is to want it at 2am.
OPTIONS="$(sed -n '/^        options:/p' "$SCHED" | sed 's/.*\[//; s/\].*//' | tr -d ' ' | tr ',' '\n' |
  grep -v '^all$' | sort)"
JOBS="$(sed -n '/^jobs:$/,$p' "$SCHED" | grep -oE '^  [a-z][a-z0-9-]*:$' | tr -d ' :' | sort)"

MISSING="$(comm -13 <(echo "$OPTIONS") <(echo "$JOBS") | tr '\n' ' ')"
if [ -z "${MISSING// /}" ]; then
  pass 'every job is reachable from the dispatch menu'
else
  fail "job(s) with no dispatch option:$MISSING - they can only ever be run by waiting for the clock"
fi

STALE="$(comm -23 <(echo "$OPTIONS") <(echo "$JOBS") | tr '\n' ' ')"
if [ -z "${STALE// /}" ]; then
  pass 'the dispatch menu names no job that no longer exists'
else
  fail "dispatch option(s) naming nothing:$STALE - picking one starts a run that does nothing, and it is green"
fi

printf '\n'
if [ "$FAIL" -ne 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
