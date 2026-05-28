# Architecture de Canari

## 1. Vue d'ensemble

Canari est un monorepo microservices. Le seul point d'entrée public est **Nginx** (frontend), qui joue le rôle de reverse proxy et de gateway d'authentification via `auth_request`.

En production, Cloudflare Tunnel expose `http://localhost:8080` - le host forward sur Nginx:80 du conteneur frontend.

---

## 2. Topologie des services

| Service                   | Stack                      | Port         | Base de données      | Rôle                                                  |
| ------------------------- | -------------------------- | ------------ | -------------------- | ----------------------------------------------------- |
| **frontend** (Nginx)      | Nginx + SvelteKit statique | 80           | -                    | Point d'entrée HTTP unique, reverse proxy             |
| **chat-gateway**          | Rust / Axum / Tokio        | 3000         | Redis                | WebSocket temps réel, routage MLS, présence           |
| **chat-delivery-service** | NestJS                     | 3010         | PostgreSQL + Redis   | API MLS, messages offline, historique Redis Stream    |
| **media-service**         | NestJS                     | 3011         | MinIO                | Stockage blobs chiffrés E2EE                          |
| **core-service**          | NestJS                     | 3012         | PostgreSQL           | Auth OIDC (Authentik), utilisateurs, paiements Stripe |
| **social-service**        | NestJS                     | 3014         | PostgreSQL + MongoDB | Posts, formulaires, channels/communautés              |
| Redis                     | -                          | 6379         | -                    | Présence, Pub/Sub, streams historique                 |
| Kafka                     | Confluent 7.5              | 9092 / 29092 | -                    | Bus d'événements asynchrones                          |
| PostgreSQL                | -                          | 5432         | `auth_db`            | Données relationnelles partagées                      |
| MongoDB                   | -                          | 27017        | `chat_db`            | Posts et données document                             |
| MinIO                     | -                          | 9000 / 9001  | -                    | Blobs médias (S3-compatible)                          |
| Coturn                    | -                          | 3478 / 5349  | -                    | STUN/TURN WebRTC (local uniquement)                   |

---

## 3. Routage Nginx

Nginx est l'unique entrée HTTP. Il implémente l'authentification via le sous-module `auth_request` de Nginx, qui valide chaque requête protégée en appelant `core-service:3012/api/auth/verify` en interne.

### Tableau des routes

| Route publique        | Upstream                     | Auth ? | Notes                                                                           |
| --------------------- | ---------------------------- | ------ | ------------------------------------------------------------------------------- |
| `/api/ws`             | `chat-gateway:3000`          | ✅     | WebSocket upgrade, token cookie                                                 |
| `/api/presence`       | `chat-gateway:3000`          | ✅     | Présence en ligne (Redis)                                                       |
| `/api/mls/*`          | `chat-delivery-service:3010` | ✅     | MLS (messages, groupes, sync, push, historique Redis sous `/api/mls/history/*`) |
| `/api/media/*`        | `media-service:3011`         | ✅     | Blobs chiffrés (MinIO)                                                          |
| `/api/posts/*`        | `social-service:3014`        | ✅     | Fil d'actualités                                                                |
| `/api/forms/*`        | `social-service:3014`        | ✅     | Formulaires avec paiements                                                      |
| `/api/associations/*` | `social-service:3014`        | ✅     | Associations (Stripe Connect)                                                   |
| `/api/channels/*`     | `social-service:3014`        | ✅     | Workspaces et channels                                                          |
| `/api/auth/*`         | `core-service:3012`          | -      | Login OIDC, refresh, logout                                                     |
| `/api/users/*`        | `core-service:3012`          | ✅     | Profils utilisateurs, recherche                                                 |
| `/api/payments/*`     | `core-service:3012`          | ✅     | Stripe (checkout, webhooks)                                                     |

> **Note**: La route `/api/groups` a été supprimée. La gestion des groupes est maintenant via `/api/mls/*` (chat-delivery-service).

