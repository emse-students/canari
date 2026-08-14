#!/usr/bin/env bash
#
# Sauvegarde complete de toutes les donnees Canari + Authentik.
#
# Produit une archive horodatee unique contenant les dumps logiques coherents
# (PostgreSQL, MongoDB, Authentik) et les metadonnees media. Conserve les N
# derniers jours en local et pousse une copie offsite (rsync) avec la meme
# retention.
#
# PERIMETRE : LES BLOBS MEDIAS N EN FONT PLUS PARTIE (bascule du 2026-08-11).
# Ils sont chiffres cote client, donc incompressibles et immuables : les
# re-archiver chaque nuit faisait couter 16 octets a chaque octet vivant sur un
# disque de 125 Go, et le disque se remplissait en 9 a 34 jours a 400 utilisateurs
# quotidiens. Ils sont desormais sauvegardes par backup-objects.sh dans un depot
# restic deduplique (14j / 8 sem / 6 mois + miroir offsite). Le raisonnement et
# les mesures sont dans docs/wiki/infrastructure/storage-forecast.md.
#
# UNE RESTAURATION COMPLETE EXIGE DONC LES DEUX : cette archive pour les bases,
# restore.sh pour les objets. Le manifeste de chaque archive le rappelle.
#
# Concu pour tourner via le timer systemd canari-backup.timer, ou a la main :
#   ./infrastructure/backup/backup.sh
#
# Aucune dependance hote requise hors Docker : pg_dump/mongodump s executent
# dans les conteneurs, le tar des volumes et rclone via des images jetables.
#
set -euo pipefail

# ── Resolution des chemins ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$INFRA_DIR/.." && pwd)"
COMPOSE_FILE="$INFRA_DIR/docker-compose.prod.yml"
ENV_FILE="$INFRA_DIR/.env"

# ── Configuration (surchargeable via infrastructure/.env) ──────────────────────
BACKUP_DIR="${BACKUP_DIR:-/home/canari/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
# Stack Authentik (compose separe). Vide pour desactiver son inclusion.
MICONNECT_PG_CONTAINER="${MICONNECT_PG_CONTAINER:-miconnect-postgresql-1}"
# Stockage secondaire offsite via SSH/rsync (serveur LAN mitv). Vide pour desactiver.
BACKUP_SSH_HOST="${BACKUP_SSH_HOST:-canaribackup@10.0.0.4}"
BACKUP_SSH_PATH="${BACKUP_SSH_PATH:-/srv/canari-backups}"

log() { printf '[backup] %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { printf '[backup] ERROR %s\n' "$*" >&2; exit 1; }

# Charge les variables (POSTGRES_USER, BACKUP_S3_*, …) depuis infrastructure/.env.
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  fail "infrastructure/.env introuvable ($ENV_FILE)"
fi

POSTGRES_USER="${POSTGRES_USER:?POSTGRES_USER absent de infrastructure/.env}"

if docker compose version >/dev/null 2>&1; then
  DC=(docker compose -f "$COMPOSE_FILE")
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose -f "$COMPOSE_FILE")
else
  fail "docker compose introuvable"
fi

TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/canari-backup.XXXXXX")"
ARCHIVE_NAME="canari-backup-${TIMESTAMP}.tar.gz"
ARCHIVE_PATH="${BACKUP_DIR}/${ARCHIVE_NAME}"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$BACKUP_DIR"
log "Demarrage de la sauvegarde -> $ARCHIVE_PATH"

# ── 1. PostgreSQL Canari (auth_db) ────────────────────────────────────────────
# Dump logique coherent via le conteneur (auth socket trust, pas de mot de passe).
log "Dump PostgreSQL auth_db…"
"${DC[@]}" exec -T postgres sh -c "pg_dump -U \"$POSTGRES_USER\" -d auth_db --clean --if-exists" \
  | gzip > "$STAGE/postgres_auth_db.sql.gz"

# ── 2. MongoDB (chat_db) ──────────────────────────────────────────────────────
log "Dump MongoDB chat_db…"
"${DC[@]}" exec -T mongo sh -c "mongodump --db=chat_db --archive --gzip" \
  > "$STAGE/mongo_chat_db.archive.gz"

