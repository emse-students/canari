#!/bin/bash
# =================================================================================================
# WHETHER THIS BOX IS ACTUALLY TAKING ITS SECURITY UPDATES - and the evidence to tell the causes
# apart when it is not.
#
# WHY IT EXISTS. `unattended-upgrades` was installed on all four hosts on 2026-09-03 (security
# origins only, never reboots). That is a MECHANISM, and this repository's hardest-won rule is that
# a correct mechanism with no report is found by hand, a day late. Two things had already gone wrong
# in exactly that way and nothing noticed either:
#
#   * `mitv` carried `/etc/apt/apt.conf.d/20auto-upgrades` with `APT::Periodic::Unattended-Upgrade
#     "1"` and the PACKAGE NOT INSTALLED. A configuration that reads as "on" and does nothing.
#   * The same box has had `/var/run/reboot-required` set since 12 July, naming a KERNEL security
#     update, with 8 weeks of uptime. A security update you installed and are not running is a
#     security update you do not have.
#
# WHAT IT MUST DISTINGUISH, because "no updates pending" has several very different causes:
#
#   | reading                         | what it could mean                                         |
#   | ------------------------------- | ---------------------------------------------------------- |
#   | 0 pending, timer ran, log clean | working                                                    |
#   | 0 pending, timer NEVER ran      | nothing is applying anything; the count is stale, not good  |
#   | N pending, timer ran            | it runs and refuses - a held package, or a failed run       |
#   | 0 pending, reboot required      | applied, and not in effect                                  |
#   | 0 pending, origins widened      | applying MORE than security, which is a different risk      |
#
# So the timer's last trigger, the last log outcome and the resolved origin list are ALL read. A
# count on its own would report the second row as health.
#
# THE ABSENCE CASE IS THE ONE THAT MATTERS. `docs/wiki/durable-rules.md` already carries it for
# GitHub's cron: a schedule is a request, and its failure mode is not lateness, it is ABSENCE. So
# this asks whether the timer RAN, never whether it is enabled - `is-enabled` answered `enabled` on
# all four hosts on 2026-09-03 while the package was absent on every one of them.
#
# SCOPE, STATED PLAINLY: this reports the box it RUNS ON, which is production. The other three hosts
# are not reachable from here - the runner's `canari` key is authorised on none of them, measured
# 2026-09-03 - and installing cross-host keys in order to write a report is a privilege expansion
# nobody asked for. That gap is in `docs/wiki/backlog.md` with what would close it.
#
# Structure: `gather` reads the host and writes facts, `judge` reads facts and decides. They are
# separate so the judgement can be tested against fabricated hosts -
# `.github/scripts/tests/host-update-report.test.sh`. A report whose verdict has never been seen to
# FAIL is the same defect one level up.
# =================================================================================================
set -uo pipefail

# How long a gap between runs is a fault rather than a weekend. The timer asks for daily with a
# randomised delay; 8 days is a whole missed week plus slack - late enough to accuse, loose enough
# not to cry wolf over one skipped day.
STALE_TRIGGER_DAYS="${STALE_TRIGGER_DAYS:-8}"

# What the origin list is ALLOWED to contain. Anything else means something widened it - and a
# package update to `50unattended-upgrades` re-adding `label=Debian` would do exactly that in
# silence, because APT configuration LISTS ACCUMULATE across files rather than overriding. Not
# hypothetical: it is what the first draft of the installer got wrong on the three trixie boxes on
# 2026-09-03, where the resolved list opened with the whole of stable while the file said security.
ALLOWED_ORIGIN_SUBSTRING="${ALLOWED_ORIGIN_SUBSTRING:-Debian-Security}"

