# Communautés, Workspaces et Channels

## 1. Modèle de données

Les communautés sont gérées par **social-service** (NestJS, PostgreSQL).

### Hiérarchie

```
Workspace (communauté)
  ├── Rôles (Administrateur, Modérateur, Membre, ...)
  ├── Membres (utilisateurs avec rôles assignés)
  └── Channels (canaux de discussion)
        └── Messages chiffrés
```

Un **Workspace** est une communauté identifiée par un `slug` unique (ex. `bde-emse`). Il peut représenter une association, une promo, un groupe de travail, etc.

Un **Channel** est un fil de discussion au sein d'un workspace. Il peut être public ou privé, avec une restriction par rôle.

---

## 2. Schéma des tables

### channel_workspaces

| Colonne | Type | Description |
|---|---|---|
| `id` | UUID | Identifiant unique |
| `slug` | string (unique) | Identifiant URL (ex. `bde-emse`) |
| `name` | string | Nom affiché |
| `createdBy` | string | userId du créateur |
| `imageMediaId` | string? | ID MinIO de l'image du workspace |
| `createdAt` | timestamp | |

### channels

| Colonne | Type | Description |
|---|---|---|
| `id` | UUID | Identifiant unique |
| `workspaceId` | UUID | Référence workspace |
| `name` | string | Nom du channel |
| `isPrivate` | boolean | Restreint aux rôles `allowedRoles` |
| `allowedRoles` | string[] | Rôles pouvant accéder (si privé) |
| `keyVersion` | integer | Version courante de la clé de chiffrement |
| `masterSecret` | string (base64) | Secret maître HKDF (32 bytes aléatoires) |
| `archived` | boolean | Channel archivé (lecture seule) |
| `imageMediaId` | string? | ID MinIO de l'image du channel |

### channel_roles

| Colonne | Type | Description |
|---|---|---|
| `id` | UUID | Identifiant unique |
| `workspaceId` | UUID | Référence workspace |
| `name` | string | Nom du rôle (ex. `Administrateur`) |
| `priority` | integer | Ordre de priorité (plus haut = plus de droits) |
| `permissions` | string[] | Ex. `["manage_members", "delete_messages"]` |

À la création d'un workspace, trois rôles sont créés automatiquement :
- **Administrateur** (priority 100) — tous les droits
- **Modérateur** (priority 50) — gestion des membres + messages
- **Membre** (priority 10) — lecture + envoi de messages

### channel_members

| Colonne | Type | Description |
|---|---|---|
| `id` | UUID | Identifiant unique |
| `workspaceId` | UUID | Référence workspace |
| `userId` | string | Identifiant utilisateur |
| `roleIds` | string[] | Rôles assignés |
| `keys` | JSONB | Clés de canal dérivées par channelId (voir §4) |

### channel_messages

| Colonne | Type | Description |
|---|---|---|
| `id` | UUID | Identifiant unique |
| `channelId` | UUID | Référence channel |
| `senderId` | string | userId de l'expéditeur |
| `content` | string | Ciphertext AES-256-GCM (base64) |
| `nonce` | string | IV GCM (base64) |
| `keyVersion` | integer | Version de clé utilisée |
| `replyTo` | UUID? | Message cité |
| `attachments` | JSONB | Pièces jointes (media_id, ...) |
| `reactions` | JSONB | Réactions emoji |
| `metadata` | JSONB | Données supplémentaires |
| `createdAt` | timestamp | |

### channel_key_distributions

Suit l'état de la distribution des clés de canal à chaque membre :

| Colonne | Type | Description |
|---|---|---|
| `channelId` | UUID | Référence channel |
| `userId` | string | |
| `deviceId` | string | |
| `status` | enum | `pending_key_distribution` \| `key_sent` \| `key_received` \| `key_acked` \| `failed` |
| `attempts` | integer | Nombre de tentatives |
| `sentAt` | timestamp? | |
| `receivedAt` | timestamp? | |
| `ackedAt` | timestamp? | |

---

## 3. Dérivation des clés de channel (HKDF)

Chaque channel dispose d'un `masterSecret` (32 bytes aléatoires, stocké côté serveur en base64). Les clés de chiffrement des messages sont dérivées à la demande par **HKDF-SHA256** :

```typescript
// Implémentation dans channel.service.ts (social-service)
private deriveEpochKey(masterSecret: string, channelId: string, version: number): Buffer {
  // Salt = SHA-256("channel-epoch:{channelId}:{version}")
  const salt = crypto.createHash('sha256')
    .update(`channel-epoch:${channelId}:${version}`)
    .digest();

  // HKDF-SHA256 : secret = masterSecret, info = "canari-channel-e2ee-v1"
  return Buffer.from(
    crypto.hkdfSync('sha256',
      Buffer.from(masterSecret, 'base64'),
      salt,
      Buffer.from('canari-channel-e2ee-v1'),
      32  // 32 bytes → AES-256
    )
  );
}
```

**Récupération de la clé par le client** :

```
GET /api/channels/:channelId/key
→ { channelId, keyVersion, newEpochBaseKey (base64) }
```

Le client stocke la clé dérivée localement (JSONB `keys` dans `channel_members`) pour déchiffrer les messages sans appel réseau supplémentaire.

---

## 4. Chiffrement des messages de canal

Contrairement aux conversations MLS (E2E strictement côté client), les messages de channel utilisent un chiffrement **serveur-assisté** : le serveur détient le `masterSecret` et peut dériver les clés d'epoch. La confidentialité est assurée contre les tiers, mais pas contre le serveur.

### Envoi d'un message

