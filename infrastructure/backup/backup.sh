#!/usr/bin/env bash
#
# Sauvegarde complete de toutes les donnees Canari + Authentik.
#
# Produit une archive horodatee unique contenant les dumps logiques coherents
# (PostgreSQL Canari, PostgreSQL Authentik) et les metadonnees media. Conserve
# les N derniers jours en local et pousse une copie offsite (rsync) avec la meme
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
# MONGODB N EST PLUS SAUVEGARDE (2026-08-18) parce qu il n existe plus : le
# service etait un vestige, aucune base applicative n a jamais ete creee dedans
# (verifie 2026-08-11 puis 2026-08-18 : seules admin/config/local) et aucun
# service ne s y connectait. Le dump de 116 octets qu il produisait figurait au
# manifeste, ou une ligne vide se lit comme une sauvegarde.
#
# Aucune dependance hote requise hors Docker : pg_dump s execute dans le
# conteneur, le tar des volumes et rclone via des images jetables.
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
# Le nom du projet compose (docker-compose.prod.yml's `name:`), pas derive d ici :
# les volumes cibles ci-dessous sont montes par un `docker run` brut, en dehors
# de `docker compose`, donc rien ne le resout pour nous a partir du fichier.
CANARI_COMPOSE_PROJECT="${CANARI_COMPOSE_PROJECT:-canari-prod}"
# Stack Authentik (compose separe). Vide pour desactiver son inclusion - et
# c est le SEUL geste qui l exclut : une valeur posee ici et injoignable fait
# echouer la sauvegarde.
MICONNECT_PG_CONTAINER="${MICONNECT_PG_CONTAINER-miconnect-postgresql-1}"
# La machine qui porte cette stack. Vide = ce conteneur tourne ici, ce qui
# etait vrai jusqu au 2026-06-22 et ne l est plus : Authentik a eu sa propre VM,
# puis a rejoint l hote mutualise le 2026-09-24.
#
# CE DEFAUT A CHANGE AVEC LA MACHINE, ET IL LE DEVAIT. L ancienne VM tourne encore
# avec une copie FIGEE de la base : un defaut qui la designerait produirait une
# sauvegarde qui reussit et qui ment, ce qui est pire qu une qui echoue. La valeur
# est un ALIAS ~/.ssh/config, qui porte la cle dediee et IdentitiesOnly.
MICONNECT_SSH_HOST="${MICONNECT_SSH_HOST-authentik-target}"
# Stockage secondaire offsite via SSH/rsync (serveur LAN mitv). Vide pour desactiver.
# `-` et non `:-`, ici et pour les deux MICONNECT_* : `:-` traite le vide comme
# l absence et remet le defaut, et "vide pour desactiver" serait un commentaire
# que le code dement - il l a ete jusqu au 2026-09-25.
BACKUP_SSH_HOST="${BACKUP_SSH_HOST-canaribackup@10.0.0.4}"
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

# ── 2. Metadonnees media-service ──────────────────────────────────────────────
log "Archivage du volume media_meta…"
docker run --rm \
  -v "${CANARI_COMPOSE_PROJECT}_media_meta":/data:ro \
  -v "$STAGE":/out \
  alpine:latest \
  tar czf /out/media_meta.tar.gz -C /data .

# ── 3. Authentik (stack miconnect) ────────────────────────────────────────────
# DEPUIS LE 2026-06-22 CETTE STACK N EST PLUS SUR CETTE MACHINE : elle a sa
# propre VM. Le "docker inspect" local qui la cherchait ici a donc echoue chaque
# nuit pendant 93 nuits, et la branche qui rattrapait cet echec ecrivait un
# avertissement puis continuait - l archive repartait sans les identites ni la
# configuration OIDC, et le manifeste continuait de les annoncer.
#
# UNE SOURCE CONFIGUREE ET INJOIGNABLE EST UNE PANNE, PAS UNE EXCLUSION. Les
# deux cas etaient confondus dans une seule condition ; ils sont separes ici, et
# seule la variable VIDE - le seul geste par lequel quelqu un declare ne pas
# vouloir cette source - autorise a continuer sans elle.
if [ -z "$MICONNECT_PG_CONTAINER" ]; then
  log "Authentik exclu par configuration (MICONNECT_PG_CONTAINER vide)"
