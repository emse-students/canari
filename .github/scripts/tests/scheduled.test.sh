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

printf '\nthe stores job completes a deferred App Store submission, and only through the release path\n'
# =================================================================================================
# THE 1.8.1 SILENCE (2026-11-25): the release deferred on a held slot, the slot freed, and nothing
# ever submitted - this job only reported. The catch-up is what closes it, and each of its inputs is
# one a later edit could quietly swap for a plausible wrong one: the notes of `main` (the NEXT
# version's), a recomputed band, or a second submission implementation. `submit.test.mjs` proves
# the decisions against a fake App Store; this proves the job feeds them the right facts.
STORES="$(sed -n '/^  stores:$/,/^  [a-z][a-z0-9-]*:$/p' "$SCHED")"
has() { grep -qF -- "$1" <<<"$STORES"; }

if has 'bun tools/app-store/submit.mjs --catch-up'; then
  pass 'the stores job submits through submit.mjs - one implementation, the release one'
else
  fail 'the stores job no longer runs submit.mjs --catch-up - a deferred App Store submission waits for a human again'
fi
if has 'divergence.mjs --catch-up-target'; then
  pass 'its target is the latest stable, while no release run is in flight (pickLatestStable, releaseInFlight)'
else
  fail 'the catch-up target is no longer divergence.mjs --catch-up-target - a stale stable could be submitted, or a release raced'
fi
# shellcheck disable=SC2016 # `${{ }}` is GitHub Actions syntax and is matched literally
if has 'WHATS_NEW_REF: ${{ steps.target.outputs.tag }}'; then
  pass "the notes are read from the stable's own tag, by submit.mjs itself"
else
  fail "the catch-up no longer hands submit.mjs the stable's tag (WHATS_NEW_REF) - main carries the next version's notes"
fi

# THE APP STORE CREDENTIAL LIVES IN ONE STEP OF THE CATCH-UP, the one that runs submit.mjs. The
# report step reads App Store Connect too and has its own; the target step must have none.
TARGET_STEP="$(sed -n '/name: Find the stable the App Store catch-up would submit/,/- name:/p' <<<"$STORES")"
if [ -n "$TARGET_STEP" ] && ! grep -q 'ASC_' <<<"$TARGET_STEP"; then
  pass 'the step choosing the target holds no App Store credential'
else
  fail 'the App Store credential reaches the target step (or the step is gone) - it belongs to the submit.mjs step only'
fi

# ONE CATCH-UP AT A TIME, AND NEVER IN THE RELEASE'S GROUP: a pending run in a shared group is
# cancelled by the next to join, so sharing `release` could cancel a queued release.
if has 'group: app-store-catch-up' && ! has 'group: release'; then
  pass 'the catch-up has its own concurrency group, not the release one'
else
  fail "the stores job's concurrency group is not app-store-catch-up alone - two catch-ups could race, or a queued release be cancelled"
fi
# THE BOUND: no wait anywhere in a catch-up, and a timeout far under a stable's time to its submit.
TIMEOUT="$(awk '/^    timeout-minutes: [0-9]+$/ && !seen { print $2; seen = 1 }' <<<"$STORES")"
if [ -n "$TIMEOUT" ] && [ "$TIMEOUT" -le 10 ]; then
  pass "the job is killed at ${TIMEOUT} minutes, under any stable's time to its own submit"
else
  fail "the stores job timeout is ${TIMEOUT:-unset} - the catch-up's write window is no longer bounded below a release's"
fi
if has 'scripts/bump-app-version.sh --code'; then
  pass 'the build number is the band the bump owns, not a second formula'
else
  fail 'the catch-up build number no longer comes from bump-app-version.sh --code'
fi
if has 'actions: read'; then
  pass 'and it may read release.yml runs, which is how it knows one is in flight'
else
  fail 'the stores job lost actions: read - releaseInFlight cannot see a running release, and the catch-up would race it'
fi
# The deferral's exit code is shared with ios.yml's; asserted here as there, so a held slot stays green.
# shellcheck disable=SC2016 # the literal workflow text, not an expansion
if has '"$code" -eq 75'; then
  pass 'a held slot (EXIT_SLOT_HELD) leaves the catch-up green'
else
  fail 'the catch-up no longer treats exit 75 as a deferral - every busy Apple queue turns it red'
fi
if [ "$(grep -c '!cancelled()' <<<"$STORES")" -ge 2 ]; then
  pass 'and a failed catch-up does not silence the report after it'
else
  fail 'the report steps no longer run after a failed catch-up - one red step would hide what the stores hold'
fi

printf '\n'
if [ "$FAIL" -ne 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
