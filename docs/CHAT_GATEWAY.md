# Chat Gateway (Rust)

## 1. Rôle

Le `chat-gateway` (port 3000) est le point d'entrée WebSocket temps réel. Il est écrit en **Rust** avec le framework **Axum** (Tokio async runtime).

Ses responsabilités :
- Gérer les connexions WebSocket des clients
- Valider les JWT à la connexion
- Maintenir un registre des devices connectés en mémoire
- Gérer la présence (online/offline) via Redis
- Router les messages MLS arrivant de Redis vers les clients connectés
- Diffuser les événements de channels arrivant de Redis

**Important** : le gateway est un routeur, pas un producteur de messages. Les messages MLS transitent via HTTP (`chat-delivery-service`), le gateway ne fait que les délivrer aux WS connectés.

---

## 2. Architecture interne

### AppState

L'état partagé entre les handlers est un `Arc<AppState>` :

```rust
pub struct AppState {
    // Map "userId:deviceId" → liste de senders mpsc
    // (plusieurs onglets = plusieurs senders)
    pub connected_users: Arc<RwLock<HashMap<String, Vec<mpsc::Sender<String>>>>>,

    // Client Redis (pool de connexions)
    pub redis: Client,

    // Secret JWT pour validation
    pub jwt_secret: String,
}
```

### ConnectionGuard

Un `ConnectionGuard` est créé à chaque connexion WS. Son `Drop` nettoie automatiquement :
- Retire le sender de `connected_users`
- Supprime la clé de présence Redis `user:online:{userId}:{deviceId}`

---

## 3. Authentification WebSocket

À la connexion (`GET /api/ws?device_id=...`), le token JWT est extrait depuis :
1. Le cookie `canari_ws_token` (priorité)
2. Le query parameter `token=` (fallback)

Validation :
```rust
// handlers.rs
fn validate_jwt(token: &str, secret: &str) -> Option<String> {
    let key = DecodingKey::from_secret(secret.as_bytes());
    let validation = Validation::new(Algorithm::HS256);
    decode::<Claims>(token, &key, &validation)
        .ok()
        .map(|data| data.claims.sub)
}
```

Si le JWT est invalide ou absent, la connexion est rejetée avec `4401 Unauthorized`.

---

## 4. Gestion des connexions

### Connexion

1. Upgrade HTTP → WebSocket
2. Validation JWT → extraction `userId`
3. Enregistrement dans `connected_users["userId:deviceId"]` (mpsc sender)
4. Set Redis `user:online:{userId}:{deviceId}` avec TTL 120s
5. Drain des `pending_welcomes:{userId}` (messages WS en attente avant connexion)
6. Lancement de deux tâches asynchrones :
   - `ws_read_loop` : écoute les frames du client
   - `ws_write_loop` : écoute le mpsc receiver et écrit vers le WS

### Heartbeat / Présence

La clé Redis `user:online:{userId}:{deviceId}` est rafraîchie toutes les **30s** (TTL 120s). Si le client se déconnecte brutalement, la clé expire en 120s maximum.

### Déconnexion

`ConnectionGuard::drop()` :
- Retire le sender de `connected_users`
- `DEL user:online:{userId}:{deviceId}` dans Redis

---

## 5. Frames WebSocket

### Client → Gateway

| Type | Champs | Action |
|---|---|---|
| `welcome_request` | `groupId`, `payload`, `targetUserId`, `targetDeviceId` | Forward du Welcome vers le device cible |
| `reinvite_request` | idem | Réinvitation (epoch stale) |
| `read` | `messageId` | Acquittement lecture (no-op) |

**Logique de forward du Welcome** :
```rust
// ws_dispatch.rs
// 1. Lit les membres du groupe dans Redis "group:members:{groupId}"
// 2. Pour chaque device cible online dans connected_users :
//    → envoie le frame via mpsc sender
// 3. Si offline : stocke dans Redis "pending_welcomes:{userId}" (list LPUSH)
```

### Gateway → Client

```json
{
  "proto": "<base64 ciphertext MLS>",
  "senderId": "userId",
  "senderDeviceId": "deviceId",
  "groupId": "uuid",
  "isWelcome": false,
  "isCommit": false,
  "timestamp": 1744459200
}
```

---

## 6. Redis Pub/Sub

Le gateway subscribe en permanence à deux canaux Redis au démarrage.

### Canal `chat:messages`

Producteur : `chat-delivery-service` (à chaque `POST /api/mls-api/send`)

Format :
```json
{
  "recipientId": "userId",
  "deviceId": "deviceId",
  "proto": "<base64>",
  "groupId": "uuid",
  "senderId": "userId",
  "senderDeviceId": "deviceId",
  "isWelcome": false,
  "isCommit": false
}
```

Traitement :
```
1. Lookup connected_users["recipientId:deviceId"]
2. Si présent et sender actif → envoie via mpsc
3. Sinon → ignore (message déjà stocké dans queued_message par chat-delivery-service)
```

### Canal `chat:channel_events`

Producteur : `social-service`

Format :
```json
{
  "type": "channel.message.created",
  "data": { "channelId": "...", "messageId": "...", "senderId": "..." },
  "userIds": ["userId1", "userId2", "userId3"],
  "timestamp": "2026-04-12T10:00:00Z"
}
```

Traitement :
```
Pour chaque userId dans userIds :
  Pour chaque deviceId connu pour cet userId dans connected_users :
    → envoie le frame JSON brut vers le WS du device
```

---

## 7. Routes HTTP (non-WebSocket)

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/api/ws` | Upgrade WebSocket |
| `GET` | `/api/groups/:groupId/members` | Liste des membres d'un groupe (depuis Redis) |
| `POST` | `/api/groups` | Crée ou met à jour un groupe dans Redis |

---

## 8. Dépendances Cargo

```toml
[dependencies]
axum = { version = "0.7", features = ["ws"] }
tokio = { version = "1", features = ["full"] }
redis = { version = "0.25", features = ["tokio-comp", "connection-manager"] }
jsonwebtoken = "9"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4"] }
tracing = "0.1"
tracing-subscriber = "0.3"
```

---

## 9. Variables d'environnement

| Variable | Défaut | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | URL Redis |
| `JWT_SECRET` | — | Secret JWT HS256 (obligatoire) |
| `PORT` | `3000` | Port d'écoute |
| `RUST_LOG` | `info` | Niveau de log (`debug`, `info`, `warn`, `error`) |

---

## 10. Build Docker

```dockerfile
# Build multi-stage
FROM rust:1.80 AS builder
WORKDIR /app
COPY . .
RUN cargo build --release --bin chat-gateway

FROM debian:bookworm-slim
COPY --from=builder /app/target/release/chat-gateway /usr/local/bin/
CMD ["chat-gateway"]
```
