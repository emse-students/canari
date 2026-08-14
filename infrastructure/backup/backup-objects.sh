#!/usr/bin/env bash
#
# Deduplicated backup of the object volumes (Garage blobs + media-service metadata) via restic.
#
# WHY THIS EXISTS
# ---------------
# backup.sh writes ONE full archive per night and keeps 14. For the logical dumps
# (PostgreSQL, MongoDB) that is the right scheme: they are small and they compress. For
# the media blobs it is not. Those blobs are encrypted client-side, so they are incompressible
# AND immutable - re-archiving the whole volume nightly makes every live byte cost 15 more on
# a 125 GB disk. The measured model is in docs/wiki/infrastructure/storage-forecast.md.
#
# restic stores deduplicated chunks: a night where nothing changed costs almost nothing,
# and a blob already stored is never written again. The same history then fits in the
# space of a single copy plus what is new.
#
# THIS IS THE ONLY BACKUP OF THE MEDIA BLOBS (cutover 2026-08-11, storage backend migrated
# from MinIO to Garage 2026-08-14 - the volume names changed, restic's own history did not).
# backup.sh does not archive the object volume, so a restore of the objects can only come
# from here. The cutover was taken after a control restore matched the live volume
# sha256-identically over 172 media objects, and after a second nightly run cost 24 KB.
#
# Consequence to keep in mind before touching anything here: a failure of this script is no
# longer softened by the tar. It is loud on purpose (`set -euo pipefail`, and a missing
# password stops rather than initialising a second repository), and the password file must
# be kept off this machine - the offsite mirror is an encrypted copy, not a second chance.
#
# No host dependency: restic runs in a throwaway image, like the tar and rclone already do.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$INFRA_DIR/.env"

BACKUP_DIR="${BACKUP_DIR:-/home/canari/backups}"
RESTIC_REPO_DIR="${RESTIC_REPO_DIR:-${BACKUP_DIR}/restic-objects}"
RESTIC_CACHE_DIR="${RESTIC_CACHE_DIR:-/home/canari/.cache/restic}"
# The repository password is deliberately NOT in infrastructure/.env: the CD regenerates
# that file from the GitHub secrets on every deploy, and a restic repository whose password
# changes is unreadable forever. It therefore lives outside the deployment cycle, and must
# be backed up off this machine (see infrastructure/MIGRATION.md).
RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-/home/canari/.config/canari/restic-password}"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:latest}"

# Retention: 14 full days (aligned with the tar), then one point per week and per month so a
# corruption discovered late is still recoverable.
KEEP_DAILY="${RESTIC_KEEP_DAILY:-14}"
KEEP_WEEKLY="${RESTIC_KEEP_WEEKLY:-8}"
KEEP_MONTHLY="${RESTIC_KEEP_MONTHLY:-6}"

BACKUP_SSH_HOST="${BACKUP_SSH_HOST:-canaribackup@10.0.0.4}"
BACKUP_SSH_PATH="${BACKUP_SSH_PATH:-/srv/canari-backups}"

log() { printf '[backup-objects] %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { printf '[backup-objects] ERROR %s\n' "$*" >&2; exit 1; }

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# A missing password is NEVER replaced by a generated one: that would silently create a
# second repository, and every previous snapshot would become unreadable without anything
# failing. Stop, loudly.
[ -f "$RESTIC_PASSWORD_FILE" ] || fail "restic password file not found ($RESTIC_PASSWORD_FILE) - see infrastructure/MIGRATION.md"

mkdir -p "$RESTIC_REPO_DIR" "$RESTIC_CACHE_DIR"

# restic runs as the calling UID, so the repository belongs to canari and the offsite rsync
# (which runs as canari) can read it. Garage's own files are 0644, so they stay readable
# without root.
restic() {
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v infrastructure_garage_data:/data/garage_data:ro \
    -v infrastructure_garage_meta:/data/garage_meta:ro \
    -v infrastructure_media_meta:/data/media_meta:ro \
    -v "$RESTIC_REPO_DIR":/repo \
    -v "$RESTIC_CACHE_DIR":/cache \
    -v "$RESTIC_PASSWORD_FILE":/pw:ro \
    -e RESTIC_PASSWORD_FILE=/pw \
    -e RESTIC_CACHE_DIR=/cache \
    -e RESTIC_REPOSITORY=/repo \
    "$RESTIC_IMAGE" "$@"
}

# ── 1. Repository ─────────────────────────────────────────────────────────────
if restic cat config >/dev/null 2>&1; then
  log "Existing restic repository -> $RESTIC_REPO_DIR"
else
  log "Initialising restic repository -> $RESTIC_REPO_DIR"
  restic init
fi

# ── 2. Backup ─────────────────────────────────────────────────────────────────
log "Backing up the object volumes…"
restic backup /data/garage_data /data/garage_meta /data/media_meta \
  --host canari \
  --tag objects \
  --exclude-caches

# ── 3. Retention + prune ──────────────────────────────────────────────────────
log "Applying retention (${KEEP_DAILY}d / ${KEEP_WEEKLY}w / ${KEEP_MONTHLY}m)…"
restic forget \
  --tag objects \
  --keep-daily "$KEEP_DAILY" \
  --keep-weekly "$KEEP_WEEKLY" \
  --keep-monthly "$KEEP_MONTHLY" \
  --prune

# ── 4. Integrity check ────────────────────────────────────────────────────────
# Structure only: fast, and enough to catch a truncated repository. Verifying the CONTENT
# (--read-data) is the job of a control restore, which is the only test that proves
# anything (see restore.sh).
log "Checking repository integrity…"
restic check

RESTIC_SIZE="$(du -sh "$RESTIC_REPO_DIR" | cut -f1)"
log "Repository size: $RESTIC_SIZE"
restic snapshots --tag objects --compact | tail -5

# ── 5. Offsite copy ───────────────────────────────────────────────────────────
# The repository is mirrored as-is: it is a set of immutable packs plus an index, so
# --delete is safe AFTER the prune above, never before it.
if [ -n "$BACKUP_SSH_HOST" ]; then
  log "Mirroring offsite to ${BACKUP_SSH_HOST}:${BACKUP_SSH_PATH}/restic-objects…"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$BACKUP_SSH_HOST" "mkdir -p '$BACKUP_SSH_PATH/restic-objects'"
  rsync -a --delete --partial -e "ssh -o BatchMode=yes -o ConnectTimeout=10" \
    "$RESTIC_REPO_DIR/" "${BACKUP_SSH_HOST}:${BACKUP_SSH_PATH}/restic-objects/" \
    && log "Offsite mirror complete"
else
  log "WARN offsite not configured (BACKUP_SSH_HOST empty) - local repository only"
fi

log "Done"
