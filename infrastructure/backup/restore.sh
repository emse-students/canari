#!/usr/bin/env bash
#
# Restauration d une sauvegarde produite par backup.sh.
#
# Usage :
#   ./infrastructure/backup/restore.sh <archive.tar.gz> --yes
#   ./infrastructure/backup/restore.sh --latest-from-mitv --yes
#
# OPERATION DESTRUCTIVE : ecrase les donnees actuelles (postgres, mongo, garage,
# media, Authentik) par celles de l archive. Exige --yes pour s executer.
#
# DEPUIS LE 2026-08-11 UNE RESTAURATION COMPLETE UTILISE DEUX SOURCES : l archive
# (bases + metadonnees) et le depot restic (blobs medias). Ce script gere les deux et
# refuse de se terminer si les medias sont introuvables - voir la section Garage.
# Le fichier de mot de passe restic ne se trouve PAS dans le depot git ni dans les
# secrets GitHub : sans lui le depot est illisible pour toujours. Il doit exister sur
# la machine cible AVANT toute migration (voir infrastructure/MIGRATION.md).
#
# DEPUIS LE 2026-08-14 LE BACKEND OBJET EST GARAGE (ex-MinIO). Les instantanes restic
# pris AVANT cette date contiennent /data/minio (ancien format, incompatible avec la
# stack actuelle qui ne lance plus MinIO) ; ceux pris APRES contiennent /data/garage_data
# et /data/garage_meta. Restaurer un instantane d avant le 14 aout est une operation
# manuelle (voir l historique git de ce fichier et de docker-compose.prod.yml a cette
# date) - ce script ne gere que le format courant.
#
# Pour une migration vers un nouveau serveur :
#   1. Cloner le repo, creer infrastructure/.env (ou laisser la CD le generer).
#   2. Copier le mot de passe restic vers /home/canari/.config/canari/restic-password
#      et le depot (ou le miroir mitv) vers /home/canari/backups/restic-objects.
#   3. Demarrer la stack : docker compose -f infrastructure/docker-compose.prod.yml up -d
#   4. Demarrer Authentik (stack miconnect) si incluse.
#   5. Lancer ce script avec l archive recuperee depuis mitv.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$INFRA_DIR/docker-compose.prod.yml"
ENV_FILE="$INFRA_DIR/.env"

BACKUP_SSH_HOST="${BACKUP_SSH_HOST:-canaribackup@10.0.0.4}"
BACKUP_SSH_PATH="${BACKUP_SSH_PATH:-/srv/canari-backups}"
MICONNECT_PG_CONTAINER="${MICONNECT_PG_CONTAINER:-miconnect-postgresql-1}"

# Depot restic des blobs medias. Doit rester aligne sur backup-objects.sh : un chemin
# qui diverge ne casse pas la sauvegarde, il casse la restauration - c est-a-dire le
# jour ou personne n a le temps de chercher pourquoi.
BACKUP_DIR="${BACKUP_DIR:-/home/canari/backups}"
RESTIC_REPO_DIR="${RESTIC_REPO_DIR:-${BACKUP_DIR}/restic-objects}"
RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-/home/canari/.config/canari/restic-password}"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:latest}"
# Par defaut le dernier instantane. Surchargeable pour remonter avant une corruption :
#   RESTIC_SNAPSHOT=<id> ./restore.sh <archive> --yes
RESTIC_SNAPSHOT="${RESTIC_SNAPSHOT:-latest}"

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

# ── Garage (volumes objet) ──────────────────────────────────────────────────────
# L ABSENCE N EST JAMAIS SILENCIEUSE : si le depot restic est illisible, ce script S ARRETE
# plutot que d annoncer une restauration complete amputee des medias.
if [ -f "$RESTIC_PASSWORD_FILE" ] && [ -d "$RESTIC_REPO_DIR" ]; then
  log "Restauration des volumes Garage depuis restic ($RESTIC_SNAPSHOT)…"
  "${DC[@]}" stop garage media-service
  # `restic restore --target /` ecrit /data/garage_data et /data/garage_meta, les chemins
  # sous lesquels backup-objects.sh a pris l instantane. Les volumes sont montes a ces
  # emplacements exacts, donc les fichiers atterrissent directement dedans.
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v infrastructure_garage_data:/data/garage_data \
    -v infrastructure_garage_meta:/data/garage_meta \
    -v "$RESTIC_REPO_DIR":/repo:ro \
    -v "$RESTIC_PASSWORD_FILE":/pw:ro \
    -e RESTIC_PASSWORD_FILE=/pw \
    -e RESTIC_REPOSITORY=/repo \
    "${RESTIC_IMAGE:-restic/restic:latest}" \
    restore "$RESTIC_SNAPSHOT" --target / --include /data/garage_data --include /data/garage_meta
  "${DC[@]}" start garage media-service
else
  fail "aucune source pour les blobs medias : depot restic illisible
  ($RESTIC_REPO_DIR avec $RESTIC_PASSWORD_FILE).
  Les bases ont peut-etre deja ete restaurees - NE PAS considerer la restauration
  comme terminee. Voir docs/wiki/infrastructure/storage-forecast.md."
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
