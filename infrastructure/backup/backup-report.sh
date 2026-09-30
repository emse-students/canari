#!/bin/bash
# shellcheck source-path=SCRIPTDIR
# =================================================================================================
# WHETHER LAST NIGHT'S BACKUPS EXIST, ARE WHOLE, AND ARE OFFSITE - read from the artefacts, never
# from the scripts' exit codes.
#
# WHY IT EXISTS. Five nights in a row (2026-09-26 to 2026-09-30) `backup.sh` wrote NO archive, the
# Canari database included, and the same five nights `backup-objects.sh` stopped before its offsite
# mirror; its snapshots of 09-24 and 09-25 were EMPTY, and no snapshot had ever held Garage's
# `node_key`. Nothing reported any of it - a session found it by hand
# (docs/wiki/infrastructure/backup.md). Both scripts were loud; a loud script that nobody reads is
# a correct mechanism with no report.
#
# WHY THE ARTEFACTS AND NOT AN EXIT CODE. A cron line that vanished, a crontab that never fires and
# a script that dies before its last step all produce the same thing - no archive - and only the
# first two produce no exit code at all. So this asks the questions a restore would ask:
#
#   | reading                                          | what it means                            |
#   | ------------------------------------------------ | ---------------------------------------- |
#   | no crontab line for the script                   | nothing schedules it                     |
#   | newest archive older than the last scheduled run | the run failed, or never happened        |
#   | a member missing, or a dump without its trailer  | an archive a restore would find partial  |
#   | offsite copy absent or a different size          | one disk holds the only copy             |
#   | newest snapshot older than the last run          | the media run failed, or never happened  |
#   | a snapshot with no garage_data file              | it backed up the wrong volumes (09-24)   |
#   | a snapshot without node_key                      | Garage would restore as another node     |
#   | the snapshot absent from the offsite mirror      | the run died before its step 5 (09-26)   |
#
# WHEN "LAST NIGHT" IS, is read from the crontab that schedules the scripts, never written here: a
# schedule moved there cannot leave this report judging the old hour.
#
# SCOPE: the box it runs on, production, as the account that owns the backups (`gha-runner` runs
# both the jobs and the crontab there). Structure: `gather` reads the host and writes facts, `judge`
# reads facts and decides - `.github/scripts/tests/backup-report.test.sh` runs the judgement against
# fabricated hosts, because a report never seen to FAIL is the same defect one level up.
# =================================================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# -------------------------------------------------------------------------------------------------
# GATHER - reads the host, writes facts, judges nothing.
# -------------------------------------------------------------------------------------------------

# `cron_of TAB SCRIPT` prints "MIN HOUR DAILY CHECKOUT" for the first active line running SCRIPT.
cron_of() {
  printf '%s\n' "$1" | awk -v s="$2" '
    /^[[:space:]]*#/ { next }
    index($0, s) {
      daily = ($3 == "*" && $4 == "*" && $5 == "*" && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/) ? "yes" : "no"
      dir = ""
      if (match($0, /cd [^ ]+ &&/)) dir = substr($0, RSTART + 3, RLENGTH - 6)
      print $1, $2, daily, dir
      exit
    }'
}

# `last_fire MIN HOUR NOW` prints the epoch of the most recent MIN:HOUR, local time, at or before NOW.
last_fire() {
  local hm t
  hm="$(printf '%02d:%02d' "$2" "$1")"
  t="$(date -d "today $hm" +%s)"
  [ "$t" -le "$3" ] || t="$(date -d "yesterday $hm" +%s)"
  printf '%s' "$t"
}

# `remote CMD` runs CMD on the offsite host; prints `unreachable` when ssh itself fails.
remote() {
  local out rc
  out="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$BACKUP_SSH_HOST" "$1" 2>/dev/null)"
  rc=$?
  if [ "$rc" -eq 255 ]; then printf 'unreachable'; else printf '%s' "$out"; fi
}

