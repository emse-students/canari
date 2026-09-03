# Frontend architecture

**Stack**: SvelteKit 2.9 / Svelte 5 (runes) / TailwindCSS 4 / Tauri 2  
**Source**: `frontend/`

## Overview

The frontend is a SvelteKit application that never renders a component on the server (`export const ssr = false` in `src/routes/+layout.ts`): every page is built by the browser. The same bundle runs inside a **Tauri 2** webview as a native desktop/mobile app (`frontend/src-tauri/`). All MLS encryption/decryption happens in the frontend — either via a WASM module (browser) or via native Rust commands (Tauri).

### One SPA, two adapters

`svelte.config.js` picks its adapter from `process.env.BUILD_WEB`:

| Build | Adapter | Output | Who sets it |
|---|---|---|---|
| Tauri, local, mobile releases | `adapter-static` (`fallback: index.html`) | `build/` — a plain static bundle | nobody: this is the default |
| Web (production) | `adapter-node` | `build/client`, `build/prerendered`, `build/index.js` | `BUILD_WEB=1` on the `build-frontend` job in `.github/workflows/deploy.yml` |

The polarity is deliberate: a build that forgets the variable produces the static bundle Tauri
needs, never a Node server it cannot consume.

The web build gains a server for exactly one reason: the `<head>`. An unfurler (Discord, Slack) and
a search crawler both fetch the URL without ever getting content out of it — a crawler *does* run
the JavaScript, but as an anonymous visitor, so it renders the login screen. `ssr` stays false, and
`src/hooks.server.ts` rewrites two literal markers in the shell on its way out. That head is the
whole indexable surface of the site.

The design, the structured data, the per-request sitemap and the escaping rules are on their own
page: **[seo.md](seo.md)**.

Nginx serves the assets and proxies HTML navigations to the `frontend-ssr` container; when that
container is down it falls back to the prerendered `app-shell.html`, so the SPA still boots — see
[../infrastructure/nginx.md](../infrastructure/nginx.md).

## Source tree

