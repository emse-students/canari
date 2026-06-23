# Audit MLS - Canari (2026-06-19)

Audit de correction, races, concurrence et veracite des types sur tout le sous-systeme MLS.
Reference de depart : commit `34e43259649cd2ae716ae7fdb2ef4b62be064062` (37 commits, ~177 fichiers).

Methode : lecture integrale de `mls-core` (Rust), des wrappers WASM / Tauri / JNI, du
pipeline de reception, de la recovery/reboot, de l'outbox et de son miroir natif, du backend
de livraison, et des services TS. Chaque entree porte un identifiant stable (C/H/M/S + numero)
pour le suivi inter-passes.

## Glossaire express (pour lire les findings)

- **epoch** : version de l'arbre du groupe. Avance a chaque commit (ajout/retrait/update).
- **generation** : compteur par-emetteur a l'interieur d'une epoch. Avance a chaque message
  applicatif. Le `SecretTree`/`SenderRatchet` derive une cle unique par generation.
- **gap d'epoch** : `msg_epoch > group_epoch` -> on a rate un commit. Recuperable en attendant
  les commits manquants.
- **erreur de ratchet meme-epoch** (`msg_epoch == group_epoch`) :
  - `TooDistantInTheFuture` : generation au-dela de `MAXIMUM_FORWARD_DISTANCE` (rare).
  - `TooDistantInThePast` : generation trop ancienne, cle deja avancee/jetee. **Permanent.**
  - `SecretReuseError` : cle de cette generation deja consommee (doublon). **Permanent.**

Point cle : une erreur de dechiffrement **a meme epoch** n'est presque jamais recuperable en
re-essayant plus tard. Seul le **gap d'epoch** justifie une mise en file.

---

## Suivi des findings (statut)

