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
- Boutique / shop (products, Stripe checkout).
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
| `/associations/[id]` | Association detail page |
| `/associations/[id]/edit` | Admin edit (profile, members, forms, payments, boutique, cotisations) |
| `/dashboard` | Association admin dashboard |
| `/lists/[slug]` | Member list public page |
| `/lists/[slug]/edit` | Edit member list |

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
the count is a CONDITION rather than a deletion, and why `associationTileList.test.ts` reads the
markup - every one of these was valid markup that rendered without complaint.

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
