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

## Owner decisions of 2026-11-03

Binding, on top of the ones above.

1. **A first-time hint never points INSIDE a modal.** For a control that opens a modal (the post
   composer, the event form) the hint points at the OPENING control, and its text names what a
   first-timer would miss once the modal is open. No engine change. Batch 1 (draft PR #2982)
   follows this.
2. **The feed tabs' (i) button moves into guided help.** The explanation shipped in #2857
   (`posts_tabs_info_*` strings) becomes a guided hint on the tab bar: shown once per account,
   replayable from Settings like the others. The permanent (i) button is then removed. Scheduled
   in batch 2 below; the existing strings are reused where they fit.
3. **A "what's new" help after an update**, besides the full welcome tour (built, #2952): on the
   first open after an update, 2 to 5 steps on the real interface pointing ONLY at what changed in
   that version, once per version per account, skippable, and never shown to a brand-new account in
   the same visit as the welcome tour. Designed AFTER the four batches. Open design points: how a
   version's steps are declared (one declaration file per version listing its steps, or a `since`
   field on each help), and how the per-version "seen" keys fit the existing allowlisted help-ids
   contract (`libs/contracts/help-ids.json`: one bounded id per version, or a version marker with
   its own allowlist rule), without letting the table grow unbounded.
4. **Pace: one batch per pre-release**, each read on the Mi 9T and the iPhone 12 before the next
   batch starts.

### The batch plan

| Batch | Content | State |
| --- | --- | --- |
| 1 | Create: post composer and event form (hint on the opening control, decision 1) | draft PR #2982 |
| 2 | Chats and CanaReels, plus the feed tabs' explanation moved from the (i) button (decision 2), plus the "what's new" mechanism with the 1.6.3 content (decision 3) | built, draft PR; [below](#whats-new-and-the-batch-2-hints) |
| 3 | Associations and spaces | after batch 2 is read on both phones |
| 4 | Booking a room | after batch 3 |

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
  rect, i.e. the one drawn. A viewport change across a breakpoint (`onViewportChange`) PLANS THE
  HELP AGAIN for the new layout (`GuideEngine.layoutChanged`): every `when` and every layout-dependent
  anchor is read afresh, the reader stays on their step when the new layout has it, else moves to the
  next declared step it has, and with none left the help is finished.
- **No step waits for a control drawn after data.** An earlier draft had a `waitForAnchor` with a
  waiting phase; no help used it, and a waiting run held the engine while drawing nothing - which also
  blocked a replay from Settings - so it was deleted (review of #2952). A future help whose control
  appears only after a load declares itself on a route where the control is drawn at the settle, or
  brings the waiting phase back WITH its first user and its tests.
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

## At most one help per visit (lead, 2026-11-03, reversible)

Without a cap, the welcome tour ends on `/posts`, the app turns quiet and `hint-create-post` starts at
once: two helps back to back on a first visit (and after a Settings replay). `GuideEngine#pick` now
offers nothing once a help has SHOWN a step in this visit - a visit being the engine's lifetime, one
app open or reload (in-memory flag, no timer, no stored state; a sign-out resets it, the next account's visit is its own). A help
declined as not-rendered shows nothing and does not count, so another may run. A replay from Settings
is exempt from the cap and sets it: it is the visit's help. Pinned in `guideEngine.test.ts`.

## Seen, ended, replayed

**Who sees the welcome tour (owner, 2026-11-02): every account that has never seen it, ONCE - new and
existing accounts alike.** There is no account-age or first-sign-in condition anywhere: a help starts
when the ACCOUNT's seen set (server-side, per account) lacks it, and nothing else about the account is
read. It can be skipped at any step and replayed from Settings (pinned in `guideEngine.test.ts` and
`seenHelps.test.ts`).

Every end records the help as seen: Next on the last step, "Passer", Esc, Back, and leaving the page
(the navigation drain). The reader met it, and Settings > Preferences > "Revoir la visite" replays
it (`replayGuide('welcome-tour')`, then the feed - the tour applies to `/posts`, where every control
it points at is drawn). A replay ignores the seen set and still waits for the quiet state.

**An unseen help starts only once the server has answered** (`seenHelps.ready`): starting on the
local copy alone would replay on a new device a tour the account finished on another one. A device
that cannot reach the server shows no new help; the next opening asks again.

## The first-time hints, batch 1 - create

Built 2026-11-03, `kind: 'hint'` each, once per account, listed after the welcome tour (so a hint
never precedes it on `/posts`). **A help never runs over a modal** (the quiet state), and the post
composer and the event form ARE modals - so those two hints point at the control that OPENS them, and
say what a first-timer would miss (publishing as an association, scheduling, validation) in the body.
The form builder is a page, so its hint points inside it.

| Id | Route | Anchor(s) | Steps (fr) |
| --- | --- | --- | --- |
| `hint-create-post` | `/posts` | `posts.compose`: the phone header's "+" (`MobileHeader`) and the desktop "Publier" button (both marked, the drawn one wins) | "Publier un message" - texte, photos, sondage ou formulaire, en son nom ou celui d'une association, envoi programmable |
| `hint-create-event` | `/calendar` | `calendar.deposit`: the "Deposer un evenement" button, drawn only for an account that may post on an association (else the step is left out, not-rendered) | "Déposer un événement" - association, date, lieu; visible dans l'agenda une fois validé |
| `hint-create-form` | `/forms/create` | `forms.create.general`, `.questions`, `.settings`: wrappers of the page's three blocks | "Le formulaire" (titre, association, choix définitif), "Les questions", "Réglages avancés" |

Pinned by `guides/createHints.test.ts` (kind, route, registered, every step kept on phone and desktop,
left out when not drawn, and the anchors really marked in the page sources). Owed: the three read on a
phone and a desktop with a signed-in account; the next batches (chats and CanaReels, associations and
spaces, booking a room) follow.

## What's new, and the batch 2 hints

Built 2026-11-04. All `kind: 'hint'`, once per account, listed after the tour in `guides/index.ts`.

| Id | Route | Anchor(s) | Steps (fr) |
| --- | --- | --- | --- |
| `hint-create-post`, `-event`, `-form` | batch 1, above | | |
| `hint-feed-tabs` | `/posts` | `posts.tab.associations`, `.followed`, `.all`: each tab of `FeedTabRow` | one step per tab, reusing the `posts_tabs_info_*` strings of the removed (i) button |
| `hint-reels` | `/posts` | `posts.reels`: the CanaReels icon (`ReelsEntryButton`), the control that OPENS the viewer | "CanaReels" - short videos, full screen, swipe for the next |
| `hint-chats` | `/chat` | `chat.new`: the "+" of the list header (`SidebarHeaderControls`), which opens the new-conversation modal | "Démarrer une discussion" - + for a person or a group, touch a conversation to open it; not-rendered (left out) where the list is not drawn |
| `whats-new-1-6-3` | `/posts` | `posts.tab.all`, `nav.chat` | "Publications épinglées" (pins stay at the top of Mon espace), "Lu sur tous vos appareils" |

**The feed tabs' (i) button is gone** (`FeedTabsInfo.svelte` and its test deleted): the explanation is
the `hint-feed-tabs` hint now. It is NOT replayable from Settings yet (neither are the batch 1
hints); Settings replays the tour only.

### The "what's new" mechanism (decision 3)

- **One declaration per version** (`guides/whatsNew.ts`, one file per version over time), **and only
  the latest is in `GUIDES`**: an account that skipped a version is shown the current news, never a
  backlog. **One bounded id per version**, `whats-new-<major>-<minor>-<patch>`, in the three
  allowlists; shipping the next version adds its id and drops the old declaration from `GUIDES`
  (the old id stays allowlisted so the rows written stay valid). The table grows by one id per
  version that ships news - bounded by the release count, and a version with nothing on screen to
  point at declares none.
- **Existing account, after an update**: `GuideDefinition.requires: 'welcome-tour'` - the news is
  offered only to an account whose seen set already has the tour. It starts at the first quiet moment
  on `/posts`, once (every end records it, like any help), skippable.
- **New account**: has not seen the tour, so the tour runs, and `welcomeTour.supersedes` records the
  current what's-new as seen WITH the tour (`GuideEngine.end`, only when the tour is met for the first
  time - a replay from Settings records nothing extra). So a new account is never shown the news,
  neither on the tour's visit (the one-help-per-visit cap) nor on the next.
- **Never on the same visit as another help**: the `#shownThisVisit` cap applies unchanged.
- **A hint, not a tour**: nothing is put behind it. That also keeps this batch from making the iOS
  native-tab-bar P3 ([backlog](../backlog.d/p3-the-native-tab-bar-stays-tappable-under-the-welcome-tour.md))
  worse: the engine does not block the native bar - it is drawn above the WebView and a backdrop
  cannot cover it, so no engine change can; the bar stays tappable, and a tap on a tab ends the help
  as a navigation (recorded as seen).
- **1.6.3 content**: two steps. The pins (a BDE pins a post at the top of its spaces) point at "Mon
  espace"; the cross-device read mark points at the chat tab. Guided help itself is not a step;
  the other 1.6.3 items (a list cashing through an association, an editable upcoming booking) have
  no anchor on the feed and are not in the news. Owed: the owner may swap the second step.

Pinned by `guideEngine.test.ts` ("the 'what's new' help": once per version, never without the tour,
never for a new account, a replay adds nothing, never beside another help) and
`guides/batch2Hints.test.ts` (routes, layouts, anchors really marked, the (i) button gone, exactly one
what's-new declared). Owed on hardware: the three hints and the news read on the Mi 9T and the iPhone
12 (the chat tab step lands on the native bar's band on iOS).

## Back, focus, motion

- **Back** closes a help like every overlay: its entry is pushed on the history overlay stack
  (`historyOverlayStack.ts`) while it is on screen and released - a ghost, no traversal - when it is
  hidden or ended from the bubble. The system Back (`popstate`) and the iOS edge-swipe Back
  (`backHistoryOverlayFromGesture`) both end it. **Android's native Back** reads the stack's depth
  synchronously (`window.canariBack.setOverlayDepth`, #2942): at 0 it finishes the activity. The
  stack has ONE call at every change point, `stackChanged()`, which publishes that depth AND tells the
  depth listeners (the overlay's quiet state) - so the tour's push publishes depth 1 like any overlay's,
  and a native Back closes the tour, never the app (`GuideOverlay.svelte.test.ts` pins it).
- **Focus** moves into the bubble on every step (`preventScroll`), Tab stays in it while the step is
  modal (`focusTrap`), the arrow keys step, Esc ends. The bubble is a `dialog` labelled by its title
  and described by its body; an always-mounted polite live region announces "Step n of N: title".
- **Modal** steps (a tour) put a layer under the bubble that takes every pointer; a hint takes none
  but the bubble's.
- **Motion**: the spotlight glides between controls (`--motion-slow`, a `transform`, never
  left/top), its ring breathes, the bubble pops in per step, the swipe mime slides - all CSS (`app.css`, "THE GUIDED HELP"), all stopped by the
  global reduced-motion rule; the two infinite ones are not even started there (`data-pulse`,
  `data-play`), and a scroll to an off-screen target is instant.
- **While the page scrolls** the re-measure is coalesced to ONE per animation frame
  (`requestAnimationFrame`; resize and `ResizeObserver` share it), and the spotlight and bubble carry
  `data-tracking`, which turns their transition off - they follow the target instead of lagging it.
  `scrollend` and the next step clear it; where `scrollend` does not fire, the cost is only that the
  glide waits for the next step.
- The layer is its own rung, `--z-guide` (one over `--z-modal`): a help never runs over a modal or
  a sheet (it would not be quiet - it is suspended), and the call and a confirmation keep their rungs
  above it. The accent ink is the `guide-ink` token (brand dark in light, yellow in dark).
- **Sign-out resets the engine** (`guideEngine.reset()` beside `resetSeenHelps()` in
  `endSessionImpl`): a run suspended for account A, or a replay A asked for, never resumes for
  account B over B's own seen set.
- **No guidance module imports a component** (`guidance.importGraph.test.ts`). Sign-out imports
  `guidance.svelte.ts`, and a component's graph reaches `globalChatSingleton` and back to sign-out -
  importing `NativeTabBar.svelte` for its state closed that cycle in CI. The bar's state lives in
  `navigation/nativeTabBarState.svelte.ts`, which the component re-exports.

## The server store

`help_seen` in core-service (migration `019_help_seen.sql`, additive: a new table), beside
`platform_announcement_seen`, the other "seen once per account" state. One row per (account, help);
`user_id` is a `varchar(255)` like `users.id`.

| Route | Answer |
| --- | --- |
| `GET /api/users/me/help-seen` | `{ seen: HelpId[] }` - only ids the current allowlist names |
| `POST /api/users/me/help-seen/:helpId` | `200 { success: true }`, idempotent (`ON CONFLICT DO NOTHING`); `400 { code: 'HELP_ID_UNKNOWN' }` for an id outside `HELP_IDS`, nothing written |

Both are behind `NginxAuthGuard` and `AccountThrottlerGuard` (30 a minute per account ON EACH
route - the throttler keys routes separately), under
`users/me/...` so `users/:id` cannot capture them. The allowlist bounds the table at one row per
account per declared help, whatever a client sends. Account erasure deletes the rows
(`CORE_ERASURE_STATEMENTS`, `help_seen`); the register row is
[C25](../compliance/register-of-processing.md).

**The client's writes** (`seenHelps.svelte.ts`): the id is added to the local copy at once
(`ACCOUNT_KEY.seenHelps`, swept by the account deletion), then POSTed. A write that met no answer is
OWED and delivered by the reconnect (`connectivity.onReconnect`, the salon writes' trigger) or by the
next `load` (the next opening). ONE refusal is dropped for good: the 400 whose typed body `code` is
`HELP_ID_UNKNOWN` (shared as `unknownIdCode` in `libs/contracts/help-ids.json`), logged as the
release mismatch it is. Every other status - a 429, a 408, a 401, a 5xx - says nothing permanent
about the id and stays owed; the decision reads the code, never a message. No retry timer.

## Tests

- `guideEngine.test.ts` - step order, layout and not-rendered skips, a target that leaves after the
  plan, replay, every end reason recorded once, the re-plan on a breakpoint (a `when` read again),
  the decline loop, and `reset` at an account switch.
- `guidePlacement.test.ts`, `guideQuiet.test.ts`, `seenHelps.test.ts` (optimistic, owed, reconnect,
  only the typed unknown-id refusal dropped, a 429/408/401/5xx kept owed, reset);
  `guideAnchors.svelte.test.ts` (a registration inside an effect does not re-run it).
- `GuideOverlay.svelte.test.ts` - the welcome tour on both layouts through the real anchor action and
  the real history stack: six steps on a phone, five on a desktop (no camera, the agenda in the rail,
  the bubble beside it), focus, the announcement, arrows, Esc, "Passer", system Back and gesture Back,
  Android's native Back depth (1 while the tour is up, 0 after Back), suspension by a call and by a
  real `Modal` with the return to the same step, no start over a covering surface, reduced motion.
- `helpIds.contract.test.ts` / `help-ids.spec.ts` - both lists equal the contract.
- core-service: `help-seen.controller.spec.ts` (allowlist before any write, guards, throttle, path),
  `help-seen.service.spec.ts`, and `help-seen.integration.spec.ts` against PostgreSQL (gated on
  `CORE_IT_DATABASE_URL`: idempotence, the allowlist, a retired id, erasure); the account-erasure
  integration spec now seeds and checks `help_seen` too.

**Owed on hardware**: the tour read on the Mi 9T and the iPhone 12 (the native bar's band on iOS 26,
the Android Back on the tour).
