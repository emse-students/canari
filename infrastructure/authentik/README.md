# Authentik (stack `miconnect`)

Fournisseur d identite OIDC de Canari.

## Ou elle tourne, et par quoi elle est deployee : la stack a la main, sa configuration par la release

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

## La configuration est dans `blueprints/`, et c est la release qui l applique

Depuis le 2026-09-30, tout ce qui avait ete construit a la main dans l admin
(flows, stages, prompts, policies, mappings, sources, providers, applications,
la brand et sa CSS) est decrit par les sept blueprints de `blueprints/`, numerotes
dans l ordre de leurs dependances. **Une modification faite dans l admin est
ecrasee a la release stable suivante** : elle se fait dans ces fichiers, par une
pull request.

`apply-blueprints.sh` les applique depuis la machine ou tourne le conteneur. Les
blueprints voyagent sur stdin avec `apply-blueprints.py`, donc rien n est monte ni
copie dans `/srv/miconnect` :

```sh
bash apply-blueprints.sh dry-run    # applique dans une transaction, affiche le diff, annule
bash apply-blueprints.sh apply      # la meme chose, et valide
bash apply-blueprints.sh snapshot   # l etat normalise de chaque objet nomme, sans rien changer
# depuis un poste de travail :
AK_REMOTE="ssh portail-etu-direct" bash apply-blueprints.sh dry-run
```

Le profil des comptes (WP1, `docs/wiki/profiles-and-access.md`) s ecrit avec
`migrate-profile.sh dry-run|apply`, meme transport (`ak-shell.sh`). Il n ecrit un profil
que la ou il n y en a pas, donc on peut le relancer sans risque ; verifier le dump
`authentik_db` du jour avant `apply`.

| Qui | Quoi |
| --- | --- |
| la CI (`test-miconnect-blueprints`) | `test-blueprints.sh` : un Authentik VIERGE demarre avec ce `compose.yml`, les blueprints y sont appliques deux fois, et la seconde doit dire `0 change(s)` |
| un pre-release (`serve-dev.yml`) | `dry-run` contre la prod : le diff que la stable appliquera, rien d ecrit (le dev se connecte au MiConnect de prod) |
| une release stable (`serve-prod.yml`) | `apply`, en une transaction : un echec laisse MiConnect intact et fait echouer le job |

**Ce qui n y est PAS, volontairement** : les utilisateurs et les groupes (la
population, pas la configuration), les secrets clients des providers (un champ
qu un blueprint ne nomme pas n est pas touche, donc ils ne quittent jamais la base
et n entrent jamais dans ce depot public), le certificat de signature (cree au
demarrage), et les objets par defaut d Authentik. La sauvegarde de la base reste
ce qui les restaure. Le pourquoi de chaque choix, et les pieges d Authentik
trouves en l ecrivant, sont dans le [wiki](../../docs/wiki/infrastructure/authentik.md#the-configuration-is-code-infrastructureauthentikblueprints-2026-09-30).

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
| `MIGALLERY_AVATAR_SIGNING_KEY` | signe l URL d avatar du mapping `avatar` - la meme valeur que le secret `AVATAR_SIGNING_KEY` de MiGallery |
| `MICONNECT_CAS_CONSUMER_SECRET` | secret du client OIDC `miconnect` cree par la DSI sur le CAS, lu par `blueprints/30-sources.yaml` |

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
2. `docker compose up -d`, depuis n importe quel dossier - **`name: miconnect` est
   DECLARE dans le `compose.yml` depuis le 2026-09-24**, donc le volume s appelle
   `miconnect_database` quel que soit le chemin. Cette ligne manquait : le nom
   etait deduit du DOSSIER, et un dossier nomme autrement aurait demarre sur une
   base VIDE au lieu d echouer. Il n a tenu pendant le demenagement que parce que
   les deux chemins successifs finissaient par `miconnect`, par chance.
3. Restaurer : `./infrastructure/backup/restore.sh --latest-from-mitv --yes`,
   qui s arrete et donne la commande a jouer sur la boite Authentik.
4. `bash apply-blueprints.sh dry-run`, puis `apply` : la base restauree et ce
   depot doivent dire la meme chose, et le diff montre ce qui a change depuis la
   sauvegarde. Sans sauvegarde, `apply` reconstruit toute la configuration sur une
   instance vierge. Il faut alors redonner a chaque application le nouveau secret
   de son provider, parce que ces secrets ne sont pas dans les blueprints.