```
1. Client → GET /api/channels/:channelId/key
   ← { keyVersion, newEpochBaseKey (base64) }

2. Client dérive localement :
   epochKey = HKDF-SHA256(newEpochBaseKey, channelId, keyVersion)
   nonce    = crypto.randomBytes(12)
   ciphertext = AES-256-GCM(epochKey, nonce, plaintext)

3. Client → POST /api/channels/:channelId/messages
   { content: base64(ciphertext), nonce: base64(nonce), keyVersion }
```

### Réception d'un message

```
1. Client reçoit { content, nonce, keyVersion } via WS ou API
2. Récupère la clé : epochKey = keys[channelId][keyVersion] (cache local)
   Sinon : GET /api/channels/:channelId/keys/history
3. plaintext = AES-256-GCM-Decrypt(epochKey, nonce, ciphertext)
```

### Rotation de clé

Lorsqu'un membre quitte ou est expulsé, la clé de l'epoch courant est révoquée et une nouvelle est générée :
- Incrémentation de `keyVersion` dans la table `channels`
- Génération d'un nouveau `masterSecret` (ou conservation du même avec un nouveau `keyVersion`)
- Distribution aux membres restants via `channel_key_distributions`

---

## 5. Cycle de vie d'un workspace

### 5.1 Création

```
POST /api/channels/workspaces
{ name, slug, imageMediaId? }
```

- Crée le workspace
- Crée automatiquement les 3 rôles (Administrateur, Modérateur, Membre)
- Ajoute le créateur comme Administrateur

### 5.2 Création d'un channel

```
POST /api/channels
{ workspaceId, name, isPrivate, allowedRoles[] }
```

- Génère un `masterSecret` aléatoire (32 bytes)
- Initialise `keyVersion = 1`
- Crée les entrées `channel_key_distributions` pour tous les membres concernés

### 5.3 Invitation d'un membre

```
POST /api/channels/:channelId/members/invite
{ actorUserId, targetUserId }
```

- Vérifie que `actorUserId` a la permission `manage_members`
- Crée l'entrée `channel_members` pour `targetUserId`
- Crée les entrées `channel_key_distributions` pour tous les channels auxquels `targetUserId` a accès
- Publie un événement Redis `channel.member.joined` → chat-gateway → WS des membres connectés

### 5.4 Expulsion d'un membre

```
POST /api/channels/:channelId/members/kick
{ actorUserId, targetUserId }
```

- Supprime l'entrée `channel_members`
- **Rotation des clés** : incrémente `keyVersion`, distribue les nouvelles clés aux membres restants
- Publie un événement Redis `channel.member.kicked`

---

## 6. Événements temps réel

social-service publie sur le canal Redis `chat:channel_events`, chat-gateway les reçoit et les transmet aux clients concernés via WebSocket.

| Type d'événement | Déclencheur | Données |
|---|---|---|
| `channel.member.joined` | Invitation acceptée | `{ workspaceId, channelId, userId }` |
| `channel.member.kicked` | Expulsion | `{ workspaceId, channelId, userId }` |
| `channel.message.created` | Nouveau message | `{ channelId, messageId, senderId, ... }` |

Format du message Redis :
```json
{
  "type": "channel.message.created",
  "data": { "channelId": "...", "messageId": "...", "senderId": "..." },
  "userIds": ["userId1", "userId2"],
  "timestamp": "2026-04-12T10:00:00Z"
}
```

Le chat-gateway lit `userIds` pour cibler précisément les connexions WS des membres du workspace.

---

## 7. API complète social-service (channels)

| Méthode | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/channels/workspaces` | ✅ | Créer un workspace |
| `GET` | `/api/channels/workspaces/by-slug/:slug` | — | Récupérer par slug |
| `GET` | `/api/channels/workspaces/user/me` | ✅ | Mes workspaces |
| `POST` | `/api/channels/roles` | ✅ | Créer un rôle |
| `GET` | `/api/channels/roles/:workspaceId` | ✅ | Rôles d'un workspace |
| `POST` | `/api/channels` | ✅ | Créer un channel |
| `GET` | `/api/channels/workspace/:workspaceId/user/me` | ✅ | Mes channels dans un workspace |
| `GET` | `/api/channels/:channelId/key` | ✅ | Clé courante du channel |
| `GET` | `/api/channels/:channelId/keys/history` | ✅ | Historique des clés |
| `POST` | `/api/channels/:channelId/join` | ✅ | Rejoindre un channel |
| `POST` | `/api/channels/:channelId/leave` | ✅ | Quitter un channel |
| `POST` | `/api/channels/:channelId/members/invite` | ✅ | Inviter un membre |
| `POST` | `/api/channels/:channelId/members/kick` | ✅ | Expulser un membre |
| `GET` | `/api/channels/:channelId/messages` | ✅ | Historique des messages |
| `POST` | `/api/channels/:channelId/messages` | ✅ | Envoyer un message |

---

## 8. Comparaison avec les conversations MLS

| Aspect | Conversations MLS (DM/groupes) | Channels (communautés) |
|---|---|---|
| **Protocole** | MLS RFC 9420 | AES-256-GCM + HKDF |
| **Clés** | Gérées 100% côté client | masterSecret côté serveur |
| **Forward secrecy** | ✅ (epoch MLS) | Partielle (rotation manuelle à l'expulsion) |
| **Post-compromise** | ✅ (MLS Update/Remove) | ✅ (rotation de clé) |
| **Accès serveur** | ❌ (impossible) | ⚠️ (le serveur détient masterSecret) |
| **Multi-device** | Chaque device = membre MLS | Clé partagée par userId |
| **Scalabilité** | Complexité O(N) commits | Simple, 1 clé par version |
