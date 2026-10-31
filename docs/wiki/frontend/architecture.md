# Frontend architecture

**Stack**: SvelteKit 3 / Svelte 5 (runes) / TailwindCSS 4 / Tauri 2  
**Source**: `frontend/`

## Overview

The frontend is a SvelteKit application that never renders a component on the server (`export const ssr = false` in `src/routes/+layout.ts`): every page is built by the browser. The same bundle runs inside a **Tauri 2** webview as a native desktop/mobile app (`frontend/src-tauri/`). All MLS encryption/decryption happens in the frontend — either via a WASM module (browser) or via native Rust commands (Tauri).

### One SPA, two adapters

`kit.config.js` picks its adapter from `process.env.BUILD_WEB`:

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

### A tab open across a deploy: its lazy modules are gone, and a reload is OFFERED

Every `import()` asks for a hashed chunk of the build the tab booted on, and a deploy deletes them.
Measured on production 2026-09-27: a tab loaded on `0.18.26` three minutes before `v0.18.27` landed,
then the carte's PDF export failed with a bare "Erreur" - `Failed to fetch dynamically imported
module`, the chunk a 404 on the new build. SvelteKit covers its OWN route chunks (a failed navigation
checks `version.json` and falls back to a full page load); the app's own `import()`s had nothing.

`src/lib/utils/staleBuild.ts`, wired in `hooks.client.ts` (web only - Tauri embeds its frontend):

| Rule | Why |
|---|---|
| Triggered by Vite's `vite:preloadError` event, never by an error's text | the distinction is typed at the throw; the build's preload helper wraps every dynamic import |
| Reads `/_app/version.json` (`no-store`) against `$app/environment`'s `version` | a missing chunk is a symptom shared by a deploy and a dead network; only a DIFFERENT served build is a reason to reload. Same build or unreadable: logged, nothing offered |
| OFFERS the reload (`showConfirm`), never forces it, never retries the chunk | the chunk is gone, not slow; a forced reload would discard what the reader was doing |
| Records the build a reload was accepted FOR in `sessionStorage` before reloading | if the reloaded page still runs the old build (a cached shell), the next failure finds it recorded and says so at ERROR instead of offering the same reload for ever. Durable state, no clock; a newer deploy is a new build and is offered again |
| One decision in flight | a chunk and its dependencies fail together; the reader is asked once |

The listener does not `preventDefault`, so the failing import still rejects and its caller still
reports it. Pinned by `staleBuild.test.ts`.

### The same response declares its stylesheets twice, and only one of the two is useful

`resolve(event, { ... })` in `src/hooks.server.ts` takes a `preload` predicate alongside
`transformPageChunk`. SvelteKit calls it once per asset it is about to name in the document, and the
ones it accepts get an early-hint `Link:` header on the SAME response that carries the markup
(`@sveltejs/kit`'s `render.js`). So for a stylesheet the browser receives both halves at once: the
header telling it to preload the file, and, a few kilobytes later in the body, the
`<link rel="stylesheet">` that actually requests it.

The header wins nothing there. The document is already in flight, the `<link>` is parsed in the same
network round trip, and the browser ends up with one resource-timing entry per sheet whose
`initiatorType` is `link` - the preload's own entry is never the one that fetched it. Measured on
production, `/login`, Chrome, 2026-09-16: the page's single stylesheet has exactly one entry, and it
is the tag's.

**This paragraph also used to cite six Firefox `preloaded ... not used` warnings, and that citation
had no source** - no console export of that day contains the string, and it traced back to the
documentation rather than to a reading. It was removed rather than softened. The change stands on the
served document below, which anyone can re-read in one request.

JavaScript is the opposite case and keeps its header, and **the served document is what settles it
rather than any argument about it.** `GET /login` on production, read 2026-09-16, returns 13 318
bytes of HTML:

| declared in the BODY | declared in the `Link:` HEADER |
| --- | --- |
| 1 x `<link rel="stylesheet">` | 1 x `rel="preload"; as="style"` |
| **0** x `<link rel="modulepreload">` | **~100** x `rel="modulepreload"` |

The two halves are not symmetric. For the stylesheet the header repeats a tag the body already
carries. For the modules there is no tag at all - the graph is discovered by *executing* the inline
bootstrap, one dependency level at a time - so the header is the only thing that makes the first
wave arrive multiplexed. The ~130 chunks it names come back at a 21 ms mean TTFB, every one a
Cloudflare HIT.

The predicate is therefore `type === 'js'`, and it lives in
[`$lib/server/preload`](../../../frontend/src/lib/server/preload.ts) rather than in
`hooks.server.ts`, so a test can import it without dragging `$app/env/private` in through the SEO
chain - the same split as `$lib/server/handleError`.

**It is written as `=== 'js'`, never as `!== 'css'`.** SvelteKit's default is
`({ type }) => type === 'js' || type === 'css'`: fonts and other assets were never preloaded, so the
negation would have silently STARTED preloading them while claiming to remove one. `hooks.server.test.ts`
pins that: a font and an asset both answer `false`.

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

### A timer a component starts dies with the component, not only with its "closed" state

`MediaLightbox` cleared its tap and zoom timers when `open` went false, and nowhere else. Unmounted
while open - a parent removing it, or a test's `unmount` - inside the 250 ms double-tap window, the
tap timer fired on a component that no longer existed and logged `mediaLightbox.chrome`. In CI that
line landed after `MediaLightbox.videoTap.svelte.test.ts` had ended and its worker was closing,
which vitest reports as `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`
and counts as a run failure with every test green (2026-10-05, `main` and PR #1392). Whether it shows
depends on how soon that worker closes, so it appeared only once new test files moved the schedule.
The run's only console line attributed to no test (`stdout | Object.d (...Log.ts)`) named the
culprit; grep a failing log for one before suspecting anything else. **Every `setTimeout` a component
holds is cleared in an `$effect` teardown**, and `vi.getTimerCount()` after `unmount` is the test.

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

### The first name has its own cache, and every door that knows it must fill it (2026-10-09)

`getUserFirstNameSync` (read-receipt popover, chat labels) reads `firstNameCache` ONLY, never a cut of
the full name (compound given names). A name enters the display-name cache by several doors and only
the profile fetch used to fill the first name too - and `resolveUserDisplayName` answers from the name
cache, so a person seeded by name was NEVER given one ("Lu par Prenom NOM"). Now: `seedUserDisplayName`
takes an optional `firstName`; a name seeded bare costs exactly ONE profile fetch (`profileAsked`,
single in-flight, the usual backoff), which never overrides the seeded name on failure or 404; a person
with no `firstName` keeps the full name. `firstNameCache` is a `SvelteMap`, so a `$derived` redraws when
the profile lands. The current user's first name comes from that same one fetch (the saved login
carries only `displayName`).

**A notification's sender line is ASKED for (2026-10-14).** `notifyInbound` used the sync cache read
with the conversation's title as fallback; on a conversation never opened since launch the cache holds
nobody, so a group banner read the GROUP name where the person belongs (Pixel 6a, prod 1.2.7) and the
native builder, which treats "group name == sender name" as a DM, drew no group shape.
`resolveNotificationSenderName` fetches the profile first and logs a warn when only the title is left.

### A derived that needs ONE key reads the SvelteMap by key, never by iterating it (2026-10-12)

Iterating a `SvelteMap` (`for ... of`, `entries()`, `values()`, `forEach`) subscribes to the map's
version AND to every key's own source; `get(key)` subscribes to that key's source only (and to the
version while the key is absent, so an arrival is still seen). `useConversations.currentConvo`
looped over the whole conversation map to find the open one, so a message landing in ANY of a heavy
account's ~220 conversations and salons re-ran it, handed ChatArea a new object, and redid every
full pass over the open thread (`groupMessages`, seen-by, the poll parse, the unread count) plus a
props refresh of every mounted row. Counted in the test: 52 writes to OTHER conversations, 52
recomputations before, 0 after ([test](../../../frontend/src/lib/composables/useConversations.currentConvoScope.svelte.test.ts)).
A `set` of the SAME object notifies nobody either way (`prev_res !== value`), so this never relied
on iteration to see an in-place mutation - every write path stores a new object.

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

### A teardown sees the values its effect saw, and a derived read there keeps them (2026-10-27)

Svelte runs every teardown - an `$effect`'s return, an `onMount` return, an `onDestroy` - with the
values the effect last saw, and that is deliberate (a teardown releases what its run acquired). Two
different failures follow from it, and only the second is silent.

**1. A `$state` read in a teardown is STALE.** It returns the value from before the current flush.
Code that ASKS "has the selection moved?" from a teardown is always told "no". `MainChatPage`'s
receipt effect detected leaving a conversation with `if (convs.selectedContact !== currentContact)`
in its teardown, so the leave branch never ran. Nothing was flushed or cancelled when the reader
left inside the 2 s window, and the next conversation's note joined the OLD window: `max(A, B)`,
delivered by A's callback (for a salon, `claimChannelReadSignal` for A). The leave is now detected
by the effect's FIRST statement, `readMarks.follow(selected)` (`readMarkDebounce.ts`). The window
now knows the conversation that opened it, and on a leave it is DELIVERED through that
conversation's own callback, for a salon as for a DM. A first draft dropped a salon's window on
leave, on the grounds that its mark is owed durably anyway. But the callback is also what sends
`markChannelRead`, the silent signal that clears the salon's banner on the account's other devices,
so dropping it lost that signal. `readMarkDebounce.test.ts` covers the delivery, and
`readMarkDebounce.leave.svelte.test.ts` pins both the stale read and the call's place in the effect.

**2. A `$derived` read in a teardown is RE-EVALUATED WITH THE STALE VALUES AND KEEPS THAT RUN'S
DEPENDENCIES** when it depends on something that changed in the flush. Any derived counts, read
directly or through a prop getter. `untrack` does not help, because it only stops the CALLER from
subscribing; the derived still rewires itself. It throws nothing. `ChatHeader`'s DM presence effect
did `return () => unwatchUsers([contactName])`. On leaving a DM, that prop read walked `ChatArea`'s
`conversation` prop back to `currentConvo` (`useConversations.svelte.ts`), which re-ran with the DM's
key and kept `conversations.get(dmKey)` as its only map dependency. It ran AFTER the pane had read
`currentConvo` for the new selection, so nothing read it again. The conversation now open could then
receive any number of messages: the map, the sidebar and the read marks had them, and the pane stayed
frozen until the selection changed again. Opening a group as its Welcome landed showed an empty
transcript; a reload drew it. Parking on a group never reproduced it, because that effect only runs
for a DM. The proof was a CDP logpoint on `currentConvo` in the dev bundle: it evaluated with the
DM's key while the selection source held the group's, called from the header's teardown.

The minimal reproduction, on Svelte 5.57.2 (red with or without the `untrack`; green when the
teardown reads nothing):

```ts
const map = new SvelteMap([['a', 1], ['b', 1]]);
let key = $state('a');
const current = $derived(map.get(key));
const seen: unknown[] = [];
$effect.root(() => {
  $effect(() => { seen.push(current); });          // the reader, declared first
  $effect(() => {
    void key;
    return () => untrack(() => current);           // a teardown that reads the derived
  });
});
flushSync();
key = 'b'; flushSync();     // the teardown re-runs `current` with key 'a': deps -> map 'a'
map.set('b', 2); flushSync();
expect(seen.at(-1)).toBe(2); // fails: 1 - `current` no longer listens to 'b'
```

**A teardown reads only locals captured in the effect body - never a prop, a `$state` or a
`$derived`** (`const watched = contactName; watchUsers([watched]); return () =>
unwatchUsers([watched]);`). A question about the CURRENT state is asked at the start of the next run,
not in the teardown. `ChatArea.leaveDirect.svelte.test.ts` mounts the real `ChatArea` on the real
`currentConvo`, leaves a DM, adds a message to the group and asserts it is drawn; it is red with the
prop read.

### An uncaught error in the reactive graph is PERMANENT until a reload, so boundaries are placed by blast radius

An error thrown from a template, a `$derived` or an `$effect` cleanup corrupts that subtree's signal
graph for the life of the page - on Android WebView the app simply freezes. `svelte:boundary` is
therefore placed by what an error would take down with it, not by how important the component looks:

| Where | What it wraps | Shape |
| --- | --- | --- |
| `src/routes/+layout.svelte` | `<ChatBackgroundService />` | invisible service - `onerror` that LOGS, no fallback UI |
| SvelteKit's root (`kit/src/runtime/components/root.svelte`) | every route node | every page - `routes/+error.svelte`, reported by `handleClientError` ([below](#a-page-that-crashes)) |
| `src/lib/components/MainChatPage.svelte` | the `{#key}` around `ChatArea` | component - `onerror` that logs |

The rule for anything new: a global service or a layout takes a logging `onerror` with no fallback; a
visible feature inside a page takes a `failed` snippet with a reset; a whole page takes NOTHING (Kit
already wraps it); a light component inside a page takes NOTHING - the page's boundary already covers
it, and a boundary per component only makes the real one harder to find.

### A page that crashes

**SvelteKit 3 owns the page boundary, so the app owns only the report and the screen.** Kit wraps
every route node in its own `<svelte:boundary>`, armed with the root `+error.svelte` and placed
INSIDE the layout's `children` - closer to the page than anything `+layout.svelte` can draw. Until
#2613 the root layout held a boundary around `{@render children?.()}` that logged `[Layout] page
crash on <route>` and drew a Retry; under Kit 3 it could never fire, and a crashed page showed Kit's
error page with a button to `/login`. Observed on the static build (a page throwing from `$effect`,
both on first load and on a client navigation): `page.status` 500, `page.error` `{ status: 500,
message: 'Internal Error' }`, and the client `handleError` hook CALLED (Kit runs every boundary error
through it as `transformError`) - so the report was not lost, only stripped of its route.

So the layout boundary is gone and the two halves sit where Kit calls them:

- **The report** is `handleClientError` (`$lib/navigation/handleClientError.ts`, the client hook):
  `[App] page crash on <route id>:` at error for an `unknown` throw or a 5xx, `[App] navigation
  error <status> on <route id>:` at warn for a 4xx. The route id, never the URL: it names the page
  in the in-app log without carrying a member's or a post's id. **The route is `match(event.url)`,
  never `event.route.id`**: Kit 3.1.0's `initialize` builds the event from the state BEFORE it
  assigns the first navigation's, so every crash before the reader's first client navigation arrives
  with `route.id === null` (read on the static build as `page crash on ?`); the `url` is right in
  every case.
- **The screen** is `routes/+error.svelte`: a 5xx offers Retry - `goto` to the same address with
  `refreshAll`, because a navigation is what makes Kit reset a failed boundary (its `resetters`
  drain after the next navigation settles) - and every status offers the home page, never `/login`.

Kit's boundary is at depth 1 only when no nearer `+error.svelte` exists; a route that adds one gets
its own, and the report still goes through the same hook. `routes/pageCrash.svelte.test.ts` mounts
Kit's real `root.svelte` with a throwing page and the real `+error.svelte`; it cannot see Kit's
navigation resetting the boundary on Retry, which was read on the static build: a page that threw
once drew again. Kit leaves `page.status` at 500 and `page.error` set after that recovery (the
same-address navigation does not count as a page change), and only `+error.svelte` reads either.

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
needs an `id` and the button an `aria-controls` pointing at it. Found on the admin dropdown (deleted 2026-10-08, the console is a hub now) while a
harness check went looking for exactly that back-reference, failed to find it, and reported a working
dropdown as clipped: the selector was wrong *and* the thing it looked for should have existed.

**It is a DISCLOSURE, not `role="menu"`.** The distinction is a contract, not a label: the menu role
promises arrow-key roving focus, Home/End and typeahead, and claiming it while offering none of them
describes an interaction model the component does not honour — worse for a screen-reader user than
the plain, accurate one. These are navigation links; `aria-expanded` + `aria-controls` says exactly
what is true. What a disclosure *does* owe is **Escape**, closing and returning focus to the trigger:
the outside-click backdrop only serves a pointer, and a keyboard user who opened a portalled panel
has nothing near their focus to get back to.

### A portalled overlay is inside the page for one effect, and focusing it there scrolls the page away

**A modal opened from a scrolled page threw that page back to the top** - every modal in the app, on
every platform, until 2026-09-17. The report was about one screen (*"Cliquer sur evenement sur mobile
(type liste) renvoie vers le haut de la page"*), and nothing in that screen was involved. Three
independent facts compose into it, and none of them is wrong on its own:

1. **`.page-scroll-wrap` carries `will-change: transform`** for the swipe-between-tabs gesture, which
   makes it the containing block for every `position: fixed` descendant - the fact the layer ladder
   in `app.css` already documents, for a different consequence. A backdrop written `fixed inset-0`
   inside a page is therefore laid out at that SCROLLER's origin, near the top of its content, and
   not against the viewport.
2. **A portal moves the node one effect AFTER it is created, and the child's action runs first.**
   Svelte 5 emits `$.action(<panel>, focusTrap)` before `$.action(<backdrop>, portal)` for
   `<div use:portal><div use:focusTrap>` - measured by compiling that exact shape, not assumed. So
   there is one effect in which the overlay genuinely is a descendant of the page scroller.
3. **`HTMLElement.focus()` scrolls its ancestors to reveal the element**, which is its whole point
   everywhere else.

Together, `focusTrap` asks the browser to reveal a control sitting at scroll offset zero of a page
scrolled anywhere else. The browser obliges, the portal then moves the overlay to the body, and the
page stays where it was left: at the top. Measured in Chrome on that geometry - scroller at 1500px,
**0px** after `focus()`, **1500px** after `focus({ preventScroll: true })`.

**The fix is `preventScroll`, and deliberately not a reordering of the two actions.** A focus trap has
no reason to scroll anything at the moment it opens: the container it focuses into is an overlay that
already covers the viewport, and its first control is at the top of a panel nobody has scrolled yet.
Stated that way it holds whatever order the two effects run in, where swapping the actions would be
an implicit dependency on how one version of Svelte emits them. The two Tab wrap-arounds in the same
file keep the browser's scrolling, for the opposite reason: they reveal a control inside a panel the
person may well have scrolled, and `preventDefault` has just cancelled the scroll sequential
navigation would have done. `focusTrap.test.ts` pins both halves.

**The general shape, worth carrying past this file:** an action attached to a node that another
action is about to MOVE runs against a position that is about to stop being true. Anything it does
that depends on where the node is - measuring it, scrolling to it, reading its containing block -
reads the wrong answer, and reads it silently.

### A request fired from an effect on render is a request for every card the page mounts

`loading="lazy"` defers the IMAGE in a card and does nothing at all for the request that decides
what the card SAYS. `LinkPreviewCard` asked `/api/mls/link-preview` from an `$effect` that ran on
mount, so a feed of link posts opened one request per card during the cold start - all of them for
cards below the fold, competing with the boot for the same connection.

`actions/nearViewport.ts` is the primitive: one `IntersectionObserver`, `rootMargin: 400px` by
default, calling back ONCE and disconnecting itself. The component holds an `isNear` flag, the effect
reads it and returns early while it is false, and the pending UI is `!isNear || isLoading` - a card
that has not asked yet and a card waiting for an answer are the same state, so nothing flashes
"nothing here" about a card that is about to be filled.

**Two things about it are deliberate and read wrong at a glance.** It fires immediately where
`IntersectionObserver` is undefined, which is a CAPABILITY CHECK and not a fallback path: no primary
path failed, the environment simply cannot answer, and the answer that preserves the old behaviour
is "yes". And `rootMargin` is a DISTANCE, not a delay - it decides how far ahead the work happens,
never whether it happens, so a wrong number costs a little early traffic or a little late paint and
never a wrong answer.

**An action cannot be applied to a component**, which is what decides where the call site sits when
a component renders one of two shapes. `LinkPreviewCard` renders either its own `<a>` or
`EcosystemCoverPreview`; a layout-neutral wrapper was the obvious alternative and is impossible,
because `display: contents` generates no box and an element with no box is never observed. Both
branches carry the action on their own root `<a>` instead, the second through an `onnear` prop.

*This is not the deferral that was rejected on [backlog](../backlog.md).* That one gated the whole
feed's ~45 requests at the SvelteKit route `load`, which changes the web client for every reader;
this gates one card's own request from inside that card, and a card nobody scrolls to never asks.

### A post's own image, in its own link preview, without dragging in a decrypt stack for every card

`LinkPreviewCard`'s in-app branch showed only the association's logo for a post link (`fetchPostPreview`
in `canariLinkPreview.ts`), never the post's own attached photo - identical to the external Open
Graph card's gap, but for a different reason. The OG card is unauthenticated and post images are
still client-side CEK-encrypted (`key`/`iv` on `PostMediaRef`, same shape as `PostMedia.svelte`
already decrypts for a post's own feed rendering), so an external crawler genuinely cannot show it -
that one keeps the association-logo fallback, on purpose. But `LinkPreviewCard` runs client-side, to
an ALREADY-AUTHENTICATED viewer whose access `getPost(postId)` already checks (the per-post visibility of WP6b),
so nothing stops it from decrypting the photo exactly as the post itself does.

The small logo slot (`CanariLinkPreviewMedia`) is left alone; the post's own photo, when it has one,
is a SEPARATE full-width banner below the logo/text row (`postImage` on `CanariLinkPreview`, resolved
from `post.media.find(m => m.type === 'image')`) - the user's own call: it augments the card rather
than replacing what the small slot already showed.

**`PostMedia.svelte` is loaded with a dynamic `import()`, never a static one, and that is not an
optimization - it is what keeps every OTHER card cheap.** A static import pulled in the whole
decrypt/lightbox/PDF-viewer stack transitively (`MediaService` → `useMessaging.svelte.ts` →
`globalChatSingleton.svelte.ts`), which broke `LinkPreviewCard.deferred.svelte.test.ts` outright
(`MediaService is not a constructor` - a happy-dom import-order issue that static analysis alone did
not catch) and would have cost every external link, form, association, profile, and imageless post
preview that same weight for a component only a post WITH a photo ever renders. Loaded alongside the
decrypt token (`getToken()`, itself cheap and in-memory-cached) in one `Promise.all`, exactly when
`fetchCanariLinkPreview` answers with a `postImage`.

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

The choice is three-way and labelled Automatic / Light / Dark in settings (the `system` value keeps its stored name; the label was "System" and icon-only below 640 px until 2026-10-01, which read as "light and dark only"). The dashboard's one-tap cycle button is gone since 2026-10-16 (the dashboard became the app's hub, [section-navigation](section-navigation.md)); the settings control is the one place the theme is chosen. `app.html` once treated a saved `system` as light (flash on a dark phone); `themeStore.test.ts` now executes that inline script against the store for every preference x OS state. Automatic was already the default; nothing changed for users who picked explicitly.

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

`bun scripts/find-oneway-colors.mjs [pathFilter]` (from `frontend/`) reports them. Two things it
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

Both retention windows are TIME bounds - five years on a device INTENDED, ninety days on the web (the garbage collector in `ChatBackgroundService.svelte:1790` applies 90 days on every platform, see [history-reconciliation](../protocols/history-reconciliation.md#two-boundaries-not-one)) - so nothing
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
- A 401 renews the token and resends the same request once, for `apiFetch`, the media upload and the
  MLS delivery API alike - one implementation, `utils/renewOn401.ts` ([sessions](../sessions.md#a-401-renews-the-token-and-sends-the-same-request-once---one-rule-every-caller)).

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
  id: string;             // MLS groupId, or `channel_<id>` for a channel
  name: string;
  contactName: string;    // normalized contact identifier
  messages: ChatMessage[];
  lifecycle: 'active' | 'pending' | 'removed';  // NOT `isReady`, gone since the lifecycle collapse
  mlsStateHex: string | null;
  unreadCount?: number;
  conversationType?: 'direct' | 'group' | 'channel';
  directPeerId?: string;
  imageMediaId?: string | null;
  lastMessageAt?: number;
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

### A conversation row has ONE builder, and the site decides only the lifecycle and the identity

`buildConversationRow` ([`utils/chat/conversations.ts`](../../../frontend/src/lib/utils/chat/conversations.ts))
is the only place a `Conversation` is constructed. Thirteen places built it by hand - boot restore,
server discovery, the Welcome handler's early placeholder and its finished row, the
`onWelcomeProcessed` fallback, group creation, DM creation, the existing-server-DM path, the FCM
in-memory merge, three channel builders in `useChannelWorkspaces` and one in `ChatBackgroundService`.
The type has twelve fields; what all thirteen agreed on was `messages: []` and `mlsStateHex: null`.

**`conversationType: 'channel'` was declared, read, and never written.** All four channel builders
left it undefined, so every reader's `conversationType ?? 'group'` classified a channel as a group.
That is not cosmetic: the sidebar tile's `#` branch could not render, and "add members", "rename" and
"set an avatar" are each gated on `!== 'group'` - the comment on the first of them says *"DMs and
channels cannot be invaded"*, and channels could. The id settles it in the builder, for every site at
once.

The two things a site genuinely decides travel as data:

| What the site decides | Why it differs |
| --- | --- |
| `lifecycle` | a discovery placeholder is `pending` because no Welcome has landed; a group this device just created is `active` because it holds the state |
| `identity` | the server's `isGroup`, a peer parsed out of the group name, the contact the user typed, or a channel's name - four sources for one answer |

Everything else - the defaults, the channel verdict, and what an existing row already carries - is
the same everywhere, so it is written once. **Passing `existing` is not a convenience**: six sites
read the row they were replacing for ONE field and rebuilt around it, and one of them reset
`messages` to `[]` on every community hydration, which is a channel going blank in front of someone
reading it.

An optional is either carried or ABSENT, never written as `undefined`, so a reader checking
`'imageMediaId' in convo` and one reading `convo.imageMediaId ?? null` see the same row. `null` is a
site SAYING there is no avatar, and it is carried rather than coalesced away.

`buildConversationRow.onePolicy.test.ts` drives nine real entry points over one table and asserts
what landed in the map, because a site that keeps its own object literal is exactly what a test of
the shared function walks past. The two sites no unit test can reach - the `onWelcomeProcessed`
callback wired inside `sessionAuth`, and a Svelte component's event handler - are covered by a source
check in the same file, which is also what catches a fourteenth builder.

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
- **AN EXCEPTION'S MESSAGE IS NOT A SENTENCE FOR A READER, EXCEPT WHEN THE THROW SAYS IT IS.**
  `e instanceof Error ? e.message : <fallback>` renders the server's or the browser's English
  almost every time, and `associations/serverProse.test.ts` fails any hand-written file under `src`
  that still carries the shape - **the whole tree since 2026-09-16, 1 004 files, with generated
  output skipped and one allowlisted site**. A log is not an exception to it: `String(e)` renders
  `Error: <message>`, which keeps the type the ternary threw away, so the convention has none. The exceptions are real, though - `sessionAuth.ts` throws a dozen
  refusals whose message IS the French sentence the user must read - so they are typed:
  `LocalizedError` (`utils/localizedError.ts`) marks a message as the reader's, and
  `localizedMessage(e, m.some_declared_line())` is how a screen asks. `ServerUnreachableError` is a
  subclass of it. Where the failure carries an HTTP STATUS instead, `utils/apiRefusal.ts` turns the
  status plus an action label into the sentence, and answers `null` rather than inventing one.
  **A STATUS AT THE THROW IS ONE TYPE, NOT ONE PER SERVICE**: `ApiRefusalError(status, code,
  message)` is the base, each service's class adds only its NAME, and a screen reads
  `refusalStatus(e)` / `refusalCode(e)` instead of naming a service it otherwise has no reason to
  import - which is how `chat/messaging.ts` stopped pulling `ChannelService` into the send path.
  A bare refused `Response` is typed by `refusalFromResponse(res, what)` (`utils/apiRefusalError.ts`,
  status + the body's `code`): minesweeper, group invites, Adminer, the vault download and the
  delivery service's key package publish, device update and commit submit/replay use it (2026-10-18).
  The stable `code` a refusal carries is worded by `describeRefusalCode` (`utils/refusalCodes.ts`),
  the mirror of both services' registries ([chat-delivery](../services/chat-delivery.md#refusal-codes---one-stable-name-per-refusal-a-member-can-act-on-2026-10-19)).
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
- WHICH of the two a bundle contains is decided by the BUILD, not by the page: `mlsServicePlatform.ts`
  is the web half, `mlsServicePlatform.native.ts` the native one, and `vite.config.js` resolves the
  import ([mobile](mobile.md#which-implementation-a-build-ships-and-why-it-is-not-a-runtime-choice)).
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

### The tests read a second Paraglide compile (WP-T1)

The app compiles Paraglide as `message-modules` into `src/lib/paraglide/` (one file per message,
~3,300, tree-shaken by the build). Every test that touches `m` would import and transform all of
them - 70 % of the suite's wall-clock. So vitest alone reads a second compile of the SAME project as
`locale-modules` (ten files) from `frontend/.paraglide-test/`: `vitest.config.ts` aliases
`$lib/paraglide` to it ahead of `$lib`.

- **No extra manual step**: `bun run paraglide:compile:test` runs from `prepare` (so after every
  `bun install`, CI included), and from `test`, `test:coverage` and `test:watch`.
- **Gitignored, and out of the app's reach**: `/.paraglide-test` is in `frontend/.gitignore`, it is
  outside `src/`, and only `vitest.config.ts` names it - `vite.config.js` and `svelte-check` still
  see `src/lib/paraglide/`, so the shipped bytes do not change.
- **Cannot drift**: `src/paraglideTestAlias.test.ts` asserts the alias hit the test output, that its
  keys equal the app output's keys, and that every key of `messages/{fr,en}.json` is in it.
- A test that dies with `Failed to resolve import "$lib/paraglide/..."` has not compiled it: run
  `bun run paraglide:compile:test`.

## SvelteKit 3 and adapter-node 6 (2026-10-27)

One pull request, because `adapter-node@6` requires `@sveltejs/kit@3` and `kit@3` drops what `adapter-node@5` used. What moved, so the next reader does not rediscover it:

- **Config.** `svelte.config.js` is refused. The same object lives in `frontend/kit.config.js` (still plain JS, still stamping `kit.version.name` once per process - `kitConfigStamp.test.ts`) and `vite.config.js` passes it to `sveltekit(kitConfig)`. There is no `kit:` namespace any more. `vitest.config.ts` passes `svelte({ configFile: false })`, otherwise the plugin logs "no Svelte config found".
- **`cookie` override removed.** `overrides.cookie ^0.7` existed to lift kit 2's `cookie@0.6`; kit 3 depends on `cookie@2`, which the pin broke (`parseCookie is not a function`).
- **adapter-node 6.** `ORIGIN` is gone and so are the three compose lines that set it (2026-10-27): the origin is derived per request: scheme `https` by default, host from `Host` (nginx `@ssr` forwards it); `PROTOCOL_HEADER` is deliberately NOT set (it would trust a client-sendable value; the edge names have no Cloudflare in front). The app has no form action or remote function for the CSRF origin check to guard; **the day one is added, verify the derived origin behind nginx first** (`$host` and the port matter; a local origin would be `https://localhost`), because that check compares it with the browser's. Static assets are served from a table recorded at build time, with content-hash ETags and `GET`/`HEAD` only. The server half of `check-bundle-consistency.mjs` now reads `const global = "__sveltekit_..."` instead of `version_hash`.
- **Two build warnings, both about `$lib`, and why they stay for now.** (1) `config_option_deprecated_alias`: `alias: { $lib: 'src/lib' }` is deprecated. The replacement, `bunx sv@latest migrate sveltekit-3 --tasks lib-alias`, was RUN on 2026-10-27 and REVERTED: it rewrites 1567 files (7645 imports gain a `.js` extension, comments included), which would conflict with every pull request open on the frontend. It belongs in a quiet window, as ONE mechanical commit with the repository frozen ([backlog](../backlog.md#p3---the-lib-alias-migration-waits-for-a-quiet-frontend-2026-10-27)); that commit removes the alias and this warning. (2) `tsconfig_invalid: "paths" was overwritten. Imports from "$lib" may not typecheck`: a FALSE POSITIVE on Windows. Kit compares the generated path `<root>srclib/*` with `path.resolve(base, ...)`, which on win32 normalises the slash to `srclib*`, so `$lib/*` always mismatches; our tsconfig sets no `paths` and `bun run check` (0 errors) is right. Linux (CI, the images) does not print it. Both disappear with the migration.
- **Behaviour kept on purpose.** `version.pollInterval: 0` (the app owns stale-build recovery) - which stops Kit 3's hourly poll ONLY: Kit still fetches `/_app/version.json` on every return to visible and every window focus ([backlog](../backlog.d/p3-sveltekit-3-what-the-audit-of-2613-left-open.md)).
- **UNVERIFIED here:** the `ORIGIN` removal behind nginx; the web app on dev (`frontend-ssr` container, SEO head injection was smoke-tested against a local `build/index.js` only); both phones. `goto` rejecting a URL no route resolves is handled below.

### A path no route matches - `AppPath` for code, `gotoAppPath` for the rest

**Kit 3's `goto` REJECTS a URL that matches no route** (`navigation_route_missing`, `resolve_intent` in `client.js`); Kit 2 navigated natively and let the server answer. Every destination is one of two kinds, and each has ONE mechanism:

- **Built by code** - a notification's (`notificationHref`, `resolveNotificationHref`), a push tap's (`appRouteForDeepLink`), a checkout return (`shopReturnPath`): typed `AppPath` (`$lib/utils/internalPath`), the template `$app/types` derives from `src/routes`, so a route renamed or deleted under one fails `bun run check`. These go to `goto` directly. `codeBuiltRoutes.test.ts` walks every notification type and every deep-link host through the real route table too, because a `${string}` segment would type a path with an extra `/`. So a notification can never name a route this build lacks; a TYPE this build does not know has no destination at all (`reportUnknownNotificationType`), and a push host it does not know opens `/notifications`.
- **Of unknown origin** - a `returnTo` (sign-in, the OIDC callback, the form builder), a form's `?redirect=` (printed on posters), the target an unsaved-changes prompt replays, a Canari link in a message or an App Link: `gotoAppPath` (`$lib/navigation/gotoAppPath.ts`) asks `match` FIRST. A page of this build is routed; anything else is loaded as a document, logged at error by its shape. What answers that load depends on the platform: on the WEB (adapter-node) the server, with the current deployment's page or its 404 page; in the PHONE APPS (adapter-static, `index.html` as the fallback for every path, `kit.config.js`) the SAME embedded build - the load is a cold restart of the app, and it ends on that build's own 404 page (`+error.svelte`, its way home). The restart is the cost, paid knowingly: it is the one outcome that leaves the reader on a page saying where they are. A target is validated against the page's origin before a full-page load, and the load is given the checked value; a target on another origin loads nothing and is logged. A navigation that rejects is logged at every call site, and the OIDC callback navigates OUTSIDE its token exchange's `try`, so a navigation failure is never shown as a failed sign-in. The cold-start App Link path cannot reach `match` before Kit's route table exists while the client `init` hook stays synchronous (the reasoning is on `init` in `hooks.client.ts`; `coldStartOrder.test.ts` holds it). Before, these handed the path to `goto`: a form's Back did nothing, a successful sign-in said the exchange failed, the form builder stayed on screen with its button live after creating the form, and `appLinkNavigation` learned from the rejection what `match` says up front.

The vitest stub of `$app/paths` matches against `src/routes` for the same reason: a stub matching nothing would send every caller down the document branch and test nothing.

**Still a fallback, and why it stays:** the checkout return in `hooks.client.ts` (`navigate`) catches any `goto` failure and assigns `window.location.href`. Its targets are `AppPath`, so a missing route is no longer what it catches; what is left is a navigation failing for another reason on the payment return, which nothing here has observed. It is filed in [backlog](../backlog.d/p3-sveltekit-3-what-the-audit-of-2613-left-open.md) rather than removed blind.
