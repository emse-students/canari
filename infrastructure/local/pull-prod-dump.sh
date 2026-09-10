#!/usr/bin/env bash
#
# Fetches a dump of production's database to this machine. READ-ONLY against production: it runs
# `pg_dump` and two `SELECT count(*)`, and nothing else. Restoring it is
# `infrastructure/local/restore-into-local.sh`'s job, and the split is deliberate - the script that
# destroys a database needs no production access at all, so it can be run and tested without any.
#
# THE DUMP IS MADE ON THE BOX AND THEN COPIED, rather than streamed. Two reasons, and the second is
# a trap worth naming: a stream dies with the connection and leaves a truncated file that looks like
# a dump, and on Windows a caller who reaches for the PowerShell tool would corrupt it anyway -
# PowerShell TEXT-ENCODES stdout, so `pg_dump | gzip` through it is not the bytes that were sent.
# `scp` writes the file itself and never puts binary on a pipe.
#
# SSH FROM BASH WORKS SINCE 2026-09-02, and it did not before. MSYS `ssh` execs the cloudflared
# `ProxyCommand` through `/bin/bash`, which ate the backslashes in its Windows path; `~/.ssh/config`
# now spells it with forward slashes, which both `bash` and `cmd` exec. If this script ever fails
# with `exec: C:UsersjolanAppData...: not found`, that config has been rewritten with backslashes.
#
# Usage:
#   infrastructure/local/pull-prod-dump.sh [output.sql.gz]
#
# Writes the dump and a `<output>.sql.gz.meta` sidecar carrying the row counts measured ON
# PRODUCTION - which is what lets the restore VERIFY its result instead of hoping. Default output is
# a timestamped file under the out-of-repo state root beside the repo, never inside it: a production
# dump holding every member's PII must not sit where `git add -A` can reach it.
set -euo pipefail

# ── Production, by compose label. Constants: this script must not be pointable elsewhere. ──
readonly PROD_HOST="canari"
readonly PROD_PROJECT="infrastructure"
readonly DATABASE="auth_db"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEFAULT_DIR="$(cd "$ROOT/.." && pwd)/canari-harness/dumps"

log() { printf '[pull-prod-dump] %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() {
  printf '[pull-prod-dump] ERROR %s\n' "$*" >&2
  exit 1
}

OUT="${1:-}"
if [ -z "$OUT" ]; then
  mkdir -p "$DEFAULT_DIR"
  OUT="$DEFAULT_DIR/auth_db-$(date '+%Y%m%d-%H%M%S').sql.gz"
fi
case "$OUT" in
  "$ROOT"/*) fail "refusing to write a production dump inside the repository: $OUT" ;;
esac
mkdir -p "$(dirname "$OUT")"

# ── The ssh binary ───────────────────────────────────────────────────────────
# Not a fallback: a deliberate choice of transport, logged. `CANARI_SSH` overrides it for a machine
# whose layout differs. Both candidates are known to work with the forward-slash ProxyCommand; the
# Windows one is preferred where it exists because it needs no MSYS path translation at all.
SSH_BIN="${CANARI_SSH:-}"
SCP_BIN="${CANARI_SCP:-}"
if [ -z "$SSH_BIN" ]; then
  if [ -x /c/WINDOWS/System32/OpenSSH/ssh.exe ]; then
    SSH_BIN=/c/WINDOWS/System32/OpenSSH/ssh.exe
    SCP_BIN=/c/WINDOWS/System32/OpenSSH/scp.exe
  else
    SSH_BIN=ssh
    SCP_BIN=scp
  fi
fi
[ -n "$SCP_BIN" ] || SCP_BIN=scp
log "transport: $SSH_BIN"

SSH=("$SSH_BIN" -o ConnectTimeout=30 -o BatchMode=yes "$PROD_HOST")

# ── Locate production's postgres, and read its user from the container ───────
PROD_PG=$("${SSH[@]}" "docker ps --filter label=com.docker.compose.project=$PROD_PROJECT --filter label=com.docker.compose.service=postgres --filter status=running --format '{{.Names}}' | head -1" | tr -d '\r')
[ -n "$PROD_PG" ] || fail "no running postgres in production's '$PROD_PROJECT' compose project"
PROD_USER=$("${SSH[@]}" "docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $PROD_PG | sed -n 's/^POSTGRES_USER=//p' | head -1" | tr -d '\r')
[ -n "$PROD_USER" ] || fail "$PROD_PG declares no POSTGRES_USER"
log "source: $PROD_PG (user $PROD_USER)"

# ── Measure BEFORE dumping, so the sidecar describes the dump ────────────────
PROD_USERS=$("${SSH[@]}" "docker exec -i $PROD_PG psql -tAX -U '$PROD_USER' -d '$DATABASE' -c 'SELECT count(*) FROM users;'" | tr -d '\r[:space:]')
log "production reports $PROD_USERS users"

# ── Dump on the box, to a private temp file ──────────────────────────────────
REMOTE="/tmp/canari-dump-$$.sql.gz"
# --clean --if-exists so the restore replaces objects rather than colliding with them. The same
# flags backup.sh and copy-prod-to-dev.sh use, deliberately: one dump format for every path.
log "dumping $DATABASE on the box…"
"${SSH[@]}" "umask 077 && docker exec -i $PROD_PG sh -c \"pg_dump -U '$PROD_USER' -d '$DATABASE' --clean --if-exists\" | gzip > $REMOTE && ls -l $REMOTE" | tr -d '\r'

log "copying…"
"$SCP_BIN" -o ConnectTimeout=30 -o BatchMode=yes "$PROD_HOST:$REMOTE" "$OUT" >/dev/null
"${SSH[@]}" "rm -f $REMOTE"

[ -s "$OUT" ] || fail "the copied dump is empty: $OUT"
# gzip integrity, not just a non-zero size: a truncated transfer is the failure this catches.
gunzip -t "$OUT" 2>/dev/null || fail "the copied dump is not a valid gzip stream - transfer truncated"

printf 'users=%s\ntaken=%s\nsource=%s\n' "$PROD_USERS" "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$PROD_PG" >"$OUT.meta"

log "wrote $OUT ($(du -h "$OUT" | cut -f1)) and $OUT.meta"
log "THIS FILE HOLDS EVERY MEMBER'S PII. It is outside the repository on purpose; delete it when the"
log "  restore is done, and never move it inside the work tree."
printf '%s\n' "$OUT"
