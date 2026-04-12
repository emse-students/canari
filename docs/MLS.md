# Protocole MLS dans Canari

## 1. Introduction

Canari implémente le **Messaging Layer Security (MLS)** défini par la RFC 9420. MLS garantit la *confidentialité future* (forward secrecy) et la *sécurité post-compromission* (post-compromise security) pour les conversations de groupe. Chaque appareil est un membre MLS indépendant.

La ciphersuite utilisée est : **MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519**
- Échange de clé : DHKEM(X25519)
- Chiffrement de message : AES-128-GCM
- Hash : SHA-256
- Signature : Ed25519

---

## 2. Structure du code MLS

```
frontend/
├── mls-core/          # Librairie Rust pure (pas de WASM)
│   ├── src/
│   │   ├── lib.rs     # MlsManager — API principale
│   │   ├── security.rs  # Chiffrement de l'état persisté
│   │   └── ...
├── mls-wasm/          # Wrapper WASM (wasm-bindgen)
│   └── src/
│       └── lib.rs     # WasmMlsClient — expose à JavaScript
└── src-tauri/
    └── src/           # Commandes Tauri (même logique via mls-core natif)
```

Le frontend web utilise `mls-wasm` (chargé en WASM dans le navigateur).
L'application Tauri (desktop) utilise `mls-core` directement via des commandes Tauri.

---

## 3. mls-core : implémentation Rust

### 3.1 State persisté

L'état MLS complet est sérialisé et chiffré avant stockage (localStorage pour le web, fichier pour Tauri) :

```rust
struct PersistedState {
    identity_bundle: Vec<u8>,                    // keypair Ed25519 + identité "userId:deviceId"
    storage_values: HashMap<Vec<u8>, Vec<u8>>,   // état interne openmls (MemoryStorage)
    group_ids: Vec<Vec<u8>>,                     // liste des groupes connus
}
```

**Chiffrement de l'état** (`security.rs`) :
- Dérivation de clé : **Argon2id** (salt aléatoire OsRng 16 bytes) → clé 32 bytes
- Chiffrement du blob : **ChaCha20-Poly1305** (nonce aléatoire 12 bytes, préfixé au ciphertext)
- Input utilisateur : PIN numérique (dérivé en clé via Argon2id)

### 3.2 Identité

Chaque device a une identité MLS unique formée de `"userId:deviceId"` encodée comme `BasicCredential`. La clé de signature Ed25519 est générée à la création et fait partie du `identity_bundle` persisté.

### 3.3 KeyPackages

Un **KeyPackage** est un ensemble signé contenant :
- La clé publique HPKE du device (X25519)
- Les extensions MLS (durée de vie, capabilities)
- La signature Ed25519 de l'identité

Canari maintient :
- **1 KeyPackage standard** par device (table `key_packages`, écrasé à chaque enregistrement)
- **Pool de one-time KeyPackages** (table `one_time_key_packages`) — utilisés pour les Welcomes afin d'éviter les collisions d'epoch

### 3.4 Cycle de vie d'un groupe MLS

**Création** :
```
mls.create_group(groupId)           → état epoch 0
mls.generate_key_package()          → KeyPackage à publier
```

**Ajout de membres** :
```
mls.add_members_bulk(groupId, [keyPackageBytes...])
  → (commit_bytes, welcome_bytes, ratchet_tree_bytes)
```
Un seul `add_members_bulk` évite les erreurs d'epoch liées aux commits multiples simultanés.

**Réception d'un Welcome** :
```
mls.process_welcome(welcome_bytes, ratchet_tree_bytes?)
  → intègre le groupe, état MLS synchronisé
```

**Envoi d'un message** :
```
mls.send_message(groupId, plaintext_bytes)
  → ciphertext MLS (chiffré pour l'epoch courant du groupe)
```

**Réception d'un message** :
```
mls.process_incoming_message(groupId, ciphertext_bytes)
  → Some(plaintext_bytes) | None (commit de gestion)
```

**Retrait d'un membre** :
```
mls.remove_member(groupId, ["userId:deviceId", ...])
  → commit MLS → epoch +1 → anciens membres ne peuvent plus déchiffrer
```

**Oubli d'un groupe** :
```
mls.forget_group(groupId, minEpoch)
  → supprime l'état local, refuse les Welcomes périmés (< minEpoch)
```

**Export de secret** :
```
mls.export_secret(groupId, label, context, keyLen)
  → secret dérivé de l'état du groupe (usage : sync multi-device)
```

---

## 4. mls-wasm : bindings JavaScript

`WasmMlsClient` expose l'API de `MlsManager` à JavaScript via `wasm-bindgen` :

