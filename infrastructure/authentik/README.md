# Authentik (stack `miconnect`)

Fournisseur d identite OIDC de Canari. Stack Docker Compose distincte de la
stack applicative, deployee par la meme CD pour qu un nouveau serveur soit
operationnel en un seul pipeline.

## Deploiement

La CD (`.github/workflows/cd.yml`, job `deploy-to-server`) :

1. cree `/home/canari/miconnect/{data,certs,custom-templates}` si absents ;
2. copie `infrastructure/authentik/compose.yml` vers `/home/canari/miconnect/compose.yml` (source de verite versionnee) ;
3. genere `/home/canari/miconnect/.env` depuis les secrets GitHub ;
4. lance `docker compose up -d` depuis ce dossier (nom de projet `miconnect`).

`up -d` est idempotent : sans changement de config, Authentik n est pas recree.

## Secrets GitHub requis

| Secret | Role |
| --- | --- |
| `MICONNECT_PG_PASS` | mot de passe PostgreSQL Authentik |
| `MICONNECT_AUTHENTIK_SECRET_KEY` | cle secrete Authentik |

## Donnees et sauvegarde

La base PostgreSQL (volume `miconnect_database`) contient toute la config
(providers, applications, utilisateurs, OIDC). Elle est sauvegardee par
[../backup/](../backup/) (`authentik_db.sql.gz`). Les dossiers `data/`, `certs/`,
`custom-templates/` sont des montages locaux actuellement vides (rien a migrer
au-dela de la base).

## Migration vers un nouveau serveur

1. Lancer la CD (cree la stack, base vide).
2. Restaurer : `./infrastructure/backup/restore.sh --latest-from-mitv --yes`
   (restaure aussi `authentik_db`).
