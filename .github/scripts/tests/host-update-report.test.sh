#!/usr/bin/env bash
# =================================================================================================
# THE OS-UPDATE REPORT'S VERDICT, AGAINST FABRICATED HOSTS.
#
# WHY. `host-update-report.sh` exists because a mechanism with no report is found by hand, a day
# late. A report whose verdict has never been seen to FAIL is the same defect one level up: it would
# go green on a box applying nothing, and nobody would learn that until the box was compromised.
#
# The script separates `gather` (reads a host) from `judge` (reads facts) exactly so this can exist.
# Every case below is a host shape that was really met on 2026-09-03, or the one the design is
# afraid of:
#
#   * One host had the periodic switch ON with the package ABSENT.
#   * It had wanted a reboot for weeks, for a KERNEL update, with 8 weeks of uptime.
#   * All four hosts had `apt-daily-upgrade.timer` reported `enabled` while applying nothing.
#   * The three trixie boxes resolved `label=Debian` into the allowed list, because APT
#     configuration lists ACCUMULATE across files rather than overriding - so the policy was
#     "everything in stable" while the file said security.
# =================================================================================================
set -uo pipefail

# shellcheck source-path=SCRIPTDIR
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT="$HERE/../../../infrastructure/deploy/host-update-report.sh"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

[ -r "$REPORT" ] || { printf 'cannot read %s\n' "$REPORT"; exit 1; }
# The subject under test lives outside `.github/`, so shellcheck cannot follow the `.` however the
# path is spelt - `source-path=SCRIPTDIR` resolves siblings, not a climb out of the tree. The `[ -r ]`
# above is the runtime version of the same assertion, and it fails loudly rather than passing zero
# assertions, which is what a moved script would otherwise do here.
# shellcheck disable=SC1090,SC1091
. "$REPORT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

NOW="$(date +%s)"
YESTERDAY=$((NOW - 86400))
LONG_AGO=$((NOW - 30 * 86400))

# `${distro_codename}` is APT's own placeholder and must stay LITERAL - it is what the resolved list
# really contains on every host here, so a double-quoted string would test a shape no box has.
# shellcheck disable=SC2016
SECURITY_ORIGINS='origin=Debian,codename=${distro_codename}-security,label=Debian-Security|origin=Debian,codename=${distro_codename},label=Debian-Security'

# Writes a facts file for a healthy host, then applies the overrides given as `key=value` words.
facts_for() {
  local out="$TMP/facts"
  {
    printf 'host=%q\n' testbox
    printf 'installed=%q\n' yes
    printf 'version=%q\n' 2.12
    printf 'periodic_update=%q\n' 1
    printf 'periodic_upgrade=%q\n' 1
    printf 'trigger_epoch=%q\n' "$YESTERDAY"
    printf 'last_run_epoch=%q\n' "$YESTERDAY"
    printf 'last_outcome=%q\n' nothing-to-do
    printf 'pending_security=%q\n' 0
    printf 'reboot=%q\n' no
    printf 'reboot_pkgs=%q\n' ""
    printf 'origins=%q\n' "$SECURITY_ORIGINS"
    printf 'now_epoch=%q\n' "$NOW"
    printf 'disk_pct=%q\n' 73
    printf 'disk_used_kb=%q\n' 32505856
    printf 'disk_size_kb=%q\n' 47185920
    printf 'backups_dir=%q\n' /srv/canari-backups
    printf 'backups_kb=%q\n' 5662310
    printf 'docker_df=%q\n' 'Images 6.301GB (538.2MB (8%) reclaimable); Local Volumes 3.994GB (0B (0%) reclaimable)'
    printf 'runners_root=%q\n' /runners
    printf 'runner_stale_kb=%q\n' 0
    printf 'runner_stale=%q\n' ''
  } > "$out"
  local kv
  for kv in "$@"; do
    local key="${kv%%=*}" val="${kv#*=}"
    # Drop the default line, append the override - so the last value wins whatever the order.
    grep -v "^${key}=" "$out" > "$out.new" && mv "$out.new" "$out"
    # %q FOR THE SAME REASON `gather` DOES IT: `judge` sources this file, so an unquoted `|` in an
    # origin list is a PIPELINE and the variable comes out unset. Writing the overrides raw is how
    # this suite spent a round reporting "allowed origins: NONE" for every case that set them.
    printf '%s=%q\n' "$key" "$val" >> "$out"
  done
  printf '%s' "$out"
}

