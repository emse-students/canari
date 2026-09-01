# Workflow de developpement Canari

> Pour le mainteneur du projet. Ce qu'il faut faire soi-meme, ce que la machine fait toute seule, et
> dans quel ordre.

Ce guide est la seule copie de la marche a suivre. Les mecanismes sont documentes ailleurs et les
liens y renvoient : [`docs/wiki/cicd.md`](../wiki/cicd.md) pour la chaine complete,
[`docs/wiki/infrastructure/dev-environment.md`](../wiki/infrastructure/dev-environment.md) pour la
seconde estate, [`infrastructure/MIGRATION.md`](../../infrastructure/MIGRATION.md) pour les secrets.

---

## 1. Ce qu'il reste a faire, et personne d'autre ne peut le faire

L'environnement `dev.canari-emse.fr` est entierement construit et teste. Il ne sert rien parce qu'un
interrupteur est absent. Trois choses, dans cet ordre.

### 1.1 La regle d'ingress du tunnel

Dans le dashboard Cloudflare : **Account -> Cloudflare Tunnel**, le tunnel qui sert deja
`canari-emse.fr`. Ajouter une regle :

| | |
|---|---|
| Hostname | `dev.canari-emse.fr` |
| Service | `http://localhost:3080` |

Le DNS resout deja. Aujourd'hui le nom est un CNAME proxifie vers le tunnel de la production :
**quiconque se fait dire "va sur dev" tape en realite dans la production.** C'est la seule chose qui
rend cette regle urgente independamment du reste.

### 1.2 Les secrets `DEV_*`

Dans **Settings -> Secrets and variables -> Actions -> Secrets**.

La liste exacte n'est pas recopiee ici, parce qu'une liste recopiee devient fausse. Elle **est**
[`infrastructure/deploy/env-manifest.tsv`](../../infrastructure/deploy/env-manifest.tsv) : chaque
ligne dont la colonne `DEV` n'est pas `skip`, prefixee `DEV_`. La commande qui l'imprime :

```bash
awk -F'\t' '!/^#/ && NF==5 && $3!="skip" && $4 ~ /^secret:/ \
  { n=$4; sub(/^secret:/,"",n); printf "%-34s %s\n", "DEV_" n, $3 }' \
  infrastructure/deploy/env-manifest.tsv
```

23 lignes en tout :

- **14 `required`** : sans elles le deploiement dev refuse de partir, avant de toucher un conteneur.
  C'est voulu - un environnement incomplet qui demarre est pire qu'un deploiement rate.
- **8 `warn`** : le deploiement passe et affiche un avertissement nommant ce qui ne marche pas. On
  peut les ajouter plus tard.
- **1 `silent`** (`DEV_SERVICE_ACCOUNT_USER_ID`) : la valeur par defaut de `.env.example` est la bonne,
  donc son absence ne merite meme pas un avertissement.

Trois regles qui comptent :

1. **Ne jamais recopier la valeur de production.** Surtout pas `DEV_JWT_SECRET` : un secret de
   signature partage rend un jeton emis par un environnement valide dans l'autre, et toute
   l'isolation disparait. Meme chose pour les cles Garage et le client Authentik. Generer :
   `openssl rand -hex 32`.
2. **Ne PAS creer les lignes `skip`.** Stripe, Lydia, `CERCLE_API_KEY` et les trois valeurs APNs sont
   volontairement absentes de dev. C'est ce qui garantit qu'une copie de la base de production ne peut
   pas debiter une vraie carte, repondre au Cercle comme si elle etait la production, ni faire sonner
   le telephone d'un vrai membre.
3. **`DEV_BASE_URL` = `https://dev.canari-emse.fr`.** C'est de la que sortent toutes les origines
   d'API du bundle dev, et il n'y a aucun repli vers celle de la production - un repli construirait
   une image dev qui parle a la production.

Le client OIDC Authentik de dev, je peux le creer moi-meme sur la machine
(`docker exec miconnect-server-1 ak shell -c ...`) : demande-le et je le fais, il faut juste que
`DEV_AUTHENTIK_CLIENT_ID` / `DEV_AUTHENTIK_CLIENT_SECRET` en sortent.

### 1.3 L'interrupteur

Dans **Settings -> Secrets and variables -> Actions -> Variables** (l'onglet *Variables*, pas
*Secrets*) :

```
DEV_ENVIRONMENT_ENABLED = true
```

C'est une *variable* et non un *secret* pour que sa valeur apparaisse dans le journal des runs : un
interrupteur silencieux est un interrupteur que personne ne peut debuguer.

Ensuite, **lancer CD a la main une premiere fois** (Actions -> *CD - Deploy to Production* -> Run
workflow). Le declenchement manuel construit le frontend dev inconditionnellement, ce qui est le
demarrage a froid : le detecteur de changements repond "le frontend a-t-il change depuis le dernier
deploiement", question sans reponse utile la premiere fois, ou aucune image `frontend:dev` n'existe.

