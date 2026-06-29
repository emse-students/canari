# Plan de normalisation Canari (i18n + wiki + commentaires + nettoyage docs)

> Document de suivi du chantier lance le 2026-06-23. Source de verite pour le plan,
> l'avancement, et la methode. A amender au fur et a mesure. Ne jamais perdre ce fichier.
>
> **Pour l'executant (Sonnet)** : la section "LISTE DE TACHES" est concue pour etre suivie
> ligne par ligne, sans avoir a reflechir. Respecter l'ordre. Cocher au fur et a mesure.
> Apres CHAQUE fichier de code touche, verifier si un test lui est associe et le mettre a jour
> (sinon CI rouge). Commit + push apres chaque sous-section.

---

## Objectif global

Passer **tout le projet** (frontend + backends NestJS/Rust + infrastructure) au peigne fin,
fichier par fichier, en menant simultanement quatre chantiers :

1. **i18n FR/EN** (frontend, Paraglide) - rendre toute l'UI bilingue.
2. **Wiki technique anglais** (`docs/wiki/`) - documenter tout le projet, par feature/module.
3. **Commentaires + dev strings en anglais** (tous fichiers).
4. **Nettoyage des `.md`** - consolider l'ancienne doc dans le wiki, supprimer le mort.

En parallele : corriger/supprimer imprecisions et code mort en passant ; noter ce qui servira
plus tard a la **doc utilisateur en francais** (utilisateurs, responsables associatifs).

---

## METHODE (regles a respecter imperativement)

### i18n / cles Paraglide
- Cles dans `frontend/messages/fr.json` (source) + `frontend/messages/en.json` (trad).
- Import `import { m } from '$lib/paraglide/messages'`. Usage `{m.key()}` ou `m.key({ param })`.
- **Avant toute nouvelle cle** : grep `fr.json` pour eviter les doublons. Reutiliser une cle
  identique mot pour mot. Reutiliser les `common_*` existantes.
- Glossaire EMSE : **"Association" -> "Club"** en anglais.
- **Ne PAS traduire les valeurs stockees en BDD** (roles 'Membre'/'Admin', `submitLabel` de form) :
  seuls les libelles d'affichage UI sont traduits.
- Pas de balise `<a>` en parametre Paraglide : couper en cles prefixe/suffixe.

### Svelte 5
- Tout `Record`/tableau dependant de `m.*()` dans un `<script>` : `$derived({...})` / `$derived([...])`
  pour rester reactif au changement de langue sans remount.
- Variable locale nommee `m` : la renommer (`mo`, `mb`, ...) pour eviter la collision avec `import { m }`.

### Dates/heures
- `import { getLocale } from '$lib/paraglide/runtime'` puis `getLocale() === 'en' ? 'en-US' : 'fr-FR'`.

### Typographie (cf. CLAUDE.md)
- ASCII droit partout : `'` (jamais `'`), `"` (jamais `" "` ni `« »`), `-` (jamais `—`/`–`).
  Echapper `\'` / `\"`. **Exception** : l'ellipse `…` est gardee partout.
- Corriger en chemin les fautes FR (espaces avant ponctuation, accents manquants).

### Commentaires / dev strings
- Tous en **anglais**. JSDoc/doc-comment sur chaque export. Voir CLAUDE.md (section qualite).

### Wiki
- **Anglais**, par feature/module (pas par fichier). Precise, exhaustive, **concise**.
- Calquer le style des pages deja faites : `docs/wiki/architecture.md`, `docs/wiki/services/chat-gateway.md`
  (intro role, tables routes/env, sections responsabilites). Tables Markdown privilegiees.

