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
| 2 | Chats and CanaReels, plus the feed tabs' explanation moved from the (i) button (decision 2), plus the "what's new" mechanism only, content with 1.6.4 (decision 3) | built, draft PR; [below](#whats-new-and-the-batch-2-hints) |
| 3 | Associations and the campus space (shop, publish as, manage; "Mon espace" is feed-tabs step 3); batch 2 read PASS on both phones 2026-11-04 | built, draft PR; [below](#batch-3---associations-and-the-campus-space) |
| 4 | Booking a room: the Reservations page and a space's week | built, in 1.6.5 (owner, 2026-11-05); [below](#batch-4---booking-a-room) |

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
- **The iOS native tab bar takes NO TOUCH under a modal step.** The backdrop cannot cover a bar drawn
  above the WebView: on the iPhone 12 (`1.6.3-alpha.7`) a tap on the chat tab left the tour and
  opened `/chat`. `GuideOverlay` writes `modalWebLayer.covering` (`navigation/nativeTabBarState`)
  while a MODAL step is on screen - not while a tour is suspended, and never for a hint, which leaves
  the page usable - and `NativeTabBar` sends it to the plugin's Canari-patched
  `set_tab_bar_interactive`, which turns the overlay's root view's `isUserInteractionEnabled` off so
  UIKit's hit test hands the touch to the WebView, where the backdrop takes it. Each call carries a
  rising `seq` (the command is async, so two quick toggles may reach the main queue out of order, and
  Swift drops an older one arriving last - the one `CommandSequence` that orders show and hide too,
  [mobile](mobile.md#the-native-ios-tab-bar)); a configuration resets the bar to interactive and the
  sequence to -1, and `NativeTabBar` sends its state after EVERY configuration - the overlay outlives
  a WebView reload, so a page reloaded under the backdrop would otherwise inherit a bar that takes no
  touch. A call is recorded as sent only once the plugin answered. The bar stays drawn:
  the tab steps point at its band. Hiding it was rejected for that reason. Owed on the iPhone: check T
  in [device-verification](../device-verification.md).

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
| `hint-feed-tabs` | `/posts` | `posts.tab.associations`, `.followed`, `.all`: each tab of `FeedTabRow` | one step per tab, reusing the `posts_tabs_info_*` strings of the removed (i) button (rewritten in "vous", like every guide string) |
| `hint-reels` | `/posts` | `posts.reels`: the CanaReels icon (`ReelsEntryButton`), the control that OPENS the viewer | "CanaReels" - short videos, full screen, swipe for the next |
| `hint-chats` | `/chat` | `chat.new`: the "+" of the list header (`SidebarHeaderControls`), which opens the new-conversation modal | "Démarrer une discussion" - the + creates a discussion (a channel in communities), touch a conversation to open it; left out (not-rendered) where the list is not drawn |

**The feed tabs' (i) button is gone** (`FeedTabsInfo.svelte` and its test deleted): the explanation is
the `hint-feed-tabs` hint, and it stays reachable: **Settings > Preferences > "Revoir les aides"**
lists every hint that declares `replay` (`{ label, route }` on its `GuideDefinition`): the post, feed
tabs, CanaReels and chats hints. A button records the request and opens the hint's page, where it
starts at the next quiet moment (the event and form hints are bound to a conditional or deep page and
have no button). The welcome tour keeps its own row above.

**A hint left by navigation before its LAST step is put back** (offered again on a later visit),
not recorded: nobody read it. Finished, skipped, Esc, Back and a navigation from the last step still
record it. A tour is unchanged.

### The "what's new" mechanism (decision 3) - mechanism only, no content yet

`GUIDES` carries NO what's-new in this batch: 1.6.3 is already the production stable, and the news of
1.6.4 is written when 1.6.4's content is known (the first draft, `whats-new-1-6-3`, was removed and
its id is not in the allowlists - it never shipped, so no row can exist).

- **One declaration per version, only the latest in `GUIDES`**: `news: true` on the definition, id
  `whats-new-<major>-<minor>-<patch>`. An account that skipped a version is shown the current news,
  never a backlog. Shipping a version's news adds a file under `guides/`, its id to the three
  allowlists, and drops the previous declaration from `GUIDES` (the old id stays allowlisted so the
  rows already written stay valid). The table grows by one id per version that has news.
- **A version that differs from the app's is a failing test**: `guideNews.test.ts` fails when a
  declared news id does not name the base version of `frontend/package.json` (a `-alpha.N` suffix
  stripped), and when more than one is declared.
- **Existing account, after an update**: a `news` help is offered only to an account whose seen set
  already has the tour (derived in `GuideEngine#pick`, no per-guide field). It starts at the first
  quiet moment on `/posts`, once, skippable; seeing it records its id, so it never returns.
- **New account**: has not seen the tour, so the tour runs, and `supersedesNews` on the tour records
  EVERY declared `news` help as seen with it - derived from `GUIDES`, no literal list - only when the
  tour is met for the first time (a replay records nothing extra). So a new account never sees the
  news, neither on the tour's visit (the one-help-per-visit cap) nor on the next.
- **Never on the same visit as another help**: the `#shownThisVisit` cap applies unchanged.
- **Write it as a hint, not a tour**: nothing is put behind it. The iOS native tab bar cannot be
  covered by any backdrop (it is drawn above the WebView); a MODAL step turns its touches off
  (see "The iOS native tab bar takes NO TOUCH under a modal step" above), a hint leaves it tappable.

Pinned by `guideNews.test.ts` (version, derivation, the engine rules over made-up ids, the put-back),
`guideEngine.test.ts`, `guides/batch2Hints.test.ts` (routes, layouts, anchors really marked, the (i)
button gone, replay declared). Owed on hardware: the three hints and the Settings replay read on the
Mi 9T and the iPhone 12.

## Batch 3 - associations and the campus space

Built 2026-11-04 on the owner's scope of that day (all four items; item 1 reshaped by the correction below), all `kind: 'hint'`, once per
account, listed after batch 2 in `guides/index.ts`. **No "what's new" content for 1.6.4** (owner,
2026-11-04): `GUIDES` still carries no `news` help.

**A hint is shown only to accounts it applies to, and the condition is never a second definition of
the right.** Two mechanisms, both reading what the interface already draws by:

- **an anchor the page marks only for the reader it concerns** (the convention since `calendar.deposit`):
  the page decides from the same facts that draw the control, an unmarked control leaves its step out
  (not-rendered) and a help with no step is never offered. The association page loads after the route
  settles, so its help starts when its anchors mount (the anchor registry's version is part of the
  engine's `situation`). A shared hub list names its anchor in its data: `HubRow.guideAnchor`,
  registered through `guideAnchorWhen` (`undefined` registers nothing).
- **`GuideDefinition.eligible`**, for a fact no control carries: read by the scheduler beside
  `appliesTo`, inside its effect, so an async answer re-asks it by itself. It also holds a replay back,
  so a help with `eligible` declares no `replay`.

| Id | Route | Anchor(s) | Eligibility source | Steps (fr) |
| --- | --- | --- | --- | --- |
| `hint-asso-shop` | `/associations/<slug>` | `asso.shop` (the Shop hub row) | any signed-in visitor of an association whose shop is non-empty: the hub draws the row only then (`mayOpenPublicSection`), else the step is left out | "La boutique de l'association" - buy products and tickets, pay the cotisation that makes you a cotisant, with the tariffs and offers reserved to cotisants |
| `hint-asso-post-as` | `/posts` | `posts.compose` (the SAME opening control as `hint-create-post`: phone "+" or desktop "Publier"; never inside the modal, decision 1) | `eligible: canPostAsAssociation` (`lib/posts/postAsAccess.svelte.ts`), which asks `listPostAsAssociations()`, the list the "Publier en tant que" picker offers | "Publier au nom d'une association" - names the picker at the top of the form |
| `hint-asso-manage` | `/associations/<slug>` | `asso.manage` (the "Gestion de l'asso" link, which OPENS the area), `asso.agenda` (Agenda hub row) | both marked only when `canManage` (the link's own condition); the agenda row also needs `canProposeEvent`, the agenda section's edit right | "Gérer l'association", "L'agenda de l'association" |
| `hint-asso-manage-hub` | `/associations/<slug>/edit` | `asso.edit.members`, `asso.edit.audience` (hub rows) | the hub draws a row only for a reader who holds its right (`visibleEditSections`), so the audience step (platform admin or BDE super-admin) is left out for a manager without it | "Membres et droits", "Le public de l'association" |

**Owner correction, 2026-11-04: one does not "join" an association.** One pays a cotisation in its
shop; only its managers edit the member list. The first draft's `hint-asso-join` (follow, members,
"Rejoindre l'association") became `hint-asso-shop`, a single step on the Shop row, and no help text
says "rejoindre"/"join" for an association (pinned in `batch3Hints.test.ts`). The follow step was
dropped to keep it short and tied to the shop.

Why two manager helps: the agenda is a row of the association's PUBLIC page, the members, rights and
audience are rows of the management hub, and a hint never follows a navigation. Neither declares
`replay` (one route per association).

**"Mon espace" has no hint of its own** (lead decision, 2026-11-04, after review): the tab is already
explained by step 3 of `hint-feed-tabs` (`posts_tabs_info_all_body`), on the same anchor, so a second
hint would only repeat it. The owner's moment is kept, not duplicated.

Pinned by `guides/batch3Hints.test.ts` (routes, layouts, anchors named in the sources, eligibility
cases, the route patterns, replay), `guideEngine.test.ts` ("eligible": not offered, offered once the
answer is yes, a replay held back, another help runs) and `postAsAccess.test.ts`. Owed on a phone: the
four read on the Mi 9T and the iPhone 12 with a plain member, a non-member, a manager and an account
that can post as an association.

## Batch 4 - booking a room

Built 2026-11-04, `kind: 'hint'` each, once per account, listed after batch 3 in `guides/index.ts`.
Ships in 1.6.5 (owner, 2026-11-05), ahead of the batch 3 phone reading. Both pages load after the route settles, so
a help starts when its anchors mount; every anchor is marked by the element's own render condition.

| Id | Route | Anchor(s) | Steps (fr) |
| --- | --- | --- | --- |
| `hint-booking-spaces` | `/bookings` | `bookings.mine` (the "Vos prochaines réservations" section, drawn once loaded), `bookings.spaces` (a wrapper of `SpaceList`, drawn only when the read succeeded and the list is not empty) | "Vos réservations" - coming ones first, past and cancelled folded below; "Réserver un espace" - pick a space for its week; a link-only space is opened by its link or QR code |
| `hint-booking-week` | `/bookings/spaces/<id>` (not `manage`, not `edit`) | `bookings.column` (a wrapper of `ColumnSelect`, drawn only for a space with several columns), `bookings.week` (`data-week-grid`: the planning list on a phone, the grid wide); both marked by `SpaceWeek` in `book` mode once the first read of the week landed | "Une colonne par ressource"; "Réserver un créneau" - body by layout (list and the icon-only + button on a phone, grid and drag on a wide screen), then the sheet adjusts the length and adds people |

`hint-booking-spaces` declares `replay` (`/bookings`, label "Réservations"); the space hint has none (one
route per space). The week anchors wait for `loaded` so a help never starts on the dimmed empty grid
and a failed read (the error line) leaves both steps out; the grid keeps its anchor while a week is
loaded, so moving week does not drop a step. Pinned by `guides/batch4Hints.test.ts`. Owed on a phone:
the two read on the Mi 9T and the iPhone 12, with a one-column and a several-column space.

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
- **The spotlight follows its target WHATEVER moves it (2026-11-05).** A `ResizeObserver` sees a
  change of SIZE only, and `scroll`/`resize` listeners see neither a banner leaving, a skeleton
  replaced by a shorter block, a scrollbar appearing nor a sidebar widening: the target MOVED with
  its size untouched and the ring kept a stale box (measured in Chromium: a 120x40 button moved from
  y=50 to y=10, the ring stayed at 44 instead of 4). `guideAnchorFollow.ts` closes it with an
  `IntersectionObserver` whose `rootMargin` shrinks the viewport to exactly the target's box: any
  shift or resize drops the intersection ratio below 1, the callback fires, and the observer is
  re-armed around the new box. It is an event, not a poll and not a per-frame read; it catches moves
  by any cause (an offset ancestor, a font, an image, a grid render) without enumerating ancestors,
  which a `ResizeObserver` on ancestors plus a `MutationObserver` could not promise. Its report joins
  the same one-measure-per-frame schedule. The frame is made of the viewport size and the target's box, so a
  `ResizeObserver` on `documentElement` and on the target re-frames when the window grows (slack the
  intersection cannot see) and when a target that had no box gains one (it had no observer at all).
  A target partly off screen IS framed (a negative inset becomes a positive `rootMargin`). The real
  limit is a target clipped by an ancestor scroller: its ratio is below 1 from the start, the first
  callback re-arms on that ratio, and moves are then seen against it.
  Measured in Chromium (review of #3050): 1px moves fire in each of the four directions, on
  fractional coordinates; 0.5px moves do NOT fire; a box at top -10px reports ratio 1 and a move to
  -5px reports 0.875, which fires; a clipped target settles after 2 arms. WebKit is untested - a
  re-arm that lingers there is the residual risk, and the bench reading on the iPhone checks it.
- **The ring hugs the control**: its padding is symmetric (0.375rem on all sides, then the 2px ring),
  and its corner radius is the control's own computed radius plus that padding (concentric), capped at
  half the short side - a pill target gets a pill ring, not the fixed `--radius-lg` corner.
- Pinned by `guideAnchorFollow.test.ts` (move reported, observer re-armed), the overlay test (a shift
  with no size change moves the spotlight) and `guideAnchorSources.test.ts` (every anchor a guide
  names is marked by a control on every layout).
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