```typescript
// Initialisation
const client = await WasmMlsClient.new(userId, deviceId, persistedStateBase64, pin);

// Génère un KeyPackage à publier
const kpBase64: string = client.generate_key_package();

// Crée un groupe
client.create_group(groupId);

// Ajoute des membres (bulk)
const result = client.add_members_bulk(groupId, [kp1Base64, kp2Base64]);
// result = { commit, welcome, ratchet_tree } (base64)

// Traite un Welcome reçu
client.process_welcome(welcomeBase64, ratchetTreeBase64?);

// Envoie un message
const ciphertext: string = client.send_message(groupId, plaintextBytes);

// Reçoit un message
const plaintext: Uint8Array | null = client.process_incoming_message(groupId, ciphertextBytes);

// Sauvegarde l'état (à appeler après chaque opération)
const newState: string = client.save_state();
```

**Gestion des erreurs silencieuses** : les erreurs `WrongEpoch`, `SecretReuseError` et `CannotDecryptOwnMessage` sont ignorées sans lever d'exception.

---

## 5. WebMlsService / TauriMlsService

Les deux services implémentent l'interface `IMlsService` en TypeScript.

### 5.1 File de traitement séquentielle

Toutes les opérations MLS passent par une file de promesses (`messageQueue`) pour éviter la corruption de l'état par des opérations concurrentes :

```typescript
private messageQueue: Promise<void> = Promise.resolve();

private enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const task = this.messageQueue.then(() => fn());
  this.messageQueue = task.then(() => {}, () => {});
  return task;
}
```

### 5.2 Connexion WebSocket

Le WebSocket se connecte sur `VITE_GATEWAY_URL/api/ws?device_id={deviceId}`.

L'authentification se fait via le cookie `canari_ws_token` (SameSite=Lax, httpOnly=false pour être lisible par JavaScript).

### 5.3 Buffer de messages en attente

Si un message arrive pour un groupe pour lequel le Welcome n'a pas encore été reçu, il est mis en tampon dans `pendingWelcomeGroups` et rejoué une fois le Welcome traité.

### 5.4 Flux de traitement des messages reçus

```
WS frame { proto, senderId, senderDeviceId, groupId, isWelcome, isCommit }
  │
  ├── isWelcome → processWelcome(proto, ratchetTree)
  │     → mls.process_welcome(...)
  │     → rejouer les messages en buffer pour ce groupe
  │
  ├── isCommit → processCommit(groupId, proto)
  │     → mls.process_incoming_message(groupId, proto) → null
  │     (les commits ne contiennent pas de message applicatif)
  │
  └── message normal → processMessage(groupId, proto)
        → mls.process_incoming_message(groupId, proto) → plaintext_bytes
        → deserialise AppMessage (Protobuf)
        → met à jour le store de conversation
```

---

## 6. Bootstrap : initialisation d'un device

Le bootstrap se déclenche à chaque connexion de l'utilisateur, qu'il s'agisse du tout premier appareil ou d'un nouvel appareil rejoignant un compte existant.

### 6.1 Séquence complète

