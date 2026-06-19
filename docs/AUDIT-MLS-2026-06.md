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
| C1 | Deux moteurs MLS ecrivent mls.bin (garde booleenne) | OPEN (P2, design + verif device) | - |
| C2 | Foreground ne recharge jamais mls.bin au resume | OPEN (P2, design + verif device) | - |
| C3 | Double envoi outbox foreground/background | FIXED (P2, reconcile au resume) | ce9232bd |
| C4 | process_welcome persiste avant les guards -> orphelin | OPEN (P3) | - |
| C5 | add_members_bulk perte silencieuse de membres | OPEN (P3) | - |
| H1 | TTL locks reboot/add < duree reelle | OPEN (P4) | - |
| H2 | forgetGroup predecesseur premature | OPEN (P4) | - |
| H3 | Mutations conversations non atomiques | OPEN (P4) | - |
| H4 | validateCommit bypass epoch 0 | OPEN (P4) | - |
| H5 | Push differe + background redondants | OPEN (P4) | - |
| H6 | Evenements de controle (reactions/edits/...) hors outbox -> perte silencieuse | OPEN (P4) | - |
| S1..S4, M1 | Strictness / veracite | OPEN (P5) | - |
| M2 | Replay: WrongEpoch marque vu definitivement | OPEN (P5) | - |
| S5 | Classification d'erreurs MLS dupliquee 4 couches | OPEN (P5) | - |

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
WASM en memoire est perime -> la prochaine persistance foreground **ecrase** `mls.bin` ->
l'avancee background est perdue -> reutilisation de generation -> `SecretReuseError` chez les
pairs + regression d'epoch -> cascade de recovery.

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

Lieu : `frontend/mls-core/src/lib.rs:596-625`.
Toute KeyPackage qui echoue a `validate` (expiree, mauvais ciphersuite, cle privee perdue chez
le pair) est `continue` sans remontee au caller. Seul `added_indices` revient. La recovery
n'envoie de Welcome qu'aux `addedDeviceIds`
(`frontend/src/lib/utils/chat/recovery.ts:601-610`) -> le device saute n'est jamais invite ni
retente -> disparition silencieuse du groupe.

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

## STRICTNESS / VERACITE (retours ambigus, `any`)

### S1 - `getGroupMeta` : `null` pour 404 ET pour echec reseau

Lieu : `frontend/src/lib/mls-client/mlsDeliveryApi.ts:662-688`.
La recovery le reconnait comme bloquant
(`frontend/src/lib/utils/chat/recovery.ts:90-92`) et s'abstient -> un blip reseau est
indiscernable d'un groupe supprime et gele la recovery. Distinguer not-found de network-error.

### S2 - Retours "vides" indistinguables de l'echec

`fetchUserDevices`->`[]`, `getGroupMembers`->`[]`, `getGroupUserMembers`->`[]`,
`deleteDeviceMembership`->`{affected:0}`, `acquireAddLock`->`false` sur exception
(`frontend/src/lib/mls-client/mlsDeliveryApi.ts:133-161,624-648,340-356`).
`inviteMembers` interprete `[]` comme "aucun membre -> abort"
(`frontend/src/lib/utils/chat/recovery.ts:540-559`) -> on saute des invitations legitimes.

### S3 - `any` qui efface la surete de type sur la livraison

- `deliveryMeta: any` : `frontend/src/lib/mls-client/messagePipeline/setupMessageHandler.ts:483`.
- `onChannelEvent?: (event: { type: string; data: any })` : `frontend/src/lib/services/BaseMlsService.ts:52`.
- `devices.map((d: any) => ...)` : `frontend/src/lib/mls-client/mlsDeliveryApi.ts:150`.
`IncomingDeliveryMeta` existe deja -> l'utiliser partout.

### S4 - Troncature u64 -> u32 sur les epochs

`get_epoch` renvoie `epoch as u32` (`frontend/mls-wasm/src/lib.rs:148`,
`frontend/src-tauri/src/lib.rs:355`), `forget_group` prend `min_epoch: u32`. Perte de veracite
de type (la source est u64).

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

### S5 - Classification d'erreurs MLS dupliquee sur 4 couches

Le meme string-matching d'erreurs OpenMLS est reparti dans :
`frontend/src-tauri/src/lib.rs` (`recevoir_message_bytes`, `map_decrypt_outcome`),
`frontend/src/lib/mls-client/messagePipeline/setupMessageHandler.ts` (`handleKnownGroup`),
`frontend/src/lib/utils/chat/history.ts` (replay). Passe 1 a centralise les cas same-epoch benins
dans `mls-core` (source unique), mais `WrongEpoch`, `NoMatchingKeyPackage`, `GAP_QUEUED`,
`CannotDecryptOwnMessage` restent matches par sous-chaine a plusieurs endroits -> divergence facile.
Piste : un type d'erreur structure expose par `mls-core` (enum) consomme partout.

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

### Passe 5 - Strictness - S1..S4, M1
18. `getGroupMeta` et consorts : distinguer not-found / network-error (Result ou type d'erreur).
19. Typer `deliveryMeta`/`onChannelEvent` avec `IncomingDeliveryMeta`.
20. Auditer chaque `.catch(() => [])` pour ne pas confondre vide et echec.

### Passe finale - Verification croisee
21. Relire chaque diff de fix au regard de cet audit (ID par ID).
22. Re-tester sur device reel le scenario "rafale" + "background/foreground".
23. Mettre a jour ce document : statut par finding (OPEN / FIXED / VERIFIED).
