# Authentik (stack `miconnect`)

Fournisseur d identite OIDC de Canari.

## Ou elle tourne, et par quoi elle est deployee : PAR RIEN

**Cette stack a sa propre VM depuis le 2026-06-22** (`10.0.0.7`, `ssh miconnect`),
dans `/home/miconnect/miconnect/`, et **aucun pipeline ne la deploie**.

Ce fichier annoncait le contraire jusqu au 2026-09-24 : il decrivait un job
`deploy-to-server` de `.github/workflows/deploy.yml` qui copiait le `compose.yml`
ci-contre vers `/home/canari/miconnect/` et generait son `.env`. **Ni ce
workflow ni ce job n existent** - les workflows visibles sont `ci`, `release`,
`arm-auto-merge` et `scheduled`, et une recherche de `infrastructure/authentik`
dans `.github/` ne renvoie rien (mesure le 2026-09-24). Les seuls secrets
`AUTHENTIK_*` que la CD manipule encore sont ceux du CLIENT OIDC, poses dans le
`.env` de l application : `AUTHENTIK_BASE_URL`, `AUTHENTIK_CLIENT_ID`,
`AUTHENTIK_CLIENT_SECRET`. Rien qui construise le fournisseur.

**Le `compose.yml` de ce dossier est donc une REFERENCE DE RECONSTRUCTION, pas
un artefact deploye**, et il a derive de celui qui tourne :

| | Ce dossier | La boite |
| --- | --- | --- |
| Image | `ghcr.io/goauthentik/server` | `docker.io/authentik/server` |
| Version | `2026.8.0` (alignee le 2026-09-24) | `2026.8.0` |
| Volume | `database` (nomme `miconnect_database` par le projet) | `miconnect_database`, `external: true` |

**La version etait `2026.2.2` ici, et c est le piege que cette ligne ferme** :
les migrations Django d Authentik ne se rejouent pas a l envers, donc quelqu un
qui aurait relance ce fichier tel quel contre le volume existant aurait tente de
faire reculer le schema de six versions. Une reference qui ne peut pas etre
lancee est inutile ; une reference qui peut etre lancee et casse la base est
pire.

## Secrets

| Variable | Role |
| --- | --- |
| `PG_PASS` | mot de passe PostgreSQL Authentik |
| `AUTHENTIK_SECRET_KEY` | cle secrete Authentik |

Elles vivent dans le `.env` de la boite, a cote du `compose.yml`.

## Donnees et sauvegarde

La base PostgreSQL (volume `miconnect_database`) contient toute la configuration
- providers, applications, utilisateurs, OIDC - et **elle est le seul endroit ou
elle existe**. La perdre, c est un estate applicatif intact dont plus personne ne
peut ouvrir de session.

Elle est sauvegardee par [../backup/](../backup/) (`authentik_db.sql.gz` dans
l archive nocturne). **Elle ne l a pas ete pendant 93 nuits**, du 2026-06-23 au
2026-09-23 : la sauvegarde cherchait le conteneur sur la machine applicative,
d ou il venait de partir. Ce qui a ete corrige, et pourquoi la boite applicative
n a la-bas qu une cle en lecture, est dans [../backup/README.md](../backup/README.md).

Les dossiers `data/`, `certs/`, `custom-templates/` sont des montages locaux
vides (16 K, 4 K, 4 K le 2026-09-24) : rien a migrer au-dela de la base.

## Reconstruire la stack sur une autre machine

1. Copier ce `compose.yml` et ecrire le `.env` (les deux secrets ci-dessus,
   `AUTHENTIK_VERSION`).
2. `docker compose up -d` depuis un dossier nomme `miconnect` - **le nom du
   projet determine le nom du volume**, donc un dossier nomme autrement
   demarrerait sur une base VIDE au lieu d echouer.
3. Restaurer : `./infrastructure/backup/restore.sh --latest-from-mitv --yes`,
   qui s arrete et donne la commande a jouer sur la boite Authentik.
