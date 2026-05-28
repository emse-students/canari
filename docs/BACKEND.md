# Services Backend

## Vue d'ensemble

Canari compte quatre services NestJS et une gateway Rust. Ce document couvre les services NestJS. Pour le chat-gateway Rust, voir [CHAT_GATEWAY.md](CHAT_GATEWAY.md).

| Service               | Port | Base de données      | Rôle principal                            |
| --------------------- | ---- | -------------------- | ----------------------------------------- |
| core-service          | 3012 | PostgreSQL           | Auth OIDC, utilisateurs, paiements Stripe |
| chat-delivery-service | 3010 | PostgreSQL + Redis   | API MLS, messages offline, historique     |
| media-service         | 3011 | MinIO                | Upload/download de médias chiffrés        |
| social-service        | 3014 | PostgreSQL + MongoDB | Posts, formulaires, channels              |

---

## 1. core-service

### Responsabilités

- Authentification OIDC via **Authentik** (provider externe)
- Gestion du profil utilisateur (upsert à la première connexion)
- Endpoint de vérification JWT pour le `auth_request` Nginx
- Intégration Stripe (onboarding, checkout, webhook)

### Entité utilisateur (PostgreSQL `auth_db`)

```typescript
@Entity('users')
class User {
  @PrimaryColumn() id: string; // sub OIDC Authentik
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  promo: number | null; // Année de promotion EMSE
  formation: string | null; // Formation (ex. "ISMIN")
  bio: string | null;
  stripeCustomerId: string | null;
  admin: boolean;
  createdAt: Date;
  updatedAt: Date;
}
```

### Endpoints

**Auth**

| Méthode | Route                     | Description                                |
| ------- | ------------------------- | ------------------------------------------ |
| `POST`  | `/api/auth/oidc/callback` | Échange OIDC `code` → JWT Canari           |
| `POST`  | `/api/auth/refresh`       | Renouvelle access_token via cookie refresh |
| `POST`  | `/api/auth/logout`        | Invalide la session, supprime cookie       |
| `GET`   | `/api/auth/verify`        | Endpoint interne Nginx auth_request        |
| `POST`  | `/api/auth/dev-login`     | Login de développement (désactivé en prod) |

**Users**

| Méthode | Route                   | Description                                 |
| ------- | ----------------------- | ------------------------------------------- |
| `GET`   | `/api/users/search?q=`  | Recherche préfixe (ILIKE, max 10 résultats) |
| `GET`   | `/api/users/me`         | Profil courant                              |
| `GET`   | `/api/users/:id`        | Profil d'un utilisateur                     |
| `PATCH` | `/api/users/me`         | Met à jour le profil                        |
| `GET`   | `/api/users/:id/avatar` | Proxy vers gallerie.mitv.fr                 |

**Paiements (Stripe)**

| Méthode | Route                                   | Description                                         |
| ------- | --------------------------------------- | --------------------------------------------------- |
| `POST`  | `/api/payments/onboarding`              | Crée un compte Stripe Connect                       |
| `POST`  | `/api/payments/create-checkout-session` | Session de paiement                                 |
| `POST`  | `/api/payments/webhook`                 | Webhook Stripe (body brut) → notifie social-service |

### Flux d'authentification OIDC

```
1. Frontend appelle startOidcLogin()
   → génère state (PKCE anti-CSRF) dans sessionStorage
   → redirect vers Authentik /authorize?...

2. Authentik redirect → /auth/callback?code=...&state=...
   Frontend vérifie state, extrait code

3. POST /api/auth/oidc/callback { code, redirect_uri }
   → core-service échange le code côté serveur (secret Authentik)
   → Authentik retourne { id_token, access_token, ... }
   → core-service décode l'id_token → { sub, email, name, ... }
   → Upsert utilisateur en PostgreSQL
   → Signe un JWT Canari (HS256, 15 min, payload: { sub, email })
   → Génère un refresh token (cookie HttpOnly, SameSite=Strict, 7 jours)
   → Retourne { access_token }

4. Frontend stocke access_token en mémoire
   + cookie canari_ws_token (SameSite=Lax) pour le WebSocket

5. Refresh automatique :
   POST /api/auth/refresh (cookie refresh automatiquement envoyé)
   → nouveau access_token
```

### NginxAuthGuard

La majorité des routes des autres services sont protégées par le `NginxAuthGuard` ou le `HeaderAuthGuard` :

