# Frontend

## 1. Vue d'ensemble

Le frontend Canari est une application **SvelteKit 2.9** utilisant **Svelte 5** (syntaxe runes) avec **TailwindCSS 4**. Il est compilé statiquement (`adapter-static`) et servi par Nginx en production.

Il existe aussi une version **application desktop** basée sur **Tauri 2** (`frontend/src-tauri/`), qui embarque le même bundle SvelteKit dans une webview native.

---

## 2. Structure du code

```
frontend/src/
├── app.html               # Template HTML racine
├── app.css                # CSS global (Tailwind + classes utilitaires)
├── app.d.ts               # Types globaux SvelteKit
├── hooks.client.ts        # Hooks client (init MLS, restauration session)
├── hooks.server.ts        # Hooks serveur (headers CSP)
├── lib/
│   ├── components/        # Composants réutilisables
│   │   ├── chat/          # Interface de messagerie
│   │   ├── messages/      # Bulles de message, médias, actions
│   │   ├── ui/            # Composants génériques (boutons, modals…)
│   │   └── communities/   # Interface des workspaces/channels
│   ├── services/
│   │   ├── WebMlsService.ts    # Implémentation MLS pour le web (WASM)
│   │   └── TauriMlsService.ts  # Implémentation MLS pour Tauri (natif)
│   ├── stores/
│   │   ├── auth.ts             # Session utilisateur, tokens
│   │   ├── conversations.ts    # État des conversations MLS
│   │   ├── ui.ts               # État UI (thème, navigation)
│   │   └── …
│   ├── sync/
│   │   └── syncEngine.ts       # Synchronisation multi-device
│   ├── composables/
│   │   ├── useChatSession.svelte.ts  # Login, reconnect, orchestration session MLS
│   │   ├── useConversations.svelte.ts # CRUD conversations, sélection, historique
│   │   └── useMessaging.svelte.ts    # Envoi, réception, réactions, médias
│   ├── types/
│   │   └── index.ts            # Dictionnaire central des types (Conversation, ChatMessage, …)
│   ├── envelope.ts             # Format unifié MessageEnvelope (text/media/system)
│   ├── proto/
│   │   └── codec.ts            # Encodage/décodage protobuf AppMessage + appMsgToEnvelope()
│   └── db.ts                   # Base de données locale (IndexedDB/SQLite Tauri)
└── routes/                 # Pages SvelteKit
    ├── +layout.svelte      # Layout racine (keyboard detection, bottom nav)
    ├── +page.svelte        # Page d'accueil
    ├── login/              # Page de connexion
    ├── auth/callback/      # Callback OIDC
    ├── chat/               # Messagerie MLS
    ├── communities/        # Workspaces et channels
    ├── posts/              # Fil d'actualités
    ├── forms/              # Formulaires
    ├── profile/            # Profil utilisateur
    └── dev/                # Outils de développement
```

---

## 3. Svelte 5 : syntaxe runes

