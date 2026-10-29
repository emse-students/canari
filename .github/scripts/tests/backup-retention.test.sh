#!/usr/bin/env bash
# =================================================================================================
# EACH PURGE OF backup.sh READS ITS OWN RETENTION.
#
# WHY. Until 2026-10-24 one variable, BACKUP_RETENTION_DAYS, drove both the local `find -mtime` and
# the offsite one. The shared host's disk reached 92 % that day and the local copy was cut to 7
# days, while the offsite copy keeps the 14 days the privacy policy states. Two numbers in one
# script are one typo away from purging the offsite copy at 7 days, which nothing else would notice
# until a restore needed day 10 - so this runs the real script, against stubs, and reads what each
# purge did.
#
# HOW. A sandbox checkout holds backup.sh and backup-config.sh beside a fabricated
# infrastructure/.env; `docker`, `ssh` and `rsync` are stubs on PATH. The local purge is the real
# `find` over archives aged with `touch -d`; the offsite purge is the command line the ssh stub
# received.
# =================================================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../../../infrastructure/backup"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

[ -r "$SRC/backup.sh" ] || { printf 'cannot read %s/backup.sh\n' "$SRC"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/repo/infrastructure/backup" "$TMP/bin"
cp "$SRC/backup.sh" "$SRC/backup-config.sh" "$TMP/repo/infrastructure/backup/"

# `docker compose version` answers, `exec` prints a dump, `run` writes the media_meta member into
# the stage it was handed as `<stage>:/out`.
cat >"$TMP/bin/docker" <<'EOF'
#!/bin/sh
case " $* " in
  *" exec "*) printf 'dump\n' ;;
  " run "*)
    for a in "$@"; do
      case "$a" in *:/out) printf 'x' >"${a%:/out}/media_meta.tar.gz" ;; esac
    done
    ;;
esac
exit 0
EOF
cat >"$TMP/bin/ssh" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$SSH_LOG"
exit 0
EOF
printf '#!/bin/sh\nexit 0\n' >"$TMP/bin/rsync"
chmod +x "$TMP/bin/docker" "$TMP/bin/ssh" "$TMP/bin/rsync"

# `run LOCAL OFFSITE` - one backup with those values in the environment (empty = the default), over
# archives aged 6, 8, 13 and 20 days. Leaves the survivors in $TMP/backups, the ssh calls in
# $TMP/ssh.log.
run() {
  rm -rf "$TMP/backups" "$TMP/ssh.log"
  mkdir -p "$TMP/backups"
  printf 'POSTGRES_USER=test\nMICONNECT_PG_CONTAINER=\nBACKUP_SSH_HOST=offsite-stub\nBACKUP_SSH_PATH=/offsite\nBACKUP_DIR=%s\n' \
    "$TMP/backups" >"$TMP/repo/infrastructure/.env"
  local age
  for age in 6 8 13 20; do
    touch -d "$age days ago" "$TMP/backups/canari-backup-old-${age}d.tar.gz"
  done
  (
    [ -n "$1" ] && export LOCAL_RETENTION_DAYS="$1"
    [ -n "$2" ] && export BACKUP_RETENTION_DAYS="$2"
    export BACKUP_SSH_HOST=offsite-stub SSH_LOG="$TMP/ssh.log" PATH="$TMP/bin:$PATH" TMPDIR="$TMP"
    bash "$TMP/repo/infrastructure/backup/backup.sh" >"$TMP/run.log" 2>&1
  ) || { cat "$TMP/run.log"; return 1; }
}

kept() { [ -f "$TMP/backups/canari-backup-old-${1}d.tar.gz" ]; }
survivors() { find "$TMP/backups" -maxdepth 1 -type f -printf '%f '; }
offsite_mtime() { grep -o -- '-mtime +[0-9]*' "$TMP/ssh.log" | head -1; }

printf '\nthe defaults: 7 days on the host, 14 offsite\n'
# ═════════════════════════════════════════════════════════════════════════════
if run "" ""; then
  pass "backup.sh completes against the stubs"
else
  fail "backup.sh failed against the stubs - every case below would be meaningless"
fi
if kept 6 && ! kept 8 && ! kept 13 && ! kept 20; then
  pass "the local purge keeps 6 days and deletes 8, 13 and 20 (LOCAL_RETENTION_DAYS=7)"
else
  fail "the local purge left: $(survivors)"
fi
if [ "$(offsite_mtime)" = "-mtime +14" ]; then
  pass "the offsite purge asks for -mtime +14 (BACKUP_RETENTION_DAYS)"
else
  fail "the offsite purge asked for '$(offsite_mtime)' - the 14-day copy would not be the one kept"
fi
if [ -n "$(find "$TMP/backups" -maxdepth 1 -name 'canari-backup-2*.tar.gz')" ]; then
  pass "the new archive is written and survives its own purge"
else
  fail "no new archive in the local directory"
fi

printf '\neach variable moves its own purge, and only its own\n'
# ═════════════════════════════════════════════════════════════════════════════
run 3 30
if ! kept 6 && [ "$(offsite_mtime)" = "-mtime +30" ]; then
  pass "LOCAL_RETENTION_DAYS=3 purges 6 days locally while the offsite purge reads BACKUP_RETENTION_DAYS=30"
else
  fail "local=3 offsite=30 gave local survivors '$(survivors)' and offsite '$(offsite_mtime)'"
fi
run 30 5
if kept 20 && [ "$(offsite_mtime)" = "-mtime +5" ]; then
  pass "BACKUP_RETENTION_DAYS=5 does not reach the local copy, and LOCAL_RETENTION_DAYS=30 does not reach the offsite one"
else
  fail "local=30 offsite=5 gave local survivors '$(survivors)' and offsite '$(offsite_mtime)'"
fi

printf '\na bad value is refused before anything is deleted\n'
# ═════════════════════════════════════════════════════════════════════════════
for bad in -1 abc 0; do
  if run "$bad" "" >/dev/null 2>&1; then
    fail "LOCAL_RETENTION_DAYS=$bad was accepted"
  elif kept 6 && kept 20; then
    pass "LOCAL_RETENTION_DAYS=$bad is refused and every archive survives"
  else
    fail "LOCAL_RETENTION_DAYS=$bad deleted archives: '$(survivors)'"
  fi
done

printf '\n'
if [ "$FAIL" -ne 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