**Headers réinjectés par Nginx** après `auth_request` réussi :

- `X-User-Id` - identifiant utilisateur (sub OIDC)
- `X-User-Logged-In` - booléen

---

## 4. Authentification (OIDC Authentik)

```
1. Frontend → startOidcLogin()
     → redirect vers Authentik /authorize (PKCE, state anti-CSRF)

2. Authentik → redirect vers /auth/callback?code=...&state=...

3. Frontend → POST /api/auth/oidc/callback { code, redirect_uri }
     → core-service échange le code contre tokens Authentik (server-side)
     → upsert utilisateur en PostgreSQL
     → retourne { access_token (JWT HS256, 15 min), refresh (cookie HttpOnly 7j) }

4. Frontend stocke access_token en mémoire + cookie canari_ws_token
     (pour auth WebSocket via cookie HTTP)

5. Refresh automatique : POST /api/auth/refresh via cookie HttpOnly
```

**En dev** : `POST /api/auth/dev-login` (désactivé via `ENABLE_DEV_ROUTES=false` en prod).

**Vérification Nginx** : `GET /internal/auth/verify` sur `core-service:3012/api/auth/verify`.

---

## 5. Communications inter-services

### HTTP synchrone

| Appelant              | Appelé       | Raison                                   |
| --------------------- | ------------ | ---------------------------------------- |
| chat-delivery-service | core-service | Vérification utilisateurs                |
| social-service        | core-service | Auth paiements, vérification memberships |
| media-service         | -            | Accès direct MinIO (SDK)                 |

### Redis Pub/Sub (temps réel)

| Canal                 | Producteur            | Consommateur | Format                                                              |
| --------------------- | --------------------- | ------------ | ------------------------------------------------------------------- |
| `chat:messages`       | chat-delivery-service | chat-gateway | `{ recipientId, deviceId, proto (base64), groupId, senderId, ... }` |
| `chat:channel_events` | social-service        | chat-gateway | `{ type, data, userIds[], timestamp }`                              |

**Types d'événements canal** (`chat:channel_events`) :

- `channel.member.joined`
- `channel.member.kicked`
- `channel.message.created`

### Kafka (événements asynchrones)

| Topic           | Producteur            | Consommateur                       | Payload            |
| --------------- | --------------------- | ---------------------------------- | ------------------ |
| `chat.messages` | chat-delivery-service | chat-delivery-service (push notif) | `MessageSentEvent` |
| `post_created`  | social-service        | chat-gateway                       | `PostCreatedEvent` |

---

## 6. Flux d'un message MLS (online)

```
1. Expéditeur (WASM)
   WasmMlsClient.send_message(groupId, plaintext)
   → ciphertext MLS (AES-128-GCM, epoch courant)

2. Frontend → HTTP POST /api/mls/send
   { proto: base64(ciphertext), groupId, recipientId, deviceId }

3. chat-delivery-service
   ├── Stocke dans Redis Stream history:{groupId}
   └── Publie N messages sur Redis "chat:messages"
       (un par membre/device destinataire)

4. chat-gateway (abonné Redis "chat:messages")
   ├── Lookup: connected_users["userId:deviceId"]
   ├── Online → envoie frame WS au destinataire
   └── Offline → message déjà stocké (récupéré à la reconnexion)

5. Destinataire (WASM)
   processIncomingMessage(groupId, bytes) → plaintext AppMessage → UI
```

**Offline** : le client appelle `GET /api/mls/messages/:userId/:deviceId` à la reconnexion et rejoue les messages en file séquentielle.

---

## 7. Flux de création d'un groupe MLS

```
1. GET /api/mls/devices/:userId  → liste des devices / KeyPackages du contact
2. POST /api/mls/groups { groupId, createdBy, members[], isGroup }
3. mls.createGroup(groupId)           → epoch 0 côté initiateur
4. mls.addMembersBulk(devices)        → { commit, welcome, ratchetTree }
5. POST /api/mls/welcome          → stockage offline pour chaque device
6. POST /api/mls/send (commit)    → diffusé via Redis aux membres online
7. Si multi-device (propres appareils): répéter 4-6
```