### Outil Edit/Write
- Exige un **Read recent du fichier dans la session courante** (un Read d'avant compaction ne compte pas).
  Refaire un Read juste avant si erreur "File has not been read yet".

### Verification & commits (NON NEGOCIABLE)
- **Changer un fichier de code = verifier/mettre a jour son test associe** (assertions sur logs
  traduits, cles renommees, etc.), sinon CI rouge.
- Frontend : `cd frontend && bun run check` -> **0 erreur, 0 warning**, puis `bun run test` (Vitest).
- NestJS : `npm test` dans le service touche. Rust : `cargo test` + `cargo clippy`.
- **Avant push** : `rm -rf apps/*/dist` (sinon le hook pre-push rejoue les specs compilees).
- Le hook pre-commit lance `eslint --fix` + `prettier` et re-stage tout le frontend dirty : normal.
- Commit + push **apres chaque sous-section**. Toujours sur `main`. Pull avant de commencer.
- **Surveiller les commits externes entre sessions** : verifier qu'ils suivent le standard.

---

## AVANCEMENT

### Chantier 1 - i18n (frontend) : TERMINE
Batches 1 a 10 livres : navigation/profil/chat/messages, posts, admin/moderation, associations (5a-5d),
forms (5e), pages legales (6), modules .ts (7), error/auth/profile/purchases (8a), shop/calendar/events
(8b), associations/directory/dashboard (8c), layout/notifications/lists/invites (8d), shared (8e),
MainChatPage/composer/bubble (9a), dev strings & commentaires chat (9b/9c), consolidation des cles (9b
followup), balayage final 40+ composants + parite cles + nettoyage cles mortes (batch 10/I1-I4).
**Resultat** : 0 chaine FR visible codee en dur dans les templates Svelte ; parite FR/EN parfaite ;
`bun run check` 0 erreur/warning ; 427 tests verts.

### Chantier 2 - Wiki technique : DEMARRE (gros reste)
Faits : `docs/wiki/index.md`, `docs/wiki/architecture.md`, `docs/wiki/services/chat-gateway.md`.
**Reste** : toutes les autres pages listees dans `index.md` (voir taches W1-W6).

### Chantier 3 - Commentaires anglais : TERMINE
Applique au fil des fichiers frontend touches (passes 9b/9c dediees au chat). C1-C4 termines : balayage
systematique des backends NestJS (core-service, social-service, media-service, chat-delivery-service)
et Rust (chat-gateway, mls-core, mls-wasm). Commit e2ef9e8c (C4).

### Chantier 4 - Nettoyage docs : TERMINE
D1-D3 livres : ARCHITECTURE.md, CHAT_GATEWAY.md, MLS_REWRITE_PLAN.md + MLS.md consolides dans le wiki
et supprimes. wiki/architecture.md enrichi (OIDC, Redis/Kafka details, MLS flows, WS protocol, schemas
PostgreSQL, topologie prod). wiki/services/chat-gateway.md enrichi (AppState, lifecycle, pending_welcomes).
wiki/mls-protocol.md cree (W6 fait en meme temps que D3) : invariants, endpoints, scenarios, bug tables.
D-pass final : BACKEND.md, FRONTEND.md, COMMUNITIES.md, STORAGE.md, PUSH_NOTIFICATIONS.md, DEPLOIEMENT.md
supprimes (contenu verifie dans le wiki).

---

## LISTE DE TACHES (ordonnee, a suivre sans reflechir)

> Ordre conseille : I (cloturer i18n) -> D+W (consolider docs dans le wiki) -> C (commentaires backend).
> Cocher `[x]` une fois fait + committe.

### Bloc I - Cloture i18n frontend

- [x] **I1** - Detecter les chaines FR residuelles dans le template/UI. Depuis `frontend/` :
  `git grep -nIE "(é|è|ê|à|ù|ç|î|ô|â)" -- "src/**/*.svelte"` puis trier : toute chaine
  **visible par l'utilisateur** encore en dur -> la passer en `m.key()` (creer la cle FR+EN).
  Ignorer les commentaires (chantier 3) et les valeurs BDD.
- [x] **I2** - Verifier la parite des cles entre les deux fichiers de messages. Script rapide :
  `node -e "const a=require('./frontend/messages/fr.json'),b=require('./frontend/messages/en.json');const ka=Object.keys(a),kb=Object.keys(b);console.log('FR only:',ka.filter(k=>!(k in b)));console.log('EN only:',kb.filter(k=>!(k in a)))"`.
  Toute cle presente d'un seul cote -> ajouter la trad manquante OU supprimer la cle morte.
- [x] **I3** - Detecter les cles definies mais jamais utilisees : pour un echantillon de cles,
  `git grep -c "m\.<key>" frontend/src`. Supprimer les cles mortes des DEUX json. `bun run check` -> 0.
- [x] **I4** - `cd frontend && bun run check` (0/0) + `bun run test`. Commit + push (`rm -rf apps/*/dist` avant).

### Bloc D - Consolidation docs (migrer le contenu unique vers le wiki AVANT toute suppression)

> Regle d'or : ne JAMAIS supprimer un `.md` ancien tant que son contenu unique n'est pas dans le wiki.
> Chaque tache D = "lire l'ancien doc -> verser l'info manquante dans la page wiki cible -> supprimer l'ancien".

- [x] **D1** - `docs/ARCHITECTURE.md` (FR) : verifier que tout est couvert par `docs/wiki/architecture.md`
  (topologie, routage, auth, Kafka/Redis). Verser le manquant, puis **supprimer** `docs/ARCHITECTURE.md`.
- [x] **D2** - `docs/CHAT_GATEWAY.md` : compare a `docs/wiki/services/chat-gateway.md`. Verser le
  manquant, puis **supprimer** `docs/CHAT_GATEWAY.md`.
- [x] **D3** - `docs/MLS_REWRITE_PLAN.md` (plan termine du 2026-06-03) : migrer les **invariants**
  (5 invariants non-negociables) et la **table des bugs corriges** vers `docs/wiki/mls-protocol.md`
  (tache W6), puis **supprimer** `docs/MLS_REWRITE_PLAN.md`.

### Bloc W - Construction du wiki (1 page par entree de `docs/wiki/index.md`)

> Pour chaque page : lire les sources indiquees, ecrire la page en anglais (style des pages existantes),
> corriger imprecisions/code mort reperes en passant. Mettre a jour `index.md` si un lien change.
> Commit + push apres chaque page (ou petit groupe).

- [x] **W1 - Services backend** (`docs/wiki/services/`)
  - [x] `chat-delivery.md` - ~60 endpoints (devices, groups, members, messaging, sync QR, push, locks, calls, internal, health) + cron jobs + Redis/Firebase deps.
  - [x] `core-service.md` - 37 endpoints (auth OIDC, users, payments Stripe, platform admin) + auth model + DB schema.
  - [x] `media-service.md` - 8 endpoints (upload, chunked upload, download, delete) + encryption model.
  - [x] `social-service.md` - posts, channels, forms, associations + channel encryption model + Redis events.
  Note: PUSH_NOTIFICATIONS.md, STORAGE.md, COMMUNITIES.md content was incorporated; those files not yet deleted (verify before D-pass).
- [x] **W2 - Frontend** (`docs/wiki/frontend/`)
  - [x] `architecture.md` - SvelteKit structure, Svelte 5 runes, auth model, i18n, mobile keyboard, Tauri, env vars.
  - [x] `mls-wasm.md` - WASM package layout, IMlsService, WasmMlsClient API, message queue, tab leadership, state persistence.
- [x] **W3 - Modules frontend** (`docs/wiki/frontend/modules/`) : `auth.md`, `chat.md`, `associations.md`,
  `forms.md`, `calendar.md`, `posts.md`, `payments.md`, `admin.md`.
- [x] **W4 - Infrastructure** (`docs/wiki/infrastructure/`) : `docker.md`, `nginx.md`, `databases.md`,
  `kafka.md`, `backup.md`. Sources = docker-compose.dev.yml + Dockerfile.frontend + backup.sh.
  Note: deployment.md optionnel non fait; DEPLOIEMENT.md et STORAGE.md restent (pas encore supprimes).
- [x] **W5 - API surface** : `docs/wiki/api-surface.md` - tous les endpoints de tous les services (gateway, chat-delivery, media, core, social).
- [x] **W6 - MLS protocol** : `docs/wiki/mls-protocol.md` <- `docs/MLS.md` + invariants de D3 +
  liens vers les docs vivantes `MLS_DESYNC_PREVENTION.md` / `MLS_RECOVERY_LADDER.md` / `AUDIT-MLS-2026-06.md`.
  Puis **supprimer** `docs/MLS.md`.

> Suppressions finales - TOUTES FAITES : `docs/ARCHITECTURE.md`, `docs/CHAT_GATEWAY.md`,
> `docs/BACKEND.md`, `docs/FRONTEND.md`, `docs/COMMUNITIES.md`, `docs/STORAGE.md`,
> `docs/MLS.md`, `docs/PUSH_NOTIFICATIONS.md`, `docs/MLS_REWRITE_PLAN.md`, `docs/DEPLOIEMENT.md`.
> **Gardes** : `docs/AUDIT-MLS-2026-06.md`, `docs/MLS_DESYNC_PREVENTION.md`,
> `docs/MLS_RECOVERY_LADDER.md`, `docs/TESTS-DEVICE-PENDING.md`, `docs/NORMALIZATION-PLAN.md`,
> tout `docs/wiki/`.

### Bloc C - Commentaires & dev strings backend/infra en anglais

> Balayer service par service. Pour chaque fichier : traduire commentaires + dev strings (logs, erreurs
> internes) en anglais, ajouter JSDoc/doc-comment sur les exports manquants. **Mettre a jour les tests**
> qui asserte sur ces strings. Lancer les tests du service avant commit.

- [x] **C1** - `apps/core-service/` : commentaires/logs FR -> EN, JSDoc exports. `npm test`. Normaliser
  aussi `apps/core-service/README.md` en anglais (le reduire a un court pointeur vers `wiki/services/core-service.md`).
- [x] **C2** - `apps/social-service/` : idem. `npm test`. Normaliser `apps/social-service/README.md`
  (-> pointeur vers `wiki/services/social-service.md`).
- [x] **C3** - `apps/media-service/` + `apps/chat-delivery-service/` : idem. `npm test` chacun.
- [x] **C4** - `apps/chat-gateway/` (Rust) + `frontend/mls-core/` (Rust) + `frontend/mls-wasm/` :
  commentaires/`log`/`eprintln` FR -> EN, doc-comments `///`. `cargo test` + `cargo clippy`.

### Bloc U - Notes pour la future doc utilisateur (FR) - au fil de l'eau
- [x] **U1** - Tenir un fichier `docs/USER-DOC-NOTES.md` (FR, scratch) : pour chaque feature documentee
  cote wiki, noter les points a expliquer aux utilisateurs/responsables assos (parcours, ecrans cles,
  permissions). Servira plus tard a rediger la vraie doc utilisateur en francais.

### Bloc R - Reecriture du README (a faire sur Opus, en fin de chantier)
- [x] **R1** - Reecrire `README.md` pour integrer tous les changements : nouveau quick start,
  stack a jour, lien vers le wiki (`docs/wiki/index.md`) et vers ce plan, suppression des sections
  perimees. Le README doit etre la porte d'entree qui renvoie vers le wiki pour le detail.

### Bloc DOC-UTILISATEUR - Documentations utilisateurs FR
> Wiki technique stable. Format retenu (DU4) : `docs/user-guide/` Markdown FR.
- [x] **DU1** - Utilisateur standard (membre) : ICM et non-ICM (parcours d'inscription/connexion differents).
  -> `docs/user-guide/membre.md`
- [x] **DU2** - Responsables d'association : secretaire, tresorier, president (gestion membres, calendrier,
  boutique/Stripe, formulaires, documents, finances).
  -> `docs/user-guide/responsable-association.md`
- [x] **DU3** - Administrateurs plateforme (dashboard admin, moderation, configuration).
  -> `docs/user-guide/administrateur.md`
- [x] **DU4** - Format retenu : `docs/user-guide/` Markdown FR (un fichier par role + index).

---

## Reutilisation (rappel final - a faire sur Opus)
- [ ] **REUSE1** - Une fois Canari termine, **rejouer toute cette methodologie** (i18n + wiki + commentaires
  + nettoyage docs) sur **Sky**, puis **MiGallery**. Cf. memoire `project_normalization_methodology`.
  -> Hors scope de cette session (Canari n'est pas encore "termine" au sens deploi stable).