- **NginxAuthGuard** (social-service) : lit le header `X-User-Id` injecté par Nginx après `auth_request`. En dev (sans Nginx), extrait le sub du JWT Bearer.
- **HeaderAuthGuard** (chat-delivery-service) : valide directement le Bearer JWT HS256.

---

## 2. chat-delivery-service

### Responsabilités

- Stocker et distribuer les messages MLS
- Gérer les KeyPackages (devices)
- Stocker les messages offline (destinataires déconnectés)
- Alimenter le Redis Stream historique
- Envoyer les push notifications (FCM/APNs) via Kafka
- Orchestrer la synchronisation multi-device

### Entités PostgreSQL (`auth_db`)

**key_packages** - KeyPackage MLS standard par device

| Colonne         | Description                                  |
| --------------- | -------------------------------------------- |
| `userId`        | Identifiant utilisateur                      |
| `deviceId`      | Identifiant device (UUID généré côté client) |
| `packageBase64` | KeyPackage sérialisé (base64)                |

Contrainte UNIQUE sur `(userId, deviceId)` - un seul KeyPackage standard par device.

**one_time_key_packages** - Pool de pré-keys (usage unique)

Utilisées lors des Welcomes MLS pour éviter les collisions d'epoch quand plusieurs invitations sont générées rapidement.

**queued_message** - Messages offline

| Colonne       | Description                      |
| ------------- | -------------------------------- |
| `recipientId` | Destinataire                     |
| `deviceId`    | Device destinataire              |
| `proto`       | Ciphertext MLS (base64)          |
| `isWelcome`   | Boolean - c'est un Welcome MLS   |
| `isCommit`    | Boolean - c'est un Commit MLS    |
| `groupId`     | Identifiant du groupe            |
| `type`        | Type de message                  |
| `ratchetTree` | Ratchet tree (base64, optionnel) |

**dm_groups** - Groupes MLS

| Colonne                    | Description                             |
| -------------------------- | --------------------------------------- |
| `id`                       | groupId (UUID)                          |
| `isGroup`                  | true = groupe multi-membres, false = DM |
| `keyVersion`               | Version clé courante                    |
| `activeEpoch`              | Epoch MLS courant                       |
| `latestKeyRotationPayload` | Dernier payload de rotation             |

**dm_group_members** - Appartenance aux groupes

| Colonne   | Description                             |
| --------- | --------------------------------------- |
| `groupId` | Référence dm_groups                     |
| `userId`  | Membre                                  |
| `role`    | `admin` \| `member`                     |
| `leftAt`  | Timestamp départ (null si membre actif) |

**dm_device_group_memberships** - Tracking par device

| Colonne         | Description                                                  |
| --------------- | ------------------------------------------------------------ |
| `groupId`       | Référence dm_groups                                          |
| `userId`        |                                                              |
| `deviceId`      |                                                              |
| `status`        | `pending` \| `welcome_sent` \| `welcome_received` \| `stale` |
| `lastEpochSeen` | Dernier epoch traité par ce device                           |

**push_tokens** - Tokens FCM/APNs

| Colonne    | Description       |
| ---------- | ----------------- |
| `userId`   |                   |
| `deviceId` |                   |
| `token`    | Token FCM ou APNs |
| `platform` | `fcm` \| `apns`   |

### Flux d'envoi d'un message

```
POST /api/mls/send
{ proto, groupId, recipientId, deviceId, senderId, senderDeviceId }

1. Stocke le message dans Redis Stream history:{groupId}
   (TTL configurable, utilisé par GET /api/mls/history/:groupId)

2. Récupère les membres du groupe dans dm_group_members

3. Pour chaque membre/device :
   a. Publie sur Redis "chat:messages"
      { recipientId, deviceId, proto, groupId, senderId, senderDeviceId }
      → chat-gateway le délivre si le device est online

   b. Si le device est offline (absence dans Redis présence) :
      → stocke dans queued_message
      → si le device est offline, envoie une push FCM data-only

4. Retourne 201 OK
```

### Push Notifications

Le comportement actuel n'utilise pas Kafka pour les pushs chat.

Le `chat-delivery-service` :

- persiste d'abord les messages dans `queued_message`
- teste ensuite la présence Redis par device
- publie sur Redis `chat:messages` si le device est online
- envoie une push Firebase Admin data-only si le device est offline

Le payload FCM actuel est minimal et transporte surtout :

```typescript
{
   data: {
      type: 'message',
      groupId: '...',
      queuedMessageId: '...',
      senderId: '...'
   }
}
```

Le texte final affiché à l'utilisateur est reconstruit côté client Android après récupération du message chiffré en attente et tentative de déchiffrement local.