# Runs `judge` in a subshell so its `.` of the facts cannot leak variables into the next case.
verdict() {
  local f="$1"
  ( judge "$f" >/dev/null 2>&1 ); printf '%s' "$?"
}

# Returns the report text, for asserting that a message NAMES the thing it found.
text_of() {
  local f="$1"
  ( judge "$f" 2>&1 ) || true
}

printf '\na healthy host passes, or nothing below means anything\n'
# ═════════════════════════════════════════════════════════════════════════════
f="$(facts_for)"
if [ "$(verdict "$f")" = "0" ]; then
  pass "installed, switches on, timer fired yesterday, nothing pending, security-only origins"
else
  fail "a healthy host was reported as a finding - every case below would be meaningless"
fi

printf '\nthe two halves of "updates are on" are read separately, because one host had them disagree\n'
# ═════════════════════════════════════════════════════════════════════════════
f="$(facts_for 'installed=no' 'version=')"
if [ "$(verdict "$f")" = "1" ]; then
  pass "the package absent is a finding"
else
  fail "a host with no unattended-upgrades package passed"
fi

# THIS IS THAT HOST AS FOUND. The switch says 1, the package is absent: a configuration that reads as
# on and does nothing. The report has to name the package, not "updates are off".
f="$(facts_for 'installed=no' 'version=' 'periodic_upgrade=1')"
case "$(text_of "$f")" in
  *"NOT INSTALLED"*) pass "the switch on with the package absent accuses the PACKAGE by name" ;;
  *) fail "the mitv shape did not name the missing package" ;;
esac

f="$(facts_for 'periodic_upgrade=0')"
if [ "$(verdict "$f")" = "1" ]; then
  pass "Unattended-Upgrade switch off is a finding"
else
  fail "the periodic upgrade switch being 0 passed"
fi

f="$(facts_for 'periodic_update=0')"
case "$(text_of "$f")" in
  *"stale index"*) pass "Update-Package-Lists off is reported as upgrading against a stale index" ;;
  *) fail "the package-list switch being 0 was not reported, or not distinguished" ;;
esac

printf '\nthe timer is judged on whether it RAN, never on being enabled\n'
# ═════════════════════════════════════════════════════════════════════════════
# All four hosts reported `is-enabled: enabled` on 2026-09-03 while the package was absent on every
# one of them. Enabled is a statement about configuration; fired is a statement about the world.
f="$(facts_for 'trigger_epoch=0')"
case "$(text_of "$f")" in
  *"never fired"*) pass "a timer that has never fired is a finding, and the message says why enabled is not enough" ;;
  *) fail "a timer that never fired was not reported" ;;
esac

f="$(facts_for "trigger_epoch=$LONG_AGO")"
if [ "$(verdict "$f")" = "1" ]; then
  pass "a timer that last fired 30 days ago is a finding"
else
  fail "a 30-day-old last trigger passed the staleness threshold"
fi

f="$(facts_for "trigger_epoch=$((NOW - 6 * 86400))")"
if [ "$(verdict "$f")" = "0" ]; then
  pass "six days is a weekend plus slack, not a fault (threshold is $STALE_TRIGGER_DAYS days)"
else
  fail "six days since the last trigger was reported as a fault - the threshold cries wolf"
fi

printf '\n"nothing pending" has several causes and the report separates them\n'
# ═════════════════════════════════════════════════════════════════════════════
f="$(facts_for 'pending_security=3')"
case "$(text_of "$f")" in
  *"something is refusing"*) pass "pending security updates on a working timer are read as a REFUSAL" ;;
  *) fail "3 pending security updates were not reported as a refusal" ;;
