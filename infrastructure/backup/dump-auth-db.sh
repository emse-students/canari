# shellcheck shell=bash
#
# THE ONE LOGICAL DUMP OF THE CANARI DATABASE (`auth_db`), for its two takers:
#
#   - `backup.sh`, the nightly backup, whose first member it is;
#   - `deploy-environment.sh`, right before it applies a migration the owner approved - the owner's
#     rule (2026-11-01): "applied only if additive, reviewed, and with a backup taken just before"
#     (infrastructure/lib/migration-hold.sh).
#
# One function, so the dump a migration is protected by is the same dump a restore already knows how
# to read (`restore.sh`), never a second recipe that drifts from it.
#
# The default home of every backup, named once: `backup-config.sh` reads it too.
# shellcheck disable=SC2034 # read by the scripts that source this file
CANARI_DEFAULT_BACKUP_DIR='/home/canari/backups'

# dump_auth_db <out.sql.gz> <compose command...>
#
# Runs pg_dump INSIDE the postgres service of the given compose command (`docker compose -f ...`, or
# a function wrapping it) as $POSTGRES_USER, gzips it to <out>, and proves the stream whole with
# `gzip -t`: a truncated stream produces a file that looks like a dump and does not decompress, which
# is exactly what a restore discovers too late. Returns non-zero on any failure; prints nothing.
dump_auth_db() {
  local out="$1"
  shift
  local -
  set -o pipefail
  if ! "$@" exec -T postgres sh -c "pg_dump -U \"$POSTGRES_USER\" -d auth_db --clean --if-exists" </dev/null | gzip >"$out"; then
    return 1
  fi
  gzip -t "$out"
}
