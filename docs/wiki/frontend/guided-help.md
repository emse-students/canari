# Guided help - the welcome tour and first-time hints

**Asked by the owner on 2026-11-02**: help and wizards throughout Canari, starting with a short,
lively first visit. His decisions, binding:

- the welcome tour is **coach marks on the real interface** - 4 to 6 steps pointing at the real
  controls (feed, chats, camera, agenda, profile), an animated halo on the target, a short bubble
  with "n/N" and Next, "Passer" always visible, replayable from Settings, on phone AND desktop
  layouts, with motion that honours `prefers-reduced-motion`;
- **"seen" is stored on the account**, server side, so it holds across devices - a small store of
  seen help ids per user, nothing else;
- **order**: the reusable ENGINE and the welcome tour first (this page's state). The first-time helps
  follow in batches: create (post, event, form); chats and CanaReels; associations and spaces;
  booking a room. Each one is a few lines of declaration (below).

## The pieces

| File | Role |
| --- | --- |
| `frontend/src/lib/guidance/guideTypes.ts` | What a help IS: `GuideDefinition` (id, `kind`, `appliesTo`, steps) and `GuideStep` |
| `frontend/src/lib/guidance/guides/` | The declarations - one file per help, listed in priority order in `index.ts` |
| `frontend/src/lib/guidance/guideEngine.svelte.ts` | THE engine: when a help starts, which steps a layout shows, when it is seen. Draws nothing; its environment is injected |
| `frontend/src/lib/guidance/guideAnchors.svelte.ts` | The anchor registry: `use:guideAnchor={'nav.chat'}` on a control, `registerGuideRegion` for a target that is not an element |
| `frontend/src/lib/guidance/guideQuiet.ts` | The quiet state - the facts that hold a help back |
| `frontend/src/lib/guidance/guidePlacement.ts` | Where the bubble goes (pure) |
| `frontend/src/lib/guidance/seenHelps.svelte.ts` | The account's seen set: optimistic local copy, server sync, owed writes |
| `frontend/src/lib/guidance/guidance.svelte.ts` | The app's one engine wired to the app; `replayGuide(id)` |
| `frontend/src/lib/components/guidance/GuideOverlay.svelte` | The ONE renderer: spotlight, halo, bubble, focus, Back. Mounted once by the root layout |
| `libs/contracts/help-ids.json` | The allowlist of help ids, shared as data by the client and the server |
| `apps/core-service/src/platform/help-seen.*`, migration `019_help_seen.sql` | The server store |

## Declaring a help

A help is DATA. A future first-time hint for the post composer's "+" is, in full:

```ts
// frontend/src/lib/guidance/guides/createPostHint.ts
import { Plus } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { GuideDefinition } from '../guideTypes';

export const createPostHint: GuideDefinition = {
  id: 'hint-create-post',
  kind: 'hint', // not modal: the page stays usable, the bubble points
  appliesTo: (pathname) => pathname === '/posts',
  steps: [
    {
      id: 'compose',
      anchor: 'posts.compose', // `use:guideAnchor={'posts.compose'}` on the "+" link
      icon: Plus,
      title: m.guide_hint_create_post_title,
      body: m.guide_hint_create_post_body,
    },
  ],
};
```

and then, in the same pull request:

1. `use:guideAnchor={'posts.compose'}` on the control (`MobileHeader.svelte` for the phone, the feed
   heading for the desktop - both may carry the SAME id, the rendered one wins);
2. a line in `guides/index.ts` (the list is the priority order);
3. the id in `libs/contracts/help-ids.json` AND in both `HELP_IDS` copies
   (`frontend/src/lib/guidance/helpIds.ts`, `apps/core-service/src/platform/help-ids.ts`) - each
   side's contract test fails until the three agree, and TypeScript refuses a declaration under an
   unlisted id;
4. the two messages in `messages/fr.json` and `en.json`.

What a step can say:

| Field | Meaning |
| --- | --- |
| `anchor` | the anchor id, `null` for a centred step about nothing on screen (a welcome, a gesture) |
| `title`, `body` | Paraglide messages, called at render time |
| `placement` | `auto` (default: the side with room, below then above, then beside), or a side |
| `when(layout)` | whether the step exists on this layout at all (the camera step: `layout.swipe`) |
| `waitForAnchor` | wait for a control drawn after data arrives; the wait ends on the anchor's registration or on a route change - never a timer |
| `icon`, `gesture` | a glyph in the bubble; `swipe-right` mimes a swipe for a place reached by a gesture |

`anchor`, `title`, `body` and `placement` take `{ byLayout: (layout) => value }` where a phone and a
desktop differ (the welcome tour's agenda: the dashboard tab on a phone, the rail entry on a wide
screen). The wrapper is an object because a Paraglide message is itself a function.

`layout` is three FACTS of the running app: `phone` (below `md`, `isPhoneViewport`), `swipe` (the
tab swipe exists, `isSwipeNavViewport`) and `nativeTabBar` (the iOS app draws the bottom bar natively).

## A missing target is decided by an event, never by a timeout

The owner's rule: a step whose target never appears is skipped deterministically, from an event that
says the route or layout will not render it.

**The registry is the list of what is mounted.** `use:guideAnchor` registers at the control's mount
and releases at its unmount, so the engine never searches the DOM for a selector that may yet appear.
**The engine evaluates only after the route has settled**: the overlay records the settled route in
`afterNavigate` (after a `tick()`), by which point every component of the page and the layout has
mounted and run its actions - and the quiet state requires it (`routeSettled`). So an anchor absent
at that moment is not drawn by this layout, and `planGuide` leaves the step out at once, logged
`step <id> left out (not-rendered)`.

Registrations run inside an action or an effect (the native tab bar registers its band from one), so
the registry bumps its `version` signal **untracked**: a tracked read-then-write there re-runs the
registering effect on its own write, forever (`effect_update_depth_exceeded`, caught by
`guideAnchors.svelte.test.ts` and the native tab bar's own tests).

Three refinements keep that exact:

- **One id, several sources.** The bottom bar and the sidebar are BOTH mounted at every width - the
  breakpoint hides one with `display: none`. An anchor resolves to the source that has a client
  rect, i.e. the one drawn. A viewport change (`onViewportChange`) re-reads the layout, and a step on
  screen whose anchor stopped being drawn moves on.
- **A control drawn after data** declares `waitForAnchor`: the step waits for the registry event, and
  the route change is the event that abandons it. Nothing is blocked meanwhile - a waiting step draws
  nothing and holds no history entry.
- **The iOS native tab bar** is drawn above the WebView, so its tabs are not elements. `NativeTabBar`
  registers each place's id as a REGION - the band the bar covers, from the plugin's measured inset -
  and the step's icon names the tab. A slice per item was rejected: the plugin gives the band's
  height, not where each item sits, and the iOS 26 floating pill would make a slice a guess.

A help that ends up with NOTHING to show is put back unseen (it never reached the reader) and is not
offered again until the situation changes (`situation()`: the settled route and the anchor registry's
version) - otherwise the scheduler would start and drop it in a loop.

## The quiet state - when a help may be on screen

The owner: never over the PIN gate, the login, a call, the camera or a modal; wait for a quiet state
defined by real app state, not a delay. `quietBlocker` (`guideQuiet.ts`) returns the first reason:

| Fact | Read from |
| --- | --- |
| no unlocked session (PIN gate, login) | `globalSession.isLoggedIn` |
| a page without the app (login, legal, public form) | the layout's own `isLoginPage` (`chromeless` prop) |
| a blocking gate (minimum version, maintenance) | `appVersionCheck` |
| the route has not settled | `afterNavigate` |
| the camera | `isFullScreenPlace` |
| a call, even minimised | `globalSession.callState !== 'idle'` |
| something covers the screen (modal, sheet, viewer, call screen, PIN lock) | `screenCover` |
| another overlay is open (a menu) | the history overlay stack's depth, minus the help's own entry (`onHistoryOverlayDepthChange`) |
| the keyboard is up | `keyboardViewport` |
| iOS: the native bar is still being configured | `nativeTabBar.status` |

The overlay re-asks on every change of any of them, so a help STARTS on the event that made the app
quiet. The same predicate SUSPENDS a help on screen (a call rings, a sheet opens): it is hidden, its
history entry released, and it comes back on the same step when the app is quiet again. A suspension
is never an end.

## Seen, ended, replayed

Every end records the help as seen: Next on the last step, "Passer", Esc, Back, and leaving the page
(the navigation drain). The reader met it, and Settings > Preferences > "Revoir la visite" replays
it (`replayGuide('welcome-tour')`, then the feed - the tour applies to `/posts`, where every control
it points at is drawn). A replay ignores the seen set and still waits for the quiet state.

**An unseen help starts only once the server has answered** (`seenHelps.ready`): starting on the
local copy alone would replay on a new device a tour the account finished on another one. A device
that cannot reach the server shows no new help; the next opening asks again.

## Back, focus, motion

- **Back** closes a help like every overlay: its entry is pushed on the history overlay stack
  (`historyOverlayStack.ts`) while it is on screen and released - a ghost, no traversal - when it is
  hidden or ended from the bubble. The system Back (`popstate`) and the iOS edge-swipe Back
  (`backHistoryOverlayFromGesture`) both end it. The Android native Back's second chance for an entry
  pushed without user activation (the double-Back fix of draft PR #2942) will cover it like any
  overlay once that lands: it acts on the stack, which this entry is on.
- **Focus** moves into the bubble on every step (`preventScroll`), Tab stays in it while the step is
  modal (`focusTrap`), the arrow keys step, Esc ends. The bubble is a `dialog` labelled by its title
  and described by its body; an always-mounted polite live region announces "Step n of N: title".
- **Modal** steps (a tour) put a layer under the bubble that takes every pointer; a hint takes none
  but the bubble's.
- **Motion**: the spotlight glides between controls (`--motion-slow`), its ring breathes, the bubble
  pops in per step, the swipe mime slides - all CSS (`app.css`, "THE GUIDED HELP"), all stopped by the
  global reduced-motion rule; the two infinite ones are not even started there (`data-pulse`,
  `data-play`), and a scroll to an off-screen target is instant.
- The layer is `--z-modal`: a help never runs over a modal (it would not be quiet), and the call and
  a confirmation keep their rungs above it.

## The server store

`help_seen` in core-service (migration `019_help_seen.sql`, additive: a new table), beside
`platform_announcement_seen`, the other "seen once per account" state. One row per (account, help);
`user_id` is a `varchar(255)` like `users.id`.

| Route | Answer |
| --- | --- |
| `GET /api/users/me/help-seen` | `{ seen: HelpId[] }` - only ids the current allowlist names |
| `POST /api/users/me/help-seen/:helpId` | `200 { success: true }`, idempotent (`ON CONFLICT DO NOTHING`); `400 { code: 'HELP_ID_UNKNOWN' }` for an id outside `HELP_IDS`, nothing written |

Both are behind `NginxAuthGuard` and `AccountThrottlerGuard` (30 a minute per account), under
`users/me/...` so `users/:id` cannot capture them. The allowlist bounds the table at one row per
account per declared help, whatever a client sends. Account erasure deletes the rows
(`CORE_ERASURE_STATEMENTS`, `help_seen`); the register row is
[C25](../compliance/register-of-processing.md).

**The client's writes** (`seenHelps.svelte.ts`): the id is added to the local copy at once
(`ACCOUNT_KEY.seenHelps`, swept by the account deletion), then POSTed. A write that met no answer is
OWED and delivered by the reconnect (`connectivity.onReconnect`, the salon writes' trigger) or by the
next `load` (the next opening); a 4xx is not owed - no repeat can change it - and is logged as an
error. No retry timer.

## Tests

- `guideEngine.test.ts` - step order, layout and not-rendered skips, a target that leaves after the
  plan, replay, every end reason recorded once, a waiting step and its route change, the decline loop.
- `guidePlacement.test.ts`, `guideQuiet.test.ts`, `seenHelps.test.ts` (optimistic, owed, reconnect,
  refusal not owed, reset).
- `GuideOverlay.svelte.test.ts` - the welcome tour on both layouts through the real anchor action and
  the real history stack: six steps on a phone, five on a desktop (no camera, the agenda in the rail,
  the bubble beside it), focus, the announcement, arrows, Esc, "Passer", system Back and gesture Back,
  no start over a covering surface, reduced motion.
- `helpIds.contract.test.ts` / `help-ids.spec.ts` - both lists equal the contract.
- core-service: `help-seen.controller.spec.ts` (allowlist before any write, guards, throttle, path),
  `help-seen.service.spec.ts`, and `help-seen.integration.spec.ts` against PostgreSQL (gated on
  `CORE_IT_DATABASE_URL`: idempotence, the allowlist, a retired id, erasure); the account-erasure
  integration spec now seeds and checks `help_seen` too.

**Owed on hardware**: the tour read on the Mi 9T and the iPhone 12 (the native bar's band on iOS 26,
the Android Back on the tour).