elif [ -n "$MICONNECT_SSH_HOST" ]; then
  log "Dump PostgreSQL Authentik via ${MICONNECT_SSH_HOST}…"
  # La cle de "canari" est installee la-bas avec une commande forcee vers
  # authentik-pg-dump (cf authentik-pg-dump.sh) : l argument ci-dessous est donc
  # ignore par le serveur, et il est ecrit quand meme parce qu il dit ce qui va
  # tourner a quelqu un qui lit ce fichier.
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$MICONNECT_SSH_HOST" authentik-pg-dump \
    > "$STAGE/authentik_db.sql.gz" \
    || fail "dump Authentik impossible via ${MICONNECT_SSH_HOST} (cle, reseau ou conteneur)"
else
  docker inspect "$MICONNECT_PG_CONTAINER" >/dev/null 2>&1 \
    || fail "conteneur Authentik ($MICONNECT_PG_CONTAINER) absent sur cette machine, et MICONNECT_SSH_HOST est vide"
  log "Dump PostgreSQL Authentik (conteneur local)…"
  docker exec "$MICONNECT_PG_CONTAINER" sh -c \
    'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
    | gzip > "$STAGE/authentik_db.sql.gz"
fi

# Un flux tronque produit un fichier qui a l air d un dump et ne se decompresse
# pas. C est exactement ce qu une restauration decouvre trop tard.
if [ -f "$STAGE/authentik_db.sql.gz" ]; then
  gzip -t "$STAGE/authentik_db.sql.gz" \
    || fail "dump Authentik illisible (flux tronque)"
fi

# ── 4. Manifeste + archive unique ─────────────────────────────────────────────
# LE MANIFESTE EST DERIVE DE CE QUI A ETE PRODUIT, JAMAIS ECRIT A L AVANCE.
# Il etait un texte constant qui annoncait trois membres : quand l un d eux a
# cesse d etre produit, l archive a continue de le promettre pendant 93 jours.
# Un manifeste qui peut mentir est pire qu un membre manquant, parce qu il est
# precisement ce qu on lit pour savoir si le membre est la - la meme lecon que
# le dump MongoDB de 116 octets ci-dessous, qui n avait pas suffi.
describe_member() {
  case "$1" in
    postgres_auth_db.sql.gz)
      printf 'Canari: users, channels, posts, forms, paiements, ET l historique MLS chiffre (queued_message, mls_*)' ;;
    media_meta.tar.gz)
      printf 'Canari: metadonnees media-service' ;;
    authentik_db.sql.gz)
      printf 'Authentik: identites, config OIDC' ;;
    *)
      printf 'membre non decrit - ajouter sa description a describe_member() dans backup.sh' ;;
  esac
}

MEMBERS=""
for member in "$STAGE"/*; do
  name="$(basename "$member")"
  MEMBERS="${MEMBERS}  - ${name}  ($(du -h "$member" | cut -f1), $(describe_member "$name"))
"
done

cat > "$STAGE/MANIFEST.txt" <<EOF
Canari backup
timestamp: $TIMESTAMP
created_by: $(whoami)@$(hostname)
git_commit: $(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo "n/a")
contenu (liste etablie a partir des fichiers reellement archives) :
${MEMBERS}
NOTE - MongoDB ne figure plus ici (2026-08-18) : le service a ete supprime de la
stack. Il ne contenait aucune base applicative et aucun service ne s y
connectait. Cette ligne du manifeste annoncait "blobs MLS chiffres / historique",
ce qui etait faux - cet historique est dans PostgreSQL, et l est toujours.

ATTENTION - les blobs medias (volumes Garage, ex-MinIO) NE SONT PLUS DANS CETTE ARCHIVE.
Ils sont sauvegardes par backup-objects.sh dans le depot restic
${BACKUP_DIR}/restic-objects (14j / 8 sem / 6 mois, miroir offsite au meme endroit).
Une restauration complete = cette archive + restore.sh pour les objets.
EOF

log "Creation de l archive finale…"
tar czf "$ARCHIVE_PATH" -C "$STAGE" .
ARCHIVE_SIZE="$(du -h "$ARCHIVE_PATH" | cut -f1)"
log "Archive locale ecrite ($ARCHIVE_SIZE)"

# ── 5. Retention locale ───────────────────────────────────────────────────────
log "Purge des sauvegardes locales > ${BACKUP_RETENTION_DAYS} jours…"
find "$BACKUP_DIR" -maxdepth 1 -name 'canari-backup-*.tar.gz' -type f \
  -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete || true

# ── 6. Copie offsite via SSH/rsync (serveur LAN mitv) ─────────────────────────
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