| ID | Sujet | Statut | Commit |
|----|-------|--------|--------|
| C0 | TooDistantInThePast/SecretReuse same-epoch mis en file -> boucle | FIXED (P1) | 9be4663a |
| C0b | Web: TooDistantInThePast -> requestReAdd | FIXED (P1, via C0 centralise) | 9be4663a |
| C0c | Config SenderRatchet tolerance 5 -> 2000 | FIXED (P1) | 9be4663a |
| C1 | Deux moteurs MLS ecrivent mls.bin (garde booleenne) | FIXED (P2: verrou Rust process-global autour des ecritures + garde foreground a expiration ; Worker degrade en janitor - option B) | (ce commit) |
| C2 | Foreground ne recharge jamais mls.bin au resume | FIXED (P2: `recharger_mls_au_resume` au `visible` AVANT la reprise WS) | (ce commit) |
| C3 | Double envoi outbox foreground/background | FIXED (P2, reconcile au resume) | ce9232bd |
| C4 | process_welcome persiste avant les guards -> orphelin | FIXED (P3) | 10d8e160 |
| C5 | add_members_bulk perte silencieuse de membres | FIXED (surface : skipped_indices remontes + logs ; auto-retry differe) | (ce commit) |
| C6 | Commit background bypasse validateCommit -> activeEpoch serveur desync -> commits foreground rejetes (fork) | FIXED (P-fork) | 60f57f08 |
| C7 | merge_pending_commit avant validation serveur -> commit rejete = fork local permanent | FIXED (B: heal-on-reject + A: valider-puis-merger sur REMOVE) | 3717c095 + (ce commit) |
| H7 | Escalade de gap remise a zero par tout dechiffrement -> device forke ne recovery jamais | FIXED (P-fork) | 60f57f08 |
| C8 | history bundle saute quand le commit broadcast echoue -> nouvel arrivant prive d'historique | FIXED (decouple du commit) | (ce commit) |
| H1 | TTL locks reboot/add < duree reelle | FIXED (P4: add 30s/clamp 60s, reboot 90s/clamp 180s) | (ce commit) |
| H2 | forgetGroup predecesseur premature | FIXED (forget gate sur successeur dans le WASM ; purge-predecesseur du Welcome forget G quand S rejoint) | (ce commit) |
| H3 | Mutations conversations non atomiques | FIXED (runExclusiveForGroup : verrou par-groupe sur migrateConversation + upsertConversation) | (ce commit) |
| H4 | validateCommit bypass epoch 0 | FIXED (P4: gate stricte baseEpoch==activeEpoch) | (ce commit) |
| H5 | Push differe + background redondants | DEFERRED (perf, pas correctness ; redondance subsumee par C1/C2 - a re-mesurer une fois les moteurs unifies) | - |
| H6 | Evenements de controle (reactions/edits/...) hors outbox -> perte silencieuse | FIXED (kind 'control' outbox) | 7f38eeeb |
| S1 | `getGroupMeta` null = 404 ET reseau -> reboot duplique un successeur | FIXED (P5: performReboot via getGroupServerStatus) | (ce commit) |
| S2 | Retours `[]` indistinguables de l'echec -> invitations sautees | FIXED (P5: getters de liste stricts + opt-in best-effort) | (ce commit) |
| S4 | Troncature u64->u32 sur les epochs | FIXED (u64 cote Tauri + f64 cote WASM = pas de troncature ; reste un `number` JS exact <= 2^53) | (ce commit) |
| M1 | Messages >2 epochs en retard -> drop silencieux | WONTFIX (by-design : `max_past_epochs(2)` = compromis forward-secrecy/anti-replay intentionnel d'OpenMLS) | - |
| S3 | `any` sur deliveryMeta/onChannelEvent/devices -> types | FIXED (P5) | (ce commit) |
| M2 | Replay: WrongEpoch marque vu definitivement | FIXED (P5: WrongEpoch retryable comme GAP_QUEUED) | (ce commit) |
| S5 | Classification d'erreurs MLS dupliquee 4 couches | FIXED (volet TS : classifyIncomingDecryptError ; volet Rust : `MlsError::decrypt_kind()` source unique dans mls-core, consomme par recevoir_message_bytes + map_decrypt_outcome) | (ce commit) |
| DB1 | SQLite sans busy_timeout -> "database is locked" sur le replay -> messages dechiffres mais jamais affiches (perte definitive) | FIXED (busy_timeout 5s foreground + natif) | 05eeeb26 |
| FCM0 | Chemin Welcome idempotent (foreground) ne promeut pas la membership 'active' -> device joint en background reste 'pending', exclu du routage | FIXED (updateInvitationStatus('active') sur le chemin idempotent) | (ce commit) |
| FCM1 | Join Welcome en BACKGROUND ne promeut jamais la membership 'active' (auth PushSecret, pas de JWT) -> pas de livraison temps-reel/push tant que l'app reste en background | OPEN (besoin d'un endpoint PushSecret d'activation) | - |
| FCM2 | onNewToken ne pousse pas le token au backend -> token tourne app tuee = push vers token mort jusqu'a reouverture | OPEN | - |
| FCM3 | Garde foreground `isInForeground` TOCTOU -> message a la transition ni traite background ni foreground | FIXED (P2, = C1 : garde foreground a expiration cote Rust, re-verifiee sous le verrou avant chaque ecriture background) | (ce commit) |

### Note architecture Android (pour C1/C2)

Trois moteurs MLS coexistent dans le **meme process** (meme `.so` Rust) :
1. **Foreground** : `MlsManager` natif en memoire (`AppState`, `src-tauri/src/lib.rs`), lu une
   fois a `initialiser_mls`, jamais recharge, ecrit `mls.bin` au save.
2. **FCM service** (`CanariFirebaseMessagingService.kt`) : JNI, `MlsManager` ephemere depuis
   `mls.bin`, garde `MlsStateLock` + `isInForeground`.
3. **WorkManager** (`MlsBackgroundWorker.kt`) : JNI, idem, garde `MlsStateLock` (15s) +
   `isInForeground`, max 3 retries.

Les moteurs 2 et 3 partagent `MlsStateLock` (Kotlin `ReentrantLock`), mais le foreground (1) n'y
participe PAS. Comme les trois sont dans le meme espace d'adressage, un `static Mutex` cote Rust
(acquis par les commandes Tauri ET les fonctions JNI avant tout acces `mls.bin`) pourrait unifier
le verrou des trois sans dependre de Kotlin (C1). Le rechargement de `mls.bin` au resume reste
necessaire pour la stale en memoire du foreground (C2).

Note versioning : le bump de version est gere par le bot CI au release (pattern observe :
commit `9f3afd91` rebuild WASM sans bump). Pas de bump manuel pour eviter un conflit CI.

---

## CRITIQUE

### C0 - `TooDistantInThePast` (meme epoch) mis en file SQLite et retente en boucle

**Symptome reel** (envoi de plusieurs messages d'un coup, mobile) :

```
recevoir_message_bytes failed: ... Process error:
  ValidationError(UnableToDecrypt(SecretTreeError(TooDistantInThePast))) [msg_epoch=1, group_epoch=1]
[GAP] Sender Ratchet gap pour group=e207b952... - message mis en file SQLite
```

`msg_epoch == group_epoch` : il n'y a **aucun gap d'epoch**. C'est une generation passee dont la
cle a deja ete ratchetee/jetee -> **indechiffrable pour toujours**. Or le code natif classe toute
erreur `Process error:` (hors `SecretReuseError`) comme "Sender Ratchet gap (generation future)"
et la **stocke dans `pending_mls_messages`** pour retry.

Lieu : `frontend/src-tauri/src/lib.rs:621-650` (`recevoir_message_bytes`, branche `Process error:`).

Chaine async / amplification :
1. Envoi de N messages -> generations 0..N-1 dans l'epoch 1.
2. Livraison multi-chemin (publish realtime + pull queue + FCM + requeue SQLite) -> certains
   arrivent **apres** que le `SecretTree` a avance au-dela de la tolerance d'ordre.
3. `recevoir_message_bytes` -> `TooDistantInThePast` -> classe en gap -> **INSERT SQLite**.
4. Drain SQLite (foreground `recevoir_messages_batch` + `MlsBackgroundWorker`) -> re-echec ->
   `attempt_count++` (retente 3x) -> chaque drain qui touche un batch mixte declenche un
   `save_encrypted` **Argon2 (~1 s sur un blob de ~318 Ko)** -> la rame.
5. Cote foreground, l'erreur remonte en `GAP_QUEUED` -> `handleKnownGroup` la traite en
   "epoch gap" et apres 30 s escalade en `forgetGroup` + `welcome_request` -> **recovery
   destructrice parasite** alors que l'epoch est saine.

Drain natif : `frontend/src-tauri/src/lib.rs:1882-1989` (`attempt_count < 3` + purge 1 h).
Escalade foreground : `frontend/src/lib/mls-client/messagePipeline/setupMessageHandler.ts:633-657`.

Defaut de fond : **les erreurs de ratchet a meme epoch ne doivent jamais etre mises en file**
(elles ne deviennent jamais dechiffrables). Seul le gap d'epoch (deja pre-check en tete de
`recevoir_message_bytes`) le justifie.

Pistes de fix :
- Native : pour une erreur a `msg_epoch == group_epoch`, traiter `TooDistantInThePast` (et tout
  ratchet meme-epoch non-future) comme `SecretReuseError` -> `Ok(None)` (ACK + drop), **pas** de
  file SQLite.
- Foreground : ajouter `TooDistantInThePast` a la liste benigne (ACK silencieux) au meme titre
  que `SecretReuseError`, cote `handleKnownGroup`, et cote web (`process_incoming_message` WASM
  -> aujourd'hui ca tombe dans `onOutOfSync` -> `requestReAdd`, voir C0b).
- Reduire la frequence du symptome : voir C0c (config sender ratchet).

### C0b - Sur web (WASM), `TooDistantInThePast` declenche une recovery complete

`handleKnownGroup` ne capture que `GAP_QUEUED`/`epoch gap`, `SecretReuseError`,
`CannotDecryptOwnMessage`. Tout le reste -> `onOutOfSync(groupId)` -> `requestReAdd`.

Lieu : `frontend/src/lib/mls-client/messagePipeline/setupMessageHandler.ts:625-672`.

Donc un simple doublon out-of-order benin (`TooDistantInThePast`) sur web provoque une
 re-invitation (kick + re-add), qui fait avancer l'epoch et peut forker durablement les pairs.
Meme correctif que C0 cote liste benigne.

### C0c - Config du Sender Ratchet par defaut (tolerance d'ordre faible)

Les configs de creation et de join n'initialisent pas `SenderRatchetConfiguration` :
- creation : `frontend/mls-core/src/lib.rs:272-276`
- join : `frontend/mls-core/src/lib.rs:685-688`

Par defaut OpenMLS garde une tolerance d'ordre faible (`OUT_OF_ORDER_TOLERANCE`). Lors d'un
envoi en rafale avec livraison desordonnee/dupliquee, des generations passees tombent hors
fenetre -> `TooDistantInThePast`. Augmenter `out_of_order_tolerance` et
`maximum_forward_distance` rend les rafales robustes. Attention : config locale appliquee
**a la creation/au join** -> n'affecte que les nouveaux groupes/joins.

### C1 - Deux moteurs MLS ecrivent `mls.bin`, separes par un simple booleen

Sur Android, deux moteurs distincts partagent `mls.bin` :
- foreground : WASM dans la WebView, etat en memoire, persiste sur `visibilitychange`->hidden ;
- background : JNI Rust (FCM/Worker) qui charge `mls.bin`, avance le ratchet, reecrit `mls.bin`.

Seule barriere : le booleen `MainActivity.isInForeground`.
Lieu : `frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt:208-219`.
Le commentaire reconnait le symptome de clobber (n_secrets->1, epoch gaps, UseAfterEviction).
`MlsStateLock` ne couvre que FCM<->Worker, pas la WebView.

TOCTOU : le thread FCM franchit la garde (`isInForeground == false`) -> l'app revient au
premier plan -> les deux moteurs tournent en parallele sur `mls.bin`.

### C2 - Le foreground ne recharge jamais `mls.bin` au resume

Le cycle de persistance ne fait que **persister sur hide** ; aucun reload-on-show.
Lieu : `frontend/src/lib/mls-client/mlsStatePersisterLifecycle.ts` (persist-only).
Envoi background qui ecrit `mls.bin` : `frontend/src-tauri/src/lib.rs:2194` (`nativeSendMessageBackground`).

Chaine : un envoi/join background avance `mls.bin` pendant l'arriere-plan -> au retour, l'etat
en memoire est perime -> la prochaine persistance foreground **ecrase** `mls.bin` ->
l'avancee background est perdue -> reutilisation de generation -> `SecretReuseError` chez les
pairs + regression d'epoch -> cascade de recovery.

### Passe 2 - Implementation (FIXED, option B) - C1 / C2 / FCM3

Correction sur Android, ou le moteur foreground est le **MlsManager Rust natif** (`AppState`,
en memoire via les commandes Tauri - pas WASM) et les moteurs background sont les JNI FCM/Worker,
tous dans le **meme process**. Trois leviers :

1. **C1 - verrou Rust process-global** (`mls_bin_write_lock`, `src-tauri/src/lib.rs`) tenu
   brievement autour de chaque ecriture de `mls.bin` : foreground (`write_mls_state_blob`) ET
   background (`background_write_mls_bin`, appele par les 3 ecrivains JNI Welcome/send). Unifie le
   verrou des trois moteurs sans dependre de Kotlin. `nativeDecryptMessage` n'ecrit pas (manager
   ephemere) -> non verrouille.

2. **FCM3 - garde foreground a expiration** (`foreground_active_until`, AtomicI64). Un heartbeat
   (`mls_foreground_heartbeat`, toutes les 10 s via `createPausableInterval`, donc en pause quand
   l'app est cachee) maintient la garde fraiche (marge 30 s). `recharger_mls_au_resume` la rafraichit
   aussi, `pause_mls_foreground` la libere immediatement sur `hidden`. Avant chaque ecriture
   background, sous le verrou, `background_write_mls_bin` **abandonne** si la garde est active ->
   ferme le TOCTOU `isInForeground` sans risque de stuck-true (la garde expire seule si le foreground
   meurt/gele, donc la livraison background FCM1/FCM2 n'est jamais bloquee durablement).

3. **C2 - reload au resume** : `recharger_mls_au_resume` (commande Tauri, Android only) relit
   `mls.bin` du disque dans le manager chaud, SOUS le verrou, AVANT la reprise WS. Branche dans
   `ChatBackgroundService.handleVisibilityChange` (`visible`) : reload -> `reconcileOutboxSent` ->
   reconnexion. Cote service : `TauriMlsService.reloadStateFromDisk` (clear epoch cache + refresh
   known-groups ; no-op hors Android via `BaseMlsService`).

4. **Option B - Worker degrade en janitor** : le Worker (`nativeProcessBackgroundTasks`) ne **draine
   plus** la file de gap (`pending_mls_messages`). Ce drain background etait **redondant** avec la
   recuperation foreground (resync serveur sur `GAP_QUEUED` ; la table n'est jamais lue par le
   foreground) et **nuisible** : il avancait le ratchet pour des messages deja livres -> `SecretReuse`,
   et son avancee, jetant le plaintext, devenait irrecuperable une fois `mls.bin` recharge par C2.
   Il ne reste que le nettoyage anti-fuite de la table (plus de charge Argon2, plus d'avancee de
   ratchet background). `persist_background_mls_checkpoint` supprime (devenu mort).

Invariant resultant : **un moteur background n'avance jamais le ratchet partage pour un message dont
il jette le plaintext.** Les notifications (chemin `nativeDecryptMessage` + cache FCM injecte au
boot, dedup par `messageId`) sont inchangees.

Build : `cargo check` desktop OK. Le code android-gated (`background_write_mls_bin`, Worker janitor,
3 sites JNI) n'est pas compilable hors NDK ici -> **a recompiler/verifier au build APK** (T9-T11).

### Suite Passe 2 - Elargissement du drain outbox background (debloque par C1/C2)

Maintenant que les ecritures cross-moteur sont serialisees, l'envoi background de l'outbox est
elargi (le verrou rendait ca risque avant) :
- **Declencheur** : `drainOutboxBackground` est appele AUSSI a la reception d'un message FCM normal
  (`CanariFirebaseMessagingService.onMessageReceived`, apres la notif), pas seulement sur les pushs
  Welcome. N'importe quel reveil background tente donc de vider l'outbox (no-op si vide).
- **Contenu** : les events de **controle** (reaction/edit/delete/read) sont desormais inclus dans le
  mirror (`toMirrorEntry` ne les exclut plus) - cas motivant : **delete** (une retraction ne reste
  plus visible chez les pairs jusqu'a reouverture alors que le corps a deja ete envoye en background).
  Media toujours exclu (upload foreground only).
- **Flag `silent`** : propage du mirror -> Kotlin -> `POST /mls/push/send` -> `messagingService`.
  Indispensable : un control est un envoi silencieux, et le serveur ne peut PAS l'inferer du
  ciphertext E2E. Sans lui, un delete/reaction background declencherait une notif parasite.

### C3 - Double envoi outbox foreground vs background (reconciliation seulement au login)

`reconcileOutboxSent()` ne tourne qu'au login.
Lieu : `frontend/src/lib/utils/chat/outboxMirror.ts:73`.
Le background ecrit `outbox_sent.ndjson` mais ne supprime pas l'entree outbox TS (IndexedDB).

Chaine : background draine l'outbox (M1 envoye) -> retour foreground sans re-login ->
`runFlush` relit M1 toujours present -> re-envoi. Deduplique par `messageId` cote recepteur, mais
re-encode contre une generation possiblement perimee (C2) -> `SecretReuseError` + divergence.
Lieu flusher : `frontend/src/lib/utils/chat/outbox.ts:316`.

### C4 - `process_welcome` : les guards rejettent APRES que `into_group` a persiste le groupe

Ordre : `frontend/mls-core/src/lib.rs:703-786`.
1. `StagedWelcome::new_from_welcome` (echoue si groupe deja en storage) ;
2. `staged_welcome.into_group(&provider)` -> **ecrit le groupe dans le storage provider** ;
3. ensuite Guard 2 (`welcome_epoch < min_epoch`) -> `return Err`.

Au `return Err`, le groupe est deja persiste en storage mais pas dans `self.groups` ->
**etat orphelin** : `save_state` ne le liste pas (`group_ids`) mais `storage_values` le contient
(`frontend/mls-core/src/lib.rs:982-994`) -> fuite + futur re-Welcome legitime heurte
`GroupAlreadyExists`. Guard 1 (branche "deja actif -> Ok") est de plus largement inatteignable
(memoire et storage coherents -> `new_from_welcome` aurait deja echoue).

### C5 - `add_members_bulk` : perte silencieuse de membres a KeyPackage invalide

Lieu : `frontend/mls-core/src/lib.rs` (`add_members_bulk`).
Toute KeyPackage qui echoue a `validate` (expiree, mauvais ciphersuite, cle privee perdue chez
le pair) ou a deserialiser etait `continue` sans remontee au caller. Seul `added_indices` revenait.
La recovery n'envoie de Welcome qu'aux `addedDeviceIds`
(`frontend/src/lib/utils/chat/recovery.ts`) -> le device saute n'etait jamais invite ni
retente -> disparition silencieuse du groupe.

**FIXED (surface)** : `add_members_bulk` retourne desormais un 5e champ `skipped_indices` (positions
des KeyPackages **invalides/illisibles** uniquement ; les deja-membres restent une dedup benigne hors
de cette liste, signalee par `MlsError::AlreadyMember`). Le champ est threade jusqu'au TS
(`AddMembersBulkResult` mls-core -> 5e element du tableau WASM / 5e du tuple Tauri ->
`skippedDeviceIds` dans `IMlsService.addMembersBulk` et les deux services). Les 4 callers
(`reboot`, et les 3 sites de `groupCreation`) logguent fort via le helper partage
`warnSkippedKeyPackages` (`groupActions.ts`) : log applicatif + `console.warn`, plus aucune perte
silencieuse. L'appel OpenMLS `add_members` est inchange byte-a-byte -> neutre sur le protocole.
Test : `add_members_dedup.rs::add_members_bulk_reports_invalid_keypackage_in_skipped_indices`
(un KP corrompu -> index dans `skipped`, le KP valide du lot est ajoute normalement).

**Differe (auto-remediation, verif device)** : la re-recuperation d'un KeyPackage frais pour le
device saute puis un nouvel ajout/reboot automatique. La remediation actuelle est la visibilite
(log/warn) ; le device rejoindra au prochain ajout/reboot une fois un KeyPackage valide republie.

---

## IMPORTANT

### H1 - TTL des verrous reboot/add inferieurs a la duree reelle (Argon2)

- reboot-lock TTL 60 s : `apps/chat-delivery-service/src/controllers/locks.controller.ts:84-89`,
  mais `performReboot` enchaine creation candidat + CAS + invitations + persist Argon2 + bundle
  (`frontend/src/lib/utils/chat/recovery.ts:303-433`) -> peut depasser 60 s sur mobile -> reboot
  concurrent -> pollution serveur (le CAS converge mais apres degats).
- add-lock TTL 10 s : `frontend/src/lib/mls-client/mlsDeliveryApi.ts:340`, alors que
  `inviteMembers` fait bulk add + persist Argon2 + commit + boucle de Welcomes sous ce lock
  (`frontend/src/lib/utils/chat/recovery.ts:578-627`) -> expiration probable -> fork d'epoch sur
  le successeur.

**FIXED** : constantes partagees `MLS_ADD_LOCK_TTL_MS=30s` / `MLS_REBOOT_LOCK_TTL_MS=90s`
(`frontend/src/lib/mls-client/mlsDeliveryApi.ts`), clamps serveur releves a 60s (add) / 180s
(reboot) (`locks.controller.ts`). Les callers a 15s explicites retombent sur le defaut centralise.
Compromis assume : un crash sous verrou bloque les pairs plus longtemps (jusqu'au TTL), mais
l'expiration en cours d'operation - cause de fork - est la menace prioritaire (et C7 heal les forks
residuels).

### H2 - `migrateConversation` fait `forgetGroup(fromGroupId)` avant garantie de join du successeur

Lieu : `frontend/src/lib/utils/chat/recovery.ts:743`.
Si le Welcome du successeur n'est pas encore traite, oublier le predecesseur renvoie ses messages
entrants dans `handleUnknownGroup` -> boucle welcome_request le temps que le successeur arrive.

### H3 - Map `conversations` mutee a travers des `await`, sans atomicite par groupe

`upsertConversation` (`frontend/src/lib/mls-client/messagePipeline/setupMessageHandler.ts:681-790`)
et `checkGroupSuccessors`/`migrateConversation`
(`frontend/src/lib/utils/chat/recovery.ts:779-862`) lisent puis reecrivent `conversations`
autour de multiples `await` reseau. Deux flux concurrents (Welcome recu + tick 5 min) peuvent
s'entrelacer sur le meme groupId -> double migration / messages memoire ecrases.

### H4 - `validateCommit` accepte n'importe quel `baseEpoch` quand `activeEpoch == 0`

Lieu : `apps/chat-delivery-service/src/services/messaging.service.ts:751-763`.
Un device en etat incoherent (`baseEpoch=5`) sur un groupe encore a 0 cote serveur serait
accepte et fixerait `activeEpoch=6`, desalignant les autres.

**FIXED** : gate stricte `baseEpoch == activeEpoch` (bypass `activeEpoch == 0` supprime). Verifie
sur le code de bootstrap : `reset-epoch` met `activeEpoch=0` PUIS `force_create_group` repart a
l'epoch MLS 0, donc le premier commit (normal ou re-bootstrap) est toujours a `baseEpoch=0` ->
la gate stricte accepte tous les flux legitimes et bloque le fast-forward incoherent.

### H5 - Push differe 10 s + envoi background -> reveils/dechiffrements redondants

Lieu : `apps/chat-delivery-service/src/services/messaging.service.ts:359-382`.
Combine au drain outbox background (C3) et au requeue, multiplie le travail crypto multi-moteur.
A correler avec les lenteurs.

### H6 - Les evenements de controle MLS contournent l'outbox durable (perte silencieuse)

Reactions, edits, suppressions, pins et accuses de lecture partent en direct via
`mlsService.sendMessage(..., silent=true)` avec le pattern `if (!conversation.isReady) return;`
puis `try { ... } catch { console.warn }`. Aucun retry, aucune file durable.

Lieux : `frontend/src/lib/utils/chat/messaging.ts` - `addReaction:188-218`, `removeReaction:224-242`,
`editMessage:244-261`, `deleteMessage:264-274`, `setMessagePinned:277-293`, `sendReadReceipt:296-311` ;
declencheurs UI dans `frontend/src/lib/composables/useMessaging.svelte.ts` (handleAddReaction,
handleEditMessage, handleDeleteMessage, handleTogglePin).

Chaine : l'utilisateur reagit/edite/supprime pendant que le groupe est momentanement non-sendable
(epoch en transit, reseau coupe, Welcome en cours) -> l'envoi est `return` ou jette -> l'etat local
optimiste reste, mais le message MLS n'est jamais emis -> les pairs ne convergent jamais. Seuls
texte/reply/media beneficient de l'outbox durable (cf. C3). Probable cause des reactions/edits/
read-state qui "ne se propagent pas". A traiter : router ces evenements via l'outbox (nouveau kind
de controle) ou une mini-file de retry.

---

## FORK D'EPOCH - messages du mobile invisibles sur les PC (C6/C7/H7)

Diagnostic etabli a partir de `logs.txt` (compte A : PC+mobile ; compte B : PC). Symptome :
un message envoye par le mobile n'apparait sur aucun PC. Ce n'est PAS le bug same-epoch de
Passe 1 (deja corrige) : c'est un **fork d'epoch** cause par une desynchronisation du compteur
d'epoch cote serveur. Pre-existant.

**Preuve (mobile, ligne 515 de logs.txt) :**
```
[WELCOME_REQ] Erreur ... Commit rejected: epoch_mismatch (server epoch: 1, sent: 3)
```
Le compteur `activeEpoch` serveur est fige a 1 alors que l'epoch MLS reel est monte a 4.

### Chaine causale

1. Le mobile (app en arriere-plan, FCM) traite un `welcome_request` et poste le commit sur
   `POST /api/mls/push/send-welcome-and-commit`. Cet endpoint **diffuse** le commit (epoch reel
   1->2) mais **n'appelle jamais `validateCommit`** -> `activeEpoch` reste a 1.
2. Le seul chemin qui met a jour `activeEpoch` est le foreground (`POST /api/mls/commit` ->
   `validateCommit`). Le compteur serveur desynchronise donc des membres reels.
3. Le mobile revenu au premier plan fait un commit foreground (kick+re-add, epoch local 3),
   valide contre `activeEpoch=1` -> `epoch_mismatch` -> **rejete**.
4. Mais `mls-core` a deja fait `merge_pending_commit` localement (avant la reponse serveur) ->
   l'etat local est deja a l'epoch suivant, **forke**, sans rollback.
5. Le mobile emet ses messages applicatifs sur la branche forkee (epoch 4) -> les PC (epoch 2)
   tombent en gap -> messages non affiches.
6. La recovery des PC ne converge jamais a cause de H7 (cf. ci-dessous).

### C6 - Le commit background bypasse `validateCommit` (cause racine)

Lieux : `apps/chat-delivery-service/src/controllers/push.controller.ts:386-393`
(`sendWelcomeAndCommitPush` diffuse via `messagingService.sendMessage({isCommit:true})` sans
validation) vs `apps/chat-delivery-service/src/services/messaging.service.ts:704`
(`validateCommit`, seul a bumper `activeEpoch`, appele uniquement par le chemin foreground).

Consequence : tout commit emis en arriere-plan (ajout de device sur welcome_request) avance
l'epoch reel sans avancer le compteur serveur -> le prochain commit foreground est rejete a tort.

Fix : le chemin background doit, comme le foreground, faire passer le commit par `validateCommit`
avant diffusion (le JNI expose l'epoch de base pre-ajout, le Kotlin le transmet, le backend valide
et bump `activeEpoch`). Touche JNI (Rust) + Kotlin + backend.

### C7 - `merge_pending_commit` avant validation serveur -> fork local permanent

Lieux : `frontend/mls-core/src/lib.rs` (`add_members_bulk:~658`, `remove_members_for_*:~509/558`),
le merge local precede l'aller-retour serveur de validation.

Consequence : apres C6, le seul fork restant est la course de commits concurrents. Deux devices
committent au meme baseEpoch N ; le lock Redis serialise `validateCommit`, accepte le premier
(N->N+1) et rejette le second (`epoch_mismatch`, serverEpoch=N+1, sent=N). Le perdant a deja
merge localement a N+1 sur une branche divergente. Comme `sendValidatedCommit` valide AVANT de
diffuser, le commit rejete n'est jamais broadcaste -> seul le perdant est forke. Mais le commit
gagnant (aussi N->N+1) lui arrive et est dropé comme same-epoch benin (fix Passe 1) -> jamais
adopte -> fork permanent. L'ancienne garde `isStaleForkError` (ecart >= 2, pensee pour un
receveur en retard) laissait passer ce cas a ecart 1.

**FIXED - Option B (heal-on-reject, livree)** : dans le chemin d'EMISSION, tout `epoch_mismatch`
(des un ecart de 1) signifie que NOTRE commit deja merge a forke -> on declenche la recovery
(`recoverForkedGroup` = forget + welcome_request) pour adopter la branche gagnante, et l'operation
est retentee. Nouveau predicat `isSenderForkError` (groupActions.ts) distinct de `isStaleForkError`
(supprime, devenu mort). Sites recables : `processPendingInvitations`, `handleWelcomeRequest`,
leurs kicks imbriques, et `kickStaleLeaf` (re-throw au lieu d'avaler). Le commit gagnant n'etant
jamais diffuse en cas de rejet, les autres membres restent sains : seul le perdant heal.

Edge connu non couvert par B : rejet `concurrent_commit` (lock non acquis) ou serverEpoch ==
sentEpoch -> `parseForkedEpoch` ne le detecte pas (retombe sur le retry du cycle suivant). Rare.

**Option A (valider-puis-merger) - LIVREE sur le chemin REMOVE.** `remove_members_for_*` *stage*
desormais le commit sans le merger ; l'appelant valide cote serveur PUIS confirme
(`merge_pending_commit_for` / commande `confirmer_commit` / binding wasm `merge_pending_commit`)
sur acceptation, ou annule (`clear_pending_commit_for` / `annuler_commit` / `clear_pending_commit`)
sur rejet. L'epoch local ne bouge jamais avant l'acceptation -> AUCUN fork possible sur un retrait
rejete. C'est le chemin vise par l'edge concurrent restant : les removes/kicks ne prennent PAS
l'add-lock (contrairement aux adds), donc deux retraits concurrents - ou un retrait pendant un
ajout - pouvaient se forker. Cote service, `sendCommit(..., staged=true)` orchestre
validate->merge/clear ; le rejet leve une erreur SANS le motif `server epoch:.., sent:..` pour que
`isSenderForkError` ne declenche PAS de recovery (il n'y a pas de fork a healer, juste un retry).
La persistance reste a la charge de l'appelant (`persistMlsStateAfterMutation`, meme fenetre
merge->persist qu'avant). Tests : `frontend/mls-core/tests/pending_commit.rs` (stage n'avance pas
l'epoch ; confirm avance de 1 ; abort laisse inchange et autorise un nouveau commit).

**Pourquoi l'ADD reste merge-immediat** : (1) le chemin add est serialise cross-device par
l'add-lock Redis (pas de course concurrente -> pas de fork concurrent a healer ; un rejet eventuel
est healé par Option B), et (2) l'export du ratchet tree (`export_ratchet_tree`) exige l'etat
POST-commit (epoch N+1) - le differer casserait le Welcome du nouvel arrivant. Un add-path Option A
demanderait de recuperer l'arbre N+1 sans merger (via le GroupInfo embarque) : refactor a part avec
verif device.

### C8 - Le history bundle est saute quand le commit broadcast echoue

Lieux : `frontend/src/lib/utils/chat/actions.ts` - `processPendingInvitations` et
`handleWelcomeRequest`. L'ordre etait : `addMember` -> `sendWelcome` -> `sendCommit` ->
`sendFullHistoryBundle`. Comme `sendCommit` peut throw (epoch_mismatch : course concurrente OU
compteur serveur en retard), le `catch` prenait la main et le bundle n'etait jamais envoye -> le
nouvel arrivant recevait la membership (via le Welcome) mais AUCUN historique.

Diagnostic terrain (logs 2026-06-20) : un nouveau device rejoint un DM dont le compteur
`activeEpoch` serveur est bloque en retard (sequelle pre-deploiement de C6 : observe `server
epoch: 1, sent: 3`). Le membre qui repond au `welcome_request` envoie le Welcome (join OK) puis
son commit est rejete -> bundle saute -> pas d'historique cote nouvel arrivant.

Point cle : `sendFullHistoryBundle` envoie des **messages applicatifs** (`mlsService.sendMessage`,
silent), PAS un commit -> il ne passe pas par `validateCommit`. Le destinataire a deja rejoint via
le Welcome (donc partage notre epoch courante), donc l'historique lui est dechiffrable
independamment du sort du commit broadcast.

**FIXED** : on decouple le bundle du commit. `sendCommit` est entoure d'un try/catch local ;
quel que soit son resultat on lance `sendFullHistoryBundle`. Si le commit a echoue, on attend la
fin de l'envoi du bundle (pour ne pas le couper) PUIS on remonte l'erreur au catch externe qui
declenche la heal (C7). Succes : envoi best-effort en tache de fond (ne bloque pas la liberation
du verrou). Limite assumee : si le commit echoue parce que NOTRE etat a forke, le nouvel arrivant
rejoint cette branche ; l'historique est livre mais la branche peut etre transitoire (C7 heal).
Le decouplage reste correct car il rend la livraison de l'historique aussi robuste que le join
lui-meme, et le cas nominal (commit accepte) est inchange.

### H7 - L'escalade de gap est remise a zero par tout dechiffrement

Lieu : `frontend/src/lib/mls-client/messagePipeline/setupMessageHandler.ts` (`handleKnownGroup`,
`epochGapSince.delete(groupId)` inconditionnel apres chaque dechiffrement reussi, ~ligne 531).

Consequence : un PC bloque en gap derriere une branche forkee escalade vers forget+re-welcome au
bout de `EPOCH_GAP_ESCALATION_MS` (30 s). Mais tout message d'un pair reste sur la meme branche
stale (ex. le compte B) se dechiffre normalement et **reinitialise le timer** -> les 30 s ne sont
jamais atteintes -> le device forke ne recovery jamais.

Fix (mitigation, sur et testable) : ne remettre `epochGapSince` a zero que sur un **commit** (qui
avance reellement l'epoch), pas sur un message applicatif d'un pair sur la branche stale. 1 ligne,
pur TS. Limite : sans C6, le re-add de recovery peut re-forker -> H7 est necessaire mais pas
suffisant seul.

---

## STRICTNESS / VERACITE (retours ambigus, `any`)

### S1 - `getGroupMeta` : `null` pour 404 ET pour echec reseau

Lieu : `frontend/src/lib/mls-client/mlsDeliveryApi.ts:662-688`.
La recovery le reconnait comme bloquant
(`frontend/src/lib/utils/chat/recovery.ts:90-92`) et s'abstient -> un blip reseau est
indiscernable d'un groupe supprime et gele la recovery. Distinguer not-found de network-error.

**FIXED** : les deux consommateurs DESTRUCTEURS de cette ambiguite sont passes a
`getGroupServerStatus` + `classifyServerStatus` (qui distingue `active|tombstone|absent|unknown`) :
- `requestReAdd` (deja fait, cf. R1) : `unknown` -> ne purge jamais sur un doute.
- `performReboot` (`recovery.ts`) : un `getGroupMeta` renvoyant `null` sur blip reseau faisait
  rater le `successorId` existant -> creation d'un successeur DUPLIQUE (pollution serveur + fork).
  Desormais, sur `unknown` (reseau) le reboot est REPORTE (return, retente au prochain tick) ;
  `absent` -> `meta=null` (comportement 404 d'avant preserve) ; `active`/`tombstone` -> meta lue.
Restent volontairement sur `getGroupMeta`/`.catch(()=>null)` les consommateurs NON destructeurs
(resolveTerminalGroup, dedup conversations, lookups predecesseur) ou un defaut `null` est sans
danger. Tests : `recovery.test.ts` (19, defaut mock = meta active).

### S2 - Retours "vides" indistinguables de l'echec

`fetchUserDevices`->`[]`, `getGroupMembers`->`[]`, `getGroupUserMembers`->`[]`,
`deleteDeviceMembership`->`{affected:0}`, `acquireAddLock`->`false` sur exception
(`frontend/src/lib/mls-client/mlsDeliveryApi.ts:133-161,624-648,340-356`).
`inviteMembers` interprete `[]` comme "aucun membre -> abort"
(`frontend/src/lib/utils/chat/recovery.ts:540-559`) -> on saute des invitations legitimes.

**FIXED** : les trois getters de liste (`fetchUserDevices`, `getGroupMembers`,
`getGroupUserMembers`) LEVENT desormais une erreur sur echec transport/HTTP et ne renvoient `[]`
que pour un vrai 200 vide -> un `[]` n'est plus jamais indiscernable d'un echec. Le chemin
DESTRUCTEUR (`inviteMembers` : sources primaire `getGroupMembers` et fallback `getGroupUserMembers`)
laisse l'erreur remonter au `.catch` log de l'appelant (reboot/health) au lieu de fabriquer un
successeur sans membre ; le filet `epoch == 0` du health-check re-invite une fois le reseau revenu.
Les appelants legitimement best-effort opt-in explicitement via `.catch(() => [])` :
`createNewGroup`/DM (nos propres devices), `processPendingInvitations` et `handleWelcomeRequest`
(pour preserver le fallback `fetchDeviceKeyPackage`), re-fetch post-kick. Les consommateurs de
membership (`verifyCurrentUserMembership`, `loadGroupMembers`, `DeviceManagementPanel`) etaient
deja sous try/catch a defaut benin (`-> true`/`[]`), donc le throw n'introduit aucun faux
"vous avez ete retire". Volontairement laisses tels quels : `deleteDeviceMembership` (`{affected:0}`
consomme uniquement sous `.catch(()=>{})`) et `acquireAddLock`->`false` (fail-safe documente).

### S3 - `any` qui efface la surete de type sur la livraison

- `deliveryMeta: any` : `frontend/src/lib/mls-client/messagePipeline/setupMessageHandler.ts:483`.
- `onChannelEvent?: (event: { type: string; data: any })` : `frontend/src/lib/services/BaseMlsService.ts:52`.
- `devices.map((d: any) => ...)` : `frontend/src/lib/mls-client/mlsDeliveryApi.ts:150`.
`IncomingDeliveryMeta` existe deja -> l'utiliser partout.

**FIXED** : `KnownGroupArgs.deliveryMeta` type `IncomingDeliveryMeta | undefined` (import ajoute) ;
`onChannelEvent` callback `data: unknown` (au lieu de `any`) dans `IMlsService` et `BaseMlsService`
(le payload heterogene est narrowe par `event.type` dans `handleChannelEvent`) ; `fetchUserDevices`
type le JSON serveur (cast explicite) au lieu de `(d: any)`. Les champs optionnels restent
re-valides par `typeof`.

### S4 - Troncature u64 -> u32 sur les epochs (FIXED)

`get_epoch` renvoyait `epoch as u32` (`mls-wasm`, `src-tauri`), `forget_group` prenait
`min_epoch: u32` - perte de veracite (la source est u64).

**FIX** : largeur preservee jusqu'a la frontiere JS. Cote **Tauri** (`obtenir_epoch` / `oublier_groupe`)
-> `u64` (serialise en JSON number). Cote **WASM** (`get_epoch` / `forget_group`) -> `f64` :
wasm-bindgen n'a pas de mapping u64 -> JS number (il produit un BigInt), et `f64` represente
exactement tout epoch <= 2^53 (jamais atteint). Cote TS, l'epoch reste un `number` -> aucun
changement consommateur. WASM regenere.

### M1 - Messages applicatifs en retard > 2 epochs -> drop silencieux

Lieu : `frontend/mls-core/src/lib.rs:894-923`. Avec `max_past_epochs(2)`, un message applicatif
livre avec plus de 2 epochs de retard renvoie `Ok(None)` (compte comme doublon) -> perte
possible. En partie par-design.

### M2 - Replay historique : WrongEpoch marque "vu" definitivement

Lieu : `frontend/src/lib/utils/chat/history.ts:316-327`. Dans le replay, `CannotDecryptOwnMessage`,
`WrongEpoch` et `SecretReuseError` sont ajoutes a `seenCipherHashes` (skip pour toujours).
`WrongEpoch` peut etre transitoirement non-dechiffrable (commit pas encore applique) ; le marquer
vu definitivement peut sauter un message recuperable. `GAP_QUEUED` est correctement exclu du skip.
Note : Passe 1 a deja retire `TooDistantInThePast` de ce chemin (devenu `Ok(None)` -> plus de spam
"History msg error" ni d'avancement de curseur errone).

**FIXED** : `WrongEpoch` rejoint la branche retryable de `GAP_QUEUED` (`skipSeenHash = true`, pas
d'avancement de curseur) au lieu de la branche "non-recuperable" : l'entree est retentee au prochain
chargement d'historique apres resync d'epoch. `CannotDecryptOwnMessage` et `SecretReuseError`
restent definitivement marques vus (vraiment non-recuperables). Compromis : un message bloque a une
epoch jamais atteinte (branche forkee non adoptee) est re-tente a chaque replay - meme semantique que
`GAP_QUEUED`, borne par la frequence des chargements.

### R1 - Decision de cycle de vie des groupes dupliquee sur 3-4 reconciliateurs

La question "ce groupe local est-il encore reel, et que faire ?" etait re-implementee dans
`discoverMissingGroups` (actions.ts), `syncConnectionAfterWsOpen` (initializeConnection.ts) et
`requestReAdd` (recovery.ts) avec des gardes divergentes. Chaque divergence = un bug : fantome
indeletable bloque en boucle readd/reboot (groupe hard-absent traite comme "a conserver"),
"statut serveur incertain" sur un groupe pourtant supprime (corps vide 200 -> 'error' au lieu de
'absent'), `serverListReliable` (liste vide suspecte) present dans un reconciliateur mais pas
l'autre.

**FIXED (unification)** : nouveau module pur `frontend/src/lib/utils/chat/groupLifecycle.ts` :
- `classifyServerStatus(raw)` -> etat serveur explicite `active | tombstone | absent | unknown`
  (leve l'ambiguite `null`/'error' partagee). Consomme par discovery ET requestReAdd.
- `decideAbsentGroupFate(input)` -> reducteur PUR `(etat serveur + signaux locaux) -> {keep |
  purge | markRemoved}`. C'est l'ancien bloc `!serverGroupIds.has(...)` de la discovery,
  extrait tel quel, teste exhaustivement (table de verite + invariant "seul un absent confirme
  purge"). `discoverMissingGroups` et `requestReAdd` consomment ce noyau unique.
Tests : `groupLifecycle.test.ts` (16 cas).

**FIXED (migration complete, commit 947b8805)** : le couple `(isReady, deletedRemotely)` est
remplace par un champ d'etat unique `Conversation.lifecycle: 'active' | 'pending' | 'removed'`
(`frontend/src/lib/types/index.ts`), PERSISTE (`ConversationMeta.lifecycle`, SQLite migration v4 +
IndexedDB, avec `normalizeConversationLifecycle` pour les anciennes lignes). Cela corrige un bug de
coherence latent : `deletedRemotely` n'etait jamais persiste -> l'etat "supprime par un pair"
disparaissait au reload et la conv pouvait etre purgee a tort si le tombstone serveur avait ete
hard-purge (violation des regles 2/4). ~110 sites migres (writes `active`/`pending`/`removed`,
reads `lifecycle === 'active'`), interface `Conversation` dupliquee dans `Sidebar.svelte` supprimee
(masquait le changement de type). `decideAbsentGroupFate` prend desormais `lifecycle` en entree et
emet l'action `markRemoved`. Reste hors scope (verif device / risque UI) : l'unification des passes
de forget-WASM (`serverListReliable`).

### S5 - Classification d'erreurs MLS dupliquee sur 4 couches

Le meme string-matching d'erreurs OpenMLS est reparti dans :
`frontend/src-tauri/src/lib.rs` (`recevoir_message_bytes`, `map_decrypt_outcome`),
`frontend/src/lib/mls-client/messagePipeline/setupMessageHandler.ts` (`handleKnownGroup`),
`frontend/src/lib/utils/chat/history.ts` (replay). Passe 1 a centralise les cas same-epoch benins
dans `mls-core` (source unique), mais `WrongEpoch`, `NoMatchingKeyPackage`, `GAP_QUEUED`,
`CannotDecryptOwnMessage` restent matches par sous-chaine a plusieurs endroits -> divergence facile.
Piste : un type d'erreur structure expose par `mls-core` (enum) consomme partout.

**FIXED (volet TS)** : nouveau module pur `frontend/src/lib/mls-client/mlsDecryptError.ts` :
`classifyIncomingDecryptError(error) -> MlsDecryptErrorKind` (`own-message | secret-reuse |
epoch-gap | wrong-epoch | oom | unknown`). C'est la SOURCE UNIQUE du string-matching des erreurs de
dechiffrement entrant ; `handleKnownGroup` (temps-reel) et `history.ts` (replay) le consomment et
gardent chacun leur POLITIQUE distincte (ACK/escalade gap/fatal vs mark-seen/retry), qui differe
legitimement. Plus aucune sous-chaine dupliquee entre ces deux chemins -> une divergence (ex. M2 :
`WrongEpoch` retryable d'un cote, "vu definitif" de l'autre) devient impossible. Tests :
`mlsDecryptError.test.ts` (7 cas). Restent HORS scope (domaines distincts, non dupliques) :
`handleUnknownGroup` (erreurs de Welcome : `GroupAlreadyExists`/`NoMatchingKeyPackage`),
`wasmLogShim`/`mlsWasmLoader` (filtrage de bruit de log), `actions.ts` (fork commit-send via
`parseForkedEpoch`).

**FIXED (volet Rust natif)** : `mls-core` expose `MlsError::decrypt_kind() -> DecryptErrorKind`
(`SecretReuse | SenderRatchetGap | Unrecoverable | Other`) - source UNIQUE du string-matching des
erreurs OpenMLS. `recevoir_message_bytes` et `map_decrypt_outcome` (`src-tauri`) le consomment au
lieu de matcher `"SecretReuseError"` / `"Process error:"` / `"UNRECOVERABLE:"` a la main. Les
sous-chaines ne vivent plus qu'a un seul endroit (mls-core), partage par le chemin WASM web et le
chemin natif Tauri.

---

## FCM / PUSH (Android background) - revue de bout en bout

Parcours audite : enrolement du token -> reception FCM (`onMessageReceived`) -> branchements
(welcome_request / Welcome / social / process_queue / message chiffre) -> traitement background JNI
-> affichage de notification. Fichier : `frontend/src-tauri/gen/android/.../CanariFirebaseMessagingService.kt`.

### Diagnostic terrain (logs 2026-06-21, B mobile)
A envoie, B (mobile) ne voit RIEN et n'a AUCUNE notification. Logs SERVEUR :
`[SEND] recipient=...:web-...-mqigddgf online=false` + `[PUSH_SEND] No push token` pour CHAQUE
message de A, et `FALLBACK_MEMBERS_CACHE count=1`. -> les messages de A ne sont routes QUE vers le
device WEB de B (hors-ligne, navigateur = pas de token FCM). Le device MOBILE de B n'est PAS dans la
liste des destinataires car `dm_device_group_memberships` ne le liste pas en `status='active'`
(la resolution des destinataires filtre sur active, `messaging.service.ts:458-465`).

### DB1 - SQLite sans busy_timeout : messages dechiffres mais jamais affiches (FIXED)
Sur le mobile, le rattrapage d'historique echoue : `[WARN] Echec replay historique ... database is
locked`. Le replay (`history.ts`) dechiffre via `recevoir_messages_batch` (le ratchet AVANCE, mls.bin
persiste) PUIS `saveMessages` ; si une autre connexion tient le verrou d'ecriture (moteur natif
background/FCM/WorkManager, ou checkpoint WAL), l'ecriture echoue IMMEDIATEMENT (aucun `busy_timeout`)
-> `session.finish()` (finally) commit le ratchet quand meme -> messages dechiffres mais jamais sauves,
et IRRECUPERABLES. FIX : `PRAGMA busy_timeout=5000` (foreground `canari.db`) + `.busy_timeout(5s)`
sur les pools natifs sqlx (`mls_pending.db`). Commit `05eeeb26`.

### FCM0 - Chemin Welcome idempotent foreground ne promeut pas 'active' (FIXED)
Le join Welcome NORMAL (`setupMessageHandler.ts:312`) appelle `updateInvitationStatus('active')`. Mais
quand un device a rejoint en BACKGROUND (FCM) puis revient au premier plan, le Welcome redelivre tombe
sur le chemin idempotent "deja detenu" (`setupMessageHandler.ts:231-242`) qui mettait le lifecycle local
a `active` SANS appeler le serveur -> membership figee a `pending` -> exclue du routage. FIX : appel
`updateInvitationStatus('active')` (fire-and-forget) ajoute sur ce chemin (commit de cette passe).

### FCM1 - Le join Welcome en BACKGROUND ne promeut JAMAIS la membership 'active' (OPEN)
`processReceivedWelcomeBackground` (`...Service.kt:814`) rejoint le groupe MLS (JNI
`nativeProcessWelcomeBackground`) mais n'appelle NI `registerMember` NI `updateInvitationStatus('active')`.
Il ne le PEUT pas : le background s'authentifie en `PushSecret`, or `invitations/status` est garde par
JWT (`HeaderAuthGuard`). Consequence : un device qui rejoint un groupe en arriere-plan reste `pending`
cote serveur ; il ne recoit AUCUN message suivant en temps-reel ni en push tant que l'app n'est pas
rouverte (ou seul FCM0 le promeut). FCM0 corrige le cas "l'app revient au premier plan" mais la livraison
background pure reste cassee. FIX a faire : endpoint PushSecret d'activation de membership, appele par
`processReceivedWelcomeBackground` apres un join reussi (et idealement par le worker apres un drain).

### FCM2 - `onNewToken` ne pousse pas le token au backend (OPEN)
`onNewToken` (`...Service.kt:188`) persiste le token localement (SharedPrefs + `fcm_token.txt`) mais ne
le transmet jamais au backend ; l'enregistrement serveur n'a lieu qu'au prochain demarrage foreground
(`registerPushToken`). Si FCM fait tourner le token pendant que l'app est tuee, le serveur garde l'ancien
token -> push vers un token mort (echec silencieux, ou `[PUSH_SEND] No push token`) jusqu'a reouverture.
Fenetre de notifications manquees. FIX : enregistrer le nouveau token cote backend depuis `onNewToken`
(auth PushSecret, idempotent), pas seulement le persister.

### FCM3 - Garde foreground `isInForeground` TOCTOU (OPEN, = C1/C2)
`onMessageReceived:216` : si `MainActivity.isInForeground`, le background s'abstient (le foreground WS
gere). Mais `isInForeground` peut etre perime pendant une transition background<->foreground -> un message
arrive pile a cet instant peut n'etre traite NI par le background (croit que le foreground gere) NI par le
foreground (WS pas encore re-etabli). Meme racine que C1/C2 (verrou commun WebView<->JNI manquant).

### Points FCM sains
- `welcome_request_pending` background (`...Service.kt:439`) : add-lock Redis + retries, JNI sous
  `MlsStateLock`, `sendWelcomeAndCommit` transmet `baseEpoch` pour `validateCommit` (C6). Solide.
- `tryDecrypt` : `fetchProto` hors verrou, `MlsStateLock` tenu uniquement pour le JNI (mls.bin+Argon2).
- `showNotification` : supprimee si l'app est au premier plan ; fallback generique si dechiffrement KO.
- Le push data-only (`messaging.service.ts:294`) fait bien declencher `onMessageReceived` fg+bg ; le
  non-affichage observe vient de FCM0/FCM1 (pas de push vers le device), PAS d'un throttling data-only.

---

## Points sains (rappel)

- Liberation des verrous Redis par script Lua atomique :
  `apps/chat-delivery-service/src/controllers/locks.controller.ts:55-60`.
- `acquireAddLock`/`acquireRebootLock` fail-safe `false` si Redis down :
  `frontend/src/lib/mls-client/mlsDeliveryApi.ts:350-355`.
- Ecriture atomique de `mls.bin` (tmp + rename) : `frontend/src-tauri/src/lib.rs:113-117`.
- Cache CBOR avec invariant `mark_state_dirty` documente : `frontend/mls-core/src/lib.rs:154-164`.
- Tests presents : `frontend/mls-core/tests/epoch_race.rs`, `add_members_dedup.rs`.

---

## Plan de correction (multi-passes)

### Passe 1 - Stopper l'amplification (rame en rafale) - C0/C0b/C0c
1. mls-core : a `msg_epoch == group_epoch`, mapper `TooDistantInThePast` (+ tout ratchet
   meme-epoch non-future) comme doublon benin -> `Ok(None)`. Eviter toute mise en file.
2. Native `recevoir_message_bytes` : ne plus router les erreurs meme-epoch vers SQLite.
3. Foreground/web `handleKnownGroup` : liste benigne (ACK) pour `TooDistantInThePast`.
4. Config sender ratchet (creation + join) : augmenter `out_of_order_tolerance` /
   `maximum_forward_distance`. Rebuild WASM + bump version.
5. Verif : tests d'integration burst (N messages, livraison desordonnee+dupliquee) -> 0
   `GAP_QUEUED`, 0 recovery, 0 Argon2 superflu.

### Passe 2 - Concurrence background/foreground - C1/C2/C3
6. Reload `mls.bin` au resume (visible/focus) AVANT toute operation foreground.
7. Verrou commun WebView<->natif (etendre la portee au-dela de FCM<->Worker), ou serialiser
   strictement (un seul moteur actif a la fois, transition incluse).
8. `reconcileOutboxSent` aussi au `visibilitychange`->visible.
9. Verif : scenario background-send puis resume -> pas de regression `mls.bin`, pas de doublon.

### Passe 3 - Coeur mls-core - C4/C5
10. `process_welcome` : appliquer les guards (min_epoch, deja-actif) AVANT `into_group`, ou
    rollback storage si rejet. Plus d'etat orphelin.
11. `add_members_bulk` : remonter les KeyPackages invalides (liste `skipped_indices`) pour
    retry/republish cote caller, au lieu d'un drop silencieux.
12. Verif : tests Rust (re-Welcome stale, KeyPackage invalide isole).

### Passe 4 - Recovery/reboot + backend - H1..H5
13. TTL locks alignes sur la duree reelle (ou renouvellement de bail pendant la section).
14. Ne `forgetGroup` le predecesseur qu'apres confirmation de join du successeur.
15. Serialiser les mutations `conversations` par groupe.
16. `validateCommit` : retirer le bypass `activeEpoch == 0` (ou le restreindre a un vrai etat
    non-initialise).
17. Verif : tests reboot concurrents, pas de pollution serveur.

### Passe fork - Messages mobile invisibles sur PC - C6/C7/H7 (prioritaire)
F1. C6 : le chemin background (`send-welcome-and-commit`) valide le commit (bump `activeEpoch`)
    avant diffusion. JNI expose l'epoch de base, Kotlin le transmet, backend appelle `validateCommit`.
F2. H7 : `handleKnownGroup` ne reinitialise `epochGapSince` que sur un commit, pas sur un message
    applicatif d'un pair stale.
F3. C7 Option B (livree) : heal-on-reject. Chemin d'emission -> tout `epoch_mismatch` (ecart >= 1)
    declenche `recoverForkedGroup`. Predicat `isSenderForkError`.
F4. Verif device : mobile envoie -> visible sur tous les PC ; ajout de device en background ->
    pas de rejet `epoch_mismatch` au prochain commit foreground. (C6/H7 confirmes via logs.)
F5. C7 Option A (futur) : valider-puis-merger dans `mls-core` (no-merge avant acceptation ;
    `clear_pending_commit` sur rejet). Refactor profond, cycle de verif device dedie.

### Passe 5 - Strictness - S1..S4, M1
18. `getGroupMeta` et consorts : distinguer not-found / network-error (Result ou type d'erreur).
19. Typer `deliveryMeta`/`onChannelEvent` avec `IncomingDeliveryMeta`.
20. Auditer chaque `.catch(() => [])` pour ne pas confondre vide et echec.

### Passe finale - Verification croisee
21. Relire chaque diff de fix au regard de cet audit (ID par ID).
22. Re-tester sur device reel le scenario "rafale" + "background/foreground".
23. Mettre a jour ce document : statut par finding (OPEN / FIXED / VERIFIED).

## Retours tests device 2026-06-23 - plan de correction (DF1..DF11)

Numerotation DF* distincte des F1..F5 de la passe fork. Diagnostic du bug critique confirme par
les logs serveur de la fenetre 10:28-10:30 : un message envoye depuis le mobile a une epoch
perimee est bien PUBLISHED et ACK cote serveur (routage OK), mais les destinataires a jour ne
peuvent pas le dechiffrer (`msg_epoch < group_epoch`) -> message silencieusement perdu. Le 10:30
passe parce que le mobile avait entre-temps rattrape l'historique (`[HISTORY] entries=2`).

### Vague 1 (livree)
DF1a. FIXED - Gate `isGroupHealthy` (outbox) sur le registre de gap d'epoch. Avant : la sante du
    groupe ne testait que l'appartenance WASM, jamais le gap, en violation du contrat de
    `OutboxDeps.isGroupHealthy`. Desormais l'outbox tient ses envois tant qu'un gap connu n'est
    pas resorbe. Nouveau module `epochGapRegistry` (Map module-globale partagee pipeline<->outbox,
    remise a zero a chaque `setupMessageHandler`). Couvre le cas "l'emetteur SAIT qu'il est en
    retard" (a recu une frame indechiffrable). Ne couvre PAS la course "envoi a froid au resume"
    (cf. DF1c).
DF3. FIXED - `consumeFcmCache` : `mergeConversation` placeholder (INSERT OR IGNORE) avant
    `saveMessage`, pour ne plus violer la FK conversations(id) (code 787) quand un groupe vient
    d'etre rejoint en arriere-plan. La vraie sync ecrase le placeholder.
DF10. FIXED (deja en place) - Banniere "en attente de connexion" supprimee pendant l'init
    messaging (`isMessagingInitializing`) pour eviter le faux positif au demarrage.

### DF7 - boucle des invitations en attente (resolu)
Une invitation en attente = ligne `DeviceGroupMembership status='pending'`. Elle ne passe `active`
que lorsque le device INVITE confirme avoir traite son Welcome (`updateInvitationStatus`, protege
par `assertCallerOwnsUserId` : l'inviteur ne peut pas la promouvoir). Un device qui rejoint l'arbre
MLS sans jamais confirmer (Welcome perdu, zombie qui se reconnecte sans traiter son Welcome) laisse
sa ligne `pending` indefiniment -> re-listee a chaque sync -> boucle. Purger cote inviteur via
`deleteDeviceMembership` couperait le routage d'un membre legitime : ECARTE.

Deux chemins surs livres :
DF7a. FIXED (chemin existant, confirme) - Supprimer un device via "Gestion des appareils"
    (`deleteDevice` -> `purgeDeviceFootprint`) efface TOUTES ses lignes `DeviceGroupMembership`
    (dont `pending`), KeyPackages, messages en file, entrees Redis, et revoque le device. Nettoie
    immediatement les invitations portees par ses PROPRES devices stale.
DF7b. FIXED (nouveau GC serveur) - Cron `cleanupStalePendingInvitations` (24h) : supprime les
    lignes `pending` dont `updatedAt` depasse `STALE_PENDING_INVITATION_MS` (14j, constante
    dediee). Seuil volontairement bien plus court que la retention du Welcome (90j) : supprimer la
    ligne `pending` ne bloque PAS la reprise d'un device vivant - elle n'est que le declencheur/
    fallback durable cote inviteur ; le Welcome en file (table separee, 90j, sans nouveau commit)
    ou un `welcome_request` (le device reste `GroupMember`) assurent la reprise. Le seuil ne borne
    donc que la duree de conservation du declencheur. Couvre AUSSI les devices zombie d'autres
    utilisateurs (que le panneau ne peut pas toucher). Ne touche jamais les lignes `active` ni
    `dm_group_members`. Filtre sur `updatedAt` (et non `createdAt`) pour redonner une fenetre de
    grace a un device jadis actif remis `pending` par `detectStaleDevices`.

### Vague 2 (livree)
DF1c. FIXED - Course "envoi a froid au resume" : l'emetteur envoyait AVANT d'avoir traite le
    commit qui avance l'epoch. `fetchPendingMessages` (reconnect/resume) ne fait qu'ENFILER les
    frames ; leur traitement (commits) est asynchrone. L'outbox attend desormais
    `waitForMessageQueueIdle()` avant la boucle d'envoi (`runFlush`) -> l'epoch locale est a jour
    avant tout chiffrement. En regime permanent la file est deja idle (resolution immediate,
    aucune latence). Complete DF1a (qui ne couvrait que le cas "l'emetteur SAIT qu'il est en
    retard"). Reste DF1b (validation epoch cote serveur) en option de durcissement.

DF5. FIXED - Badge "Sync" persistant sur une conversation rejointe. La reconciliation au login
    demotait active->pending pour les groupes absents du WASM, mais ne promouvait JAMAIS l'inverse :
    une conversation persistee `pending` dont l'etat MLS est present localement (typiquement un join
    background : etat MLS sur disque + membership active serveur, mais lifecycle DB jamais flippe)
    restait `pending` -> badge "Sync" eternel ([[ConversationTile]] affiche le badge si
    `lifecycle !== 'active'`). Ajout de la promotion miroir pending->active quand le groupe est dans
    le WASM. Se combine avec DF3 (placeholder pending au join background -> promu actif a l'ouverture).

### Vague 3 (livree)
DF2. FIXED - Fenetre d'activation : pendant que le device est `pending`, la resolution des
    destinataires (`status='active'`) l'exclut -> aucune notification push pour les messages de la
    fenetre (le message arrive via rattrapage, mais la notif est perdue). A la transition
    pending->active (et UNIQUEMENT elle, via lecture de l'etat anterieur avant upsert), le serveur
    re-livre via FCM les messages applicatifs de la fenetre (stream `history:{groupId}`, qui exclut
    Welcome/Commit/silent). Le device vient de traiter son Welcome -> il peut dechiffrer. Borne a
    5 min / 50 msg ; dedup client par messageId.
DF8. FIXED - Pas d'atterrissage en bas a l'ouverture d'une conversation. Cause : la fenetre de
    rendu initiale etait de 180 groupes -> rendu synchrone de centaines de bulles -> le layout se
    pose apres le scroll-to-bottom. Reduite a 60 (un ecran, rendu instantane) ; `loadOlderGroups`
    pagine les plus anciens au scroll vers le haut. Garde `fillViewportThenPin` : elargit la
    fenetre si le 1er ecran est plus court que le viewport (sinon scroll-up injoignable), puis pin.
DF4. Bundle d'historique pre-join (C8) a investiguer. DF5/DF6 : badge Sync persistant + nettoyage
    devices stale. DF8/DF9/DF11 : rendu progressif, frictions scroll, bruit de logs.

### Vague 4 (livree) - stabilite connexion (logs PC 2026-06-23)
DF12. FIXED - Deconnexions WS 1006 a repetition. Le heartbeat gateway pingait toutes les 1s et
    fermait la connexion des qu'UN seul Pong manquait (fenetre ~1s). Une jitter reseau d'1s+
    (wifi/mobile/VPN, stalls) suffisait a declarer le client mort -> fermeture 1006 -> reconnexion
    en boucle (observe ~toutes les 30-90s dans les logs). Passe a ping=15s + tolerance
    MAX_MISSED_PONGS=4 (detection ~60s, sous le proxy_read_timeout nginx de 120s). Compteur
    AtomicU32 au lieu d'un booleen. Reduit aussi le trafic de heartbeat 15x.

DF13. FIXED - notify-reaction renvoyait 401 "User is not authenticated". `notifyReaction` faisait
    un `fetch` brut avec seulement Content-Type, SANS header Authorization. Le token d'acces etant
    en memoire (jamais en cookie), nginx `auth_request` ne recevait aucun token -> 401. Bascule sur
    `apiFetch` (injecte le Bearer + rejoue une fois sur 401 apres refresh). Sweep complet des autres
    `fetch('/api/...')` relatifs : pin-change/pin-status/pin-reset/pin-check attachent deja le token,
    ackRetry/deliveryKeepalive recoivent les headers du caller -> notifyReaction etait le seul oubli.