gather() {
  local out="$1"
  export LC_ALL=C
  local now tab
  now="$(date +%s)"
  tab="$(crontab -l 2>/dev/null)"

  # THE VARIABLES THE CRONTAB SETS, applied as cron applies them, then the shared defaults, then the
  # checkout's .env - the order backup.sh itself reads them in, so this checks where it WRITES.
  local line
  while IFS= read -r line; do
    [ -n "$line" ] && export "${line?}"
  done <<<"$(printf '%s\n' "$tab" | grep -E '^[A-Z_][A-Z0-9_]*=')"
  # shellcheck source=backup-config.sh
  . "$SCRIPT_DIR/backup-config.sh"

  local b_min="" b_hour="" b_daily="" b_dir="" o_min="" o_hour="" o_daily=""
  read -r b_min b_hour b_daily b_dir <<<"$(cron_of "$tab" infrastructure/backup/backup.sh)"
  read -r o_min o_hour o_daily _ <<<"$(cron_of "$tab" infrastructure/backup/backup-objects.sh)"
  if [ -n "$b_dir" ] && [ -r "$b_dir/infrastructure/.env" ]; then
    set -a
    # shellcheck disable=SC1090,SC1091  # the production checkout's .env: secrets, never in the tree
    . "$b_dir/infrastructure/.env"
    set +a
  fi

  local backup_expected=0 objects_expected=0
  [ "$b_daily" = "yes" ] && backup_expected="$(last_fire "$b_min" "$b_hour" "$now")"
  [ "$o_daily" = "yes" ] && objects_expected="$(last_fire "$o_min" "$o_hour" "$now")"

  # THE NEWEST ARCHIVE, and its time from its NAME: the name is when the run started, the mtime is
  # whatever last touched the file.
  local archive="" archive_epoch=0 archive_size=0 members="" incomplete="" media_meta_ok="no"
  archive="$(find "$BACKUP_DIR" -maxdepth 1 -name 'canari-backup-*.tar.gz' -type f -printf '%f\n' 2>/dev/null | sort | tail -1)"
  if [ -n "$archive" ]; then
    local stamp="${archive#canari-backup-}"
    stamp="${stamp%.tar.gz}"
    archive_epoch="$(date -d "${stamp:0:8} ${stamp:9:2}:${stamp:11:2}:${stamp:13:2}" +%s 2>/dev/null || echo 0)"
    archive_size="$(stat -c %s "$BACKUP_DIR/$archive")"
    members="$(tar -tzf "$BACKUP_DIR/$archive" 2>/dev/null | sed 's|^\./||' | grep -v '^$' | sort | paste -sd' ')"
    local m
    for m in $members; do
      case "$m" in
        *.sql.gz)
          # pg_dump's LAST line: a dump cut anywhere before it lacks it, whatever its size.
          tar -xOzf "$BACKUP_DIR/$archive" "./$m" 2>/dev/null | gzip -dc 2>/dev/null | tail -c 512 |
            grep -q 'PostgreSQL database dump complete' || incomplete="$incomplete $m"
          ;;
      esac
    done
    tar -xOzf "$BACKUP_DIR/$archive" ./media_meta.tar.gz 2>/dev/null | gzip -t 2>/dev/null && media_meta_ok="yes"
  fi

  local offsite_archive_size="disabled" offsite_snapshot="disabled"
  if [ -n "$BACKUP_SSH_HOST" ] && [ -n "$archive" ]; then
    offsite_archive_size="$(remote "stat -c %s '$BACKUP_SSH_PATH/$archive' 2>/dev/null || echo absent")"
  fi

  # THE NEWEST MEDIA SNAPSHOT, read-only: no lock, so a report can never block a backup.
  local snapshot_id="" snapshot_epoch=0 node_key=0 garage_files=0
  if [ -r "$RESTIC_PASSWORD_FILE" ]; then
    local r=(docker run --rm --user "$(id -u):$(id -g)"
      -v "$RESTIC_REPO_DIR":/repo:ro -v "$RESTIC_PASSWORD_FILE":/pw:ro
      -e RESTIC_PASSWORD_FILE=/pw -e RESTIC_REPOSITORY=/repo
      "$RESTIC_IMAGE" --no-cache --no-lock)
    local json listing
    json="$("${r[@]}" snapshots --tag objects --latest 1 --json 2>/dev/null)"
    snapshot_id="$(printf '%s' "$json" | jq -r 'max_by(.time) | .id // empty' 2>/dev/null)"
    if [ -n "$snapshot_id" ]; then
      snapshot_epoch="$(date -d "$(printf '%s' "$json" | jq -r 'max_by(.time) | .time')" +%s 2>/dev/null || echo 0)"
      listing="$("${r[@]}" ls "$snapshot_id" 2>/dev/null)"
      node_key="$(printf '%s\n' "$listing" | grep -c '^/data/garage_meta/node_key$')"
      garage_files="$(printf '%s\n' "$listing" | grep -c '^/data/garage_data/.')"
      if [ -n "$BACKUP_SSH_HOST" ]; then
        offsite_snapshot="$(remote "test -f '$BACKUP_SSH_PATH/restic-objects/snapshots/$snapshot_id' && echo present || echo absent")"
      fi
    fi
  fi

  {
    printf 'host=%q\n' "$(hostname)"
    printf 'now_epoch=%q\n' "$now"
    printf 'backup_dir=%q\n' "$BACKUP_DIR"
    printf 'backup_cron=%q\n' "${b_min:+$b_min $b_hour}"
    printf 'backup_daily=%q\n' "$b_daily"
    printf 'backup_expected=%q\n' "$backup_expected"
    printf 'objects_cron=%q\n' "${o_min:+$o_min $o_hour}"
    printf 'objects_daily=%q\n' "$o_daily"
    printf 'objects_expected=%q\n' "$objects_expected"
    printf 'archive=%q\n' "$archive"
    printf 'archive_epoch=%q\n' "$archive_epoch"
    printf 'archive_size=%q\n' "$archive_size"
    printf 'members=%q\n' "$members"
    printf 'incomplete=%q\n' "${incomplete# }"
    printf 'media_meta_ok=%q\n' "$media_meta_ok"
    printf 'authentik_expected=%q\n' "$([ -n "$MICONNECT_PG_CONTAINER" ] && echo yes || echo no)"
    printf 'offsite_archive_size=%q\n' "$offsite_archive_size"
    printf 'password_readable=%q\n' "$([ -r "$RESTIC_PASSWORD_FILE" ] && echo yes || echo no)"
    printf 'snapshot_id=%q\n' "$snapshot_id"
    printf 'snapshot_epoch=%q\n' "$snapshot_epoch"
    printf 'node_key=%q\n' "$node_key"
    printf 'garage_files=%q\n' "$garage_files"
    printf 'offsite_snapshot=%q\n' "$offsite_snapshot"
  } >"$out"
}

