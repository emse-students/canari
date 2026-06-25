# Frontend architecture

**Stack**: SvelteKit 2.9 / Svelte 5 (runes) / TailwindCSS 4 / Tauri 2  
**Source**: `frontend/`

## Overview

The frontend is a SvelteKit application compiled as a static bundle (`adapter-static`), served by Nginx in production. The same bundle can also run inside a **Tauri 2** webview as a native desktop/mobile app (`frontend/src-tauri/`). All MLS encryption/decryption happens in the frontend — either via a WASM module (browser) or via native Rust commands (Tauri).

## Source tree

```
frontend/
├── src/
│   ├── app.html                    # Root HTML template
│   ├── app.css                     # Global CSS (Tailwind + utilities)
│   ├── hooks.client.ts             # Client hooks (MLS init, session restore)
│   ├── hooks.server.ts             # Server hooks (CSP headers)
│   ├── lib/
│   │   ├── components/
│   │   │   ├── chat/               # Messaging UI (ChatArea, Composer, MessageBubble...)
│   │   │   ├── messages/           # Message bubbles, media, reactions
│   │   │   ├── posts/              # Feed components
│   │   │   ├── associations/       # Association management
│   │   │   ├── profile/            # Profile sections
│   │   │   ├── shared/             # Generic shared components
│   │   │   └── ui/                 # Headless UI primitives (buttons, modals, pickers)
│   │   ├── composables/
│   │   │   ├── useChatSession.svelte.ts   # Login, reconnect, MLS session orchestration
│   │   │   ├── useConversations.svelte.ts # CRUD conversations, active selection, pagination
│   │   │   └── useMessaging.svelte.ts     # Send/receive messages, reactions, edits, media
│   │   ├── mls-client/             # MLS client package (see mls-wasm.md)
│   │   ├── services/
│   │   │   ├── WebMlsService.ts    # MLS implementation: browser (WASM)
│   │   │   └── TauriMlsService.ts  # MLS implementation: Tauri (native Rust)
│   │   ├── stores/
│   │   │   ├── auth.svelte.ts      # User session, tokens, ws cookie
│   │   │   ├── user.ts             # Current user profile
│   │   │   ├── conversations.ts    # Conversation state (SvelteMap)
│   │   │   ├── confirm.svelte.ts   # Global confirm dialog store
│   │   │   ├── toast.svelte.ts     # Toast notifications
│   │   │   └── ui.svelte.ts        # Theme, navigation state
│   │   ├── types/
│   │   │   └── index.ts            # Central type dictionary
│   │   ├── utils/
│   │   │   ├── chat/               # Chat utilities (connection, actions, history, messaging)
│   │   │   └── apiFetch.ts         # Authenticated fetch wrapper (auto-refresh)
│   │   ├── envelope.ts             # MessageEnvelope union type + serialization
│   │   ├── proto/
│   │   │   └── codec.ts            # Protobuf encode/decode + appMsgToEnvelope()
│   │   ├── paraglide/              # Generated i18n messages (Paraglide)
│   │   └── db.ts                   # Local DB (IndexedDB web / SQLite Tauri)
│   └── routes/
│       ├── +layout.svelte          # Root layout (keyboard detection, bottom nav)
│       ├── login/                  # Login page (OIDC + dev mode)
│       ├── auth/callback/          # OIDC callback handler
│       ├── chat/                   # MLS messaging
│       ├── communities/            # Workspaces and channels
│       ├── posts/                  # News feed
│       ├── forms/[id]/             # Form submission
│       ├── lists/                  # Association member lists
│       ├── profile/                # User profile
│       └── admin/                  # Platform admin (global admin only)
├── mls-wasm/                       # Rust WASM bindings (OpenMLS)
├── mls-core/                       # Shared Rust MLS logic
├── src-tauri/                      # Tauri 2 configuration and native commands
└── messages/
    ├── fr.json                     # French i18n messages (source of truth)
    └── en.json                     # English i18n messages
```

## Svelte 5 patterns

All components use **Svelte 5 runes** exclusively:

```typescript
let count = $state(0);
let doubled = $derived(count * 2);
$effect(() => { /* reactive side effect */ });
const { message, onReply }: Props = $props();
```

