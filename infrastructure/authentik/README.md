# Authentik (stack `miconnect`)

Fournisseur d identite OIDC de Canari.

## Ou elle tourne, et par quoi elle est deployee : PAR RIEN

**Cette stack a rejoint l hote mutualise le 2026-09-24** : elle tourne dans
`/srv/miconnect/` sur `193.49.175.67`, publiee sur `127.0.0.1:9000`, et le nginx
de l hote termine TLS devant elle. Elle a eu sa propre VM du 2026-06-22 au
2026-09-24 (`10.0.0.7`), et **aucun pipeline ne la deploie**, avant comme apres.

> **L ancienne VM n est pas vide, et ce n est pas un oubli.** Son PostgreSQL y
> tourne encore avec une copie FIGEE de la base, comme retour arriere ; seuls
> `server` et `worker` sont arretes. Elle porte aussi le RELAIS qui fait suivre
> `9000` vers l hote cible, parce que le tunnel Cloudflare y pointe toujours -
> c est ce qui rend la bascule, et son retour, locaux a cette machine.
> **Consequence a ne pas rater : une sauvegarde qui viserait encore `10.0.0.7`
> reussirait en copiant une base morte.**

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

| | Ce dossier | L ancienne VM | L hote cible, depuis le 2026-09-24 |
| --- | --- | --- | --- |
| Image | `ghcr.io/goauthentik/server` | `docker.io/authentik/server` | `ghcr.io/...` - **ce fichier** |
| Version | `2026.8.0` (alignee le 2026-09-24) | `2026.8.0` | `2026.8.0` |
| Volume | `database` (nomme `miconnect_database` par le projet) | `miconnect_database`, `external: true` | `database`, cree par ce fichier |

**La derive est fermee : c est ce `compose.yml` qui tourne maintenant**, au `.env`
pres. Les deux images ne se ressemblent pas, elles sont la MEME - `RepoDigests`
identiques (`sha256:7421753c...`), verifie le 2026-09-24 apres une fausse alerte
ou c est le digest de CONFIG local, propre a chaque machine, qui avait ete compare.

**La version etait `2026.2.2` ici, et c est le piege que cette ligne ferme** :
les migrations Django d Authentik ne se rejouent pas a l envers, donc quelqu un
qui aurait relance ce fichier tel quel contre le volume existant aurait tente de
faire reculer le schema de six versions. Une reference qui ne peut pas etre
lancee est inutile ; une reference qui peut etre lancee et casse la base est
pire.

## Deux choses retirees le 2026-09-24, avant le demenagement

**Le socket Docker n est plus monte dans le worker.** Authentik ne s en sert que
pour piloter des outposts en CONTENEURS, via une connexion de service Docker. Le
seul outpost declare ici est l **Embedded Outpost**, qui tourne dans le conteneur
serveur et n a besoin d aucun socket ; la connexion de service existe bien en base
et **aucun outpost ne la reference** - verifie AVANT la suppression, pas apres :

```sh
docker exec miconnect-postgresql-1 psql -U authentik -d authentik   -c 'SELECT name, type, managed, service_connection_id FROM authentik_outposts_outpost;'
```

Ce que le montage coutait : sur une machine partagee avec d autres locataires,
c est un controle equivalent-root sur TOUT le demon Docker, le leur compris. Il
reste une connexion de service qui pointe vers un socket absent - elle
n orchestre rien et s affichera en erreur dans l admin.

**Le port `9443` n est plus publie, et il n avait aucun consommateur.** L ingress
du tunnel atteint `http://10.0.0.7:9000`, en clair - lu sur le
connecteur lui-meme (`curl http://127.0.0.1:20241/config` sur la boite qui le
fait tourner, l API Cloudflare ne voyant pas les tunnels). Sur l hote partage,
TLS est termine par le nginx de l hote avec le certificat DSI, comme pour les
autres estates.

`AUTHENTIK_PUBLISH` remplace `COMPOSE_PORT_HTTP` et `COMPOSE_PORT_HTTPS` : elle
porte l ADRESSE entiere, pas seulement le port, pour qu un demenagement la lie a
`127.0.0.1:9000` sans toucher au `compose.yml`.

**Les deux registres servent la MEME image**, verifie par digest de manifeste et
non par le champ `Id`, qui est le digest de configuration local et differe d une
machine a l autre : `sha256:7421753c...` des deux cotes pour `2026.8.0`.

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
l archive nocturne). **Elle ne l a pas ete pendant 94 nuits**, du 2026-06-23 au
2026-09-24 : la sauvegarde cherchait le conteneur sur la machine applicative,
d ou il venait de partir. **Le correctif a ete ecrit le 2026-09-23 et n a rien
change la nuit suivante** - il est reste dans le depot, le checkout de production
etant a `0.18.22`. La premiere archive a contenir Authentik date du 2026-09-24.
Pourquoi, et pourquoi la boite applicative n a la-bas qu une cle en lecture, est
dans [../backup/README.md](../backup/README.md).

Les dossiers `data/`, `certs/`, `custom-templates/` portent UN fichier a eux trois
(le fond par defaut, 16 K / 4 K / 4 K le 2026-09-24) : rien a migrer au-dela de la
base. Ils ont quand meme ete transportes, et le fond est bien servi depuis l hote
cible - ce qui est la seule preuve qu ils l ont ete.

## Reconstruire la stack sur une autre machine

1. Copier ce `compose.yml` et ecrire le `.env` (les deux secrets ci-dessus,
   `AUTHENTIK_VERSION`).
2. `docker compose up -d` depuis un dossier nomme `miconnect` - **le nom du
   projet determine le nom du volume**, donc un dossier nomme autrement
   demarrerait sur une base VIDE au lieu d echouer.
3. Restaurer : `./infrastructure/backup/restore.sh --latest-from-mitv --yes`,
   qui s arrete et donne la commande a jouer sur la boite Authentik.