---

## 8. Protocole WebSocket (frames JSON)

### Client → Gateway (entrant)

| Frame              | Champs                                                 | Action                                       |
| ------------------ | ------------------------------------------------------ | -------------------------------------------- |
| `welcome_request`  | `groupId`, `payload`, `targetUserId`, `targetDeviceId` | Forward du Welcome à un peer                 |
| `reinvite_request` | idem                                                   | Réinvitation après stale epoch               |
| `read`             | `messageId`                                            | Acquittement de lecture (no-op côté gateway) |

### Gateway → Client (sortant)

```json
{
  "proto": "<base64 ciphertext MLS>",
  "senderId": "userId",
  "senderDeviceId": "deviceId",
  "groupId": "uuid",
  "isWelcome": false,
  "isCommit": false
}
```

---

## 9. Schémas de données PostgreSQL

Toutes les tables partagent la base `auth_db` (core-service + chat-delivery-service ont le même host).

### Tables core-service

| Table   | Colonnes clés                                                                            |
| ------- | ---------------------------------------------------------------------------------------- |
| `users` | `id` (sub OIDC), `displayName`, `promo`, `formation`, `bio`, `stripeCustomerId`, `admin` |

### Tables chat-delivery-service

| Table                         | Colonnes clés                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `key_packages`                | `userId`, `deviceId` (UNIQUE), `packageBase64`                                                           |
| `one_time_key_packages`       | pool de pré-keys par `(userId, deviceId)`                                                                |
| `queued_message`              | `recipientId`, `deviceId`, `proto`, `isWelcome`, `isCommit`, `groupId`, `type`, `ratchetTree`            |
| `dm_groups`                   | `id`, `isGroup`, `keyVersion`, `activeEpoch`, `latestKeyRotationPayload`                                 |
| `dm_group_members`            | `groupId`, `userId`, `role`, `leftAt`                                                                    |
| `dm_device_group_memberships` | `groupId`, `userId`, `deviceId`, `status` (pending/welcome_sent/welcome_received/stale), `lastEpochSeen` |
| `push_tokens`                 | `userId`, `deviceId`, `token`, `platform` (fcm/apns)                                                     |

### Tables social-service

| Table                       | Colonnes clés                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `channel_workspaces`        | `id`, `slug` (unique), `name`, `createdBy`, `imageMediaId`                                                    |
| `channels`                  | `workspaceId`, `name`, `isPrivate`, `allowedRoles[]`, `keyVersion`, `masterSecret`, `archived`                |
| `channel_roles`             | `workspaceId`, `name`, `priority`, `permissions[]`                                                            |
| `channel_members`           | `workspaceId`, `userId`, `roleIds[]`, `keys` (JSONB)                                                          |
| `channel_messages`          | `channelId`, `senderId`, `content` (ciphertext), `nonce`, `keyVersion`, `replyTo`, `attachments`, `reactions` |
| `channel_key_distributions` | `channelId`, `userId`, `deviceId`, `status`, `attempts`, `sentAt`, `receivedAt`, `ackedAt`                    |

---

## 10. Déploiement production

```
Internet
  └── Cloudflare (TLS termination)
        └── Cloudflare Tunnel → http://localhost:8080
              └── Nginx:80 (conteneur frontend)
                    ├── /api/ws         → chat-gateway:3000
                    ├── /api/mls/*  → chat-delivery-service:3010
                    ├── /api/media/*    → media-service:3011
                    ├── /api/auth/*     → core-service:3012
                    ├── /api/channels/* → social-service:3014
                    └── /*              → SvelteKit statique (build/)
```

Les services backend sont uniquement exposés via `expose:` (pas de `ports:` en prod), ils ne sont accessibles que depuis le réseau Docker interne.
