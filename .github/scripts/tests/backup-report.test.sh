#!/usr/bin/env bash
# =================================================================================================
# THE BACKUP REPORT'S VERDICT, AGAINST FABRICATED HOSTS.
#
# WHY. `backup-report.sh` exists because five nights of failed backups (2026-09-26 to 2026-09-30)
# reached nobody. A report whose verdict has never been seen to FAIL would go green on exactly those
# nights. Every case below is a shape production really had, or the one a restore is afraid of:
#
#   * 09-26 to 09-30: no archive at all, backup.sh dying on an SSH alias before its tar.
#   * 09-24 and 09-25: media snapshots of EMPTY volumes, the wrong compose project's.
#   * every snapshot ever: no Garage `node_key`, root-only and skipped.
#   * 09-26 to 09-30: snapshots taken and never mirrored, the run dying before its offsite step.
# =================================================================================================
set -uo pipefail

# shellcheck source-path=SCRIPTDIR
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT="$HERE/../../../infrastructure/backup/backup-report.sh"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

[ -r "$REPORT" ] || { printf 'cannot read %s\n' "$REPORT"; exit 1; }
# Outside `.github/`, so shellcheck cannot follow the `.`; the `[ -r ]` above is the runtime check.
# shellcheck disable=SC1090,SC1091
. "$REPORT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

NOW="$(date +%s)"
DUE=$((NOW - 3600))
AFTER=$((DUE + 5))
DAYS_AGO=$((DUE - 5 * 86400))

# Writes a facts file for a healthy host, then applies the overrides given as `key=value` words.
facts_for() {
  local out="$TMP/facts"
  {
    printf 'host=%q\n' testbox
    printf 'now_epoch=%q\n' "$NOW"
    printf 'backup_dir=%q\n' /srv/canari-backups
    printf 'backup_cron=%q\n' '30 3'
    printf 'backup_daily=%q\n' yes
    printf 'backup_expected=%q\n' "$DUE"
    printf 'objects_cron=%q\n' '0 4'
    printf 'objects_daily=%q\n' yes
    printf 'objects_expected=%q\n' "$DUE"
    printf 'archive=%q\n' canari-backup-20260930-033002.tar.gz
    printf 'archive_epoch=%q\n' "$AFTER"
    printf 'archive_size=%q\n' 60389963
    printf 'members=%q\n' 'MANIFEST.txt authentik_db.sql.gz media_meta.tar.gz postgres_auth_db.sql.gz'
    printf 'incomplete=%q\n' ''
    printf 'media_meta_ok=%q\n' yes
    printf 'authentik_expected=%q\n' yes
    printf 'offsite_archive_size=%q\n' 60389963
    printf 'password_readable=%q\n' yes
    printf 'snapshot_id=%q\n' df505d4a1234
    printf 'snapshot_epoch=%q\n' "$AFTER"
    printf 'node_key=%q\n' 1
    printf 'garage_files=%q\n' 1001
    printf 'offsite_snapshot=%q\n' present
  } >"$out"
  local kv
  for kv in "$@"; do
    local key="${kv%%=*}" val="${kv#*=}"
    grep -v "^${key}=" "$out" >"$out.new" && mv "$out.new" "$out"
    printf '%s=%q\n' "$key" "$val" >>"$out"
  done
  printf '%s' "$out"
}

verdict() { ( judge "$1" >/dev/null 2>&1 ); printf '%s' "$?"; }
text_of() { ( judge "$1" 2>&1 ) || true; }

# `expect NAME PATTERN OVERRIDES...` - the case must FAIL and its report must contain PATTERN.
expect() {
  local name="$1" pattern="$2" f
  shift 2
  f="$(facts_for "$@")"
  if [ "$(verdict "$f")" != "1" ]; then
    fail "$name - it PASSED"
    return
  fi
  case "$(text_of "$f")" in
    *"$pattern"*) pass "$name" ;;
    *) fail "$name - failed, but without naming '$pattern'" ;;
  esac
}

printf '\na healthy host passes, or nothing below means anything\n'
# ═════════════════════════════════════════════════════════════════════════════
if [ "$(verdict "$(facts_for)")" = "0" ]; then
  pass "an archive and a snapshot after their runs, whole, both offsite"
else
  fail "a healthy host was reported as a finding - every case below would be meaningless"
fi
if [ "$(verdict "$(facts_for 'authentik_expected=no' 'members=MANIFEST.txt media_meta.tar.gz postgres_auth_db.sql.gz')")" = "0" ]; then
  pass "an archive without Authentik passes when MICONNECT_PG_CONTAINER is set EMPTY, the one way to exclude it"
else
  fail "a deliberately excluded Authentik was reported missing"
fi
if [ "$(verdict "$(facts_for 'offsite_archive_size=disabled' 'offsite_snapshot=disabled')")" = "0" ]; then
  pass "an empty BACKUP_SSH_HOST is a decision, not a finding"
else
  fail "a disabled offsite was reported as a failure"
fi