Voir aussi `docs/PUSH_NOTIFICATIONS.md` pour le flux réel, les limites actuelles et les pistes de correction.

---

## 3. media-service

### Principe de sécurité

Le media-service stocke uniquement des **blobs opaques chiffrés**. Il ne détient jamais les clés de déchiffrement - celles-ci voyagent dans les messages MLS chiffrés.

### Stockage

- Backend : **MinIO** (API S3 compatible), bucket `canari-media`
- Limite de taille : `MEDIA_MAX_SIZE_MB` (max policy 100 MB, chunks de 50 MB)

### Auth

Validation JWT HS256 maison via `Authorization: Bearer <token>` (même `JWT_SECRET` que les autres services).

### Endpoints

| Méthode  | Route               | Description                      |
| -------- | ------------------- | -------------------------------- |
| `POST`   | `/api/media/upload` | Upload multipart → `{ mediaId }` |
| `GET`    | `/api/media/:id`    | Download du blob chiffré         |
| `DELETE` | `/api/media/:id`    | Suppression                      |

### Flux d'upload

```
1. Client génère CEK (32B) + IV (12B)
2. Chiffre le fichier : AES-256-GCM(CEK, IV, plaintext) → ciphertext
3. POST /api/media/upload { file: ciphertext, mimetype }
   ← { mediaId }
4. Envoie un message MLS MediaMsg { media_id, key=CEK, iv=IV, ... }
   (CEK + IV chiffrés dans le proto MLS - jamais vus par le serveur)
```

---

## 4. social-service

### Responsabilités

- Fil d'actualités (posts, sondages, réactions)
- Formulaires (avec paiement Stripe)
- Channels et workspaces (communautés) → voir [COMMUNITIES.md](COMMUNITIES.md)
- Événements et associations

### Auth

`NginxAuthGuard` : lit `X-User-Id` (injecté par Nginx). En dev, fallback JWT Bearer.

### Posts

**Collections MongoDB** (`chat_db`) : `posts`, `comments`, `reactions`

| Méthode  | Route                                   | Description                                                  |
| -------- | --------------------------------------- | ------------------------------------------------------------ |
| `POST`   | `/api/posts`                            | Créer un post (vérification membership + Stripe si paiement) |
| `GET`    | `/api/posts`                            | Liste paginée                                                |
| `GET`    | `/api/posts/:id`                        | Détail d'un post                                             |
| `PATCH`  | `/api/posts/:id`                        | Modifier (auteur ou admin)                                   |
| `DELETE` | `/api/posts/:id`                        | Supprimer                                                    |
| `POST`   | `/api/posts/:id/reactions`              | Réagir (emoji)                                               |
| `POST`   | `/api/posts/:postId/polls/:pollId/vote` | Voter dans un sondage                                        |
| `POST`   | `/api/posts/:id/comments`               | Commenter                                                    |

### Formulaires

Les formulaires permettent de collecter des réponses avec paiement optionnel via Stripe Connect :

| Méthode | Route                      | Description                 |
| ------- | -------------------------- | --------------------------- |
| `POST`  | `/api/forms`               | Créer un formulaire         |
| `GET`   | `/api/forms/:id`           | Récupérer un formulaire     |
| `POST`  | `/api/forms/:id/responses` | Soumettre une réponse       |
| `GET`   | `/api/forms/:id/responses` | Toutes les réponses (admin) |

### Channels / Communautés

Voir [COMMUNITIES.md](COMMUNITIES.md) pour la documentation complète.

### Webhook Stripe

`POST /api/payments/webhook` (depuis core-service) : déclenche les actions post-paiement dans social-service (ex. confirmation d'inscription à un événement).

---

## 5. Authentification dans les services NestJS

### NginxAuthGuard (production)

```typescript
// apps/social-service/src/common/guards/nginx-auth.guard.ts
@Injectable()
export class NginxAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();

    if (process.env.NGINX_AUTH_SECRET) {
      // Production : vérifier le secret Nginx
      const secret = req.headers['x-nginx-auth'];
      if (secret !== process.env.NGINX_AUTH_SECRET) return false;
    }

    // Lire l'utilisateur depuis le header injecté par Nginx
    const userId = req.headers['x-user-id'];
    if (!userId) return false;

    req.user = { id: userId };
    return true;
  }
}
```

### HeaderAuthGuard (chat-delivery-service)

Valide directement le JWT Bearer (sans Nginx intermédiaire) :

```typescript
const payload = jwt.verify(token, JWT_SECRET);
req.user = { id: payload.sub };
```