- No `$:` reactive declarations, no `export let`, no `createEventDispatcher`.
- Events are passed as callback props (`onReply`, `onEdit`, etc.).
- Composables with reactive state use the `.svelte.ts` extension.
- Locale-reactive derived values: `const label = $derived(m.some_key())` — reassigned automatically on locale change.

## Auth / token management

- **Access token**: JWT HS256 (15 min), stored in memory only — never localStorage.
- **Refresh token**: HttpOnly cookie (7 days), rotated on each use via `POST /api/auth/refresh`.
- **WebSocket auth**: cookie `canari_ws_token` set via `document.cookie` on each token refresh.
- `apiFetch.ts` handles 401 responses by attempting a token refresh before retrying.

```typescript
// auth.svelte.ts
export const currentUser: Writable<User | null>;
export const accessToken: Writable<string | null>;
export function setWsSessionCookie(token: string): void;
export async function refreshAccessToken(): Promise<string | null>;
export async function logout(): Promise<void>;
```

## Core types

```typescript
// types/index.ts
interface Conversation {
  id: string;             // MLS groupId
  name: string;
  contactName: string;    // normalized contact identifier
  messages: ChatMessage[];
  isReady: boolean;       // MLS group ready (Welcome received)
  conversationType?: 'direct' | 'group' | 'channel';
  directPeerId?: string;
  imageMediaId?: string | null;
}

interface ChatMessage {
  id: string;
  senderId: string;
  content: string;        // serialized MessageEnvelope JSON
  timestamp: Date;
  isOwn: boolean;
  status?: 'sending' | 'sent' | 'error';
  replyTo?: MessageReference;
  reactions?: MessageReaction[];
}
```

## i18n (Paraglide)

- Keys defined in `frontend/messages/fr.json` (source) and `en.json` (translation). Parity between files is required.
- Import: `import { m } from '$lib/paraglide/messages'`.
- Usage in templates: `{m.key()}` or `m.key({ param })`.
- Locale-reactive in `<script>`: `const label = $derived(m.some_key())`.
- Date/number locale: `import { getLocale } from '$lib/paraglide/runtime'` -> `getLocale() === 'en' ? 'en-US' : 'fr-FR'`.
- User-visible strings must always go through Paraglide — never inline French string literals.

## Mobile keyboard detection

The root layout detects the virtual keyboard via `visualViewport`:

```typescript
function keyboardOpenThresholdPx(): number {
  if (/iPhone|iPad|iPod/.test(ua)) return 100;
  if (/Android/.test(ua)) return 140;
  return 120;
}
visualViewport?.addEventListener('resize', () => {
  const delta = window.innerHeight - (visualViewport?.height ?? window.innerHeight);
  isKeyboardOpen = delta > keyboardOpenThresholdPx();
});
```

When `isKeyboardOpen = true`: bottom nav is hidden, `pb-14` padding removed, `--keyboard-height` CSS variable updated.

## Tauri (desktop/mobile)

`frontend/src-tauri/` contains the Tauri 2 configuration. Key differences from the browser build:

- `TauriMlsService` calls `invoke()` instead of WASM (native Rust execution).
- MLS state stored on the filesystem, not localStorage.
- HTTP requests via `@tauri-apps/plugin-http` (bypasses CORS).
- Native Tauri commands: `mls_init`, `mls_send_message`, `mls_process_message`, `mls_create_group`, `mls_add_members_bulk`, `mls_process_welcome`, `mls_generate_key_package`.

## Build-time environment variables

| Variable | Description |
|---|---|
| `VITE_GATEWAY_URL` | chat-gateway WebSocket URL |
| `VITE_DELIVERY_URL` | chat-delivery-service URL |
| `VITE_MEDIA_URL` | media-service URL |
| `VITE_CORE_URL` | core-service URL |
| `VITE_SOCIAL_URL` | social-service URL |
| `VITE_OIDC_AUTHORITY` | Authentik issuer URL |
| `VITE_OIDC_CLIENT_ID` | OIDC client ID |
| `VITE_OIDC_REDIRECT_URI` | OIDC callback URI |

## Linting and checks

```bash
cd frontend
bun run check       # paraglide:compile + svelte-kit sync + svelte-check (must be 0 errors/warnings)
npm run lint:fix    # ESLint auto-fix
npm run format      # Prettier
bun run test        # Vitest
```