Tout le code utilise les **runes Svelte 5** (pas l'ancienne syntaxe `$:` ou `export let`) :

```typescript
// État réactif
let count = $state(0);
let doubled = $derived(count * 2);

// Effets
$effect(() => {
  console.log('count changed:', count);
});

// Props d'un composant
const { message, onReply }: { message: Message; onReply: () => void } = $props();
```

---

## 4. Stores principaux

### auth.ts

Gère la session utilisateur et les tokens :

```typescript
// État
export const currentUser: Writable<User | null>;
export const accessToken: Writable<string | null>;

// Actions
export function setWsSessionCookie(token: string): void;
// → document.cookie = 'canari_ws_token=…; SameSite=Lax; path=/'
export function clearWsSessionCookie(): void;

export async function refreshAccessToken(): Promise<string | null>;
export async function logout(): Promise<void>;
```

Le token JWT est stocké **en mémoire** uniquement (pas localStorage). Le cookie `canari_ws_token` est synchronisé à chaque set/refresh du token pour permettre l'authentification WebSocket.

### Composables de messagerie (Svelte 5)

L'état des conversations n'est plus un store Svelte 4. Il vit dans une `SvelteMap<string, Conversation>` locale aux composables, instanciée par `MainChatPage.svelte` et `ChatBackgroundService.svelte`.

```typescript
// types/index.ts - types centraux
interface Conversation {
  id: string; // groupId MLS
  name: string; // nom affiché
  contactName: string; // identifiant de contact (ex : email normalisé)
  messages: ChatMessage[];
  isReady: boolean; // groupe MLS prêt (Welcome reçu)
  mlsStateHex: string | null;
  unreadCount?: number;
  conversationType?: 'direct' | 'group' | 'channel';
  directPeerId?: string;
  imageMediaId?: string | null;
}

interface ChatMessage {
  id: string;
  senderId: string;
  content: string; // JSON sérialisé d'un MessageEnvelope
  timestamp: Date;
  editedAt?: Date;
  isOwn: boolean;
  isSystem?: boolean;
  status?: 'sending' | 'sent' | 'error';
  replyTo?: MessageReference;
  reactions?: MessageReaction[];
  readBy?: string[];
  isEdited?: boolean;
  isDeleted?: boolean;
}
```

Les trois composables s'utilisent ensemble :

- `useConversations` - CRUD conversations, sélection active, scroll, pagination
- `useMessaging` - envoi/réception de messages, réactions, édition, suppression, médias
- `useChatSession` - orchestration globale (login, reconnect, WebSocket, sync multi-device)

---

## 5. Routes principales

### /login

Page de connexion. Deux modes :

- **OIDC** : bouton "Se connecter avec Authentik" → `startOidcLogin()`
- **Dev** : formulaire email/password (si `ENABLE_DEV_ROUTES=true` côté serveur)

### /auth/callback

Reçoit le `code` OIDC, vérifie le `state`, appelle `POST /api/auth/oidc/callback`, stocke le token.

### /chat

Interface de messagerie MLS. Composants principaux :

- `ChatArea.svelte` - zone principale (header + messages + composer)
- `ChatComposer.svelte` - zone de saisie avec gestion du clavier mobile
- `ChatMessageGroups.svelte` - rendu des messages groupés par date
- `MessageBubble.svelte` - bulle de message avec read receipts, search highlight, reply

Fonctionnalités UI :

- **Focus writing mode** : le header se masque quand le compositeur est actif sur mobile
- **Indicateur de date sticky** : la date courante reste visible lors du scroll
- **Recherche in-chat** : barre de recherche avec navigation prev/next et surlignage
- **Lightbox médias** : plein écran image/vidéo avec pinch-zoom et téléchargement
- **Menu radial** (mobile) : actions sur un message via menu circulaire (long press)
- **Read receipts** : états "Envoyé" / "Distribué" / "Lu" avec icônes distincts

### /communities

Interface des workspaces et channels. Chiffrement AES-256-GCM côté client (clé reçue de social-service via HTTPS).

### /posts

Fil d'actualités. Appelle `GET /api/posts` (social-service). Posts, sondages, réactions.

---

## 6. Détection du clavier mobile

Le layout racine (`+layout.svelte`) détecte l'ouverture du clavier virtuel via `visualViewport` :

```typescript
// Seuil adaptatif selon la plateforme
function keyboardOpenThresholdPx(): number {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 100; // iOS
  if (/Android/.test(ua)) return 140; // Android
  return 120; // Fallback
}

// Détection
visualViewport?.addEventListener('resize', () => {
  const delta = window.innerHeight - (visualViewport?.height ?? window.innerHeight);
  isKeyboardOpen = delta > keyboardOpenThresholdPx();
});
```

Quand `isKeyboardOpen = true` :

- `pb-14` (padding pour la bottom nav) est retiré
- La bottom nav est masquée
- La variable CSS `--keyboard-height` est mise à jour

---

## 7. Service MLS (WebMlsService)

Voir [MLS.md](MLS.md) pour la documentation complète du protocole.

Points spécifiques au frontend web :

```typescript
class WebMlsService implements IMlsService {
  private client: WasmMlsClient | null = null;

  async init(userId: string, deviceId: string, pin: string): Promise<void> {
    // Charge le WASM
    await init(); // wasm-bindgen init
    // Restaure l'état depuis localStorage
    const savedState = localStorage.getItem(`mls_state_${deviceId}`);
    this.client = await WasmMlsClient.new(userId, deviceId, savedState, pin);
  }

  // Toutes les opérations sont séquentialisées via messageQueue
  // pour éviter la corruption de l'état MLS concurrent
}
```

---

## 8. Application Tauri (desktop)

`frontend/src-tauri/` contient la configuration Tauri 2.

Différences avec la version web :

- `TauriMlsService` utilise `invoke()` au lieu de WASM (exécution native Rust)
- L'état MLS est stocké sur le filesystem (pas localStorage)
- Les requêtes HTTP utilisent `@tauri-apps/plugin-http` pour bypasser les restrictions CORS
- Le WS se connecte de la même façon
- La build génère des installateurs (`.exe`/`.dmg`/`.AppImage`)

Commandes Tauri disponibles (définies dans `src-tauri/src/`) :

- `mls_init` - initialise le client MLS
- `mls_send_message` - chiffre et retourne un ciphertext
- `mls_process_message` - déchiffre un message entrant
- `mls_create_group` / `mls_add_members_bulk` / `mls_process_welcome`
- `mls_generate_key_package`

---

## 9. Variables d'environnement (build time)

Injectées via `VITE_*` au moment du build (GitHub Actions ou `frontend/.env` local) :

| Variable                 | Description                                                             |
| ------------------------ | ----------------------------------------------------------------------- |
| `VITE_GATEWAY_URL`       | URL du chat-gateway (WebSocket)                                         |
| `VITE_DELIVERY_URL`      | URL du chat-delivery-service                                            |
| `VITE_MEDIA_URL`         | URL du media-service                                                    |
| `VITE_CORE_URL`          | URL du core-service                                                     |
| `VITE_SOCIAL_URL`        | URL du social-service                                                   |
| `VITE_OIDC_AUTHORITY`    | URL Authentik                                                           |
| `VITE_OIDC_CLIENT_ID`    | Client ID OIDC                                                          |
| `VITE_OIDC_REDIRECT_URI` | URI de callback OIDC                                                    |
| `PUBLIC_JWT_SECRET`      | Secret JWT (injecté via Vite, utilisé côté client pour la vérification) |

> **Attention** : `PUBLIC_JWT_SECRET` est embarqué dans le bundle JS. Il ne s'agit pas d'un secret strictement confidentiel côté client - la sécurité repose sur la validation serveur.

---

## 10. Qualité et conventions

### Linting / Formatage

```bash
cd frontend
bun run lint        # ESLint
bun run lint:fix    # Auto-fix
bun run format      # Prettier
bun run check       # svelte-check (TypeScript + Svelte)
```

### Hooks Husky

- **Pre-commit** : ESLint + Prettier (`--check`)
- **Pre-push** : svelte-check (0 erreurs, 0 warnings requis)

### Conventions de composants

- Extension `.svelte` pour les composants, `.svelte.ts` pour les composables avec state Svelte 5
- Props via destructuring `$props()` avec types TypeScript explicites
- Événements via callbacks dans les props (`onReply`, `onEdit`, etc.) - pas de `dispatch`
- Classes CSS : Tailwind utilities en priorité, classes nommées dans `app.css` pour les patterns répétés