# -------------------------------------------------------------------------------------------------
# GATHER - reads the host, writes facts, judges nothing.
# -------------------------------------------------------------------------------------------------
gather() {
  local out="$1"
  export LC_ALL=C

  local installed="no" version=""
  if version="$(dpkg-query -W -f='${Version}' unattended-upgrades 2>/dev/null)" && [ -n "$version" ]; then
    installed="yes"
  fi

  # The two periodic switches, read through `apt-config` rather than by grepping a file: the value
  # that counts is the RESOLVED one, and any file in apt.conf.d can set it.
  local periodic_update periodic_upgrade
  periodic_update="$(apt-config shell x APT::Periodic::Update-Package-Lists 2>/dev/null | sed -n "s/^x='\(.*\)'\$/\1/p")"
  periodic_upgrade="$(apt-config shell x APT::Periodic::Unattended-Upgrade 2>/dev/null | sed -n "s/^x='\(.*\)'\$/\1/p")"

  # WHEN THE TIMER LAST FIRED, in epoch seconds. `LastTriggerUSec` is 0 or `n/a` when it has never
  # fired, which is precisely the state a pending count cannot see.
  local trigger_us trigger_epoch=0
  trigger_us="$(systemctl show apt-daily-upgrade.timer -p LastTriggerUSec --value 2>/dev/null)"
  if [ -n "$trigger_us" ] && [ "$trigger_us" != "0" ] && [ "$trigger_us" != "n/a" ]; then
    trigger_epoch="$(date -d "$trigger_us" +%s 2>/dev/null || echo 0)"
  fi

  # THE LAST OUTCOME, from the package's own log - the only place a REFUSAL is recorded. The wording
  # is stable across both versions in this estate (2.9.1 on bookworm, 2.12 on trixie).
  local log=/var/log/unattended-upgrades/unattended-upgrades.log
  local last_run_epoch=0 last_outcome="never" line=""
  if [ ! -r "$log" ]; then
    # UNREADABLE IS NOT "NOTHING HAPPENED", AND CONFLATING THE TWO IS HOW A CHECK GOES QUIET. The
    # directory is `root:adm 0750`, and this report was written by an account that was not in `adm`:
    # it reported `never` on a box whose timer had fired that morning, so the ERROR arm could not
    # have fired whatever the host did. The fix on the host is `adduser <runner> adm`, which grants
    # nothing an account already in `sudo` and `docker` did not have, and this stays a FINDING so
    # that losing the group again says so instead of going silent.
    last_outcome="unreadable"
  else
    line="$(grep -E 'All upgrades installed|No packages found|Packages that will be upgraded|ERROR' "$log" 2>/dev/null | tail -1)"
    if [ -n "$line" ]; then
      last_run_epoch="$(date -d "$(printf '%s' "$line" | cut -c1-19)" +%s 2>/dev/null || echo 0)"
      case "$line" in
        *ERROR*) last_outcome="error" ;;
        *"All upgrades installed"*) last_outcome="installed" ;;
        *"No packages found"*) last_outcome="nothing-to-do" ;;
        *) last_outcome="partial" ;;
      esac
    fi
  fi

  # PENDING SECURITY UPDATES SPECIFICALLY, not pending updates. A Docker CE bump sitting there is a
  # decision somebody took; a security bump sitting there is this mechanism failing.
  local pending_security=0
  if command -v apt-get >/dev/null 2>&1; then
    pending_security="$(apt-get -s upgrade 2>/dev/null | grep '^Inst' | grep -c 'Debian-Security')"
  fi

  local reboot="no" reboot_pkgs=""
  if [ -f /var/run/reboot-required ]; then
    reboot="yes"
    # `.pkgs`, WITH A DOT. Reading `-pkgs` with a hyphen made the first draft of the installer
    # report "no" on the one host that needed a reboot - wrong in the reassuring direction.
    reboot_pkgs="$(paste -sd',' /var/run/reboot-required.pkgs 2>/dev/null)"
  fi

  local origins
  origins="$(apt-config dump Unattended-Upgrade::Origins-Pattern 2>/dev/null |
    sed -n 's/^Unattended-Upgrade::Origins-Pattern:: "\(.*\)";$/\1/p' | paste -sd'|')"

  # EVERY VALUE IS %q-QUOTED, AND THAT IS NOT TIDINESS. `judge` reads this file with `.`, so the
  # SHELL parses it: an unquoted `origins=a|b` is a PIPELINE and not an assignment, the variable
  # comes out unset, and nothing errors. The report then invented a finding - "allowed origins:
  # NONE" - about a host whose policy was perfectly correct. The patterns also contain
  # `${distro_codename}`, which an unquoted assignment expands to nothing.
  {
    printf 'host=%q\n' "$(hostname)"
    printf 'installed=%q\n' "$installed"
    printf 'version=%q\n' "$version"
    printf 'periodic_update=%q\n' "$periodic_update"
    printf 'periodic_upgrade=%q\n' "$periodic_upgrade"
    printf 'trigger_epoch=%q\n' "$trigger_epoch"
    printf 'last_run_epoch=%q\n' "$last_run_epoch"
    printf 'last_outcome=%q\n' "$last_outcome"
    printf 'pending_security=%q\n' "$pending_security"
    printf 'reboot=%q\n' "$reboot"
    printf 'reboot_pkgs=%q\n' "$reboot_pkgs"
    printf 'origins=%q\n' "$origins"
    printf 'now_epoch=%q\n' "$(date +%s)"
  } >"$out"
}

