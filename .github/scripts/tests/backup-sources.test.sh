#!/usr/bin/env bash
# =================================================================================================
# THE OBJECT BACKUP READS AN ALLOWLIST OF VOLUMES, AND THE LIVE SEGMENTS ARE NOT ON IT.
#
# WHY. The owner decided on 2026-11-09 that live replays are NEVER in backups (D2,
# docs/wiki/live-replays.md): a replay is promised gone three days after its live, and a nightly
# restic snapshot kept 14 days, 8 weeks and 6 months would keep it for half a year. Garage stores an
# object as content-addressed blocks, so no prefix of `garage_data` can be excluded - the live
# segments therefore live on a volume of their own, `live_segments`, written by media-service
# (WP-R3). What keeps them out of the backup is that `backup-objects.sh` mounts volumes BY NAME. A
# later edit that mounts the new volume ("back up every media volume") would put every replay back
# into the snapshots and nothing would fail - so this runs the real script against a stub `docker`
# and reads the volumes it actually mounted.
#
# WHAT IT HOLDS.
#   1. backup-objects.sh mounts exactly garage_data, garage_meta and media_meta of the project.
#   2. No script of infrastructure/backup names `live_segments`.
#   3. The deployed compose files mount `live_segments` into media-service at the path its
#      LIVE_SEGMENTS_DIR names, so the segments are on that volume and not in the container layer
#      (where a recreate would lose them) nor on a backed-up volume.
#
# Run by `make test-ci-scripts`.
# =================================================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
SRC="$ROOT/infrastructure/backup"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

[ -r "$SRC/backup-objects.sh" ] || { printf 'cannot read %s/backup-objects.sh\n' "$SRC"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/repo/infrastructure/backup" "$TMP/bin" "$TMP/state"
cp "$SRC/backup-objects.sh" "$SRC/backup-config.sh" "$TMP/repo/infrastructure/backup/"
printf 'pw\n' >"$TMP/state/pw"

# Every `docker` call is appended, one argument per line, between two markers.
cat >"$TMP/bin/docker" <<'EOF'
#!/bin/sh
{ printf -- '--call--\n'; for a in "$@"; do printf '%s\n' "$a"; done; } >>"$DOCKER_LOG"
exit 0
EOF
chmod +x "$TMP/bin/docker"

echo "backup-objects.sh mounts an allowlist of volumes"
DOCKER_LOG="$TMP/docker.log" \
  PATH="$TMP/bin:$PATH" \
  BACKUP_SSH_HOST="" \
  BACKUP_DIR="$TMP/state/backups" \
  RESTIC_REPO_DIR="$TMP/state/repo" \
  RESTIC_CACHE_DIR="$TMP/state/cache" \
  RESTIC_PASSWORD_FILE="$TMP/state/pw" \
  CANARI_COMPOSE_PROJECT="proj" \
  bash "$TMP/repo/infrastructure/backup/backup-objects.sh" >"$TMP/run.log" 2>&1
status=$?
if [ "$status" -eq 0 ]; then pass "the script ran against the stubs"; else
  fail "the script exited $status"
  sed 's/^/        /' "$TMP/run.log"
fi

# The volume sources: every argument after a `-v` whose source is a NAMED volume of the project.
mounted="$(awk 'prev == "-v" { print } { prev = $0 }' "$TMP/docker.log" |
  sed -n 's/^proj_\([^:]*\):.*/\1/p' | sort -u | tr '\n' ' ')"
expected="garage_data garage_meta media_meta "
if [ "$mounted" = "$expected" ]; then pass "it mounts exactly: $expected"; else
  fail "it mounts [$mounted], the allowlist is [$expected]"
fi
case " $mounted " in
  *" live_segments "*) fail "it mounts live_segments: every replay would be in the snapshots" ;;
  *) pass "it never mounts live_segments" ;;
esac

echo "no backup script names the live segments volume"
if grep -rln 'live_segments' "$SRC" >/dev/null 2>&1; then
  fail "a backup script names live_segments: $(grep -rln 'live_segments' "$SRC" | tr '\n' ' ')"
else
  pass "infrastructure/backup never names live_segments"
fi

echo "the deployed compose files put the segments on that volume"
for compose in docker-compose.prod.yml docker-compose.dev.yml local/docker-compose.yml; do
  file="$ROOT/infrastructure/$compose"
  # The media-service block: from its key to the next service key at the same indent.
  block="$(awk '/^  media-service:/ { on = 1; print; next } on && /^  [a-z]/ { on = 0 } on' "$file")"
  dir="$(printf '%s\n' "$block" | sed -n 's/^ *LIVE_SEGMENTS_DIR: *//p' | tr -d '"')"
  if [ -n "$dir" ] && printf '%s\n' "$block" | grep -q -- "- live_segments:$dir\$"; then
    pass "$compose: media-service mounts live_segments at LIVE_SEGMENTS_DIR ($dir)"
  else
    fail "$compose: media-service must set LIVE_SEGMENTS_DIR and mount live_segments there (dir=[$dir])"
  fi
  if grep -q '^  live_segments:' "$file"; then pass "$compose: declares the live_segments volume"; else
    fail "$compose: the live_segments volume is not declared"
  fi
done

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