```
1. Vérification du PIN
   POST /api/mls-api/pin-verifier/check { userId, verifier }

   verifier = PBKDF2-SHA256(pin, userId)  — jamais le PIN brut

   Réponses possibles :
   ├── { status: "registered" }   → premier appareil, PIN enregistré
   ├── { status: "ok" }           → PIN correct pour un compte existant
   └── { status: "mismatch" }     → PIN incorrect → login refusé
                                    (tous les appareils d'un compte partagent le même PIN)

2. Résolution du device ID
   Si localStorage["mls_device_id_{userId}"] existe → réutilisé
   Sinon → généré : "web-{userId}-{timestamp36}-{random4}"
                 ou "tauri-{userId}-{timestamp36}-{random4}"
   Stocké dans localStorage (permanent).

3. Initialisation de l'état MLS (mls-core / WASM)
   Si localStorage["mls_autosave_{userId}"] existe :
     → bytes = fromHex(savedState)
     → MlsManager::load_encrypted(userId, deviceId, Some(bytes), pin)
       → déchiffre avec ChaCha20-Poly1305 (clé Argon2id depuis pin)
       → restaure keypair Ed25519 + credential + groupes

   Sinon (nouvel appareil) :
     → MlsManager::load_or_create(userId, deviceId, None)
       → génère un keypair Ed25519 frais
       → credential = BasicCredential("userId:deviceId")
       → état vide (aucun groupe)

4. Publication du KeyPackage
   kpBytes = mls.generate_key_package()
   POST /api/mls-api/register-device { userId, deviceId, keyPackage: base64(kpBytes) }
   → le serveur stocke/écrase dans la table key_packages
   → retourne les groupes auxquels l'utilisateur appartient côté serveur

5. Publication du pool de one-time KeyPackages (optionnel)
   packages = mls.generate_key_packages(N)
   POST /api/mls-api/register-device/prekeys { userId, deviceId, keyPackages[] }
   → alimente one_time_key_packages (un par Welcome futur)

6. Récupération et traitement des Welcomes en attente
   GET /api/mls-api/welcome
   → tableau de { welcome, ratchetTree, groupId }
   Pour chaque Welcome :
     mls.process_welcome(welcomeBytes, ratchetTree?) → rejoint le groupe
     → sauvegarde état

7. Découverte des groupes manquants (discoverMissingGroups)
   Comparer groupes serveur vs état MLS local.
   Pour chaque groupe présent côté serveur mais absent localement :
     a. Si d'autres membres sont connectés :
        → envoyer welcome_request via WS → un pair envoie un Welcome
     b. Sinon (timeout BOOTSTRAP_TIMEOUT_MS = 30s dépassé) :
        → forceCreateGroup + addMembersBulk (re-création complète)
        → envoyer group_reset aux autres membres
           (chaque pair reçoit group_reset → forgetGroup + attend Welcome)

8. Sauvegarde de l'état MLS
   stateBytes = mls.save_state()     → sérialise + chiffre (ChaCha20-Poly1305)
   localStorage["mls_autosave_{userId}"] = toHex(stateBytes)
   Appelée après chaque opération MLS (send, receive, add/remove member).
```

### 6.2 Nouveaux appareils d'un compte existant

Quand un utilisateur ajoute un nouvel appareil, les conversations existantes ne sont **pas** automatiquement disponibles — MLS exige que l'initiateur du groupe envoie un Welcome au nouveau device.

Flux :
1. Nouvel appareil → `POST /api/mls-api/register-device` → KeyPackage publié
2. Serveur notifie les membres existants via Redis (`group.member.device_added`)
3. Un des appareils existants reçoit un `welcome_request` WS :
   - Récupère le KeyPackage du nouveau device
   - `addMember(groupId, keyPackage)` → commit + Welcome
   - `POST /api/mls-api/welcome` → Welcome stocké offline
   - `POST /api/mls-api/send` (commit) → distribué via Redis
4. Nouveau device reçoit le Welcome → `process_welcome` → groupe rejoint

Si le nouvel appareil est en ligne au moment où un pair traite le welcome_request, le Welcome arrive directement via WebSocket.

### 6.3 Récupération après perte d'état (group_reset)

Si un device perd son état MLS local (localStorage effacé, désinstallation, etc.) :

```
Device perdu                          Membres existants
─────────────                         ─────────────────
forceCreateGroup(groupId)             ← group_reset reçu
  → epoch 0 local                       forgetGroup(groupId)
  → envoyer group_reset WS              marquer conversation not-ready
addMembersBulk([tous les devices])    ← welcome_request envoyé
  → Welcome pour chaque device          process_welcome()
POST /api/mls-api/welcome                → rejoindre le groupe
POST /api/mls-api/send (commit)
```

Le mécanisme de retry (`discoverMissingGroups` relancé à t+35s et t+70s) couvre le cas où le premier bootstrap échoue car tous les pairs sont hors ligne.

---

## 7. Payload applicatif chiffré : AppMessage (Protobuf)

Défini dans `libs/proto/canari.proto`. Le plaintext MLS est le sérialisation Protobuf d'un `AppMessage` :

```protobuf
message AppMessage {
  oneof payload {
    TextMsg   text    = 1;
    ReplyMsg  reply   = 2;
    ReactionMsg reaction = 3;
    MediaMsg  media   = 4;
    SystemMsg system  = 5;
    CallMsg   call    = 6;
  }
}

message TextMsg   { string content = 1; }

message ReplyMsg  {
  string content = 1;
  ReplyRef reply_to = 2;
}

message ReplyRef  {
  string id = 1;
  string sender_id = 2;
  string preview = 3;
}

message ReactionMsg {
  string message_id = 1;
  string emoji = 2;
}

message MediaMsg {
  MediaKind kind = 1;    // IMAGE, VIDEO, AUDIO, FILE
  string media_id = 2;   // identifiant MinIO
  bytes  key = 3;        // CEK AES-256 (32 bytes) — chiffrée dans le proto MLS
  bytes  iv = 4;         // IV GCM (12 bytes)
  string mime_type = 5;
  int64  size = 6;
  string file_name = 7;
  string caption = 8;
}

message SystemMsg {
  string event = 1;      // "groupRenamed" | "memberAdded" | "memberRemoved" | "groupDeleted"
}

message CallMsg {
  string call_id = 1;
  oneof signal {
    string offer_sdp     = 2;
    string answer_sdp    = 3;
    string ice_candidate = 4;
    bool   hangup        = 5;
  }
}
```

