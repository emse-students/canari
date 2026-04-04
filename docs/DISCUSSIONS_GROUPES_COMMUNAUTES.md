# Documentation technique : Discussions, Groupes et Communautés

> Documentation exhaustive du système de messagerie Canari, détaillant chaque action possible, les fonctions impliquées, la gestion des epochs MLS, et les incohérences potentielles identifiées.

---

## Table des matières

1. [Architecture générale](#1-architecture-générale)
2. [Concepts MLS fondamentaux](#2-concepts-mls-fondamentaux)
3. [Cycle de vie d'une session](#3-cycle-de-vie-dune-session)
4. [Actions détaillées — Discussions 1-to-1](#4-actions-détaillées--discussions-1-to-1)
5. [Actions détaillées — Groupes](#5-actions-détaillées--groupes)
6. [Actions détaillées — Messages](#6-actions-détaillées--messages)
7. [Actions détaillées — Communautés (Channels)](#7-actions-détaillées--communautés-channels)
8. [Synchronisation multi-appareils](#8-synchronisation-multi-appareils)
9. [Système de file d'attente des messages](#9-système-de-file-dattente-des-messages)
10. [Gestion des groupes fantômes](#10-gestion-des-groupes-fantômes)
11. [Sauvegarde / Restauration](#11-sauvegarde--restauration)
12. [Tableau récapitulatif des opérations MLS et epochs](#12-tableau-récapitulatif-des-opérations-mls-et-epochs)
13. [Inventaire complet des fonctions](#13-inventaire-complet-des-fonctions)
14. [Fonctions inutilisées / code mort](#14-fonctions-inutilisées--code-mort)
15. [Incohérences temporelles et risques identifiés](#15-incohérences-temporelles-et-risques-identifiés)
16. [Corrections de résilience (Cycles 1-8)](#16-corrections-de-résilience-cycles-1-8)

---

## 1. Architecture générale

```
┌─────────────────┐     WebSocket / HTTP     ┌──────────────────┐     Redis PubSub     ┌───────────────────────┐
│   Frontend       │ ◄─────────────────────► │  Chat Gateway     │ ◄──────────────────► │  Chat Delivery Service │
│   (Svelte 5)     │                          │  (Rust)           │                      │  (NestJS)              │
│   + WASM MLS     │                          └──────────────────┘                      │  + PostgreSQL          │
│   (OpenMLS 0.8)  │                                                                    │  + MongoDB             │
└─────────────────┘                                                                     └───────────────────────┘
```

- **Frontend** : Application Svelte 5 + Tauri. Le chiffrement MLS est effectué côté client via OpenMLS compilé en WASM (`mls-wasm`).
- **Chat Gateway** : Serveur WebSocket Rust. Route les messages entre clients connectés.
- **Chat Delivery Service** : API NestJS. Stocke les métadonnées des groupes, les KeyPackages, les Welcome hors-ligne, l'historique chiffré.

### Fichiers principaux

| Fichier                                                 | Rôle                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| `frontend/src/lib/services/IMlsService.ts`              | Interface du service MLS (~30 méthodes)                        |
| `frontend/src/lib/services/WebMlsService.ts`            | Implémentation WASM pour le web                                |
| `frontend/src/lib/services/TauriMlsService.ts`          | Implémentation Tauri (IPC Rust) pour le desktop                |
| `frontend/src/lib/utils/chat/groupCreation.ts`          | Création de groupes et conversations 1-to-1                    |
| `frontend/src/lib/utils/chat/groupActions.ts`           | Renommage de groupe, retrait de membre                         |
| `frontend/src/lib/utils/chat/actions.ts`                | Synchronisation multi-appareils, backup, découverte de groupes |
| `frontend/src/lib/utils/chat/connection.ts`             | Gestion des messages entrants, traitement des Welcome          |
| `frontend/src/lib/utils/chat/conversations.ts`          | Chargement des conversations, dédoublonnage, migration         |
| `frontend/src/lib/utils/chat/history.ts`                | Rejeu de l'historique serveur, mapping des messages stockés    |
| `frontend/src/lib/utils/chat/messaging.ts`              | Envoi de messages, édition, suppression, read receipts         |
| `frontend/src/lib/composables/useChatSession.svelte.ts` | Composable principal : login, lifecycle, reconnexion           |
| `frontend/src/lib/composables/useMessaging.svelte.ts`   | Composable messagerie : envoi, UI optimiste, réactions         |
| `frontend/src/lib/db.ts`                                | Interface stockage (IndexedDB + SQLite)                        |
| `frontend/src/lib/backup.ts`                            | Export/import de sauvegardes chiffrées (.canari)               |
| `frontend/src/lib/envelope.ts`                          | Sérialisation/parsing des enveloppes de messages               |
| `frontend/src/lib/crypto/ChannelKeyVault.ts`            | Gestion des clés AES-256-GCM pour les communautés              |

---

## 2. Concepts MLS fondamentaux

### Epoch

Chaque groupe MLS possède un compteur d'**epoch** qui s'incrémente à chaque modification de la composition du groupe. Les opérations qui font avancer l'epoch sont :

| Opération                |       Epoch +1 ?        | Détail                                       |
| ------------------------ | :---------------------: | -------------------------------------------- |
| `createGroup`            |        Epoch = 0        | Initialisation                               |
| `addMember`              |         ✅ Oui          | 1 commit = 1 nouvel epoch                    |
| `addMembersBulk`         |     ✅ Oui (1 seul)     | 1 commit unique pour N appareils             |
| `removeMember`           |         ✅ Oui          | 1 commit pour retirer les appareils          |
| `processWelcome`         | ✅ Oui (côté récepteur) | Le récepteur rejoint à l'epoch du Welcome    |
| `processIncomingMessage` |  ✅ Oui (si handshake)  | Traitement d'un commit reçu = avance l'epoch |
| `sendMessage`            |         ❌ Non          | Chiffrement applicatif dans l'epoch courant  |
| `saveState`              |         ❌ Non          | Sérialisation uniquement                     |

### KeyPackage

Clé publique éphémère qu'un appareil publie pour permettre à d'autres de l'inviter dans un groupe. Chaque `generateKeyPackage` crée un nouveau KeyPackage et le publie sur le serveur.

### Welcome

Message d'invitation MLS envoyé après un `addMember`/`addMembersBulk`. Le récepteur appelle `processWelcome` pour rejoindre le groupe à l'epoch courant.

Important : un appareil **ne peut pas s'auto-ajouter** sans Welcome. Le Welcome doit être produit par un appareil qui possède déjà l'état MLS du groupe (même utilisateur sur un autre appareil, ou autre membre du groupe), puis livré au nouvel appareil.

### Commit

Message de contrôle MLS diffusé aux membres existants pour qu'ils fassent avancer leur epoch. Envoyé via `sendCommit` après chaque opération de membership.

---

## 3. Cycle de vie d'une session

**Fonction principale** : `login()` dans `useChatSession.svelte.ts`

### Séquence complète au login

```
1. login(userId, pin)
   │
   ├── 2. Vérification du PIN (déchiffrement de l'état MLS avec ChaCha20Poly1305 + Argon2)
   │
   ├── 3. mlsService.init(userId, pin, state?)
   │       → Charge le WASM OpenMLS
   │       → Crée ou restaure le WasmMlsClient
   │       → Génère un deviceId unique : "web-{userId}-{timestamp36}-{random}"
   │
   ├── 4. storage.init()
   │       → Ouvre IndexedDB (web) ou SQLite (Tauri)
   │
   ├── 5. loadExistingConversations(ctx)            [conversations.ts]
   │       ├── 5a. Phase 1 : Stubs rapides (conversations vides, immédiatement afichées)
   │       └── 5b. Phase 2 : En parallèle pour chaque conversation :
   │               ├── Déchiffrement des messages stockés (mapStoredMessagesToChatMessages)
   │               ├── Détection direct/group via API isGroup
   │               └── Rejeu de l'historique serveur (replayConversationHistory)
   │
   ├── 6. setupMessageHandler(deps)                 [connection.ts]
   │       → Enregistre le callback mlsService.onMessage(...)
   │       → Configure onChannelEvent pour les communautés
   │
   ├── 7. initializeConnection(deps)                [connection.ts]
   │       ├── 7a. mlsService.connect(token)
   │       │       → Ouverture WebSocket vers le Gateway
   │       │       → fetchPendingMessages() automatique à l'ouverture
   │       │           ├── GET /api/mls-api/welcome/{deviceId} (Welcome hors-ligne)
   │       │           └── GET /api/mls-api/messages/{userId}/{deviceId} (messages en attente)
   │       ├── 7b. generateKeyPackage(pin)
   │       │       → Publication du KeyPackage sur le serveur
   │       ├── 7c. Délai 500ms (propagation du KeyPackage)
   │       └── 7d. processDeviceInvitationsLocally()
   │
   ├── 8. processPendingInvitations(params)          [actions.ts]
   │       → Paradigme "Any member bootstraps" : n'importe quel appareil en ligne
   │         traite les DeviceGroupMembership en attente (pending) pour les groupes
   │         auxquels il appartient.
   │       → Fetch serveur → addMember → sendWelcome → updateInvitationStatus
   │
   └── 9. discoverMissingGroups(params)              [actions.ts]
           → Détecte les groupes serveur absents localement → crée des placeholders
```

### Reconnexion automatique

Gérée par `scheduleReconnect()` dans `useChatSession.svelte.ts` :

- Backoff exponentiel : `[1s, 2s, 4s, 8s, 16s, 30s]` (plafonné à 30s)
- À chaque reconnexion réussie : `fetchPendingMessages()` + `processPendingInvitations()` + `generateKeyPackage()`

---

## 4. Actions détaillées — Discussions 1-to-1

### 4.1 Créer une discussion directe

**Fonction** : `startNewConversation(contactName, deps)` → `groupCreation.ts`

```
Epoch Timeline :
  E0 ─── createGroup ──→ E0
  E0 ─── addMembersBulk(contact devices) ──→ E1
  E1 ─── sendCommit(E1) ──→ diffusé
  E1 ─── addMembersBulk(own other devices) ──→ E2
  E2 ─── sendCommit(E2) ──→ diffusé
```

**Étapes détaillées** :

1. **Vérification pré-création** : `fetchDevicesWithRetry(mlsService, contact, log, 6, 1500)`
   - Interroge `GET /api/mls-api/devices/{userId}` jusqu'à 6 fois avec 1.5s entre chaque tentative
   - Si aucun appareil trouvé → **abandon** (pas de groupe orphelin créé)

2. **Vérification de doublon** : Recherche dans `conversations` une entrée existante avec `conversationType === 'direct'` et `directPeerId === contact`
   - Si trouvé → `selectConversation()` et **retour immédiat**

3. **Création côté serveur** : `mlsService.createRemoteGroup(groupName, false)`
   - `POST /api/mls-api/groups` avec `{ name: "userId::contact", isGroup: false }`
   - Retourne un `groupId` unique

4. **Pré-affichage** : Ajout immédiat dans `conversations` avec `isReady: false`

5. **Création locale MLS** : `mlsService.createGroup(groupId)` → **Epoch 0** (groupe local vide)

6. **Enregistrement créateur** : `mlsService.registerMember(groupId, userId, deviceId)`
   - `POST /api/mls-api/groups/{groupId}/members`

7. **Ajout du contact** (bulk) : `mlsService.addMembersBulk(groupId, contactDevices)` → **Epoch 0 → 1**
   - WASM : `client.add_members_bulk(groupId, keyPackages[])`
   - Retourne `{ commit, welcome, addedDeviceIds, ratchetTree }`
   - Un seul commit pour tous les appareils du contact

8. **Enregistrement des appareils du contact** : Pour chaque `deviceId` ajouté → `registerMember()`

9. **Envoi des Welcome** : Pour chaque appareil du contact → `mlsService.sendWelcome(...)`
   - `POST /api/mls-api/welcome` → stockage MongoDB + broadcast Redis si en ligne

10. **Envoi du Commit** : `mlsService.sendCommit(commit, groupId)` → broadcast aux membres existants (ici : le créateur)

11. **Ajout des propres appareils** : `mlsService.addMembersBulk(groupId, ownDevices)` → **Epoch 1 → 2**
    - Même workflow : Welcome + Commit + registerMember

12. **Sauvegarde état MLS** : `mlsService.saveState(pin)` → `localStorage['mls_autosave_' + userId]`

13. **Finalisation** : `isReady: true`, `saveConversation()`

### 4.2 Réparer une discussion directe

**Fonction** : `repairDirectConversation(conversationKey, deps)` → `groupCreation.ts`

Même workflow que `startNewConversation` mais :

- Opère sur une conversation existante (met à jour le `groupId`)
- Retry limité à 3 tentatives / 1000ms au lieu de 6/1500ms
- Appelée quand une conversation directe est `isReady: false`

```
Epoch Timeline : identique à startNewConversation
  E0 → E1 (contact) → E2 (own devices)
```

---

## 5. Actions détaillées — Groupes

### 5.1 Créer un groupe multi-utilisateurs

**Fonction** : `createNewGroup(name, deps)` → `groupCreation.ts`

```
Epoch Timeline :
  E0 ─── createGroup ──→ E0
  E0 ─── addMembersBulk(own other devices) ──→ E1
  E1 ─── sendCommit(E1) ──→ diffusé
```

**Étapes détaillées** :

1. **Vérification de doublon** : Recherche d'un groupe existant avec le même nom (insensible à la casse)

2. **Génération de clé** : `conversationKey = "grp_" + crypto.randomUUID()`

3. **Création serveur** : `mlsService.createRemoteGroup(name, true)` avec `isGroup: true`

4. **Création locale** : `mlsService.createGroup(groupId)` → **Epoch 0**

5. **Enregistrement créateur** : `registerMember(groupId, userId, deviceId)`

6. **Ajout des propres appareils** (bulk) : `addMembersBulk(groupId, ownDevices)` → **Epoch 0 → 1**
   - Welcome envoyé à chaque appareil distant
   - Un seul Commit pour tous

7. **Sauvegarde état** + ajout dans `conversations` avec `isReady: true`, `conversationType: 'group'`

**Note** : Le groupe est créé SANS membres externes. L'invitation se fait dans une étape séparée.

### 5.2 Inviter des membres dans un groupe

**Fonction** : `inviteMembersToGroup(memberIds[], conversation, deps)` → `groupCreation.ts`
**Délègue à** : `processBulkAddition(memberIds, conversation, deps)` (helper interne)

```
Epoch Timeline :
  En ─── addMembersBulk(tous les appareils de tous les invités) ──→ En+1
  En+1 ── sendCommit ──→ diffusé
  En+1 ── sendMessage(memberAdded) ──→ notification système (pas d'epoch change)
```

**Étapes detaillées** :

1. **Collecte des appareils** : Pour chaque `targetUser` → `fetchDevicesWithRetry()`
   - Construit un tableau plat de tous les appareils de tous les utilisateurs
   - Maintient une `userMap: Map<deviceId, userId>` pour le mapping inverse

2. **Ajout bulk unique** : `addMembersBulk(groupId, allDevices)` → **Un seul changement d'epoch**
   - Crucial : un commit unique évite les erreurs `WrongEpoch` qui surviendraient avec des ajouts séquentiels

3. **Enregistrement serveur** : Pour chaque `addedDeviceId` → `registerMember(groupId, userId, deviceId)`

4. **Sauvegarde état MLS**

5. **Envoi des Welcome** : Pour chaque appareil ajouté → `sendWelcome(...)`
   - Envoi individuel (pas de broadcast Welcome)
   - Erreur sur un appareil n'annule pas les autres

6. **Envoi du Commit** : `sendCommit(commit, groupId)`

7. **Notification système** : `sendMessage(encodeAppMessage(mkSystem('memberAdded', {...})))`
   - Type protobuf `system` avec event `memberAdded`
   - Contient la liste des `newUsers` ajoutés

### 5.3 Inviter un seul membre

**Fonction** : `inviteMemberToGroup(memberId, conversation, deps)` → `groupCreation.ts`

- Simple wrapper : appelle `inviteMembersToGroup([memberId], ...)`

### 5.4 Renommer un groupe

**Fonction** : `renameGroupAndBroadcast(params)` → `groupActions.ts`

```
Epoch Timeline :
  En ─── renameGroup (HTTP PATCH, pas MLS) ──→ En (pas de changement)
  En ─── sendMessage(groupRenamed) ──→ En (message applicatif, pas d'epoch change)
```

**Étapes** :

1. `mlsService.renameGroup(groupId, newName)` → `PATCH /api/mls-api/groups/{groupId}` avec `{ name }`
2. `mlsService.sendMessage(...)` → diffuse un message système `groupRenamed` avec `{ newName }`
3. `saveState(pin)` → persistance

**Important** : Le renommage ne touche PAS l'arbre MLS → pas de changement d'epoch.

### 5.5 Supprimer un groupe

**Fonction** : `deleteGroupAndBroadcast(params)` → `groupActions.ts`

```
Epoch Timeline :
  En ─── sendMessage(groupDeleted) ──→ En (message applicatif)
  ─── deleteGroupOnServer ──→ DELETE HTTP
```

**Étapes** :

1. `sendMessage(...)` → message système `groupDeleted` (best effort, try/catch silencieux)
2. `mlsService.deleteGroupOnServer(groupId)` → `DELETE /api/mls-api/groups/{groupId}`

**⚠️ ATTENTION** : Cette fonction est **inutilisée** (voir §14).

### 5.6 Retirer un membre

**Fonction** : `removeMemberAndBroadcast(params)` → `groupActions.ts`

```
Epoch Timeline :
  En ─── removeMember(groupId, [memberId]) ──→ En+1 (commit MLS)
  En+1 ── sendMessage(memberRemoved) ──→ En+1 (message applicatif)
  ─── removeMemberFromServer ──→ DELETE HTTP
```

**Étapes** :

1. **MLS remove** : `mlsService.removeMember(groupId, [memberId])`
   - WASM : `client.remove_members(groupId, userIds)` → retourne un commit
   - Le commit est envoyé immédiatement via `sendCommit(commitBytes, groupId)` (dans `WebMlsService.removeMember`)
   - → **Epoch +1** : tous les membres restants avancent leur epoch

2. **Notification** : `sendMessage(mkSystem('memberRemoved', { targetUser }))` → message applicatif

3. **Nettoyage serveur** : `removeMemberFromServer(groupId, memberId)` → `DELETE /api/mls-api/groups/{groupId}/members/{userId}`

4. **Sauvegarde état** : `saveState(pin)`

---

## 6. Actions détaillées — Messages

### 6.1 Envoyer un message texte

**Fonctions impliquées** :

- UI → `useConversations.svelte.ts` → `sendMessage()`
- MLS : `mlsService.sendMessage(groupId, encodeAppMessage(...))`
- Transport : `WebMlsService.sendMessage()`

```
Epoch Timeline :
  En ─── sendMessage ──→ En (PAS de changement d'epoch)
```

**Étapes** :

1. **Encodage** : `encodeAppMessage(mkText(content))` → sérialisation Protobuf
2. **Chiffrement MLS** : `client.send_message_bytes(groupId, messageBytes)` → chiffré avec la clé de l'epoch courant
3. **Envoi** :
   - **WS ouvert** : `ws.send(JSON.stringify({ type: 'mls', groupId, proto: base64(ciphertext) }))`
   - **WS fermé** : `POST /api/mls-api/send` (fallback HTTP)
4. **Stockage local** : `storage.saveMessage({...}, pin)` → chiffré avec ChaCha20Poly1305

### 6.2 Recevoir un message texte

**Fonction** : callback `mlsService.onMessage(...)` configuré dans `setupMessageHandler()` → `connection.ts`

```
Epoch Timeline :
  En ─── processIncomingMessage ──→ En (message applicatif, pas d'epoch change)
  OU En ─── processIncomingMessage ──→ En+1 (si c'est un commit de handshake)
```

**Étapes** :

1. **Réception WS** : Le Gateway envoie un frame JSON `{ senderId, groupId, proto, isWelcome }`
2. **Mise en file** : `enqueueMessage()` dans `WebMlsService`
3. **Traitement séquentiel** : `processQueue()` → appelle le `messageCallback`
4. **Recherche de conversation** : Par `groupId` d'abord, puis par `senderId` (fallback 1-to-1)
5. **Déchiffrement** : `mlsService.processIncomingMessage(groupId, ciphertext)` → WASM `process_incoming_message_bytes`
6. **Décodage protobuf** : `decodeAppMessage(decryptedBytes)`
7. **Routage par type** :
   - `msg.text` → `addMessageToChat(sender, serializeEnvelope(mkTextEnvelope(...)))`
   - `msg.reply` → idem avec `replyTo`
   - `msg.reaction` → mise à jour `messageReactions` + persistance DB
   - `msg.media` → `addMessageToChat()` avec `mkMediaEnvelope(...)`
   - `msg.call` → `onCallSignal(sender, callMsg)`
   - `msg.system` → traitement spécifique (voir §6.6)
8. **Auto-save état MLS** : `saveState(pin)` → `localStorage`

### 6.3 Envoyer une réponse (reply)

Même flux que §6.1 mais avec :

```typescript
encodeAppMessage(mkReply(content, { id, senderId, preview }));
```

Le `replyTo` est sérialisé dans le protobuf et transporté comme un message normal.

### 6.4 Envoyer une réaction (emoji)

**Envoi** :

```typescript
encodeAppMessage(mkReaction(messageId, emoji))
→ mlsService.sendMessage(groupId, reactionBytes)
```

**Réception** (dans `setupMessageHandler`) :

1. Déchiffrement + décodage → `msg.reaction`
2. Mise à jour de `messageReactions.get(messageId)` : filtre le même userId puis ajoute
3. **Persistance** : `storage.saveMessage({...reactions: filtered}, pin)` sur le message cible

### 6.5 Accusé de réception (read receipt)

**Envoi** :

```typescript
encodeAppMessage(mkSystem('read_receipt', JSON.stringify({ messageIds })))
→ mlsService.sendMessage(groupId, readReceiptBytes)
```

**Réception** :

1. Déchiffrement → `msg.system` avec `event === 'read_receipt'`
2. Pour chaque `messageId` dans `data.messageIds` :
   - Trouve le message dans `conversation.messages`
   - Ajoute `senderNorm` à `readBy[]` si absent
3. **Persistance DB** : `storage.saveMessage({...readBy: updatedReadBy}, pin)` pour chaque message modifié
4. Callback optionnel : `onReadReceiptReceived?.({...})`

### 6.6 Messages système

**Fonction de traitement** : dans le callback `mlsService.onMessage()` → branche `msg.system`

| Event            | Action                                                                   | Epoch ? |
| ---------------- | ------------------------------------------------------------------------ | :-----: |
| `groupRenamed`   | Met à jour `conversation.name`, affiche message système                  |   ❌    |
| `memberRemoved`  | Affiche message système "{sender} a retiré {target}"                     |   ❌    |
| `memberAdded`    | Affiche message système "{sender} a ajouté {users}"                      |   ❌    |
| `groupDeleted`   | `isReady: false`, sauvegarde, message système                            |   ❌    |
| `read_receipt`   | Met à jour `readBy[]` + persistance                                      |   ❌    |
| `delete_message` | `isDeleted: true`, contenu remplacé                                      |   ❌    |
| `edit_message`   | `isEdited: true`, `editedAt`, nouveau contenu, `readBy: []` réinitialisé |   ❌    |

### 6.7 Envoi de média

**Encodage** :

```typescript
encodeAppMessage(mkMedia({ kind, mediaId, key, iv, mimeType, size, fileName }, caption?))
```

- Le fichier est chiffré côté client et uploadé au `media-service`
- Seule la **référence** (mediaId + clé de déchiffrement) est envoyée dans le message MLS

### 6.8 Rejeu de l'historique serveur

**Fonction** : `replayConversationHistory(params)` → `history.ts`

**Étapes** :

1. `mlsService.fetchHistory(groupId)` → `GET /api/history/{groupId}` → messages chiffrés base64
2. Pour chaque message :
   - Décodage base64 → `Uint8Array`
   - `processIncomingMessage(groupId, bytes)` → **avance l'epoch si c'est un commit**
   - `decodeAppMessage(decryptedBytes)` → routage par type (text, reply, media, reaction, system)
3. Sauvegarde état MLS final

**⚠️ Risque temporel** : Chaque `processIncomingMessage` sur un commit historique fait avancer l'epoch. Si l'historique contient des commits mélangés avec des messages applicatifs, l'ordre doit être exact.

---

## 7. Actions détaillées — Communautés (Channels)

Les communautés utilisent un système de chiffrement **différent de MLS** : chiffrement AES-256-GCM avec rotation de clé par epoch.

### 7.1 Architecture Channel

```
Frontend (AES-256-GCM)  ←→  Social Service (MongoDB)  ←→  Redis PubSub
       ↕                                                         ↕
  ChannelKeyVault                                          Chat Gateway
  (clés par epoch)                                       (diffusion WS)
```

### 7.2 Créer un channel

**Fonction** : `createNewChannel(workspaceId, name, ctx)` → `useChannelWorkspaces.svelte.ts`

1. `POST` au social-service avec `{ workspaceId, name, visibility: 'public' }`
2. Le backend crée le channel en MongoDB
3. Frontend crée une conversation locale avec clé `channel_{channelId}`
4. Pas de MLS impliqué

### 7.3 Rejoindre un channel

**Backend** : `joinChannel()` → `channel.service.ts`

1. Vérifie/crée l'utilisateur comme membre du workspace (rôle `Member` par défaut)
2. Publie `channel.member.joined` via Redis
3. Frontend reçoit via `onChannelEvent` → callback `onChannelMemberJoined`

### 7.4 Envoyer un message dans un channel

1. **Chiffrement** : `channelKeyManager.encryptMessage(channelId, plaintext)` → AES-256-GCM avec clé de l'epoch courant
2. **Envoi** : `POST` au social-service avec `{ ciphertext, nonce, keyVersion }`
3. Backend stocke et publie `channel.message.created` via Redis
4. Tous les membres reçoivent le message via WebSocket

### 7.5 Recevoir un message dans un channel

**Traitement** : dans `setupMessageHandler()` → branche `onChannelEvent` pour `channel.message.created`

1. **Identification** : Recherche de la conversation `channel_{channelId}`
2. **Déchiffrement** :
   - Si `data.nonce && data.keyVersion !== undefined` → AES-256-GCM via `channelKeyManager.decryptMessage()`
   - Sinon → Fallback legacy base64 (`atob`)
3. **Décodage** : `decodeAppMessage(bytes)` → extraction texte/reply
4. **Affichage** : `addMessageToChat(sender, content, convoKey, ...)`

### 7.6 Rotation de clé de channel

**Événement** : `channel.key.rotated` reçu via WebSocket

1. Données : `{ channelId, newEpochBaseKey (base64), keyVersion }`
2. `channelKeyManager.getVault(channelId)` → récupère ou crée le vault
3. Décodage base64 → `Uint8Array` (32 bytes AES-256)
4. `vault.rotateKey(keyVersion, rawKeyMat)` → stockage de la nouvelle clé
5. Les anciens messages restent déchiffrables via leur `keyVersion` stocké

### 7.7 Invitation dans un channel

**Backend** : `inviteToChannel(channelId, { targetUserId, roleName })` → `channel.service.ts`

1. **Vérification** : L'inviteur a la permission `INVITE_USERS` ou `MANAGE_WORKSPACE` ou `MANAGE_CHANNELS`
2. Si nouveau dans le workspace : création de `ChannelMember` avec rôles
3. Publication `channel.member.joined` via Redis
4. Frontend met à jour la sidebar

### 7.8 Expulsion d'un channel

**Événement** : `channel.member.kicked` → callback `onChannelMemberKicked`

---

## 8. Synchronisation multi-appareils

### 8.1 Paradigme "Any member bootstraps" (processPendingInvitations)

**Fonction** : `processPendingInvitations(params)` → `actions.ts`

**Principe** : N'importe quel appareil d'un membre du groupe, déjà en ligne et en état `welcome_received`, peut traiter les invitations en attente (status `pending`) des autres appareils. Cela élimine les deadlocks : le premier appareil à se reconnecter invite automatiquement tous les appareils en attente.

**Entité serveur** : `DeviceGroupMembership` avec machine à états :
- `pending` → L'appareil est enregistré mais n'a pas encore reçu de Welcome
- `added` → Un appareil a commité un Add MLS pour cet appareil  
- `welcome_sent` → Le Welcome a été stocké sur le serveur
- `welcome_received` → L'appareil a récupéré et traité son Welcome

```
Pour chaque invitation pending (groupée par groupId) :
  ── Vérifier conversation locale ready ── skip si absente
  ── acquireAddLock(groupId, 15s) ── skip si verrou pris
  ── fetchUserDevices(inv.userId) ── récupérer KeyPackage frais
  ── getGroupMembers(groupId) ── vérifier idempotence
  ── addMember(groupId, keyPackage) → Epoch+1
  ── registerMember + sendWelcome + saveState + sendCommit
  ── releaseAddLock(groupId)
```

**Gestion des erreurs** :
- `DuplicateSignatureKey` → Appareil déjà membre → `updateInvitationStatus(welcome_received)`
- `WrongEpoch` → Vérifier si un autre appareil a déjà traité → skip si `welcome_sent`/`welcome_received`
- KeyPackage introuvable → skip (appareil potentiellement supprimé)

**Détection des appareils obsolètes** (cron serveur toutes les 5 min) :
- Groupes avec `activeEpoch > 10` : appareils avec `lastEpochSeen < activeEpoch - 10` → reset à `pending`
- L'appareil sera automatiquement ré-invité au prochain passage de `processPendingInvitations`

**Nettoyage automatique** (cron serveur toutes les heures) :
- Messages en file d'attente (QueuedMessage) de plus de 7 jours → supprimés

### 8.2 Découverte de groupes manquants

**Fonction** : `discoverMissingGroups(params)` → `actions.ts`

1. `mlsService.getUserGroups(userId)` → `GET /api/mls-api/user-groups/{userId}`
2. Déduplique la réponse serveur par `groupId`
3. Compare avec **tous** les `groupId` locaux (conversations prêtes et placeholders)
4. Pour chaque groupe manquant : crée un placeholder avec `isReady: false`
5. Le groupe deviendra fonctionnel quand un Welcome sera reçu

### 8.3 Reset de sync forcé

**Fonction** : `forceSyncReset(userId, log)` → `actions.ts`

- Outil de debugging : force le rechargement complet
- Au prochain rechargement, `processPendingInvitations` retraite toutes les invitations pending

---

## 9. Système de file d'attente des messages

**Implémenté dans** : `WebMlsService` (propriétés `messageQueue`, `pendingWelcomeGroups`, `isProcessingQueue`)

### Principe

Les messages sont traités **séquentiellement** pour éviter les conflits d'epoch. Les Welcome sont **prioritaires**.

### Flux

```
Message WS reçu
       │
       ▼
  enqueueMessage(msg)
       │
       ├── msg.isWelcome ?
       │     ├── OUI : pendingWelcomeGroups.set(groupId, [])
       │     │         messageQueue.unshift(msg)  ← PRIORITÉ
       │     └── NON : pendingWelcomeGroups.has(groupId) ?
       │                 ├── OUI : buffer dans pendingWelcomeGroups.get(groupId)
       │                 └── NON : messageQueue.push(msg)
       │
       ▼
  processQueue() — traitement séquentiel
       │
       Pour chaque message :
       ├── Appel messageCallback(...)
       ├── Si Welcome terminé :
       │     └── Flush des messages bufferisés vers le début de la queue
       └── Erreur ? → nettoyage du pending state
```

### Récupération des messages hors-ligne

**Fonction** : `fetchPendingMessages()` → `WebMlsService`

Appelée automatiquement à chaque `connect()` :

1. `GET /api/mls-api/welcome/{deviceId}` → Welcome messages stockés (MongoDB)
2. Pour chaque Welcome → `simulateMessageReceive({ type: 'mlsWelcome', ... })`
3. `GET /api/mls-api/messages/{userId}/{deviceId}` → messages applicatifs en attente
4. Pour chaque message → `simulateMessageReceive(msg)` → si succès, accumule l'ID
5. `POST /api/mls-api/messages/ack` → acquittement des messages traités

---

## 10. Gestion des groupes fantômes

**Implémentée dans** : `setupMessageHandler()` → `connection.ts`

Un "groupe fantôme" est une conversation dont le `groupId` existe dans la carte `conversations` mais n'est plus connu de l'état WASM MLS.

### Détection

```
processIncomingMessage(groupId, content) → ERREUR
  │
  ├── "CannotDecryptOwnMessage" ou "WrongEpoch" → ACK (retourne true)
  │
  └── "groupe introuvable" / "group not found" → Compteur +1
        │
        ├── < 3 échecs → Log warning
        └── ≥ 3 échecs → Suppression automatique
              ├── storage.deleteConversation(convoKey)
              ├── conversations.delete(convoKey)
              └── Redirection vers la liste si c'était la conv sélectionnée
```

**Seuil** : `PHANTOM_THRESHOLD = 3` échecs consécutifs

---

## 11. Sauvegarde / Restauration

### 11.1 Export

**Fonction** : `exportUserBackup(params)` → `actions.ts`

1. Récupère `localStorage['mls_autosave_' + userId]` (état MLS hex)
2. `exportBackup(storage, userId, pin, myDeviceId, mlsStateHex)` → Blob chiffré
3. Téléchargement automatique : `canari-backup-{userId}-{date}.canari`

### 11.2 Import

**Fonction** : `importUserBackup(params)` → `actions.ts`

1. `importBackup(arrayBuffer, pin, storage, myDeviceId)` → déchiffre et restaure
2. Si même appareil : restaure l'état MLS (sauf si un état plus récent existe localement)
3. Si appareil différent : import en lecture seule. Les groupes ne seront actifs qu'après re-invitation
4. `clearConversations()` + `reloadConversations()`

---

## 12. Tableau récapitulatif des opérations MLS et epochs

| Action utilisateur   | Fonction(s)                 | Opérations MLS                                                      |        Epochs        | Commits envoyés |
| -------------------- | --------------------------- | ------------------------------------------------------------------- | :------------------: | :-------------: |
| Créer groupe         | `createNewGroup`            | `createGroup` + `addMembersBulk` (own)                              |        0 → 1         |        1        |
| Créer discussion 1:1 | `startNewConversation`      | `createGroup` + `addMembersBulk` (contact) + `addMembersBulk` (own) |      0 → 1 → 2       |        2        |
| Inviter membres      | `inviteMembersToGroup`      | `addMembersBulk`                                                    |       n → n+1        |        1        |
| Retirer un membre    | `removeMemberAndBroadcast`  | `removeMember`                                                      |       n → n+1        |        1        |
| Renommer groupe      | `renameGroupAndBroadcast`   | Aucune (HTTP PATCH)                                                 |          n           |        0        |
| Supprimer groupe     | `deleteGroupAndBroadcast`   | Aucune (HTTP DELETE)                                                |          n           |        0        |
| Envoyer message      | `sendMessage`               | `send_message_bytes`                                                |          n           |        0        |
| Recevoir message     | `setupMessageHandler`       | `processIncomingMessage`                                            | n (ou n+1 si commit) |        0        |
| Recevoir Welcome     | `setupMessageHandler`       | `processWelcome`                                                    |  → epoch du Welcome  |        0        |
| Sync appareils       | `processPendingInvitations` | `addMember` par invitation pending (avec verrou)                     |    +1 par invitation |    1 par add    |
| Réparer discussion   | `repairDirectConversation`  | `createGroup` + `addMembersBulk` ×2                                 |      0 → 1 → 2       |        2        |
| Rejeu historique     | `replayConversationHistory` | `processIncomingMessage` × N                                        |       variable       |        0        |
| Discovery            | `discoverMissingGroups`     | Aucune                                                              |          —           |        0        |

---

## 13. Inventaire complet des fonctions

### `groupCreation.ts`

| Fonction                                                            |  Exportée  | Rôle                                                                   |
| ------------------------------------------------------------------- | :--------: | ---------------------------------------------------------------------- |
| `toUiDiscussionError(error)`                                        | ❌ interne | Traduit les erreurs techniques en messages utilisateur                 |
| `fetchDevicesWithRetry(mlsService, userId, log, attempts?, delay?)` | ❌ interne | Récupère les appareils d'un utilisateur avec retry (6×1.5s par défaut) |
| `processBulkAddition(memberIds, conversation, deps)`                | ❌ interne | Logique commune d'ajout bulk de membres                                |
| `createNewGroup(name, deps)`                                        |     ✅     | Crée un groupe MLS multi-utilisateurs                                  |
| `inviteMembersToGroup(memberIds[], conversation, deps)`             |     ✅     | Invite N membres (wrapper pour `processBulkAddition`)                  |
| `inviteMemberToGroup(memberId, conversation, deps)`                 |     ✅     | Invite 1 membre (wrapper pour `inviteMembersToGroup`)                  |
| `startNewConversation(contactName, deps)`                           |     ✅     | Crée une discussion 1-to-1                                             |
| `repairDirectConversation(conversationKey, deps)`                   |     ✅     | Répare une discussion directe cassée                                   |

### `groupActions.ts`

| Fonction                                       | Exportée | Rôle                                                  |
| ---------------------------------------------- | :------: | ----------------------------------------------------- |
| `fetchUniqueGroupMembers(mlsService, groupId)` |    ✅    | Récupère la liste dédupliquée des userId d'un groupe  |
| `renameGroupAndBroadcast(params)`              |    ✅    | Renomme un groupe + diffuse notification système      |
| `deleteGroupAndBroadcast(params)`              |    ✅    | Supprime un groupe (⚠️ **inutilisée**)                |
| `removeMemberAndBroadcast(params)`             |    ✅    | Retire un membre MLS + notification + cleanup serveur |

### `actions.ts`

| Fonction                         | Exportée | Rôle                                                                      |
| -------------------------------- | :------: | ------------------------------------------------------------------------- |
| `processPendingInvitations(params)` |    ✅    | Traite les invitations pending via paradigme "any member bootstraps" |
| `forceSyncReset(userId, log)`    |    ✅    | Outil de debugging : force un rechargement complet des invitations        |
| `discoverMissingGroups(params)`  |    ✅    | Détecte les groupes serveur absents localement                            |
| `exportUserBackup(params)`       |    ✅    | Exporte une sauvegarde chiffrée                                           |
| `importUserBackup(params)`       |    ✅    | Importe une sauvegarde                                                    |
| `generateDevKeyPackage(params)`  |    ✅    | Génère un KeyPackage (outil dev)                                          |
| `addDevMember(params)`           |    ✅    | Ajoute un membre manuellement par hex (outil dev)                         |
| `processDevWelcome(params)`      |    ✅    | Traite un Welcome manuellement par hex (outil dev)                        |

### `connection.ts`

| Fonction                     |  Exportée  | Rôle                                                         |
| ---------------------------- | :--------: | ------------------------------------------------------------ |
| `bytesToHex(bytes)`          | ❌ interne | Conversion bytes → hex                                       |
| `mediaKindToType(kind)`      | ❌ interne | Conversion enum MediaKind → string type                      |
| `setupMessageHandler(deps)`  |     ✅     | Configure le callback de traitement des messages entrants    |
| `initializeConnection(deps)` |     ✅     | Initialise la connexion WS, publie KeyPackage, lance le sync |

### `conversations.ts`

| Fonction                                                                  | Exportée | Rôle                                                              |
| ------------------------------------------------------------------------- | :------: | ----------------------------------------------------------------- |
| `archiveStorageKey(uid)`                                                  |    ✅    | Clé localStorage pour les conversations archivées                 |
| `loadPersistedArchivedIds(uid)`                                           |    ✅    | Charge la liste des conversations archivées                       |
| `persistArchivedConversations(uid, ids)`                                  |    ✅    | Persiste la liste des conversations archivées                     |
| `deriveConversationIdentity(metaName, userId, metaId?)`                   |    ✅    | Détermine le type (direct/group) et l'identité d'une conversation |
| `mergeDirectConversationDuplicates(convMetas, userId, pin, storage, log)` |    ✅    | Fusionne les conversations directes en doublon                    |
| `loadExistingConversations(ctx)`                                          |    ✅    | Charge toutes les conversations (2 phases)                        |

### `history.ts`

| Fonction                                                  |  Exportée  | Rôle                                                        |
| --------------------------------------------------------- | :--------: | ----------------------------------------------------------- |
| `bytesToHex(bytes)`                                       | ❌ interne | Conversion bytes → hex                                      |
| `mediaKindToType(kind)`                                   | ❌ interne | Conversion enum MediaKind → string type                     |
| `mapStoredMessagesToChatMessages(storedMessages, userId)` |     ✅     | Transforme les messages stockés en ChatMessage pour le UI   |
| `replayConversationHistory(params)`                       |     ✅     | Rejeu des messages serveur via déchiffrement MLS séquentiel |

### `WebMlsService.ts` (méthodes de classe)

| Méthode                                           | Rôle                                                        |
| ------------------------------------------------- | ----------------------------------------------------------- |
| `init(userId, pin, state?)`                       | Initialise le WASM, génère/restaure le deviceId             |
| `connect(token)`                                  | Ouvre le WebSocket, fetch les messages en attente           |
| `fetchPendingMessages()`                          | Récupère les Welcome + messages stockés hors-ligne          |
| `simulateMessageReceive(data)`                    | Injecte un message (format flat ou legacy) dans le callback |
| `enqueueMessage(msg)`                             | Ajoute un message à la file (Welcome = priorité)            |
| `processQueue()`                                  | Traitement séquentiel de la file                            |
| `createGroup(groupId)`                            | Création locale MLS                                         |
| `createRemoteGroup(name, isGroup)`                | POST création serveur                                       |
| `addMember(groupId, keyPackage)`                  | Ajout d'un seul appareil                                    |
| `addMembersBulk(groupId, devices)`                | Ajout bulk (un seul commit)                                 |
| `removeMember(groupId, userIds)`                  | Retrait MLS + envoi commit                                  |
| `processWelcome(welcomeBytes, ratchetTreeBytes?)` | Rejoint un groupe via Welcome                               |
| `sendMessage(groupId, messageBytes)`              | Chiffre + envoie (WS ou HTTP)                               |
| `processIncomingMessage(groupId, messageBytes)`   | Déchiffre un message entrant                                |
| `sendWelcome(...)`                                | Envoie un Welcome (POST ou WS)                              |
| `sendCommit(commitBytes, groupId)`                | Envoie un commit (WS ou POST)                               |
| `generateKeyPackage(pin)`                         | Génère + publie un KeyPackage                               |
| `publishKeyPackage(keyPackageBytes)`              | POST /api/mls-api/register-device                           |
| `fetchUserDevices(userId)`                        | GET /api/mls-api/devices/{userId}                           |
| `registerMember(groupId, userId, deviceId)`       | POST /api/mls-api/groups/{groupId}/members                  |
| `fetchHistory(groupId)`                           | GET /api/history/{groupId}                                  |
| `saveState(pin)`                                  | Sérialise l'état MLS chiffré                                |
| `renameGroup(groupId, name)`                      | PATCH /api/mls-api/groups/{groupId}                         |
| `deleteGroupOnServer(groupId)`                    | DELETE /api/mls-api/groups/{groupId}                        |
| `removeMemberFromServer(groupId, userId)`         | DELETE /api/mls-api/groups/{groupId}/members/{userId}       |
| `getGroupMembers(groupId)`                        | GET /api/mls-api/groups/{groupId}/members                   |
| `getUserGroups(userId)`                           | GET /api/mls-api/user-groups/{userId}                       |
| `exportSecret(groupId, label, context, keyLen)`   | Export de secret MLS                                        |
| `getDeviceId()`                                   | Retourne le deviceId courant                                |
| `getLocalGroups()`                                | Liste des groupes MLS locaux                                |

### `IMlsService.ts` — Interface complète

~30 méthodes définissant le contrat du service MLS. Voir le tableau `WebMlsService.ts` ci-dessus pour l'implémentation.

---

## 14. Fonctions inutilisées / code mort

### ❌ `deleteGroupAndBroadcast` — `groupActions.ts`

- **Exportée** : Oui
- **Importée quelque part** : Non
- **Appelée** : Jamais
- **Raison probable** : L'UI de suppression de groupe n'est pas implémentée. La suppression se fait par le mécanisme de détection de groupes fantômes (§10) ou côté serveur.
- **Recommandation** : Supprimer ou implémenter l'UI correspondante.

### ✅ `forceSyncReset` — `actions.ts`

- **Exportée** : Oui
- **Importée** : `MainChatPage.svelte` (raccourci Ctrl+Shift+S)
- **Appelée** : Via raccourci clavier pour debugging
- **Rôle** : Force un rechargement complet, `processPendingInvitations` retraitera toutes les invitations pending au prochain cycle.

---

## 15. Incohérences temporelles et risques identifiés

### � Risque 1 (RÉSOLU) : Race condition sur les Welcome — anciennement syncOwnDevicesToGroups

**Contexte historique** : L'ancien `syncOwnDevicesToGroups` traitait les appareils séquentiellement avec des délais fixes (100ms entre groupes, 2000ms entre appareils).

**Résolution** : Le nouveau paradigme "any member bootstraps" (`processPendingInvitations`) utilise un **système de verrous distribués** (`acquireAddLock/releaseAddLock` avec TTL 15s) et traite les invitations **une par une** avec vérification d'idempotence. Les race conditions sont gérées par :
- Vérification `getGroupMembers` avant chaque ajout
- Gestion explicite de `DuplicateSignatureKey` et `WrongEpoch`
- Détection des appareils obsolètes par cron (epoch threshold > 10)

### 🔴 Risque 2 : Epoch divergence lors du rejeu d'historique

**Contexte** : `replayConversationHistory` appelle `processIncomingMessage` pour chaque message de l'historique. Si certains de ces messages sont des commits (handshake), ils font avancer l'epoch.

**Problème** : L'historique est récupéré après `loadExistingConversations` (qui restaure l'état MLS depuis le stockage local). Si l'état local était déjà à l'epoch N et que l'historique contient un commit de l'epoch N-1, le `processIncomingMessage` échouera avec `WrongEpoch`.

**Atténuation existante** : Le code traite `WrongEpoch` comme non-fatal (retourne `true` pour acquitter). Mais cela signifie que certains messages historiques peuvent être **silencieusement perdus**.

### � Risque 3 (RÉSOLU) : addMember séquentiel — anciennement syncOwnDevicesToGroups

**Contexte historique** : `syncOwnDevicesToGroups` créait un commit par groupe par appareil, multipliant les changements d'epoch.

**Résolution** : `processPendingInvitations` traite les invitations pending individuellement avec verrou. Chaque invitation = 1 addMember + 1 commit, mais le verrou distribué empêche les conflits d'epoch entre appareils traitant simultanément. La détection d'appareils obsolètes (cron staleDevices) recycle automatiquement les invitations échouées.

### 🟡 Risque 4 : Ordre Welcome → Commit non garanti

**Contexte** : Dans `startNewConversation` et `repairDirectConversation` :

1. `addMembersBulk(contact devices)` → retourne `{ welcome, commit }`
2. Envoi des Welcome un par un (`sendWelcome`)
3. Envoi du Commit (`sendCommit`)

**Problème** : Le Welcome et le Commit sont envoyés via des canaux potentiellement différents (Welcome via POST HTTP, Commit via WebSocket). Rien ne garantit que le Welcome arrive AVANT le Commit au récepteur.

**Atténuation existante** : Le système de file d'attente prioritise les Welcome et bufferise les messages des groupes en cours de join. Mais si le Commit arrive en premier (via WS plus rapide que HTTP POST), il sera traité avant que le récepteur n'ait rejoint le groupe → erreur.

### 🟡 Risque 5 : Deux addMembersBulk consécutifs sans délai

**Contexte** : Dans `startNewConversation` :

```
addMembersBulk(contactDevices) → Epoch 0→1 → sendWelcome + sendCommit
addMembersBulk(ownDevices) → Epoch 1→2 → sendWelcome + sendCommit
```

**Problème** : Le deuxième `addMembersBulk` est exécuté immédiatement après le premier, sans attendre que les Welcome du contact soient traités. Le contact peut recevoir le commit de l'Epoch 2 alors qu'il n'a pas encore traité l'Epoch 1.

**Atténuation** : Le contact process le Welcome (qui l'amène à E1), puis le commit E1→E2 arrive. Comme le commit est dans la file après le Welcome (grâce au buffering), cela devrait fonctionner. Mais en cas de latence réseau, l'ordre n'est pas garanti.

### 🟢 Point positif : DuplicateSignatureKey bien géré

Le code dans `processPendingInvitations` traite correctement `DuplicateSignatureKey` comme un cas "déjà membre" non-fatal (→ update status `welcome_received`), et vérifie les membres serveur avant d'essayer l'ajout.

### 🟢 Point positif : Bulk operations

L'utilisation de `addMembersBulk` dans la plupart des flux de création évite la fragmentation d'epoch (un seul commit pour N appareils).

### 🟢 Point positif : Vérification pré-création des appareils

`startNewConversation` vérifie que le contact a des appareils disponibles AVANT de créer le groupe serveur, évitant les groupes orphelins.

---

## 16. Corrections de résilience (Cycles 1-8)

> Audit systématique de tous les scénarios de défaillance identifiés et corrigés à travers 8 cycles d'analyse.

### Cycle 1 — Persistance et nettoyage fondamental

| #   | Sévérité    | Fichier            | Problème                                                                                | Correction                                                                           |
| --- | ----------- | ------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | 🔴 CRITIQUE | `connection.ts`    | `saveState` manquant après `processWelcome` → état MLS perdu au rechargement            | Ajout `saveState` après chaque Welcome traité                                        |
| 2   | 🔴 CRITIQUE | `connection.ts`    | delete_message/edit_message non persistés en DB → modifications perdues au rechargement | Ajout persistance DB des messages supprimés/édités avec flags `isDeleted`/`isEdited` |
| 3   | 🟠 HAUT     | `db.ts`            | Interface `StoredMessage` sans champs `isDeleted`/`isEdited`                            | Extension du type avec champs optionnels                                             |
| 4   | 🟠 HAUT     | `history.ts`       | `mapStoredMessagesToChatMessages` ne propageait pas `isDeleted`/`isEdited`              | Propagation des flags dans le mapper                                                 |
| 5   | 🟠 HAUT     | `conversations.ts` | Race condition Phase 2 : async IIFEs sans `await`                                       | Collecte dans `phase2Promises` + `Promise.allSettled`                                |
| 6   | 🟠 HAUT     | `connection.ts`    | `loadHistoryForConversation` non appelé après Welcome join                              | Ajout appel après création de la conversation                                        |
| 7   | 🟡 MOYEN    | `groupActions.ts`  | `deleteGroupAndBroadcast` code mort                                                     | Suppression                                                                          |
| 8   | 🟡 MOYEN    | `history.ts`       | `replayConversationHistory` avale les erreurs silencieusement                           | Ajout logging des erreurs                                                            |
| 9   | 🟡 MOYEN    | `groupActions.ts`  | `removeMemberAndBroadcast` non résilient (crash si notification échoue)                 | Best-effort notification + cleanup                                                   |
| 10  | 🟡 MOYEN    | `groupActions.ts`  | `renameGroupAndBroadcast` non résilient                                                 | Best-effort broadcast                                                                |
| 11  | 🟡 MOYEN    | `actions.ts`       | `discoverMissingGroups` placeholders non persistés en DB                                | Persist via `saveConversation` optionnel                                             |
| 12  | 🟡 MOYEN    | `groupCreation.ts` | `startNewConversation` groupes orphelins si échec                                       | Cleanup remote group via `deleteGroupOnServer`                                       |

### Cycle 2 — Closures, compteurs et doublons

| #   | Sévérité    | Fichier            | Problème                                                                                                     | Correction                                                  |
| --- | ----------- | ------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| 13  | 🔴 CRITIQUE | `connection.ts`    | Closure stale de `selectedContact` dans phantom group cleanup                                                | Lambda `getSelectedContact = () => deps.selectedContact`    |
| 14  | 🟠 HAUT     | `connection.ts`    | Compteur `groupMlsFailures` jamais réinitialisé après succès                                                 | `groupMlsFailures.delete(convoKey)` sur message traité      |
| 15  | 🟠 HAUT     | `connection.ts`    | Welcome handler duplique conversations (discoverMissingGroups crée un placeholder, Welcome en crée un autre) | Recherche par `joinedGroupId` dans conversations existantes |
| 16  | 🟡 MOYEN    | `groupCreation.ts` | `createNewGroup` : `saveConversation` non await, pas de cleanup orphelins                                    | `await saveConversation` + cleanup on failure               |
| 17  | 🟡 MOYEN    | `groupCreation.ts` | `repairDirectConversation` : pas de cleanup orphelins                                                        | Cleanup remote group on failure                             |

### Cycle 3 — Stabilité WebSocket et logging

| #   | Sévérité    | Fichier                    | Problème                                                                      | Correction                                               |
| --- | ----------- | -------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| 18  | 🔴 CRITIQUE | `WebMlsService.ts`         | `connect()` bloque indéfiniment si `fetchPendingMessages` lance une exception | try/catch autour de `fetchPendingMessages` dans `onopen` |
| 19  | 🟠 HAUT     | `WebMlsService.ts`         | `ws.send()` race condition (WS pas encore OPEN)                               | try/catch + fallback HTTP via `sendViaHttp`              |
| 20  | 🟠 HAUT     | `WebMlsService.ts`         | `sendViaHttp` ne vérifie pas `response.ok`                                    | Vérification du code retour                              |
| 21  | 🟡 MOYEN    | `useChatSession.svelte.ts` | Errors sync/discovery silencieusement avalées (`.catch(() => {})`)            | Remplacement par logging via `cb.log`                    |
| 22  | 🟡 MOYEN    | `useChatSession.svelte.ts` | Reconnexion échouée sans détail d'erreur                                      | Log du message d'erreur complet                          |

### Cycle 4 — Persistance cryptée et sécurité

| #   | Sévérité    | Fichier                  | Problème                                                                                         | Correction                                                 |
| --- | ----------- | ------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| 23  | 🔴 CRITIQUE | `db.ts`                  | `isDeleted`/`isEdited` absents du payload chiffré (IndexedDB ET SQLite) → perdus au rechargement | Persistance dans le payload chiffré pour les deux backends |
| 24  | 🔴 SÉCURITÉ | `useMessaging.svelte.ts` | `handleDeleteMessage`/`handleEditMessage` sans vérification de propriété                         | Validation `senderId === userId` avant modification        |
| 25  | 🟠 HAUT     | `TauriMlsService.ts`     | Même bug `connect()` hang que WebMlsService                                                      | try/catch autour de `fetchPendingMessages`                 |
| 26  | 🟠 HAUT     | `TauriMlsService.ts`     | Même race condition `ws.send()`                                                                  | try/catch + fallback HTTP                                  |

### Cycle 5 — Validation entrées et parsing robuste

| #   | Sévérité    | Fichier              | Problème                                                                 | Correction                                                             |
| --- | ----------- | -------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 27  | 🔴 CRITIQUE | `backup.ts`          | Aucune validation des données importées (conversations, messages)        | Validation arrays + types + limites (10K conversations, 500K messages) |
| 28  | 🟠 HAUT     | `migration.ts`       | `saveConversation` sans try/catch → migration s'arrête sur erreur        | try/catch + skip conversation en erreur                                |
| 29  | 🟠 HAUT     | `migration.ts`       | `isDeleted`/`isEdited` perdus lors de la migration localStorage          | Préservation des champs dans saveMessage                               |
| 30  | 🟠 HAUT     | `connection.ts`      | Welcome matchedExisting ne met pas à jour le nom → nom placeholder stale | Mise à jour `name` dans le spread                                      |
| 31  | 🟠 HAUT     | `connection.ts`      | `channel.key.rotated` sans validation base64/format clé                  | Regex base64 + validation longueur 32 bytes minimum                    |
| 32  | 🟠 HAUT     | `ChannelKeyVault.ts` | `rotateKey` accepte clé invalide (taille, epoch négatif)                 | Validation epoch `>= 0` + clé exactement 32 bytes                      |
| 33  | 🟡 MOYEN    | `ChannelKeyVault.ts` | Messages d'erreur non informatifs                                        | Epoch courant et epochs disponibles dans le message                    |
| 34  | 🟡 MOYEN    | `envelope.ts`        | Parsing protobuf hors limites (bytes[3] sans vérification)               | Bounds check `bytes.length >= 4` + `4 + textLen <= bytes.length`       |
| 35  | 🟡 MOYEN    | `envelope.ts`        | `replyTo` non validé structurellement (cast unsafe)                      | Validation stricte des champs `id`, `senderId`, `content`              |

### Cycle 6 — Timeout WebSocket et fuite mémoire

| #   | Sévérité    | Fichier                                   | Problème                                                                 | Correction                                               |
| --- | ----------- | ----------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| 36  | 🔴 CRITIQUE | `WebMlsService.ts`                        | `connect()` bloque indéfiniment si réseau ne répond pas (pas de timeout) | Timeout 15s avec `clearTimeout` sur open/error/close     |
| 37  | 🔴 CRITIQUE | `WebMlsService.ts`                        | Ancien WebSocket non fermé avant reconnexion → fuite mémoire             | Close old WS (null handlers + close) avant new WebSocket |
| 38  | 🔴 CRITIQUE | `TauriMlsService.ts`                      | Mêmes bugs connect() timeout + close-before-create                       | Mêmes corrections                                        |
| 39  | 🟠 HAUT     | `WebMlsService.ts` / `TauriMlsService.ts` | `processQueue` ne nettoie `pendingWelcomeGroups` que sur erreur Welcome  | Nettoyage sur TOUTE erreur (messages réguliers aussi)    |
| 40  | 🟡 MOYEN    | `useChatSession.svelte.ts`                | `reconnectTimer` stale d'une session précédente non nettoyé au login     | `clearTimeout` + reset au début de `login()`             |

### Cycle 7 — Timeout fetch et validation ACK

| #   | Sévérité | Fichier              | Problème                                                                               | Correction                                        |
| --- | -------- | -------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 41  | 🟠 HAUT  | `WebMlsService.ts`   | `fetchPendingMessages` sans timeout → hang indéfini si serveur lent                    | AbortController 10s sur toutes les requêtes fetch |
| 42  | 🟠 HAUT  | `TauriMlsService.ts` | Même absence de timeout                                                                | Mêmes AbortController 10s                         |
| 43  | 🟡 MOYEN | `WebMlsService.ts`   | ACK response non vérifiée → messages considérés comme acquittés même si serveur refuse | Vérification `ackRes.ok` avec log d'erreur        |
| 44  | 🟡 MOYEN | `TauriMlsService.ts` | Même absence de vérification ACK                                                       | Même correction                                   |

### Cycle 8 — Cohérence cross-plateforme et diagnostic

| #   | Sévérité | Fichier                                   | Problème                                                                | Correction                                            |
| --- | -------- | ----------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| 45  | 🟠 HAUT  | `WebMlsService.ts` / `TauriMlsService.ts` | Champ ID message inconsistant (`msg.id` vs `msg._id`)                   | Fallback `msg.id \|\| msg._id` dans les deux services |
| 46  | 🟡 MOYEN | `groupCreation.ts`                        | Erreurs sync propres appareils avalées silencieusement (2 emplacements) | Log `[WARN]` avec message d'erreur                    |

### Correctifs additionnels (post-cycle)

| #   | Sévérité | Fichier                              | Problème                                                                                         | Correction                                                                                        |
| --- | -------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 47  | 🟠 HAUT  | `actions.ts`                         | `discoverMissingGroups` recrée des placeholders car seuls les groupes `isReady` étaient comparés | Détection des absents basée sur **tous** les `groupId` locaux (ready + pending)                   |
| 48  | 🟠 HAUT  | `actions.ts`                         | Placeholder direct affiché en brut (`jolan::test`)                                               | Extraction du pair (`test`) pour `contactName`/`name` + `directPeerId`                            |
| 49  | 🟡 MOYEN | `actions.ts`                         | Réponse serveur de groupes potentiellement dupliquée                                             | Déduplication par `groupId` côté client avant traitement                                          |
| 50  | 🟡 MOYEN | `conversations.ts` / `connection.ts` | Parsing direct fragile pour noms legacy (`user::peer::user`)                                     | Parsing robuste (normalisation + unicité + extraction du pair ≠ user courant)                     |
| 51  | 🟡 MOYEN | `conversations.ts` / `history.ts`    | Erreurs non fatales insuffisamment diagnostiquées                                                | Logging explicite au chargement + `SecretReuseError` traité comme erreur historique non bloquante |
| 52  | 🟡 MOYEN | `TauriMlsService.ts`                 | Incohérence auth headers vs WebMlsService (welcome/messages/ack)                                 | Ajout `authToken` + `withAuthHeaders()` sur les fetchs de pending et ACK                          |

### Risques architecturaux identifiés (non corrigés — requièrent refactoring backend)

| #   | Sévérité    | Composant                  | Problème                                                             |
| --- | ----------- | -------------------------- | -------------------------------------------------------------------- |
| A1  | 🔴 CRITIQUE | `chat-gateway/handlers.rs` | Pas de vérification d'appartenance au groupe pour le routage MLS     |
| A2  | 🟠 HAUT     | `chat-gateway/handlers.rs` | Pas d'autorisation destinataire pour les Welcome                     |
| A3  | 🟡 MOYEN    | `chat-gateway/handlers.rs` | Array `recipients` non borné (vecteur DoS potentiel)                 |
| A4  | 🟡 MOYEN    | `chat-gateway/handlers.rs` | Race condition async cleanup à la déconnexion (ConnectionGuard Drop) |

---

## Annexe : Diagramme de séquence — Création d'une discussion 1-to-1

```
Alice (Device A1)         Gateway/Delivery            Bob (Device B1, B2)
      │                          │                          │
      │── createRemoteGroup ────►│                          │
      │◄── groupId ──────────────│                          │
      │                          │                          │
      │── createGroup(local) ────│                          │
      │   [Epoch 0]              │                          │
      │                          │                          │
      │── registerMember(A1) ───►│                          │
      │                          │                          │
      │── addMembersBulk(B1,B2) ─│ [Epoch 0→1]             │
      │   → welcome + commit     │                          │
      │                          │                          │
      │── registerMember(B1) ───►│                          │
      │── registerMember(B2) ───►│                          │
      │                          │                          │
      │── sendWelcome(B1) ──────►│── Welcome ──────────────►│ B1: processWelcome
      │── sendWelcome(B2) ──────►│── Welcome ──────────────►│ B2: processWelcome
      │── sendCommit ───────────►│── Commit (broadcast) ───►│ [Epoch 1]
      │                          │                          │
      │── addMembersBulk(A2) ────│ [Epoch 1→2]             │
      │   → welcome2 + commit2   │                          │
      │                          │                          │
      │── sendWelcome(A2) ──────►│── Welcome ──► A2         │
      │── sendCommit ───────────►│── Commit ───► all        │ [Epoch 2]
      │                          │                          │
      │   [conversation ready]   │                          │
```
