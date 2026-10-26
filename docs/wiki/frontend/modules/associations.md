# Associations module

**Routes**: `src/routes/associations/`, `src/routes/lists/`, `src/routes/dashboard/`  
**Components**: `src/lib/components/associations/`

## Responsibilities

- Browse and search association (club) directory.
- Manage association profile, logo, colors, description.
- Member management (add, roles, permissions) - the flag model and who may exercise a flag are on
  [Association permissions](../../association-permissions.md); this module renders it.
- Calendar of events.
- Document storage (PDFs, files).
- Boutique / shop (products, online checkout - [payments](payments.md#a-product-checkout-is-a-row-one-per-attempt-2026-10-21)).
- Forms with payment (see forms module for form execution; this module handles form management within an association).
- Stripe Connect onboarding for receiving online payments.
- Tag-based autocomplete for association tagging on posts.
- Cotisant (membership dues) management - see [Cotisations](../../cotisations.md).

## Key components

| Component | Role |
|---|---|
| `AssociationDetailView.svelte` | Public-facing association page |
| `AssociationCard.svelte` | Card in the directory listing |
| `AssociationMembersSection.svelte` | Member list with role display |
| `AssociationCalendarSection.svelte` | Calendar events for an association |
| `AssociationDocumentManager.svelte` | Upload/download/delete documents |
| `edit/EditProfileTab.svelte` | Edit name, description, logo, color |
| `edit/EditMembersTab.svelte` | Manage members and roles |
| `edit/EditFormsTab.svelte` | Manage forms, view pending cash submissions |
| `edit/EditPaymentsTab.svelte` | Stripe Connect setup and status |
| `edit/EditBoutiqueTab.svelte` | Boutique products (`type: 'other'`), members-only + member pricing - see [Cotisations](../../cotisations.md) |
| `edit/EditCotisationsTab.svelte` | Enable cotisation, membership price, cotisant roster (search, export, manual grant/revoke) - see [Cotisations](../../cotisations.md) |
| `edit/EditDelegationTab.svelte` | Route payments to a parent association + parent-side approval/accounting - see [Payments](payments.md#payment-delegation-parent-association-routing) |

## Routes

| Route | Description |
|---|---|
| `/associations` | Public association directory |
| `/lists`, `/institutions` | The list and institution directories (same API, narrowed by type) |
| `/associations/new`, `/lists/new`, `/institutions/new` | ONE creation flow, three types (`/institutions/new`: global admin only) |
| `/associations/[id]` | Association detail page |
| `/associations/[id]/edit` | Admin edit (profile, members, forms, payments, boutique, cotisations) |
| `/dashboard` | Association admin dashboard |
| `/lists/[slug]` | Member list public page |
| `/lists/[slug]/edit` | Edit member list |

## One header and one creation flow for the three directories (2026-10-07)

**"Mes ..." blocks live in their own tab (user, 2026-10-19).** `MyMembershipsSection.svelte` is the pinned block on top
of a directory: `/associations` draws only "Mes associations", `/institutions` only "Mes institutions", `/lists` only
"Mes listes" (one `groupAssociationsForSelect` classifier, the data `listMyAssociations` already returned). Empty blocks
are not drawn. The directory below still lists every row with the member's own one badged (the pinned-subset pattern the
Associations tab always had). Test: `routes/associations/mineBlocks.svelte.test.ts`.

Audited on 2026-10-07 after a screenshot of `/associations`: four buttons of two kinds (three links to
directories, one creation) drawn alike, and **`/institutions` had NO creation button**. What existed
before: creation was a checkbox on `/associations/new` visible to a global admin; the reach was only
editable on the `/admin/spaces` grid (`PUT /api/associations/:id/audiences`, global admin); members were
added on the generic members tab as `Membre` (0) or `Admin`, so a new institution member could not
publish in its name until a flag was ticked by hand.

Now:

- `AssociationsHeader.svelte` is the heading of the three directories. NAVIGATION is a row of outlined
  pills under the title (Associations, Listes, Institutions; the global agenda tab was removed 2026-10-18, `/calendar` stays as a route) with the current directory
  filled and `aria-current="page"`; the single PRIMARY action, yellow, sits on the title line and names what
  THAT directory creates (`Créer l'association`, `Créer une liste`, `Créer une institution`). The lists and
  institutions pages lost their "back to Associations" link: the nav carries it.
- `AssociationCreatePage.svelte` is the one creation flow, `kind = association | list | institution`; the
  three `/new` routes are three lines. A list adds campaign and parent fields; an institution adds an
  **audience choice**: none (default, D36 - visible to its members only), the whole School, one campus, or one
  campus x formation (`reachChoiceToRules` in `audienceRules.ts`; a half-filled choice yields no rule and the
  submit is disabled, never a wider reach). The rule is written right after the creation with the grid's own
  `setAssociationAudiences`, and the creator lands on the members tab of the new institution. A non-admin
  opening `/institutions/new` is sent back to `/institutions`.
- The members tab offers a third access level, `Publie en son nom` (`PUBLISHER_PRESET` =
  `POST_AS_ASSO | PROPOSE_EVENT`), which is the DEFAULT when the association is an institution.
- Test: `associationsHeader.test.ts` (wiring), `audienceRules.test.ts` (`reachChoiceToRules`). Read on the
  local estate at 390 and 1280 (no horizontal scroll, nav wraps cleanly).

## The slug is a technical id: derived by the server, never shown, typed or edited (user, 2026-10-26)

The product rule is *a technical id is never shown to, typed by, or edited by a person*. For an
association, list or institution it means: no `@slug` under the detail title (a list keeps its
parent's name), none in the edit subtitles (a list keeps its promo year), and no "Slug (URL)" field
on the shared creation flow. The slug remains the URL segment (`/associations/<slug>`) and the
unique key.

The server derives it: `CreateAssociationDto.slug` is optional, and `AssociationsService.create`
walks `slugCandidates(name)` from `association-slug.util.ts` - lowercase, accents folded, hyphenated,
at most 50 characters, then `-2`, `-3`... Each candidate is its OWN transaction and the unique index
is the arbiter (a unique violation aborts the transaction it happens in, and a check-then-insert
would let two concurrent creates both pass). A slug SENT explicitly (an old client) is still
validated and refused `400` when taken, including when it loses the race at the index.

## The audience tab and the campus prompt (WP-B, 2026-10-08)

The edit page has an **Audience** tab (`EditAudienceTab.svelte`) for a global admin and a BDE star of the association: two presets (my campus; my campus and chosen formations), a third (everyone) for an institution only, the grid link for admins. The creation page shows `ProfileCampusPrompt` instead of the form when the creator's profile has no campus, and maps the five typed server refusals through `audienceRefusal.ts`. Mechanism, limits (a star cannot read the current audience) and tests: [profiles-and-access](../../profiles-and-access.md#audiences-client-presets-as-built-wp-b-2026-10-08).


**What closed the institution creation gaps (2026-10-09).** (1) Members are NOT asked for on the creation form: the creator lands on the members tab, where `Publie en son nom` is already the default for an institution, and an institution with no member is a state of one click, not a defect. (2) An institution's reach IS editable on its own edit page: the Audience tab is drawn for a global admin (`editRights.audience`), with the `everyone` preset. (3) A union of several campuses or formations - which three presets cannot say - is the **Custom** choice: `CellPicker.svelte` (one block per campus, a parent box and one box per formation, built on the `/admin/spaces` helpers), offered on the creation form of an institution and, to a GLOBAL ADMIN only, as a fourth preset on the Audience tab of an INSTITUTION (`offeredPresets(type, gridAllowed)`); never for an association or a list, which address ONE campus (decision 3 of the audiences chantier); the rules written are `toRules(cells)`, the smallest equivalent set, and an empty picker cannot be submitted. A union already stored on an institution opens the tab on Custom with its pairs ticked. Tests: `CellPicker.svelte.test.ts`, `reachChoiceToRules('custom', ...)` in `audienceRules.test.ts`, `offeredPresets` in `audiencePresets.test.ts`.

## Promo lists, and the second theme

A list is NOT its own entity: it is a row in `associations` discriminated by `type = 'list'`, so the
entity, the DTOs, the service, the frontend types and `AssociationTile` are all shared with
associations. Four columns are list-only: `promo` (the campaign year), `parentAssociationId` (the
association that runs it, surfaced on the read side as the denormalised `parentName`), and
`name2` / `logoMediaId2` - the SECOND THEME.

**A campaign list can run two themes at once**, a public one and the one it is actually called, so
it carries two names and two logos. Migration `015_list_second_theme.sql` added both columns; they
are always optional and associations leave them NULL.

### The half that could only ever be turned off

Until 2026-09-22 `logoMediaId2` was plumbed end to end - column, entity, `Create`/`Update` DTO,
public projection, frontend type, detail-page rendering - and **nothing could set it**. There was
no upload endpoint for it (only `setLogoFromUpload`, which wrote the primary slot), and no field in
either the create or the edit form. The blank-to-NULL normalisation on update meant the value could
be CLEARED and never written, and `list_new_logo2_label` sat in both message catalogues referenced
by zero source files - an orphan key left for the uploader that was never built.

The slot is now a parameter on the one implementation (`LogoSlot = 'primary' | 'second'`, a
`?slot=second` query on `POST`/`DELETE /associations/:id/logo`) rather than a second endpoint: the
permission flag, the 2 MB ceiling, the mime allowlist, the media upload and the deletion of what it
replaces are identical, and only the column differs. Anything but the literal `second` is the
primary slot - an unknown value must never silently write the other one.

**There is no `logoUrl2`, deliberately.** `logoUrl` exists to carry a `?v=` cache-buster for the
primary logo that every tile in the app renders; a media id changes on every upload and is
therefore its own buster. `associationSecondLogoSrc` is the ONE derivation of that path, so the two
surfaces showing it - the tile and the detail header - cannot disagree.
`associations.service.logo-slot.spec.ts` pins that neither slot writes the other's column, that the
replaced object deleted is the one the SAME slot held, and that the validation is shared.

**What `logoUrl` may hold (input validation, 2026-10-22).** The upload writes
`/api/media/public/<id>?v=<n>`; the create and update bodies still accept the field, and on both the
service holds it to an allowlist - that own-media shape, or an absolute `https:` URL with no quote,
angle bracket or whitespace - and refuses anything else with `400 ASSOCIATION_IMAGE_URL_INVALID`
(`apps/social-service/src/associations/association-image-url.ts`; a blank value clears it). Migration
`106` brings any stored value outside the allowlist back to the row's own media, or clears it -
**and loses nothing silently**: each changed row's id, old value and `updatedAt` are copied first
into `association_logo_url_rewrites`, and the count is raised as a `NOTICE` in the deploy log
(`association-logo-url-migration.integration.spec.ts` runs it against PostgreSQL). The deploy applies
migrations by itself (`infrastructure/lib/migrations.sh`), so releasing it IS applying it. Its SQL
patterns are at least as strict as the reader, not a byte-for-byte copy of the writer (which also
parses the URL). The reader's half is `imageSrcOrNull` (`frontend/src/lib/utils/imageSrc.ts`), called
by `associationLogoSrc`: only a path or an http(s) URL is ever drawn, and a dropped value is said
through `Log.i`. The two export sheets built as HTML strings (`calendarExport.ts`, `trombinoscope.ts`)
escape every interpolated value, attributes included, through the one `escapeHtmlAttribute`
(`frontend/src/lib/utils/escapeHtml.ts`). In the trombinoscope, a photo that does not load shows
initials (`showInitialsInstead`).

### What a list's card says, and what it stopped saying

Three changes, all of them about not repeating what the page already states (user, 2026-09-22):

| Was | Now | Why |
| --- | --- | --- |
| a "Liste 2026" pill on every card | gone | the shelf heading above it is already `Campagnes 2026` |
| `N membres` on every card | associations only | a list's card is read to find a campaign, and "0 membres" on a list whose members are not registered yet answers nothing |
| the second theme visible only on the detail page | on the card, small, under both main ones | `sm` (24px) against the main `lg` (48px), muted label |

The archived and "Membre" notes stay on both kinds, because they answer something the shelf does
not; the middot separator belongs to the count, so a list prints the note without one.
`AssociationTile` is shared by five call sites across `/associations` and `/lists`, which is why
the count is a CONDITION rather than a deletion. `AssociationTile.render.svelte.test.ts` MOUNTS the
tile for each of these (it read the markup's spelling until WP-T5, 2026-10-18,
[test-suite-reform](../../test-suite-reform.md)) - every one of them was valid markup that
rendered without complaint.

### What the detail header says, and the space a compiler kept eating

Two defects reported together on 2026-09-23, both visible in one screenshot of `/lists/minestagnard`.

**`BDE - Bureau des Eleves ·@minestagnard`, and `Mines'tagnard& Mines'diana Jones`.** Neither was a
typo. Svelte removes the whitespace at the end of an `{#if}` block and at the start of an element's
content, and the header had one of each: the space after the middot was the last thing inside the
parent-name block, and the space before `&` was the first thing inside the second name's `<span>`.
The source showed a space in both places; the emitted code did not, which `compile(src, { generate:
'server' })` prints in seconds. The meta line is now a `flex` row whose separators are its own
children, so the spacing is `gap-x-1.5` - the box model cannot be trimmed by a compiler, and the row
still reads correctly when the parent name is absent. The rule is in
[durable-rules](../../durable-rules.md).

**Each logo now sits with its own name.** Both logos shared one `lg` row while both names shared the
`<h1>`, so `logo1 logo2 / name1 & name2` asked the reader to cross the pairing over (user: *"ce n'est
pas logique d'avoir logo1 puis titre1 et titre2 puis logo2"*). The second theme is the subordinate
row `AssociationTile` already draws - an `sm` avatar beside its own name, under the main pair - so
the card and the detail page now state the same thing the same way, and the `&` shape that needed a
space in markup is gone. It renders when EITHER half is set, matching the tile: a list can be renamed
before its second logo is uploaded, or the reverse.

**The member count left the header** (user, same day). The members tab states it, and on a list it
read "0 membre" for a campaign whose roster simply is not registered yet - the same reason the card
stopped printing it on 2026-09-22. `asso_header_member_count` had no other caller and was deleted
from both catalogues. `Campagnes 2026` became a pill rather than the tail of a run of middots.

**Portail-etu carried both defects identically** and took the same fix (`EntityDetail.svelte`,
`AssociationCard.svelte`), plus one of its own: its `<h1>` tested `name2` alone while its logo row
tested `name2 && logoMediaId2`, so the two halves of the same header disagreed about whether a second
theme existed, and a list renamed before its logo was uploaded lost the logo. Its cards did not show
the second theme at all; they do now.

### The two orderings of the directory, and the grouping that lasted one day

`/lists` shelves by campaign year, most recent first, `promo`-less lists last under "Divers". The
year is the ONLY heading, and inside a shelf the lists are ORDERED by parent association then by
their own name, the parentless ones last - **one grid per year, never one grid per parent**.

The parent was a second GROUPING level on 2026-09-22 and was undone the next day: with two lists
per association, each group opened its own `CARD_GRID` and spent a full row on two cards, leaving
most of the width blank (user: *"enorme espace vide... c'etait plus les organiser en les ordonnant,
pas en les regroupant"*). A sort buys the same adjacency for nothing, and the sub-heading was a
duplicate anyway - every card already prints its `parentName` above its title, the same redundancy
that removed the per-card year pill under the year heading.

`buildCampaignShelves` (`lib/associations/listShelves.ts`) is the whole of it, with both orderings
total so the same data cannot render two ways, and both asserted apart in `listShelves.test.ts`.

## Permissions

Permissions are checked at the component level using the `X-Global-Admin` header and association-level role flags injected by Nginx. The key flags are:

- `MANAGE_MEMBERS` — add/remove members, edit roles
- `MANAGE_ASSO` — edit profile, create products, manage forms
- Global admin — can do everything

## Stripe Connect

Associations that want to accept online payments must complete Stripe Connect onboarding. The `EditPaymentsTab.svelte` component handles:

1. Starting onboarding (`POST /api/payments/onboarding`).
2. Checking status (`GET /api/payments/connect-status/:associationId`).
3. Displaying the Stripe Dashboard link for reporting.

Forms with `basePrice > 0` show a warning if Connect is not yet configured.

## An institution is not called an association (2026-10-07)

The edit page is shared by the three kinds and said "association" to an institution in the tab title,
the Danger tab, the delete confirmation and the Lydia card, and sent a deleted institution to
`/associations`. `lib/associations/kindWording.ts` is now the ONE table of nouns per kind
(`association | list | institution`: edit title, danger panel, Lydia card, the directory to land on
after a delete); components call `wordingFor(kind)` and never ternary over a sentence
(`EditDangerTab` takes the full `AssociationKind`, the Lydia form reads `asso.type`). A new kind is a
new row, and `kindWording.test.ts` fails if an institution sentence says association or club.
The document title cannot come from the path (`/associations/<slug>/edit` does not say the type), so
the page hands it to `SeoHead` through `lib/seo/pageTitle.svelte.ts`, which stays the only writer of
`<title>`. Lists already redirected to `/lists`. A title set AFTER the navigation is not heard by
SvelteKit's hidden route announcer, which copies `document.title` at the navigation only: a page
whose answer arrives later announces it ITSELF, through its own polite status region present from
the first frame. The payment return does (`role="status"` on its heading and sentence only, the icon and the link
outside it) - the announcer read
"Verification du paiement..." over "Paiement introuvable" (iPhone 12, v1.2.9-alpha.4). Making the
router re-read the title by a shallow `replaceState` was refused in review: it rewrites the history
entry, notifies every page-store subscriber, and throws before the router has started.

### The tab title on a DIRECT load, and three sentences that still said "association" (2026-10-07, dev read)

Direct load of an institution's edit page read "Associations" in `document.title` and `og:title`:
`SeoHead` merges the server-injected head LAST, and the server resolved the path to the generic
`/associations` title, so it beat the page's own `pageTitle` hand-off (in-app navigation was right,
nothing was injected). `serverSeo.ts` now has an enricher for `/associations/<slug>/edit`
(`ASSOCIATION_EDIT_PATH`, exported from `resolve.ts`): it reads `type` from the public association
projection and returns `wordingFor(type).editTitle()` - the SAME row the page reads, so the two
cannot disagree. The edit path is `noindex` in `resolveSeoForPath` (it was crawlable under the
generic title). An unknown slug keeps the path's association wording; no kind is ever guessed.
`kindWording.ts` also carries `manageButton`, `descriptionPlaceholder` and `boutiqueSubtitle` now
(the public-page button, the Profil placeholder, the Boutique intro). Tests: `serverSeo.test.ts`,
`kindWording.test.ts`.

### The post composer filed an institution among the clubs, and its member could not find it (2026-10-14, prod)

Reported by a member of the `Représentants de promotion ICM` institution: *"je ne vois pas
l'institution quand je veux publier un post en tant qu'elle"*. **Nothing refused it.** Prod
(read-only, 2026-10-14): his membership holds `permissions = 1823` (`POST_AS_ASSO` included, the
publisher default of an institution), every one of the institution's 12 members holds
`POST_AS_ASSO`, and the edge log shows the composer's `GET /api/associations?scope=all` (the
global-admin branch of `listPostAsAssociations`, `lib/posts/postIdentity.ts`) answered `200` nine
minutes after the institution was created, so the row WAS in the picker. It was filed under
**"Associations"**: `groupAssociationsForSelect` split the kinds on `type !== 'list'`, so an
institution sorted alphabetically among 47 associations (16 of them archived) under a heading that
names what it is not - 30-odd rows down for a global admin, who is offered the whole catalogue.
The same split fed every association picker (calendar filter, event form, parents, Cercle admin,
role history, `CoOwnerPicker`).

`lib/associations/selectGroups.ts` now has FOUR groups and one display order,
`associationSelectGroups`: **Institutions** (`asso_select_group_institutions`), Associations,
Listes, then **Archivées** (`asso_select_group_archived`, user, 2026-10-14) - every archived row
whatever its kind, out of its kind's group, still choosable and drawn `text-text-muted` (the
`muted` flag of `PickerOption`, and `group.muted` in `CoOwnerPicker`). An empty group is dropped.
`associationPickerOptions` and `CoOwnerPicker` both read it, so a new kind is one row there. Tests:
`selectGroups.test.ts` (mutation-checked against the old two-way split and against an archived row
left in its kind).

**Archived stays SELECTABLE because the server accepts it.** `POST /api/posts` checks
`canPostAs` (`apps/social-service/src/posts/posts.controller.ts`, then
`AssociationsService.canPostAs`): `POST_AS_ASSO` via `mayAct`, then only that the row EXISTS -
`archived` is never read. Only a global admin meets an archived row here, since
`/associations/me/list` filters them out. If archived associations are ever to be refused as
authors, the refusal goes in `canPostAs` first and the group turns `disabled` with a reason in the
same change - the picker must never offer what the server refuses, nor hide what it accepts.