**Ce que ca fait la premiere fois :** clone `/home/canari/canari-dev`, rend le `.env` dev, tire les
images, monte l'estate, joue les migrations sur une base **vide**, puis verifie que le site repond.
La base ne sera peuplee qu'a la premiere copie (section 4.3).

### 1.4 Facultatif, et non bloquant

| | ce que ca achete |
|---|---|
| Un projet Firebase dev | les notifications push sur dev. Sans lui, avertissement au deploiement, rien de casse |
| Un service token Cloudflare Access | le banc de test automatise peut piloter dev. Necessite `Account -> Cloudflare Tunnel` plus les deux permissions Access au niveau du compte |
| Un keystore Android dev | le mobile sur dev, qui est explicitement une phase 2 |

---

## 2. Ou pousser

**Sur `main`, directement.** Pas de branche de fonctionnalite, pas de branche `dev` (elle n'existe
pas et rien ne l'ecoute). C'est une regle du projet, et l'environnement dev ne la change pas : dev
deploie depuis `main` comme la production.

Un `git push` sur `main` declenche, dans cet ordre :

```
push main
  |
  +-- CI (tests, lint, types)  +  CodeQL
  +-- detection des services modifies
  +-- build des images modifiees -> GHCR
  |
  +-- deploy-dev          <-- dev deploie D'ABORD
  |
  +-- deploy-to-server    <-- la production, seulement si dev n'a pas echoue
```

**Dev passe avant la production, et un deploiement dev en echec bloque celui de la production.**
C'est tout l'interet d'un second environnement : une migration qui va casser la production casse dev
d'abord, sur une copie des donnees de la production, pendant que la production sert encore.

**Le garde-fou :** si dev est casse pour une raison qui lui est propre (un `DEV_*` mal regle, son
client Authentik revoque), il retiendrait les livraisons de la production en otage. Mettre
`DEV_ENVIRONMENT_ENABLED` a autre chose que `true` saute dev et debloque la production
immediatement.

**Une regle qui ne change pas :** un run de la campagne de tests et un push sur `main` sont
**mutuellement exclusifs**. Un deploiement en cours de run a deja invalide trois mesures.

---

## 3. Ce qui se compile, par quoi, et ce que ca ne prouve pas

Rien a compiler a la main pour deployer. Ce qui suit sert a savoir quoi verifier avant de pousser.

### Avant chaque commit, en local

```bash
cd frontend && bun run check && bun run lint && bun run format
```

Le hook de pre-commit balaye tout le frontend (2-3 min) et re-stage le resultat. Ne jamais le
contourner : si un hook echoue, la cause se corrige.

Pour la chaine complete en local : `make run-ci`. Pour les tests : `make test`.

### Ce que le pipeline construit tout seul

| quoi | quand |
|---|---|
| Les 4 services NestJS, les 2 services Rust, les 2 images frontend | a chaque push touchant leurs sources |
| Le WASM MLS et les bindings protobuf | a chaque build frontend - **jamais commites**, chaque pipeline les regenere |
| `frontend:dev` et `frontend-ssr:dev` | quand le frontend change, ou sur declenchement manuel |
| Les images backend de dev | **aucune** : dev partage celles de la production |

**Pourquoi dev partage les images backend.** Une image backend lit toute sa configuration dans
`.env` au demarrage. Dev fait donc tourner les memes binaires que la production, et c'est
deliberement une fonctionnalite : une difference de comportement entre les deux estates ne peut
jamais s'expliquer par un build different, ce qui est la seule chose qui rend un environnement de
test utile. Le frontend est l'exception parce que SvelteKit inline `import.meta.env.*` a la
compilation - les origines d'API, le client Authentik et la banniere "environnement de test" sont
cuits dans le bundle.

### Ce qu'un build vert ne prouve pas

Tout ce qui est natif est verifie **en compilant**, ce qui ne dit rien sur l'execution. Et un
deploiement vert prouve que les conteneurs ont demarre, jamais que le site repond. C'est pourquoi le
deploiement dev interroge `/api/version` : tous les autres controles passent avec la base de donnees
par terre - nginx repond `/`, et les deux routes de liveness sont anonymes expres. Le frontend a
repondu 200 pendant les 33 minutes de panne du 2026-09-01.

---

## 4. Le quotidien, une fois dev allume

### 4.1 Verifier ou en est chaque estate

```bash
curl -s https://canari-emse.fr/api/version      # prod : build = null
curl -s https://dev.canari-emse.fr/api/version  # dev  : build = dev.<sha7>
```

Le champ `build` est ce qui distingue deux deploiements dev d'une meme version. Il est
**volontairement absent en production** : le champ `version` est transforme par les clients en tag de
release puis en URL de telechargement, donc un suffixe dedans produit un 404.

Sur la machine, savoir dans quelle estate on est - **c'est le nom du conteneur qui le dit, et rien
d'autre** :

```bash
docker ps --filter label=com.docker.compose.project=infrastructure   # production
docker ps --filter label=com.docker.compose.project=canari-dev       # dev
```

### 4.2 Reconnaitre dev a l'ecran

Une banniere permanente et non fermable, en haut de chaque page. Elle est necessaire : dev porte une
copie complete de la base de production, donc les memes membres, les memes associations, les memes
publications. Sans banniere, rien ne distingue les deux.

### 4.3 Rafraichir les donnees de dev

Automatique : **tous les lundis a 04:00 UTC**. A la demande : Actions -> *Refresh
dev.canari-emse.fr from production* -> Run workflow. La case `dry_run` dit ce qui se passerait sans
rien changer.

**C'est destructif pour dev, et pour rien d'autre.** Tout ce qui a ete tape dans dev depuis le
dernier rafraichissement disparait. La copie retire les jetons push et les identifiants client
Stripe avant la restauration.

### 4.4 Les mises a jour de dependances

Dependabot ouvre les PR, et elles se fusionnent toutes seules quand les tests le permettent. Un refus
n'est **jamais** un renvoi vers une revue humaine : c'est l'affirmation qu'un test manque, et le
message nomme le test qui leverait le blocage. Le detail est sur
[`docs/wiki/cicd.md`](../wiki/cicd.md).

Deux choses sont volontairement retenues : PostgreSQL reste en 15 (le passage a 18 demande une
migration que personne n'a faite - c'est ce qui a cause la panne du 2026-09-01), et les majeures qui
touchent aux datastores attendent le test nomme dans leur refus.

---

## 5. Publier une release

**Une seule action manuelle : creer la release sur GitHub.** Tout le reste s'enchaine.

1. Sur GitHub : **Releases -> Draft a new release**, tag `vX.Y.Z` (le `v` compte), cible `main`,
   publier.
2. `bump-version.yml` incremente les versions dans `package.json`, `Cargo.toml`, la config Tauri et
   le projet iOS, puis pousse sur `main`.
3. A la fin de ce bump, quatre workflows partent en parallele :

| workflow | resultat |
|---|---|
| `cd.yml` en mode rebuild-only | reconstruit `core-service` et le frontend (pour que `/api/version` et la SPA correspondent au tag), puis redeploie |
| `android-release.yml` | `.aab` signe, attache a la release **et publie sur Google Play, piste production, deploiement complet** |
| `ios-release.yml` | `.ipa`, envoye sur TestFlight via `altool` |
| `appimage-release.yml` | `.AppImage`, attache a la release |

**Ce qui reste manuel apres coup :**

- **App Store Connect** : la soumission elle-meme. TestFlight recoit le build automatiquement, mais
  passer en revue App Store est un acte humain. Ou en est chaque moitie est sur
  [`docs/wiki/frontend/mobile.md`](../wiki/frontend/mobile.md).
- **Le tout premier passage sur Google Play** devait etre cree a la main dans la console (fiche,
  classification de contenu). C'est fait ; les suivants sont automatiques.
- **Verifier que Play a bien pris le build** est une mesure, pas une deduction :
  `node tools/play-vitals/vitals.mjs`.

**Quand publier ?** Il n'y a pas de cadence imposee. Ce qui compte : une release entraine une
publication publique sur Google Play en deploiement complet, donc elle se fait quand la production
tourne depuis assez longtemps pour qu'on la croie, pas juste apres un push. Un `gh run list` vert et
`/api/version` qui repond sont le minimum avant de creer le tag.

---

## 6. Quand ca casse

**Rien ne previent encore que la production est tombee.** Les deux pannes du 2026-09-01 ont ete
signalees par l'utilisateur ; un run CD rouge ne reveille personne, et le frontend a repondu 200 tout
du long. C'est un element ouvert du backlog, et il attend une decision puis un clic.

En attendant, la verification qui tranche :

```bash
curl -s https://canari-emse.fr/api/version   # doit repondre 200 - ca lit la base de donnees
gh run list --limit 5                        # le pipeline est-il vert et silencieux
```

Sur la machine :

```bash
ssh canari
docker compose -f canari/infrastructure/docker-compose.prod.yml ps
```

> Depuis un poste Windows, utiliser **PowerShell** pour les commandes `ssh`, jamais Git Bash : ce
> dernier mange les antislashs de la ProxyCommand cloudflared.

---

## En resume, les trois choses a faire maintenant

1. La regle d'ingress du tunnel : `dev.canari-emse.fr` -> `http://localhost:3080`.
2. Les secrets `DEV_*` (14 obligatoires ; la liste est le manifeste, pas ce fichier).
3. `DEV_ENVIRONMENT_ENABLED = true` dans les *Variables*, puis un run CD manuel.

Tant que le point 3 n'est pas fait, tous les jobs dev sont sautes et CD se comporte exactement comme
avant. Rien de ce qui a ete ajoute ne peut affecter la production.