printf '\nthe nights of 2026-09-26 to 2026-09-30, shape by shape\n'
# ═════════════════════════════════════════════════════════════════════════════
expect "no archive since the scheduled run (09-26: backup.sh died before its tar)" \
  "no archive since the run due" "archive=canari-backup-20260925-033002.tar.gz" "archive_epoch=$DAYS_AGO"
expect "a snapshot of empty volumes (09-24, 09-25: the wrong compose project)" \
  "backed up empty volumes" "garage_files=0"
expect "a snapshot without node_key (every snapshot until 2026-09-30)" \
  "different node" "node_key=0"
expect "a snapshot never mirrored (09-26: the run died before its offsite step)" \
  "not in the offsite mirror" "offsite_snapshot=absent"
expect "no media snapshot since the scheduled run" \
  "no media snapshot since the run due" "snapshot_epoch=$DAYS_AGO"

printf '\nthe absences no exit code reports\n'
# ═════════════════════════════════════════════════════════════════════════════
expect "no crontab line for backup.sh" "nothing schedules infrastructure/backup/backup.sh" "backup_cron="
expect "no crontab line for backup-objects.sh" "the media blobs have no backup" "objects_cron="
expect "a schedule that is not daily is not judged as one" "not daily" "backup_daily=no"
expect "no archive at all" "no canari-backup-*.tar.gz at all" "archive="
expect "an unreadable restic password is the report being blind, not a pass" \
  "cannot see the media backup" "password_readable=no"

printf '\nan archive a restore would find partial\n'
# ═════════════════════════════════════════════════════════════════════════════
expect "no Authentik dump while one is expected" "has no authentik_db.sql.gz" \
  "members=MANIFEST.txt media_meta.tar.gz postgres_auth_db.sql.gz"
expect "no Canari database dump" "has no postgres_auth_db.sql.gz" \
  "members=MANIFEST.txt authentik_db.sql.gz media_meta.tar.gz"
expect "a dump without pg_dump's closing line" "the dump was cut" "incomplete=authentik_db.sql.gz"
expect "a media_meta that does not decompress" "does not decompress" "media_meta_ok=no"
expect "an offsite copy of a different size" "one disk holds the only whole copy" "offsite_archive_size=1234"
expect "an offsite copy absent" "one disk holds the only whole copy" "offsite_archive_size=absent"
expect "an offsite host unreachable" "cannot be reached" "offsite_archive_size=unreachable"

printf '\nfindings accumulate, so one run names everything wrong\n'
# ═════════════════════════════════════════════════════════════════════════════
out="$(text_of "$(facts_for "archive_epoch=$DAYS_AGO" 'node_key=0' 'offsite_snapshot=absent')")"
n=0
case "$out" in *"no archive since"*) n=$((n + 1)) ;; esac
case "$out" in *"different node"*) n=$((n + 1)) ;; esac
case "$out" in *"offsite mirror"*) n=$((n + 1)) ;; esac
if [ "$n" -eq 3 ]; then
  pass "the 09-26 night reports all three of its faults in one run"
else
  fail "only $n of 3 findings were reported"
fi

printf '\nwhen "last night" is comes from the crontab\n'
# ═════════════════════════════════════════════════════════════════════════════
TAB='BACKUP_DIR=/srv/canari-backups
# 30 2 * * * cd /old && ./infrastructure/backup/backup.sh
30 3 * * * cd /srv/canari && ./infrastructure/backup/backup.sh >> /srv/canari-backups/backup.log 2>&1
0 4 * * * cd /srv/canari && ./infrastructure/backup/backup-objects.sh >> x 2>&1
15 4 * * * BACKUP_DIR=/srv/le-cercle-backups /srv/le-cercle-backups/backup.sh >> y 2>&1'
if [ "$(cron_of "$TAB" infrastructure/backup/backup.sh)" = "30 3 yes /srv/canari" ]; then
  pass "the active backup.sh line is read, the commented one and the Cercle's backup.sh are not"
else
  fail "cron_of read '$(cron_of "$TAB" infrastructure/backup/backup.sh)'"
fi
if [ "$(cron_of "$TAB" infrastructure/backup/backup-objects.sh)" = "0 4 yes /srv/canari" ]; then
  pass "backup-objects.sh is read as its own line"
else
  fail "cron_of read '$(cron_of "$TAB" infrastructure/backup/backup-objects.sh)' for backup-objects.sh"
fi
if [ "$(cron_of '30 3 * * 1 cd /srv/canari && ./infrastructure/backup/backup.sh' infrastructure/backup/backup.sh)" = "30 3 no /srv/canari" ]; then
  pass "a weekly line is read as not daily"
else
  fail "a weekly line was read as daily"
fi
noon="$(date -d 'today 12:00' +%s)"
if [ "$(last_fire 30 3 "$noon")" = "$(date -d 'today 03:30' +%s)" ] &&
  [ "$(last_fire 30 13 "$noon")" = "$(date -d 'yesterday 13:30' +%s)" ]; then
  pass "the last run due is today's when its hour has passed, yesterday's when it has not"
else
  fail "last_fire picked the wrong day"
fi

printf '\n'
if [ "$FAIL" -ne 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