# ── 3. Metadonnees media-service ──────────────────────────────────────────────
log "Archivage du volume media_meta…"
docker run --rm \
  -v infrastructure_media_meta:/data:ro \
  -v "$STAGE":/out \
  alpine:latest \
  tar czf /out/media_meta.tar.gz -C /data .

# ── 4. Authentik (stack miconnect) ────────────────────────────────────────────
if [ -n "$MICONNECT_PG_CONTAINER" ] && docker inspect "$MICONNECT_PG_CONTAINER" >/dev/null 2>&1; then
  log "Dump PostgreSQL Authentik…"
  docker exec "$MICONNECT_PG_CONTAINER" sh -c \
    'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
    | gzip > "$STAGE/authentik_db.sql.gz"
else
  log "WARN conteneur Authentik ($MICONNECT_PG_CONTAINER) absent - ignore"
fi

# ── 5. Manifeste + archive unique ─────────────────────────────────────────────
cat > "$STAGE/MANIFEST.txt" <<EOF
Canari backup
timestamp: $TIMESTAMP
created_by: $(whoami)@$(hostname)
git_commit: $(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo "n/a")
contenu:
  - postgres_auth_db.sql.gz   (Canari: users, channels, posts, forms, paiements,
                               ET l historique MLS chiffre - queued_message, mls_*)
  - mongo_chat_db.archive.gz  (VIDE en pratique - voir ci-dessous)
  - media_meta.tar.gz         (Canari: metadonnees media-service)
  - authentik_db.sql.gz       (Authentik: identites, config OIDC)

NOTE - mongo_chat_db.archive.gz fait ~116 octets et c est NORMAL : l instance
MongoDB de production ne contient aucune base applicative (verifie 2026-08-11,
seules admin/config/local existent) et aucun service ne s y connecte. Cette ligne
du manifeste annoncait auparavant "blobs MLS chiffres / historique", ce qui etait
faux : cet historique est dans PostgreSQL. Un dump vide n est pas une panne ici,
mais il ne doit pas passer pour une sauvegarde.

ATTENTION - les blobs medias (volumes Garage, ex-MinIO) NE SONT PLUS DANS CETTE ARCHIVE.
Ils sont sauvegardes par backup-objects.sh dans le depot restic
${BACKUP_DIR}/restic-objects (14j / 8 sem / 6 mois, miroir offsite au meme endroit).
Une restauration complete = cette archive + restore.sh pour les objets.
EOF

log "Creation de l archive finale…"
tar czf "$ARCHIVE_PATH" -C "$STAGE" .
ARCHIVE_SIZE="$(du -h "$ARCHIVE_PATH" | cut -f1)"
log "Archive locale ecrite ($ARCHIVE_SIZE)"

# ── 6. Retention locale ───────────────────────────────────────────────────────
log "Purge des sauvegardes locales > ${BACKUP_RETENTION_DAYS} jours…"
find "$BACKUP_DIR" -maxdepth 1 -name 'canari-backup-*.tar.gz' -type f \
  -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete || true

# ── 7. Copie offsite via SSH/rsync (serveur LAN mitv) ─────────────────────────
if [ -n "$BACKUP_SSH_HOST" ]; then
  log "Envoi offsite vers ${BACKUP_SSH_HOST}:${BACKUP_SSH_PATH}…"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$BACKUP_SSH_HOST" "mkdir -p '$BACKUP_SSH_PATH'"
  rsync -az --partial -e "ssh -o BatchMode=yes -o ConnectTimeout=10" \
    "$ARCHIVE_PATH" "${BACKUP_SSH_HOST}:${BACKUP_SSH_PATH}/" \
    && log "Copie offsite reussie"

  # Retention offsite alignee sur la retention locale.
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$BACKUP_SSH_HOST" \
    "find '$BACKUP_SSH_PATH' -maxdepth 1 -name 'canari-backup-*.tar.gz' -type f -mtime +${BACKUP_RETENTION_DAYS} -delete" \
    || log "WARN purge offsite incomplete"
else
  log "WARN offsite non configure (BACKUP_SSH_HOST vide) - sauvegarde locale seule"
fi

log "Sauvegarde terminee: $ARCHIVE_PATH"