esac

f="$(facts_for 'last_outcome=error')"
if [ "$(verdict "$f")" = "1" ]; then
  pass "the last run ending in ERROR is a finding even with nothing pending"
else
  fail "a failed last run passed because the pending count was 0"
fi

# THE FIRST REAL RUN OF THIS REPORT WAS BLIND AND SAID NOTHING. `/var/log/unattended-upgrades` is
# `root:adm 0750`, the reporting account was outside `adm`, and the outcome came back `never` on a
# box whose timer had fired four hours earlier - so the ERROR arm above could not fire whatever the
# host did. "Cannot see" and "nothing happened" are different facts and must read differently.
f="$(facts_for 'last_outcome=unreadable')"
case "$(text_of "$f")" in
  *"ERROR arm of this report is blind"*) pass "an unreadable log is a finding about the REPORT, and names the group that fixes it" ;;
  *) fail "an unreadable log passed as health - the report's own blindness was silent" ;;
esac

# And `never` on a box that genuinely has not run yet is NOT the same accusation: the timer check
# owns that case, so a fresh install with a fired timer and no log line yet is not a log finding.
f="$(facts_for 'last_outcome=never' 'last_run_epoch=0')"
case "$(text_of "$f")" in
  *"blind"*) fail "'never' was reported as the report being blind - the two were conflated again" ;;
  *) pass "'never' is left to the timer check rather than accusing the log" ;;
esac

# A kernel security update installed for weeks and never in effect, with nothing saying
# so. Installed is not running.
f="$(facts_for 'reboot=yes' 'reboot_pkgs=linux-image-6.12.95+deb12-amd64')"
case "$(text_of "$f")" in
  *"linux-image-6.12.95+deb12-amd64"*) pass "a required reboot is a finding and NAMES the package holding it" ;;
  *) fail "a required reboot was not reported, or did not name the package" ;;
esac

printf '\nwider than security is a different risk, not a smaller one\n'
# ═════════════════════════════════════════════════════════════════════════════
# The defect of 2026-09-03: APT configuration lists ACCUMULATE across files, so declaring an
# Origins-Pattern APPENDS to `50unattended-upgrades` instead of replacing it. On the three trixie
# boxes the resolved list opened with `label=Debian` - the whole of stable - while the file said
# security. A package update could re-add it tomorrow and nothing else would notice.
f="$(facts_for "origins=origin=Debian,codename=\${distro_codename},label=Debian|$SECURITY_ORIGINS")"
case "$(text_of "$f")" in
  *"NON-SECURITY origin"*) pass "label=Debian in the resolved list is a finding, however it got there" ;;
  *) fail "the whole of stable being allowed passed as security-only" ;;
esac

f="$(facts_for 'origins=')"
case "$(text_of "$f")" in
  *"upgrade nothing at all"*) pass "an empty origin list is a finding, not a strict policy" ;;
  *) fail "a host that would upgrade nothing passed" ;;
esac

f="$(facts_for "origins=$SECURITY_ORIGINS|origin=Debian,codename=\${distro_codename}-security,label=Debian-Security")"
if [ "$(verdict "$f")" = "0" ]; then
  pass "a duplicated security entry is not a finding - mitv resolves four, all of them security"
else
  fail "duplicate security origins were reported as a policy change"
fi

printf '\nfindings accumulate rather than short-circuiting, so one run names everything wrong\n'
# ═════════════════════════════════════════════════════════════════════════════
f="$(facts_for 'installed=no' 'version=' 'trigger_epoch=0' 'reboot=yes' 'reboot_pkgs=linux-image' 'pending_security=9')"
out="$(text_of "$f")"
n=0
case "$out" in *"NOT INSTALLED"*) n=$((n + 1)) ;; esac
case "$out" in *"never fired"*) n=$((n + 1)) ;; esac
case "$out" in *"needs a REBOOT"*) n=$((n + 1)) ;; esac
case "$out" in *"something is refusing"*) n=$((n + 1)) ;; esac
if [ "$n" -eq 4 ]; then
  pass "a badly broken host reports all four findings in one run, not the first one"