---

## 8. Médias chiffrés E2EE

Le service media ne voit jamais les clés de déchiffrement :

```
1. Expéditeur génère : CEK (AES-256-GCM, 32B) + IV (12B)
2. Chiffre le fichier local : AES-256-GCM(CEK, IV, blob)
3. POST /api/media/upload { ciphertext } → { mediaId }
4. Envoie un MediaMsg MLS : { media_id, key=CEK, iv=IV, ... }
   (CEK + IV voyagent chiffrés dans le ciphertext MLS)
5. Destinataire déchiffre : GET /api/media/{id} → blob_chiffré
   AES-256-GCM(CEK_depuis_plaintext_MLS, IV, blob_chiffré) → fichier clair
```

---

## 9. Synchronisation multi-device (SyncEngine)

Le `SyncEngine` (`frontend/src/lib/sync/syncEngine.ts`) synchronise les conversations entre deux appareils du même utilisateur via un protocole pair-à-pair chiffré :

```
Device A (source)                          Device B (cible)
─────────────────                          ────────────────
buildLocalSyncManifest()
POST /api/mls-api/sync/session/start
  { offerPublicKey (ECDH ephémère) }
                                           Scan QR code / token
                                           POST /api/mls-api/sync/session/join
                                             { answerPublicKey }
Dérivation clé partagée ECDH ──────────── Dérivation clé partagée ECDH
diffLocalAndRemoteManifest()
  → missingOnRequester, missingOnPeer
PUT /api/mls-api/sync/session/upload
  { chunks chiffrés AES-GCM }             GET /api/mls-api/sync/session/download
import des messages manquants              import des messages manquants
```

Le chiffrement des chunks utilise la clé dérivée de l'échange ECDH, en AES-256-GCM.

---

## 10. API chat-delivery-service (endpoints MLS)

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/api/mls-api/register-device` | Enregistre un device (KeyPackage + push token) |
| `POST` | `/api/mls-api/key-package` | Met à jour le KeyPackage standard |
| `GET` | `/api/mls-api/:userId/devices` | Liste les KeyPackages disponibles d'un utilisateur |
| `POST` | `/api/mls-api/groups` | Crée un groupe MLS (`{ groupId, createdBy, members[], isGroup }`) |
| `GET` | `/api/mls-api/groups/:groupId/members` | Membres d'un groupe |
| `POST` | `/api/mls-api/welcome` | Stocke un Welcome offline pour un device |
| `GET` | `/api/mls-api/welcome` | Récupère les Welcomes en attente pour le device courant |
| `POST` | `/api/mls-api/send` | Envoie un message MLS (publie en Redis + push notif offline) |
| `GET` | `/api/mls-api/messages/:groupId` | Messages en attente offline |
| `POST` | `/api/mls-api/register-member` | Enregistre un membre dans un groupe |
| `GET` | `/api/history/:groupId` | Lit le Redis Stream `history:{groupId}` |
| `POST` | `/api/mls-api/link-preview` | Génère une prévisualisation de lien (OG tags) |
| `POST` | `/api/mls-api/sync/session/start` | Démarre une session de sync |
| `POST` | `/api/mls-api/sync/session/join` | Rejoint une session de sync |
| `PUT` | `/api/mls-api/sync/session/:id/upload` | Upload de chunks de sync |
| `GET` | `/api/mls-api/sync/session/:id/download` | Download de chunks de sync |
| `POST` | `/api/mls-api/pin-verifier/check` | Vérifie un PIN (test de déchiffrement état MLS) |

---

## 11. Garanties de sécurité

| Propriété | Mécanisme |
|---|---|
| Confidentialité des messages | AES-128-GCM, chiffrement MLS par epoch |
| Forward secrecy | Rotation de clé à chaque commit MLS (epoch +1) |
| Post-compromise security | Suppression d'un membre → nouvel epoch inaccessible aux exclus |
| Authenticité des messages | Signature Ed25519 de chaque KeyPackage |
| Confidentialité de l'état local | ChaCha20-Poly1305 + Argon2id (PIN utilisateur) |
| Confidentialité des médias | AES-256-GCM côté client, clé dans le ciphertext MLS |
| Transport | HTTPS (Cloudflare TLS) + JWT HS256 pour l'API |
