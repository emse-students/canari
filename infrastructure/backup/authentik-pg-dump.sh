#!/usr/bin/env bash
#
# Dump PostgreSQL d Authentik, sur stdout, compresse.
#
# S EXECUTE SUR LA BOITE AUTHENTIK, PAS SUR CELLE DE CANARI. Depuis le
# 2026-06-22 la stack "miconnect" ne vit plus a cote de la stack applicative :
# elle a sa propre VM. backup.sh l atteint donc par SSH, et ce fichier est le
# SEUL programme que la cle de sauvegarde a le droit de lancer la-bas.
#
# C EST LA RAISON D ETRE DU SCRIPT. Le compte qui possede la stack Authentik est
# membre des groupes "sudo" et "docker", donc equivalent root sur cette machine :
# autoriser la cle de "canari" sur ce compte sans rien d autre donnerait a la
# boite applicative les pleins pouvoirs sur le fournisseur d identite. La cle est
# donc installee avec une commande forcee qui pointe ici, et "restrict" :
#
#   command="/home/miconnect/bin/authentik-pg-dump",restrict ssh-ed25519 AAAA… canari@canari
#
# La liste de ce que la cle peut faire vaut alors exactement une ligne, et c est
# celle-ci - une liste blanche, pas une interdiction. Ce que SSH aurait
# transporte d autre (pty, agent, port forwarding, X11) est refuse par
# "restrict", et l argument de la ligne de commande du client est ignore.
#
# Installation (cf ../README.md) :
#   install -m 0755 authentik-pg-dump.sh ~/bin/authentik-pg-dump
#
set -euo pipefail

CONTAINER="${MICONNECT_PG_CONTAINER:-miconnect-postgresql-1}"

# Un conteneur absent est une panne, jamais un dump vide : sans cette sortie, la
# sauvegarde d en face recevrait zero octet valide en gzip et l archiverait.
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  printf 'authentik-pg-dump: conteneur %s introuvable sur %s\n' "$CONTAINER" "$(hostname)" >&2
  exit 1
fi

# POSTGRES_USER et POSTGRES_DB sont lus DANS le conteneur : ils y sont poses par
# le compose, et les redeclarer ici ferait une deuxieme source de verite.
docker exec "$CONTAINER" sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  | gzip