```
frontend/
├── src/
│   ├── app.html                    # Root HTML template
│   ├── app.css                     # Global CSS (Tailwind + utilities)
│   ├── hooks.client.ts             # Client hooks (MLS init, session restore)
│   ├── hooks.server.ts             # Injects the per-page <head> into the shell (web build only)
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
│   │   ├── seo/
│   │   │   ├── resolve.ts          # Per-path title/description/noindex baseline
│   │   │   ├── serverSeo.ts        # Server-only enrichment (internal service calls, LRU)
│   │   │   ├── internalApi.ts      # Server-only client shared with the sitemap
│   │   │   ├── jsonLd.ts           # schema.org nodes + the JSON-LD script escaping
│   │   │   ├── injectedSeo.ts      # Client reads back what the server resolved
│   │   │   ├── sitemap.ts          # Static entries + the XML builder
│   │   │   └── renderHead.ts       # Escapes and renders the injected head tags
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

### A cleanup that releases something acquired asynchronously must wait for the acquisition

An effect that unmounts before its `await` returns runs its release against a reference count that
has not been incremented yet: the release decrements nothing, the retain lands a moment later, and
the resource is then held by NOBODY - never freed, and in the avatar case still served to every
later mount of the same face. The `cancelled` flag guards the STATE ASSIGNMENT, not the resource.
Release inside the pending promise's `finally`, never beside it.

### A synchronous "unknown" placeholder is indistinguishable from an answer

Once a placeholder label is stored, anything that later resolves the real value LOSES to it - and a
module-level cache re-renders nothing when it warms, so whether a user ever sees the truth depends
on cache timing. Return the ABSENCE, never the label: `peekUserDisplayName` answers `null`, and a
caller that needs to distinguish "not yet known" from "known to be empty" takes an explicit
`*Resolved` flag. Same shape as the `displayName.ts` failure counter - a value and the fact that it
was measured are two different pieces of information.

The asynchronous twin of the same rule: **a lookup that FAILED returns "I do not know", never the
text it would have displayed.** The moment a failure answers with a renderable value it is TRUTHY,
and every caller written as `if (resolved) use it` overwrites what it already had - a name, a
fallback, a cached row - with a placeholder. `resolveUserDisplayName` did exactly that to twenty-six
call sites, and only on the FIRST failure: the suppression window answered `null` afterwards, so one
event had two renderings chosen by how recently it had happened. **Rendering a placeholder is the
CALLER's decision**; the resolver's job ends at the fact.

### Svelte trims whitespace at a block boundary

`{label}{#if x}<span>...</span>{/if}` renders `labelSuffix` with no space: the compiler treats the
text run ending at `{#if` as trimmed. Putting `{label}` and `{#if x}` on separate source lines keeps
the space, because the newline itself is the text node. This is invisible in review and only shows
up as two words glued together in the rendered UI.

### A prop expression is re-evaluated during TEARDOWN, so an `{#if}` does not protect it

`{#if chatView}<Child prop={chatView.contactName} />{/if}` crashes on unmount. Svelte 5 re-reads a
child's prop getters while it cleans the reactive subscriptions up, and by then the `$derived` the
`{#if}` was guarding has already gone `null` - so the guard is proven true, the component is torn
down, and the getter runs against nothing. The result is an uncaught `TypeError` in the reactive
graph, which is the worst place for one (see the next section).

**Every nullable `$derived` passed as a prop takes `?.` and a default**, whatever encloses it:
`prop={chatView?.contactName ?? ''}`. The visual guard is not a temporal guard.

It is worth knowing WHY this was only ever seen on a phone: on desktop V8 the window between the
value changing and the getter running is imperceptible, while on Android WebView - slower, with a
more aggressive GC - it is wide enough to hit regularly. A race that "cannot happen" on the machine
it was written on is a race that happens to users.

### An uncaught error in the reactive graph is PERMANENT until a reload, so boundaries are placed by blast radius

An error thrown from a template, a `$derived` or an `$effect` cleanup corrupts that subtree's signal
graph for the life of the page - on Android WebView the app simply freezes. `svelte:boundary` is
therefore placed by what an error would take down with it, not by how important the component looks:

| Where | What it wraps | Shape |
| --- | --- | --- |
| `src/routes/+layout.svelte` | `<ChatBackgroundService />` | invisible service - `onerror` that LOGS, no fallback UI |
| `src/routes/+layout.svelte` | `{@render children?.()}` | every page - `{#snippet failed}` with a retry control |
| `src/lib/components/MainChatPage.svelte` | the `{#key}` around `ChatArea` | component - `onerror` that logs |

The rule for anything new: a global service or a layout takes a logging `onerror` with no fallback; a
whole page or a visible feature takes a `failed` snippet with a reset; a light component inside a page
takes NOTHING - the page's boundary already covers it, and a boundary per component only makes the
real one harder to find.

### An anchored dropdown must be portalled, never absolutely positioned

**Every modal body clips on both axes.** `overflow-y-auto` alone is enough: CSS forces the other
axis from `visible` to `auto` whenever one axis is not `visible`, so a modal that only meant to
scroll vertically also clips horizontally. A panel positioned `absolute` inside it is therefore cut
off, and **no z-index rescues it** - stacking order does not take an element out of an ancestor that
clips.

The fix is to take it out of the ancestor: render the panel at the document level and position it
`fixed` against its anchor's viewport rect, through `bindFixedPopover`
(`actions/fixedPopover.ts`), which also flips it above the anchor when there is no room below,
clamps it to the viewport, and re-runs on scroll and resize. `matchAnchorWidth` exists because
`w-full` no longer resolves once the panel is portalled out of its container.

**Portalling breaks the accessible relationship too, and nothing warns.** Once the panel is no longer
a descendant of its trigger, `aria-expanded` on that trigger announces "expanded" without naming what
expanded, and there is no DOM structure left for a screen reader to infer it from — so the panel
needs an `id` and the button an `aria-controls` pointing at it. Found on `AdminNavGroup` while a
harness check went looking for exactly that back-reference, failed to find it, and reported a working
dropdown as clipped: the selector was wrong *and* the thing it looked for should have existed.

**It is a DISCLOSURE, not `role="menu"`.** The distinction is a contract, not a label: the menu role
promises arrow-key roving focus, Home/End and typeahead, and claiming it while offering none of them
describes an interaction model the component does not honour — worse for a screen-reader user than
the plain, accurate one. These are navigation links; `aria-expanded` + `aria-controls` says exactly
what is true. What a disclosure *does* owe is **Escape**, closing and returning focus to the trigger:
the outside-click backdrop only serves a pointer, and a keyboard user who opened a portalled panel
has nothing near their focus to get back to.

### An API helper that ends in `res.json()` throws on a void response

A `DELETE` or a void `POST` answers `204`, or `200` with an empty body - and `res.json()` on an
empty body throws. The throw happens **after** the server has acted, so the call that succeeded is
the one the UI reports as failed, and the optimistic update is rolled back on a mutation that
actually went through. Any helper used for those verbs has to check for an empty body before
parsing.

## Theming (light / dark)

`themeStore.svelte.ts` writes `data-theme="light" | "dark"` on `<html>` from the persisted
`canari-theme` preference (`dark` | `light` | `system`, default `system`, tracking the OS media
query live). `app.html` replays the same decision in an inline script before first paint so the
splash does not flash the wrong colour.

`src/app.css` is the single source of truth. Every colour that must flip is a CSS variable
redefined under `:root[data-theme='dark']` and exposed to Tailwind through `@theme`:

| Utility                          | Variable            | Role                                  |
| -------------------------------- | ------------------- | ------------------------------------- |
| `bg-cn-bg`                       | `--cn-bg`           | App/page background                   |
| `bg-cn-surface`                  | `--cn-surface`      | Panels, cards, inputs, sheets         |
| `bg-surface-elevated` / `bg-cn-surface-alt` | `--surface-elevated` / `--cn-surface-alt` | One step toward / away from the reader (popovers, inactive chips) |
| `border-cn-border`               | `--cn-border`       | Borders and dividers                  |
| `text-text-main` / `text-text-muted` | `--text-main` / `--text-muted` | Body and secondary text   |
| `text-red-err` / `text-green-ok` / `text-amber-warn` | `--red-err` / `--green-ok` / `--amber-warn` | The status triad: error, success, warning |
| `bg-cn-yellow` / `hover:bg-cn-yellow-hover` | `--cn-yellow` | Brand fill                    |
| `text-cn-ink`                    | fixed `#151b2c`     | Ink **on** the brand yellow           |
| `bg-cn-scrim` / `bg-cn-tooltip`  | fixed `#0a0d14` / `#1a2236` | Surfaces that are dark in BOTH themes (call chrome, tooltips) |
| `bg-banner` / `bg-banner-warn`   | `--banner-bg` / `--banner-warn-bg` | Banner surfaces, OPAQUE by construction — see [Status banners](#status-banners) |
| `bg-banner-notice` / `-danger` / `-info` | fixed `#f59e0b` / `#dc2626` / `#2563eb` | The strong banner variants, identical in both themes |
| `text-cn-dark`                   | `--cn-dark`         | Emphasis text — **flips** with theme  |

Rules:

- **Never hardcode a one-way colour** (`bg-white`, `bg-red-50`, `text-amber-900`, a raw hex). It
  does not flip, so a card keeps its light background while `text-text-main` turns near-white in
  dark mode — white on white. Reach for a token instead.
- `text-cn-dark` and `text-cn-ink` are **not** interchangeable: `cn-dark` flips (dark navy → near
  white), `cn-ink` is fixed. Text sitting on the always-light yellow brand surface needs `cn-ink`.
- The `dark:` variant is a `@custom-variant` bound to `[data-theme='dark']`, **not** the OS media
  query — `dark:` pairs work, but a single flipping token is preferred over a two-class pair.
- Tint with an opacity modifier on a token (`bg-red-err/10`, `bg-cn-yellow/15`) rather than a
  fixed-palette tint: the tint then tracks the theme too.
- A `-600` shade is not a safe middle ground. `text-red-600` reads fine on a light card and drops
  to roughly 3.9:1 once that card flips; `text-red-err` stays above 7:1 in both.
- **A `@theme` entry is what makes a token exist.** `bg-cn-surface-alt` was used by six components
  with no `--color-cn-surface-alt` behind it, so Tailwind generated no rule and the class was
  silently inert — those badges rendered with no background at all. Check `app.css` before
  inventing a token name.

### Finding one-way colours

`node scripts/find-oneway-colors.mjs [pathFilter]` (from `frontend/`) reports them. Two things it
gets right that a grep does not:

- Detection is **per class list**, not per file: `bg-white dark:bg-slate-900` flips and is fine, so
  a plain grep over-reports by roughly 4x.
- It does **not** tokenize on `:`, which would strip the `dark:` prefix off every counterpart and
  make correctly-paired utilities look one-way.

It deliberately stays quiet about black (a `bg-black/40` scrim is meant to darken what is behind it)
and about `bg-white/N` at 20% or less (the glassmorphism highlight idiom). What it still reports is
intentional and should stay: switch thumbs (`bg-white` on a coloured track), colour-picker handles,
the always-dark call and lightbox chrome, and the white plate behind a QR code, which has to be
white to scan.

## Status banners

Every strip that announces a transient app-wide fact goes through
`lib/components/shared/Banner.svelte`. It owns three things and deliberately not a fourth.

| It owns | Because |
| --- | --- |
| The surface (`bg-banner`, `bg-banner-warn`, `bg-banner-notice`, `bg-banner-danger`, `bg-banner-info`) | All five are opaque. A translucent banner puts the text underneath behind the words meant to be read - four of the six banners were tinted (`/10`, `/40`, `/60`) before this existed |
| The live region (`role`, `aria-live`, `aria-busy`) | A strip that exists only visually announces nothing. Use `tone="alert"` only where the message genuinely cannot wait - a fatal MLS error, never a synchronisation |
| The row layout, with an optional `action` snippet | So a dismiss or take-over control sits outside the label's flow |
| **NOT placement** | It legitimately differs - `fixed` at the window, `absolute` over a conversation, in the flow above content - and only the caller knows which. Position comes in through `class` |

**Three scales, and a banner belongs to exactly one.**

| Scale | Where | Who |
| --- | --- | --- |
| Window | `+layout.svelte`, one fixed flex column | maintenance, fatal MLS error, tab follower, offline |
| Conversation | `ChatArea.svelte`, `absolute` over the message list | synchronisation |
| Application | `MainChatPage.svelte` | **nothing, on purpose** |

Rules, each written after the thing it prevents:

- **One fact, one banner, at one scale.** `MainChatPage` carried two that duplicated others:
  "En attente de connexion" repeated `OfflineBanner` (going offline raised both, three seconds
  apart), and its synchronisation strip repeated `ChatArea`'s from the very same
  `isCatchupOverlayVisible`, so the two never appeared apart. Both are deleted.
- **A banner above the content must not sit in the layout flow.** Those two did: raising one shoved
  the application down 29 px and dropping it snapped everything back, up at ~480 ms into a load and
  gone at ~2 286 ms. On 2026-08-14 a click aimed at a channel row was recorded landing on the
  "Ajouter un canal" button below it, and the harness spent a run accusing a working application.
  Window-scale banners are `fixed`, the conversation one is `absolute`.
- **Same scale means one column, never two `fixed` layers.** The maintenance notice
  (`z-[120]`) painted over the fatal MLS error (`z-50`), hiding the only message that says the
  messaging stack is dead. Both now stack in one flex column, which is the lesson `ChatArea` had
  already learnt for its own pair.
- **A status must be true when it is shown.** The synchronisation banner fired on
  `isMessagingInitializing`, true on every start with or without a message, so it announced
  synchronising messages while nothing was. It is bound to `isCatchupOverlayVisible` alone: a real
  MLS mailbox drain, past `OVERLAY_MIN_MESSAGES`. History recovery runs in `PERSIST_ONLY_PHASE` and
  stays silent by design.

## When the local store fails

**Source**: `src/lib/db.ts`, `src/lib/db/indexeddb.ts`, `src/lib/db/storageFaults.test.ts`

Both retention windows are TIME bounds - five years on a device, ninety days on the web - so nothing
caps the store by SIZE, and what a full disk or an evicted store actually DOES was unknown rather
than designed. It was settled on 2026-08-19 by INJECTION, never on a real device: the campaign phone
is an appliance the campaign depends on, not a place to find out. `storageFaults.test.ts` is the
answer and pins every line of it.

| Fault | What happens | Is that right? |
|---|---|---|
| Tauri, SQLite open fails (no space left) | `getStorage` throws | **Now.** It used to catch and answer with IndexedDB in the same webview |
| Web, IndexedDB open fails | rejects with `StorageOpenError`, `cause` = the DOMException | **Now.** It used to reject with the string `'IndexedDB open error'` |
| Web, upgrade blocked by another tab | rejects, and says which tabs to close | **Now.** `onblocked` had no handler, so `init()` never settled at all |
| Web, a write hits the quota | the rejection reaches the caller | Yes - a message that was never persisted must not be reported as sent |
| Web, the browser evicted the store | opens clean, reads empty | Yes, and it cannot be otherwise - see below |

### The fallback that was worse than no storage

A failed SQLite open on Tauri was caught and answered with IndexedDB. That is not a degraded version
of the same device, it is a different one: the MLS state persister writes `mls.bin` to the
FILESYSTEM on Tauri and does not follow that choice, so the group state would have stayed on disk
while conversations and messages moved into the webview's store - a client that opens, looks
healthy, and carries a history that does not match its own ratchet.

And the cause the fallback existed for is the one it cannot survive: the second store is on the same
full disk.

### Eviction is indistinguishable from a first run, by construction

Quota eviction drops the whole origin bucket. The next open finds no database, runs the upgrade path
from version 0, and hands back an empty store - byte for byte what a browser that has never seen
Canari does. **Nothing local survives to tell the two apart**, because everything that could have
(localStorage, the caches) is inside the bucket the browser just emptied.

No machinery is proposed for it, and that is a decision rather than an omission: an empty store IS a
new device, the new-device path already exists and already re-joins, local history is replayable
from the server, and the MLS state is re-established by enrolling again. A client that claimed to
know it had been evicted would be claiming knowledge it does not have.

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
- User-visible strings must always go through Paraglide — never inline string literals, in either
  language. English ones are the easier mistake to miss: they look like the rest of the codebase.
- **Nothing types a string as user-visible**, so the compiler cannot enforce the rule above.
  `showToast` takes a `string` and a literal passes lint, `check` and CI. `showToast` is guarded by
  `stores/toastLocalization.test.ts`, which reads the sources and accepts a template only when it
  interpolates an `m.*()` call; other entry points are on trust.
- **A native prompt is user-visible UI whose text you do not fully own.** A plugin fills the fields
  you leave empty from its own hardcoded defaults, which are English: `tauri-plugin-biometric`
  titles the Android prompt "Fingerprint Authentication" and labels its button "Cancel" unless
  `title` and `cancelTitle` are passed. Localizing the one string the API makes obvious (`reason`)
  leaves the two most prominent lines untranslated. See
  [auth - the system biometric prompt](modules/auth.md).
- **Filling every field a native prompt accepts is not the same as filling it well.** Android stacks
  `title`, `subtitle` and description and then adds its own gesture hint, so a prompt that supplies
  all three shows four lines. Decide what each line adds before passing it, and remember the OS gets
  the last one for free.
- **`bun run build` leaves Paraglide output that resolves to English**, which makes the
  locale-asserting tests fail (4 files: `callSystemMessages`, `pinChange`, `publicAppUrl`,
  `canariLinkPreview`). `bun run test` therefore compiles Paraglide itself, exactly as `bun run
  check` always has - it is not a step to remember. An Android or iOS build triggers this, because
  `beforeBuildCommand` is `bun run build`.

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
bun run lint        # oxlint + oxvelte
bun run lint:fix    # the same, auto-fixing what can be
bun run format      # oxfmt (NOT prettier - this repo has no prettier config)
bun run test        # Vitest
```
