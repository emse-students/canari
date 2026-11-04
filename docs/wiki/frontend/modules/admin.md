# Admin module

**Routes**: `src/routes/admin/`  
**Components**: `src/lib/components/moderation/`

## Responsibilities

- Platform configuration (maintenance mode, minimum client version).
- Content moderation (post reports).
- User management (global admin only).

## Access control

**`/admin` is not one permission, it is four tiers sharing a shell.** The layout decides who gets in
and which items appear; every page repeats its own check, because a route is reachable by URL.

| Tier | How the client knows | Source |
| --- | --- | --- |
| Platform administrator | `isGlobalAdmin()` | `X-Global-Admin`, injected by nginx from `auth_request` |
| BDE super-admin | `isAssociationSuperAdmin()` | `MANAGE_ASSO` in a BDE association |
| Content moderator | `isContentModerator()` | `MODERATE` in a BDE association |

These are "in the BDE of at least one space": they decide which ADMIN PAGES open. A control on ONE
association or ONE event is scoped (WP6c step 2) and reads elsewhere: the per-association BDE
powers from `getMyBdeReach()` (`GET /api/associations/me/bde-reach`), and each pending event's
validate / reject buttons from its own server-computed `canValidate` on `/admin/agenda`
([association-permissions](../../association-permissions.md#wp6c-step-2-a-bde-governs-the-associations-its-spaces-reach-2026-10-04)).

The BDE-derived capabilities all come from **one** membership request, `ensureMyAssociations()`,
which publishes their flags as a side effect. It is awaited rather than probed in the background
wherever it decides a REDIRECT: a background probe bounces the very user it was meant to admit
whenever it loses the race.

**WHO MAY OPEN `/admin` IS ONE PREDICATE, `ensureMayOpenAdmin()` in `lib/admin/access.ts`.** It
admits only accounts with at least one actionable admin panel: platform admin, BDE super-admin,
content moderator, or event validator. A plain association admin no longer gets a read-only pending
agenda route, so the shell refuses that account as well. `access.test.ts` pins these cases.

## Routes, and who reaches them

| Route | Section | Who |
| --- | --- | --- |
| `/admin` | Home (cards) | Any BDE super-admin, content moderator, event validator, or platform admin |
| `/admin/agenda` | Pending agenda events | BDE event validator (`VALIDATE_EVENTS`) or platform admin; a BDE sees and decides the events of the associations its spaces reach (`canValidate` per row) |
| `/admin/moderation` | Reports, hidden posts, mutes | Content moderator or platform admin |
| `/admin/read-access` | Two tabs: named readers (platform admin only) and public-document reviewers ([below](#read-access-adminread-access)) | BDE super-admin (reviewers tab only) or platform admin |
| `/admin/carte` | Carte de la Vie Asso | BDE super-admin or platform admin |
| `/admin/spaces` | Every association, list and institution (searched, filtered, paged), its spaces, the BDE star, and the create form ([below](#the-catalogue-and-the-create-form-adminspaces-owner-2026-11-02)) | Platform admin |
| `/admin/platform` | Maintenance, minimum client version | Platform admin |
| `/admin/users` | User list, admin flag | Platform admin |
| `/admin/status` | Presence and connections | Platform admin |
| `/admin/cercle` | Cercle top-up product | Platform admin |
| `/admin/storage` | Storage usage | Platform admin |

**The way in is the dashboard's Administration row** (`lib/navigation/dashboardSections.ts`), shown on exactly the predicate the layout admits on, plus a
direct link to `/admin/agenda` from the calendar for users who can validate events. Nothing else
links into this tree.

**AND IT IS NOT CALLED "ADMINISTRATION" FOR EVERYONE.** For anyone who is not a platform admin,
`/admin` contains only panels the current account can act on. The pending listing and its calendar
entry are limited to BDE event validators or platform admins; ordinary association admins are not
given a read-only queue whose validation actions they cannot execute.

`adminScopeLabels(isGlobalAdmin())` returns the heading **and** the sentence under it, together,
from one predicate - a heading and its subtitle that branch separately are two places to change and
one to forget. The description was already truthful ("Moderation de l'agenda de vos associations"),
so the heading follows the description rather than the description being questioned. The same pair
titles the dashboard row and its group, which is why `dashboard_admin_heading`, `dashboard_admin_generic_label`
and `dashboard_admin_generic_desc` are gone: three keys saying "Administration" where two already
said the truth.

For a BDE super-admin the non-global wording **under-promises** - they also hold the reviewer grants
and the cartography, both named by the "Communaute" group in the nav. That is deliberate:
under-promising is not the defect being fixed, and splitting a third tier is a question the user has
not been asked.

**A tier without its screen is a right nobody can exercise.** `/admin/moderation` was gated on
`isGlobalAdmin()` in three places at once - the nav item, the home card and the page's own redirect -
while the server had `MODERATE` accepted on the reports, mutes and comment endpoints. A BDE holding
the flag could reach none of it, and the whole tier was reachable only by someone who already knew
the URL. Whenever a permission is added to a server-side check, the matching screen is part of the
same change.

## Read access (`/admin/read-access`)

Two unrelated access lists, one tab each (`SegmentedControl`, `?tab=readers|reviewers`). A BDE
super-admin sees the reviewers alone, with no tab bar: the named readers are a platform admin's (D24,
[profiles-and-access](../../profiles-and-access.md#nominative-read-grants-as-built-wp-c-2026-10-08)).

**ONE TEMPLATE FOR BOTH (user, 2026-10-16: "uniformiser, rendre plus clair").** `components/admin/access/AccessSection.svelte`
draws each tab in the same order: a one-line summary with the full explanation behind "En savoir
plus", a person search with ONE primary `Button` (never drawn disabled - with nothing picked it focuses
the field), the list as cards or the shared `EmptyState`, and the journal folded under the list as a
`<details>` whose summary carries the count (`Journal (n)`). `ReadAccessPanel` and
`DocumentReviewersPanel` own the data; `lib/admin/readAccess.ts` holds the pure part (cell keys, the
grouping of a person's cells, the reviewers' journal).

The decisions, taken by the user on 2026-10-16:

- **Named readers are cards, not a grid.** The person x (2 campuses x 6 scopes) table could not fit a
  phone. A card lists what the person reads as chips grouped by campus (`ReadGrantCard`), and
  "Modifier" opens a sheet (`ReadGrantSheet`, the shared `Modal`: bottom sheet on a phone, focus
  trap, Escape, Back) with one checkbox group per campus. "Ajouter" opens the same sheet for the
  picked person; they get a card once they hold a cell.
- **Every change saves at once and offers "Annuler" in a toast** (`showUndoToast`, 6 s; the toast
  store gained an optional action button). There is no undo endpoint: undo is the INVERSE call.
  For a reader cell that is `PUT /read-grants` with the opposite state, journalled by the server like
  any change. For a reviewer it is `POST`/`DELETE /document-reviewers`, so **a removal undone is a
  new grant, dated now and authored by whoever undid it**. The undo itself offers no undo.
- **Removing a reviewer asks first** (`showConfirm`, danger) and the button carries its word
  ("Révoquer"), not a bare trash icon.
- **The reviewers' fold is labelled for what it is, "Accès en cours (n)"**: the server keeps no
  history for that capability, only the grants in force (who authorized whom, when), so a removal
  leaves no trace and a line says so. The readers' "Journal (n)" is the server's append-only
  `read_grant_journal`, of which `GET /read-grants` returns the latest `JOURNAL_PAGE` (200) lines:
  a full page reads "200+" (`journalCountLabel`; a test reads the server constant).

**What the review of #1957 fixed (2026-10-16).**

- **RE-READS ANSWER IN ANY ORDER.** Tick A then B: A's re-read, sent before B was written, could
  land after B's and draw B unticked while the server held it - and the next click REVOKED it.
  `loadGrants` numbers each re-read when SENT and drops an answer older than the one on screen; a
  write's optimistic overlay goes once its own re-read returns, by which point the screen shows that
  answer or a newer one.
- **Inside the sheet's focus trap a keyboard cannot reach the toast**, so the last change and its
  "Annuler" are also a row in the sheet; a failed save is said in the sheet, not on the dimmed page.
  That row goes only into the sheet of the person changed: a write landing after its sheet closed
  (another person's may be open) keeps its toast and draws nothing in the sheet on screen.
- **A box being saved is `aria-disabled` + `aria-busy`, dimmed with a spinner - never `disabled`**,
  which drops focus to the page body behind the sheet; a click on it is put back. An undo that meets
  a write still in flight for that cell or person says so in a toast instead of doing nothing; the
  reviewers' writes are tracked per person, so an undo for one never waits on an add for another.
- **A failed add keeps the person in the search field** (`onAdd` answers whether it succeeded).

**"Voit les commentaires", one switch per person (owner, 2026-11-04: "un truc clair et propre, le
plus user-friendly possible").** At the foot of the same sheet, under the campuses: the shared
`Toggle`, labelled "Voit les commentaires", with ONE line under it saying what the reader will and
will not see in its current state (OFF: reads the posts and reacts, without the comments or who
reacted or voted; ON: reads and writes the comments, sees who reacted or voted). OFF is the default,
for every named reader already there too. It saves at once and offers "Annuler" like a box
(`PUT /read-grants/comments`, the inverse write as undo, journalled `cmt_show`/`cmt_hide` and drawn
in the journal in words); while it saves it is `busy` (the `Toggle`'s new prop: `aria-busy` +
`aria-disabled`, a click does nothing - never `disabled`, for the focus-trap reason above). The card
says the state in one muted line under the chips. What it changes for the reader, and why:
[profiles-and-access](../../profiles-and-access.md#nominative-read-grants-as-built-wp-c-2026-10-08).

Tests: `readAccess.test.ts` (grouping, "200+", the server's page size), `ReadGrantCard.svelte.test.ts`
(chips), `ReadAccessPanel.svelte.test.ts` (save at once, undo = inverse write, the re-read race -
checked to FAIL with the sequence guard removed - busy box, undo in the sheet, failed save inside
the sheet, the folded journal and its cap), `DocumentReviewersPanel.svelte.test.ts` (confirmation,
undo re-grants, the in-force label, a failed add keeps the person picked and the field clears only
on success - checked to FAIL when the field clears unconditionally; the readers' "Ajouter" opens
the sheet, then clears; `src/test/pickUser.ts` picks through the real search), `routes/admin/read-access/page.tabs.svelte.test.ts` (two tabs
for a global admin, the reviewers alone and no read-grants request for a BDE super-admin, the hub
for anyone else). The comments switch: `ReadGrantCard.svelte.test.ts` (the state line),
`ReadAccessPanel.svelte.test.ts` (OFF by default with its line, saves at once, undo = inverse
write, a click while busy is put back and sends nothing, a switch line of the journal in words).

## The catalogue and the create form (`/admin/spaces`, owner 2026-11-02)

**The platform admin reaches EVERY entity here, member or not.** The page reads
`GET /api/associations/admin/catalogue?type=&q=&after=&limit=` (`AdminAssociationsController`, guarded
`NginxAuthGuard` + `GlobalAdminGuard` + a per-user throttle), never the reader's directory. A BDE is
refused here: its `MANAGE_ASSO` creates through `POST /associations`, in its own campus
([association-permissions](../../association-permissions.md#creating-an-entity-two-routes-two-tiers)).

- **Every row has two links**: the public page and the management hub, both under the base of its kind
  (`entityBase`: `/lists` for a list, `/associations` otherwise). The management page admits a non-member
  platform admin (`canEdit = isGlobalAdmin() || ...`, then `editRights`, which reads `isGlobalAdmin`
  first). The zero-member audit of 2026-11-02 read every tab and found no tab that needs a membership.
  Every row also shows its member count, so an empty entity reads "0 membre".
- **Search, type filter, keyset pages.** One request per visible kind, ordered `(name, id)` and paged on
  that pair (`(a.name, a.id) > cursor`). A page costs the same at any depth, and a row created meanwhile
  never shifts the next page. The search runs on the server, over the name or slug, ignoring case
  AND accents ("ecole" finds the name with its acute accent). The fold is `foldSql` in
  `search-fold.ts`, a `translate` table. It is not `unaccent`: no social-service migration installs that
  extension, only core-service creates it at boot. Search answers are numbered when sent, so an
  answer older than the one on screen is dropped. "Afficher plus" asks with the cursor the last page
  gave AND the query that cursor was read for. A cursor is a position in one result set, so a click
  during the search pause never mixes the old cursor with the new query. A cursor the server did not
  write is the typed `ADMIN_ASSOCIATION_BAD_CURSOR`, never a 500: a malformed shape, an id that is not
  a UUID, and a NUL are all refused this way. Each row carries its audience rules, which
  replaced the whole-table `GET /api/associations/spaces/audiences` read (kept for old builds,
  [legacy-compatibility](../../legacy-compatibility.md)).
  Measured 2026-11-02, read-only: production holds 97 entities (49 associations, 44 lists, 4
  institutions; 49 of them already have no member), dev holds 10. The paging is there so that the
  count does not matter.
- **The governor star and the reach box are two axes** (reform 2.5, WP-D1). The star designates a
  space's governor - an association, or an institution (D3), never a list - and since WP-D1 writes no
  audience rule; the reach box beside it is a box like any other, a governor's included. A refused
  designation is worded by its typed code (`dependencyRefusalMessage`).
- **The Dependencies panel** (`AdminDependenciesPanel.svelte`, `GET`/`PUT
  /api/associations/spaces/dependencies[/:id]`, reform 2.7): each BDE with the entities that depend on
  it, then the entities attached to a non-BDE (orphaned), those with no BDE, and the institutions,
  apart; each mismatch of 2.5 beside its entity. A platform admin changes a parent, and a list's
  display label (G3), here; the server journals it and refuses what the two-level rule forbids. The
  panel reads the axis again after every governor designation (`revision`). The arrangement is
  `groupDependencies` (`$lib/associations/dependencies.ts`), which puts every entity in exactly one
  group.
- **The create form** (`AdminEntityCreateForm.svelte`, `POST /api/associations/admin`) asks for exactly
  four things:
  - a name;
  - a kind;
  - its spaces (`CellPicker`, written as `toRules(cells)`);
  - an OPTIONAL first admin, picked from the accounts and given `firstAdminPresetFor(kind)`. It carries
    NO role: the row takes the column's default, like any member added without a title. A label
    typed by this code would be a locale string stored as data. This is
    the kind's admin preset, except for an institution. **An institution's members are managed by
    the platform admin only** (owner, 2026-11-02), so its first admin never holds `MANAGE_MEMBERS`.
    The server refuses that bit on an institution with `ADMIN_ASSOCIATION_INSTITUTION_MEMBERS_PLATFORM_ONLY`
    (400, rolled back with the row), and never strips it silently - the same rule and code as every
    member write, judged in `insertMembership`, the one member writer. `MANAGE_MEMBERS` also gates the profile, the logo
    and the tags (`PATCH :id`), so the platform admin keeps those as well.

  **The default is no member at all, and the creating admin never becomes one.** Logo, description and
  cotisations stay on the management page. The server writes the row, its rules and the first admin in
  ONE transaction, through `AssociationsService.create` with a placement: no second creation path
  exists. A first admin that names no account is the typed `ADMIN_ASSOCIATION_FIRST_ADMIN_UNKNOWN` and
  leaves no row behind. An `everyone` rule on an association or a list is refused with
  `AUDIENCE_EVERYONE_INSTITUTION_ONLY`, as on every audience write. The explicit spaces replace the
  creator-campus default, so a platform admin with no campus on their profile can still create.
- **The slug preview is the server's answer** (`GET /api/associations/admin/slug-preview?name=`,
  `previewDerivedSlug`). It walks the same `slugCandidates`, skipping a taken slug or a cotisation-stem
  collision, so `-2` and `-3` appear as the create would take them. It reads every stem ONCE
  (`stemCollidesElsewhere`, where a slug is its own base stem) and ASKS the same predicate the create's
  `assertCotisationStemFree` applies. It never catches that refusal, which would WARN on every
  keystroke for a collision nobody committed. A test asserts that a preview logs no warning, and a
  control that catches the refusal again fails it. It is asked once the name has
  rested for 300 ms and is numbered like the search. The create stays the authority: a concurrent
  create may move the slug on by one suffix, and the link follows what the create answered.

Tests:
- `admin-create.integration.spec.ts` (PostgreSQL): no member; a first admin; an unknown admin rolls the
  row back; `-2`, with the preview naming it first; the stem walk; explicit spaces; the `everyone`
  refusal; a BDE `MANAGE_ASSO` holder refused; keyset paging over tied names, search and counts; a forged
  cursor. A control removing the platform-admin check and loosening the keyset to `>=` fails two cases.
- `admin-associations.controller.spec.ts`: the guards, and the one creation call.
- `AdminEntityCreateForm.svelte.test.ts`: the preview and the stale answer it drops, which a control
  without the guard fails; the default with no member; the spaces and the first admin's preset; a typed
  refusal; a blank name. `editSections.test.ts`: `firstAdminPresetFor` (no `MANAGE_MEMBERS` on an
  institution) and `entityBase`. The integration file also refuses an institution first admin holding
  `MANAGE_MEMBERS`.
- `page.catalogue.svelte.test.ts`: both links per row and the member count; "show more"; the server
  search; the type filter; opening the form.
  - A search answer older than the one on screen is dropped.
  - "Show more" during the search pause asks with its cursor's own query.
  - A control without each guard fails its test.

## Cercle top-ups (`/admin/cercle`)

The Cercle recharge is configured here, not in an association's boutique. The page is a
beneficiary-association selector (Le Cercle preselected by slug) over **one** `balance_topup`
product: amount bounds, webhook URL, webhook secret. It is not a product catalogue - a recharge
exists once per beneficiary, so the shape is imposed rather than offered: the buyer picks the
amount (`allowCustomAmount`, no fixed price) and the server forces `allowRepeatPurchase` with both
purchase caps cleared, a top-up being repeatable by nature and impossible to exhaust. Failed
webhook deliveries are listed below, each retryable **or deletable** - deletion is for a top-up
already settled by hand on the Cercle side, where a retry would credit it twice. Creating or
updating a `balance_topup` product requires a **global admin** - enforced server-side in
`products.service.ts` (D7), not merely by this route's `isGlobalAdmin()` guard. See
[Cotisations](../../cotisations.md) for the product model.

**This page has no test button, and that is deliberate.** It used to carry one that credited 5 EUR
to the pressing admin's own Cercle account through the production path on a synthetic
`pi_canari_test_` intent. It was removed on 2026-08-28: it moved a real balance on another system
and left a real accounting row, so it was a credit wearing a test's name. The link is exercised by a
real purchase, and read back from the delivery list below.

## Platform configuration (`/admin/platform`)

Fetches and updates `GET/PATCH /api/users/admin/platform`:

| Setting | Description |
|---|---|
| `maintenanceEnabled` | Show maintenance gate to all non-admin users |
| `maintenanceMessage` | Custom message shown during maintenance |
| `minClientVersion` | Minimum app version; older clients are blocked until they update |

On save, the frontend also triggers `refreshAppVersionCheck()` to apply the new version gate without reload.

> **`minClientVersion` is now the only thing that interrupts a user.** Since the store release there
> is no optional update prompt at all - a client merely behind the deployed version is told nothing,
> because the store updates people by itself and a modal on every launch was pure friction. The
> version is available passively in the "A propos" block of `/settings`. Raising this field is
> therefore the whole escalation ladder in one step: it blocks the app outright
> (`PlatformGateOverlay`, `shouldBlockSessionUnlock`) and offers the store as the only way forward.
>
> **Raise it only once the store rollout has actually reached devices.** The gate is enforced the
> instant it is saved, while a Google Play review plus rollout takes days and an App Store review
> longer - set it to a version nobody can install yet and every mobile user is locked out with a
> button that leads to a store still serving the old build. The safe sequence is: ship, wait for the
> new version to be live on both stores, then raise the minimum.

The destination of that block is resolved at runtime, not from configuration - see
[mobile](../mobile.md#where-an-update-comes-from) for why a sideloaded Android install must never be
sent to Google Play.

## Moderation

Three tabs, open to a content moderator (BDE `MODERATE`) or a platform admin - the same tier every
endpoint behind them accepts:

| Tab | Reads | Acts |
| --- | --- | --- |
| Reports | `GET /api/moderation/reports` | review/dismiss, hide the post, delete it, delete a reported comment, mute the author |
| Hidden posts | `GET /api/posts/hidden` | unhide, delete, mute |
| Muted users | `GET /api/moderation/muted` | unmute |

**There is ONE report store.** `content_reports`, written by `POST /api/moderation/reports` and read
by this queue. A second one existed until 2026-08-27 - a `reports` JSONB column on `posts`, written
by `POST /api/posts/:postId/report` and read by `GET /api/posts/reported` - and **neither end had a
caller**, so no report ever went there: 112 posts on production, 0 with a row in it. Both routes and
the column are gone. The queue also takes reports on a PERSON (`contentType: 'user'`), previewed by
display name. [Reporting and blocking](../../moderation-and-blocking.md)

## User management

Global admins can list all users (`GET /api/users/admin/list`) and toggle admin status (`PATCH /api/users/:id/admin`). An admin cannot revoke their own admin flag.