# -------------------------------------------------------------------------------------------------
# JUDGE - reads facts, prints the report, decides. Touches no host, so it is testable.
# -------------------------------------------------------------------------------------------------
# Every variable this function reads - `host`, `installed`, `origins`, `now_epoch` and the rest -
# arrives from the facts file sourced on its first line, which is the whole point of the split: the
# judgement can then be run against a fabricated host. shellcheck cannot see through a `.` of a
# runtime path, so SC2154 is disabled for the function rather than silenced per line.
# shellcheck disable=SC2154
judge() {
  local facts="$1"
  local findings=0

  # shellcheck disable=SC1090  # written by `gather` above; not a user-supplied path
  . "$facts"

  printf '=== OS updates on %s\n' "${host:-unknown}"
  if [ "${installed}" = "yes" ]; then
    printf '    unattended-upgrades : yes (%s)\n' "${version}"
  else
    printf '    unattended-upgrades : %s\n' "${installed}"
  fi
  printf '    periodic switches   : update=%s upgrade=%s\n' \
    "${periodic_update:-unset}" "${periodic_upgrade:-unset}"
  if [ "${trigger_epoch}" -gt 0 ]; then
    printf '    last timer trigger  : %s\n' "$(date -u -d "@${trigger_epoch}" '+%Y-%m-%d %H:%M UTC')"
  else
    printf '    last timer trigger  : NEVER\n'
  fi
  if [ "${last_run_epoch}" -gt 0 ]; then
    printf '    last log outcome    : %s at %s\n' \
      "${last_outcome}" "$(date -u -d "@${last_run_epoch}" '+%Y-%m-%d %H:%M UTC')"
  else
    printf '    last log outcome    : %s\n' "${last_outcome}"
  fi
  printf '    pending SECURITY    : %s\n' "${pending_security}"
  if [ "${reboot}" = "yes" ]; then
    printf '    reboot required     : yes (%s)\n' "${reboot_pkgs}"
  else
    printf '    reboot required     : no\n'
  fi
  printf '    allowed origins     : %s\n\n' "${origins:-NONE}"

  if [ "${installed}" != "yes" ]; then
    printf '::error::unattended-upgrades is NOT INSTALLED on %s - nothing is applying security updates\n' "${host}"
    findings=$((findings + 1))
  fi

  # THE SWITCHES AND THE PACKAGE ARE TWO FACTS, AND `mitv` HAD THEM DISAGREE. Reported separately so
  # the message names which half is missing instead of saying "updates are off".
  if [ -z "${periodic_upgrade:-}" ] || [ "${periodic_upgrade}" = "0" ]; then
    printf '::error::APT::Periodic::Unattended-Upgrade is off on %s, so the timer runs and applies nothing\n' "${host}"
    findings=$((findings + 1))
  fi
  if [ -z "${periodic_update:-}" ] || [ "${periodic_update}" = "0" ]; then
    printf '::error::APT::Periodic::Update-Package-Lists is off on %s, so it upgrades against a stale index\n' "${host}"
    findings=$((findings + 1))
  fi

  # ABSENCE, NOT LATENESS.
  local stale_secs=$((STALE_TRIGGER_DAYS * 86400))
  if [ "${trigger_epoch}" -eq 0 ]; then
    printf '::error::apt-daily-upgrade.timer has never fired on %s - being enabled is not the same as running\n' "${host}"
    findings=$((findings + 1))
  elif [ $((now_epoch - trigger_epoch)) -gt "$stale_secs" ]; then
    printf '::error::apt-daily-upgrade.timer last fired %s days ago on %s (threshold %s)\n' \
      "$(((now_epoch - trigger_epoch) / 86400))" "${host}" "${STALE_TRIGGER_DAYS}"
    findings=$((findings + 1))
  fi

  if [ "${last_outcome}" = "error" ]; then
    printf '::error::the last unattended-upgrades run on %s ended in ERROR - read /var/log/unattended-upgrades/\n' "${host}"
    findings=$((findings + 1))
  fi

  # A CHECK THAT CANNOT SEE MUST SAY SO, or its silence reads as a pass. `/var/log/unattended-
  # upgrades` is `root:adm 0750`; the first real run of this report was made by an account outside
  # `adm` and reported `never` on a box whose timer had fired four hours earlier - so the ERROR arm
  # above was unreachable, whatever the host was doing.
  if [ "${last_outcome}" = "unreadable" ]; then
    # shellcheck disable=SC2016  # the backticks are prose, naming three unix groups, not a subshell
    printf '::error::%s cannot read /var/log/unattended-upgrades - the ERROR arm of this report is blind, so a failed run would pass. Fix: add the reporting account to the `adm` group (it grants nothing an account in `sudo` and `docker` did not already have)\n' "${host}"
    findings=$((findings + 1))
  fi

  # A PENDING SECURITY UPDATE ON A HOST WHOSE TIMER IS RUNNING IS A REFUSAL, and the two readings
  # above are what separate that from "it has not had its turn yet".
  if [ "${pending_security}" -gt 0 ]; then
    printf '::error::%s security update(s) pending on %s and the mechanism exists to apply them - something is refusing\n' \
      "${pending_security}" "${host}"
    findings=$((findings + 1))
  fi

  # A KERNEL SECURITY UPDATE INSTALLED AND NOT RUNNING IS NOT A SECURITY UPDATE. Deliberately a
  # finding and never an action: nothing here reboots a box that serves anything, and `mitv` has
  # wanted one since 12 July with nothing saying so.
  if [ "${reboot}" = "yes" ]; then
    printf '::error::%s needs a REBOOT for %s - updates are installed and not in effect, and only a human reboots this box\n' \
      "${host}" "${reboot_pkgs:-an unnamed package}"
    findings=$((findings + 1))
  fi

  # WIDER THAN SECURITY IS A DIFFERENT RISK, NOT A SMALLER ONE. PG 15 is held at 15 on purpose.
  if [ -z "${origins:-}" ]; then
    printf '::error::no Unattended-Upgrade::Origins-Pattern resolves on %s - it would upgrade nothing at all\n' "${host}"
    findings=$((findings + 1))
  else
    local entry
    while IFS= read -r entry; do
      [ -n "$entry" ] || continue
      case "$entry" in
        *"${ALLOWED_ORIGIN_SUBSTRING}"*) : ;;
        *)
          printf '::error::%s allows a NON-SECURITY origin: %s - APT config lists accumulate, so something widened the policy\n' \
            "${host}" "$entry"
          findings=$((findings + 1))
          ;;
      esac
    done <<EOF
$(printf '%s' "${origins}" | tr '|' '\n')
EOF
  fi

  if [ "$findings" -eq 0 ]; then
    printf 'OK: %s is applying its security updates, and they are in effect.\n' "${host}"
    return 0
  fi
  printf '\n%s finding(s) on %s.\n' "$findings" "${host}"
  return 1
}

main() {
  local facts
  facts="$(mktemp)"
  # shellcheck disable=SC2064  # expand `$facts` now, deliberately
  trap "rm -f '$facts'" EXIT
  gather "$facts"
  judge "$facts"
}

# Sourced by the self-test, run directly by the workflow.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
