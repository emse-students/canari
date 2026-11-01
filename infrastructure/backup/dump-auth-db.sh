# shellcheck shell=bash
#
# THE ONE LOGICAL DUMP OF THE CANARI DATABASE (`auth_db`), for its two takers:
#
#   - `backup.sh`, the nightly backup, whose first member it is;
#   - `deploy-environment.sh`, right before it applies a migration the owner approved - the owner's
#     rule (2026-11-01): "applied only if additive, reviewed, and with a backup taken just before"
#     (infrastructure/lib/migration-hold.sh). It calls `pre_migration_backup`, below.
#
# One function, so the dump a migration is protected by is the same dump a restore already knows how
# to read (`restore.sh`), never a second recipe that drifts from it.

# dump_auth_db <out.sql.gz> <compose command...>
#
# Runs pg_dump INSIDE the postgres service of the given compose command (`docker compose -f ...`, or
# a function wrapping it) as $POSTGRES_USER, gzips it to <out>, and proves the stream whole with
# `gzip -t`: a truncated stream produces a file that looks like a dump and does not decompress, which
# is exactly what a restore discovers too late. Returns non-zero on any failure, and then leaves NO
# file at <out>: a partial dump beside the real ones is a restore point that is not one.
dump_auth_db() {
  local out="$1"
  shift
  local -
  set -o pipefail
  if ! "$@" exec -T postgres sh -c "pg_dump -U \"$POSTGRES_USER\" -d auth_db --clean --if-exists" </dev/null | gzip >"$out" ||
    ! gzip -t "$out" 2>/dev/null; then
    rm -f "$out"
    return 1
  fi
}

# canari_backup_dir
#
# Prints the backup directory, read from the ONE place that names it: the `BACKUP_DIR=` line of THIS
# account's crontab - the line cron hands `backup.sh` every night, and the one `backup-report.sh` and
# `host-update-report.sh` read to find the archives. The deploy runs as that same account (the
# self-hosted runner's), so it reads the directory the nightly backup writes, which `backup-report`
# watches and the host report measures.
#
# THERE IS NO DEFAULT, deliberately (review of #2873). The first version fell back to a home
# directory of the box production left on 2026-09-24: an approved migration would have failed its
# `mkdir` on every deploy, or dumped where nothing reads. An unnamed directory is an ::error:: here.
canari_backup_dir() {
  local tab dir
  if ! tab="$(crontab -l 2>/dev/null)"; then
    printf '::error::this account (%s) has no crontab, so nothing names the backup directory (its BACKUP_DIR= line, docs/wiki/infrastructure/backup.md)\n' "$(id -un)" >&2
    return 1
  fi
  dir="$(sed -n 's/^BACKUP_DIR=//p' <<<"$tab" | sed -n 1p)"
  if [ -z "$dir" ] || [ "${dir#/}" = "$dir" ]; then
    printf '::error::the crontab of this account (%s) has no BACKUP_DIR= line naming an absolute directory (read: '"'"'%s'"'"'), so nothing names the backup directory (docs/wiki/infrastructure/backup.md)\n' "$(id -un)" "$dir" >&2
    return 1
  fi
  printf '%s\n' "$dir"
}

# pre_migration_backup <migration file> <compose project> <compose command...>
#
# The backup right before an approved held migration: `dump_auth_db` into
# `<backup dir>/pre-migration/<project>-<UTC time>-<migration>.sql.gz`. Returns non-zero, with an
# ::error:: and no partial file, when the directory is unnamed or unwritable or the dump fails.
#
# NO RETENTION RULE, deliberately: there is one file per approved held migration, never one per
# deploy, and each is the only restore point taken right before a change the owner accepted may lose
# data. A rule that aged them out would delete exactly that. They are local only (the offsite copy
# carries the nightly archive), and their size is in the host report's `du` of the backup directory
# (docs/wiki/infrastructure/backup.md, "Retention").
pre_migration_backup() {
  local migration="$1" project="$2" root dir out
  shift 2
  root="$(canari_backup_dir)" || return 1
  dir="$root/pre-migration"
  out="$dir/${project}-$(date -u '+%Y%m%dT%H%M%SZ')-$(basename "$migration" .sql).sql.gz"
  if ! mkdir -p "$dir"; then
    printf '::error::cannot create %s for the backup before %s\n' "$dir" "$migration"
    return 1
  fi
  if ! dump_auth_db "$out" "$@"; then
    printf '::error::the dump of the %s database before %s failed or is truncated - nothing was kept at %s\n' "$project" "$migration" "$out"
    return 1
  fi
  printf 'backup taken before %s: %s (%s bytes)\n' "$migration" "$out" "$(wc -c <"$out" | tr -d ' ')"
}