else
  fail "only $n of 4 findings were reported - a run that stops at the first sends you back tomorrow"
fi

printf '\na box whose apt policy belongs to ITS ADMINISTRATORS is judged on our questions only\n'
# ═════════════════════════════════════════════════════════════════════════════
# The Portail-etu host (2026-10-10): the School's policy allows full stable and packagecloud, and
# its log is unreadable to the runner. Both were red for ever, on facts nobody here may change.
# shellcheck disable=SC2016  # APT's own placeholder, literal on purpose
WIDE='origin=Debian,codename=${distro_codename},label=Debian|site=packagecloud.io'
f="$(facts_for "origins=$WIDE" 'last_outcome=unreadable' 'last_run_epoch=0')"
if [ "$(POLICY_OWNER=canari verdict "$f")" = "1" ] && [ "$(POLICY_OWNER=host-admins verdict "$f")" = "0" ]; then
  pass "a wide origin list and an unreadable log accuse OUR box and are only reported on a host-admins one"
else
  fail "POLICY_OWNER did not separate the two policies"
fi

# What stays OUR question under host-admins: a security update that is pending, a timer that never ran.
f="$(facts_for "origins=$WIDE" 'last_outcome=unreadable' 'last_run_epoch=0' 'pending_security=3' 'trigger_epoch=0')"
if [ "$(POLICY_OWNER=host-admins verdict "$f")" = "1" ]; then
  pass "a host-admins box with a pending security update and a timer that never ran is still a finding"
else
  fail "POLICY_OWNER=host-admins silenced a finding that is not about the policy"
fi

printf '\nthe root disk: DISK_FAIL_PERCENT is the red line, and a disk nobody can read is not a pass\n'
# ═════════════════════════════════════════════════════════════════════════════
# 2026-10-24: the host's administrators found its root disk at 90 % (92 % when read) before any
# report here said so. The threshold is 85, and these cases pin both sides of it.
f="$(facts_for 'disk_pct=85')"
case "$(text_of "$f")" in
  *"is at 85 % (threshold 85 %)"*) pass "DISK_FAIL_PERCENT: 85 % is a finding that names the percentage and the threshold" ;;
  *) fail "DISK_FAIL_PERCENT: a root disk at 85 % was not reported" ;;
esac
f="$(facts_for 'disk_pct=84')"
if [ "$(verdict "$f")" = "0" ]; then
  pass "DISK_FAIL_PERCENT: 84 % passes"
else
  fail "DISK_FAIL_PERCENT: 84 % was reported - the threshold is off by one"
fi
f="$(facts_for 'disk_pct=92')"
if [ "$(DISK_FAIL_PERCENT=95 verdict "$f")" = "0" ] && [ "$(verdict "$f")" = "1" ]; then
  pass "DISK_FAIL_PERCENT moves the line: 92 % fails at the default 85 and passes at 95"
else
  fail "DISK_FAIL_PERCENT is not the value the judgement reads"
fi
f="$(facts_for 'disk_pct=')"
case "$(text_of "$f")" in
  *"cannot read the root filesystem"*) pass "an unreadable df is a finding about the report, not a pass" ;;
  *) fail "an unreadable root filesystem passed" ;;
esac
f="$(facts_for 'runner_stale_kb=5452595' 'runner_stale=canari/bin.2.337.0 canari/externals.2.337.0')"
out="$(text_of "$f")"
named=no
case "$out" in *"5.2 GB in canari/bin.2.337.0"*"note: the self-hosted runners left 5.2 GB"*) named=yes ;; esac
if [ "$(verdict "$f")" = "0" ] && [ "$named" = "yes" ]; then
  pass "runner leftovers are named with their size, as a note and not a finding"
else
  fail "runner leftovers were a finding, or were not named"
fi

printf '\n'
if [ "$FAIL" -ne 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
