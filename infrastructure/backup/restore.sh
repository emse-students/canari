#!/usr/bin/env bash
#
# Restauration d une sauvegarde produite par backup.sh.
#
# Usage :
#   ./infrastructure/backup/restore.sh <archive.tar.gz> --yes
#   ./infrastructure/backup/restore.sh --latest-from-mitv --yes
#
# OPERATION DESTRUCTIVE : ecrase les donnees actuelles (postgres, mongo, minio,
# media, Authentik) par celles de l archive. Exige --yes pour s executer.
#
# Pour une migration vers un nouveau serveur :
#   1. Cloner le repo, creer infrastructure/.env (ou laisser la CD le generer).
#   2. Demarrer la stack : docker compose -f infrastructure/docker-compose.prod.yml up -d
#   3. Demarrer Authentik (stack miconnect) si incluse.
#   4. Lancer ce script avec l archive recuperee depuis mitv.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$INFRA_DIR/docker-compose.prod.yml"
ENV_FILE="$INFRA_DIR/.env"

BACKUP_SSH_HOST="${BACKUP_SSH_HOST:-canaribackup@10.0.0.4}"
BACKUP_SSH_PATH="${BACKUP_SSH_PATH:-/srv/canari-backups}"
MICONNECT_PG_CONTAINER="${MICONNECT_PG_CONTAINER:-miconnect-postgresql-1}"

log() { printf '[restore] %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { printf '[restore] ERROR %s\n' "$*" >&2; exit 1; }

ARCHIVE=""
CONFIRM="no"
FROM_MITV="no"
for arg in "$@"; do
  case "$arg" in
    --yes) CONFIRM="yes" ;;
    --latest-from-mitv) FROM_MITV="yes" ;;
    -*) fail "option inconnue: $arg" ;;
    *) ARCHIVE="$arg" ;;
  esac
done

[ -f "$ENV_FILE" ] || fail "infrastructure/.env introuvable"
set -a; . "$ENV_FILE"; set +a
POSTGRES_USER="${POSTGRES_USER:?POSTGRES_USER absent de infrastructure/.env}"

if docker compose version >/dev/null 2>&1; then
  DC=(docker compose -f "$COMPOSE_FILE")
else
  DC=(docker-compose -f "$COMPOSE_FILE")
fi

# Recuperation de la derniere archive depuis mitv si demande.
if [ "$FROM_MITV" = "yes" ]; then
  log "Recuperation de la derniere archive depuis ${BACKUP_SSH_HOST}…"
  LATEST="$(ssh -o BatchMode=yes "$BACKUP_SSH_HOST" \
    "ls -1t '$BACKUP_SSH_PATH'/canari-backup-*.tar.gz 2>/dev/null | head -1")"
  [ -n "$LATEST" ] || fail "aucune archive sur mitv"
  ARCHIVE="/tmp/$(basename "$LATEST")"
  rsync -az -e "ssh -o BatchMode=yes" "${BACKUP_SSH_HOST}:${LATEST}" "$ARCHIVE"
  log "Archive recuperee: $ARCHIVE"
fi

[ -n "$ARCHIVE" ] || fail "preciser une archive ou --latest-from-mitv"
[ -f "$ARCHIVE" ] || fail "archive introuvable: $ARCHIVE"

if [ "$CONFIRM" != "yes" ]; then
  fail "operation DESTRUCTIVE. Relancer avec --yes pour confirmer la restauration depuis $ARCHIVE"
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/canari-restore.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
log "Extraction de l archive…"
tar xzf "$ARCHIVE" -C "$STAGE"
[ -f "$STAGE/MANIFEST.txt" ] && cat "$STAGE/MANIFEST.txt"

# ── PostgreSQL Canari ─────────────────────────────────────────────────────────
if [ -f "$STAGE/postgres_auth_db.sql.gz" ]; then
  log "Restauration PostgreSQL auth_db…"
  gunzip -c "$STAGE/postgres_auth_db.sql.gz" \
    | "${DC[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d auth_db -v ON_ERROR_STOP=0
fi

# ── MongoDB ───────────────────────────────────────────────────────────────────
if [ -f "$STAGE/mongo_chat_db.archive.gz" ]; then
  log "Restauration MongoDB chat_db…"
  "${DC[@]}" exec -T mongo mongorestore --gzip --archive --drop < "$STAGE/mongo_chat_db.archive.gz"
fi

# ── MinIO (volume objet) ──────────────────────────────────────────────────────
if [ -f "$STAGE/minio_data.tar.gz" ]; then
  log "Restauration du volume MinIO (arret temporaire de minio)…"
  "${DC[@]}" stop minio media-service
  docker run --rm \
    -v infrastructure_minio_data:/data \
    -v "$STAGE":/in:ro \
    alpine:latest \
    sh -c 'rm -rf /data/* /data/..?* /data/.[!.]* 2>/dev/null; tar xzf /in/minio_data.tar.gz -C /data'
  "${DC[@]}" start minio media-service
fi

# ── Metadonnees media-service ─────────────────────────────────────────────────
if [ -f "$STAGE/media_meta.tar.gz" ]; then
  log "Restauration du volume media_meta…"
  "${DC[@]}" stop media-service
  docker run --rm \
    -v infrastructure_media_meta:/data \
    -v "$STAGE":/in:ro \
    alpine:latest \
    sh -c 'rm -rf /data/* /data/..?* /data/.[!.]* 2>/dev/null; tar xzf /in/media_meta.tar.gz -C /data'
  "${DC[@]}" start media-service
fi

# ── Authentik ─────────────────────────────────────────────────────────────────
if [ -f "$STAGE/authentik_db.sql.gz" ]; then
  if docker inspect "$MICONNECT_PG_CONTAINER" >/dev/null 2>&1; then
    log "Restauration PostgreSQL Authentik…"
    gunzip -c "$STAGE/authentik_db.sql.gz" \
      | docker exec -i "$MICONNECT_PG_CONTAINER" sh -c \
        'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=0'
  else
    log "WARN conteneur Authentik absent - dump authentik non restaure"
  fi
fi

log "Restauration terminee. Verifier les services puis redemarrer si besoin :"
log "  ${DC[*]} restart"