# -------------------------------------------------------------------------------------------------
# JUDGE - reads facts, prints the report, decides. Touches no host, so it is testable.
# -------------------------------------------------------------------------------------------------
# Every variable below arrives from the facts file sourced on the first line; shellcheck cannot see
# through a `.` of a runtime path, hence SC2154 for the function.
# shellcheck disable=SC2154
judge() {
  local facts="$1"
  local findings=0
  # shellcheck disable=SC1090  # written by `gather` above
  . "$facts"

  at() { if [ "$1" -gt 0 ]; then date -d "@$1" '+%Y-%m-%d %H:%M %Z'; else printf 'never'; fi; }
  finding() { printf '::error::%s\n' "$1"; findings=$((findings + 1)); }

  printf '=== Backups on %s\n' "${host:-unknown}"
  printf '    archive     : %s (%s bytes, started %s)\n' "${archive:-NONE}" "$archive_size" "$(at "$archive_epoch")"
  printf '    members     : %s\n' "${members:-none}"
  printf '    offsite     : %s\n' "$offsite_archive_size"
  printf '    snapshot    : %s (%s; %s garage_data files, node_key %s)\n' \
    "${snapshot_id:0:8}" "$(at "$snapshot_epoch")" "$garage_files" "$node_key"
  printf '    offsite     : %s\n\n' "$offsite_snapshot"

  # --- the nightly archive (backup.sh) ---
  if [ -z "$backup_cron" ]; then
    finding "nothing schedules infrastructure/backup/backup.sh in this account's crontab on ${host} - no archive will ever be written"
  elif [ "$backup_daily" != "yes" ]; then
    finding "backup.sh is scheduled '${backup_cron}' but not daily on ${host} - this report only knows how to judge a daily run"
  elif [ -z "$archive" ]; then
    finding "no canari-backup-*.tar.gz at all in ${backup_dir} on ${host}"
  elif [ "$archive_epoch" -lt "$backup_expected" ]; then
    finding "no archive since the run due $(at "$backup_expected") on ${host} - the newest is ${archive}; read ${backup_dir}/backup.log"
  fi

  if [ -n "$archive" ]; then
    local want="MANIFEST.txt media_meta.tar.gz postgres_auth_db.sql.gz" w
    [ "$authentik_expected" = "yes" ] && want="$want authentik_db.sql.gz"
    for w in $want; do
      case " $members " in
        *" $w "*) : ;;
        *) finding "${archive} has no ${w} - a restore from it would come back without it" ;;
      esac
    done
    [ -z "$incomplete" ] || finding "${archive}: ${incomplete} lack pg_dump's closing line - the dump was cut"
    case " $members " in
      *" media_meta.tar.gz "*) [ "$media_meta_ok" = "yes" ] || finding "${archive}: media_meta.tar.gz does not decompress" ;;
    esac
    case "$offsite_archive_size" in
      disabled) : ;;
      "$archive_size") : ;;
      unreachable) finding "the offsite host cannot be reached from ${host} - ${archive} may be the only copy" ;;
      *) finding "${archive} offsite is '${offsite_archive_size}' against ${archive_size} bytes here - one disk holds the only whole copy" ;;
    esac
  fi

  # --- the media snapshot (backup-objects.sh) ---
  if [ -z "$objects_cron" ]; then
    finding "nothing schedules infrastructure/backup/backup-objects.sh in this account's crontab on ${host} - the media blobs have no backup"
  elif [ "$objects_daily" != "yes" ]; then
    finding "backup-objects.sh is scheduled '${objects_cron}' but not daily on ${host} - this report only knows how to judge a daily run"
  elif [ "$password_readable" != "yes" ]; then
    finding "the restic password file is unreadable on ${host} - this report cannot see the media backup, so a failed one would pass"
  elif [ -z "$snapshot_id" ]; then
    finding "the restic repository on ${host} has no snapshot tagged objects"
  else
    [ "$snapshot_epoch" -ge "$objects_expected" ] ||
      finding "no media snapshot since the run due $(at "$objects_expected") on ${host} - read backup-objects.log"
    [ "$garage_files" -gt 0 ] ||
      finding "snapshot ${snapshot_id:0:8} holds no garage_data file - it backed up empty volumes, not the media"
    [ "$node_key" -gt 0 ] ||
      finding "snapshot ${snapshot_id:0:8} has no garage_meta/node_key - a restored Garage would come back as a different node, absent from its own layout"
    case "$offsite_snapshot" in
      disabled | present) : ;;
      unreachable) finding "the offsite host cannot be reached from ${host} - the media mirror may be stale" ;;
      *) finding "snapshot ${snapshot_id:0:8} is not in the offsite mirror - the run stopped before its offsite step" ;;
    esac
  fi

  if [ "$findings" -eq 0 ]; then
    printf 'OK: last night'"'"'s archive and media snapshot on %s are whole, and both are offsite.\n' "${host}"
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
