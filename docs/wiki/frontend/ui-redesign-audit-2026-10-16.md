# UI redesign audit - which pages are on the admin-era standard, and the plan for the rest (2026-10-16)

The user, 2026-10-16: *"on a refait plein de pages (comme https://canari.emse.fr/admin, super !) mais
pas https://canari.emse.fr/dashboard, on pourrait la revoir non ? D'autres aussi ?"*

This page is an AUDIT and a PLAN. No page was changed by it. It is the starting point for the work
packages in section 5, and each of them deletes its row here when it ships.

## 1. What "redone like /admin" means

`/admin` was rebuilt in lot 3 of the section-navigation chantier (#1626), and the same shapes were then
applied to settings, profile, the association public page and its edit page. The standard is four
things, all already built and reusable. Nothing in the plan below needs a new primitive.

| Piece | Where | What it gives |
| --- | --- | --- |
| Page shell | `lib/components/layout/PageContainer.svelte` (widths from `pageWidth.ts`: reading, tool, editor), `PageHeader.svelte` | One column and one heading (`text-2xl` over `text-sm` muted), no icon in the heading, `backHref` or `crumbs` as the only back link ([design-reference 12](design-reference.md#12-the-page-shell---one-column-one-heading-no-logos)) |
| Hub of route sections | `lib/components/navigation/SectionHub.svelte` + `Breadcrumb.svelte`, with ONE table per area (`adminSections.ts`, `settingsSections.ts`, `profileSections.ts`, `editSections.ts`, `publicSections.ts`) | Grouped rows that are real links: icon, title, a summary where a count is already loaded, chevron. The same table decides the row and the route guard |
| Fixed segmented control | `lib/components/ui/SegmentedControl.svelte`, state in `?tab=` via `navigation/tabQuery.ts` | 3 or fewer short labels, equal columns, tablist semantics, no history entry |
| Controls and states | `ui/Button`, `Card`, `Input`, `Select`, `Toggle`, `Picker`; `shared/EmptyState`, `Banner`, `StatusPill`, `CardTile`, `Modal`, `ConfirmDialog` | One look for a button, a field, an empty list |

The two navigation shapes are CLOSED ([section-navigation](section-navigation.md#closed-2026-10-14---the-final-shape-do-not-reopen)).
This audit does not reopen them; it applies them to pages the 2026-10-14 inventory classified as
"no menu" and therefore never looked at as pages.

**What the code sweep cannot discriminate on.** Raw `[Npx]` values and raw hex colours are at ZERO on
every page route (one `[Npx]` in `f/[id]`), and `text-sm` / `rounded-xl` already ARE the scaled
tokens since #447. So "not redone" is never "wrong numbers" here. It is the SHAPE: hand-rolled card
grids instead of a hub, `<button onclick={goto(...)}>` instead of a link, no `EmptyState`, a filter
form occupying the first screen.

## 2. How it was looked at

- Code: every `frontend/src/routes/**/+page.svelte`, shared-component imports, raw `<button>` count,
  breakpoints, `EmptyState` use (a search pass, 2026-10-16, on `origin/main` at `990ba8fe9`).
- Screen: `dev.canari-emse.fr`, signed in as the bench account `fourth` (the `chrome-w3` profile, a
  plain member, NOT staff, holding no association), CDP device-metrics override at 390x844 (mobile)
  and 1280x900. 21 pages, two widths each, saved as `<page>-<width>.png` outside the repository
  (dev is a copy of production and the shots carry real association content). Nothing was posted,
  followed or changed.
- **Not seen: `/admin` itself.** The bench account holds no admin tier, so `/admin` redirected to
  `/dashboard` (`admin-390.png` is the dashboard). The admin standard was read from its code and from
  the pages that share it (`/settings`, `/profile`, `/associations/bde`), which were seen.
- **No usage data exists.** There is no page-view analytics on any estate. "Usage" below is a proxy:
  a place in the mobile tab bar (Feed, Communities, Chats, Dashboard) is daily; a place only reached
  from the dashboard is weekly; the rest is occasional.

## 3. The pages, classified

Legend: **REDONE** on the standard; **PARTLY** on the shell but with hand-rolled controls or a shape
problem; **NOT** neither. Size S < half a day, M about a day, L several. Priority 1 is first.

| Page | Status | What is wrong (specific) | Proposed change | Size | Risk | Prio |
| --- | --- | --- | --- | --- | --- | --- |
| `/dashboard` | NOT | A static launcher in a 2-column tile grid (`dashboard-390.png`): 4 square tiles for Profile / Settings / Theme / Logout, then 4 cards. Every tile is a `<button onclick={goto(...)}>`, not a link (no long-press, no middle-click, no prefetch). The same `rounded-2xl border ... color-mix` string is written 6 times. "Theme" duplicates `/settings/preferences`; "Logout" as a red tile is the largest target on the screen for the rarest, most destructive gesture. No count, nothing personal; Notifications, Annuaire and Documents are missing for a member | Rebuild as THE hub of the app (section 4) | M | Low: no data path, the tab is in the mobile bar so a phone look is mandatory | 1 |
| `/associations` | PARTLY | The 4 cross-page links "Associations / Listes / Institutions / Agenda global" (`AssociationsHeader.svelte`) are a WRAPPED PILL GRID on a phone, "Agenda global" alone on a second line (`associations-390.png`) - exactly the shape the chantier refused ("a wrapped grid of tabs"), missed by the 2026-10-14 inventory because the pills are links between ROUTES, not a tab state. Cards are tall (identity, description, member count) so 2.5 associations fit a phone screen; no `PageHeader` consistency with `/lists` and `/institutions`; no `EmptyState` | Move the 4 destinations into the dashboard hub (section 4) and drop the strip; or, if a strip must stay, 3 entries in a `SegmentedControl` (Associations, Listes, Institutions) with the global agenda reached from `/calendar`. Denser rows (`SectionHub`-like list: logo, name, members, chevron) | M | Low; `sectionMenus.test.ts` should learn to see route-link strips | 2 |
| `/calendar` | PARTLY | On a phone the filter card (association select + "S'abonner au calendrier" button) takes the first ~200px before any event (`calendar-390.png`). The day list itself is good. 4 raw buttons | Filter becomes one `Select` row in the header line; "S'abonner" moves to a secondary action (overflow or the bottom of the list); keep the day list as is | S | Low | 3 |
| `/directory` | NOT | A 6-field search form fills the WHOLE first phone screen; results start below the fold (`directory-390.png`). No `EmptyState`, no aria. Reachable for a member from nowhere: its only link is the admin hub's "shortcuts" group (`adminSections.ts:182`) | One search field always visible, the 5 filters in a collapsible "Filtres" sheet; results as hub-like rows. Decide (user) whether a member should reach it from the dashboard | M | Low; who may see the directory server-side must be read before linking it | 4 |
| `/forms` | PARTLY | Fine empty state (`forms-390.png`), but "Mes formulaires / Nouveau formulaire" is shown to a plain member, who does not create forms; the member's real question ("what can I fill in?") has no answer here. 5 raw buttons | Split by role: a member sees the forms open to them; creation lives under the association's edit hub | M | Medium: product decision, ask the user | 5 |
| `/forms/[id]` | NOT | 929 lines, no `PageHeader` (by design, the hero is the heading), 27 `text-sm/xs`, 16 corners, 5 raw buttons, no aria | Keep the hero; move controls to `ui/*`; a11y pass | M | Medium: the public form is reached by outsiders, look at it logged out | 6 |
| `/profile/[id]` | NOT | Another person's profile: 464 lines, 4 raw buttons, 0 `ui-*`, no aria, 15 breakpoints; it does not share the identity block of `/profile` (REDONE), so the two profiles look like two products | Factor the identity card of the own-profile hub and reuse it; rows for associations / career | M | Low | 7 |
| `/account/purchases` | NOT | "Explorer la boutique" in the empty state is plain bold text, not a button (`purchases-390.png`); hand-rolled empty box instead of `EmptyState`; a sub-page of the profile reached by `backHref` while its sibling sections live under `/profile/me/*` | Fold into `/profile/me/subscriptions` (the hub row "Cotisations et achats" already exists) or at least `EmptyState` + `Button` | S | Low | 8 |
| `/notifications` | PARTLY | Pills are a documented exception and fine; the empty state is a hand-rolled icon + line, not `EmptyState`. On a phone it is reached only through the header bell, and that bell is drawn on the Feed alone (`MobileHeader.svelte`, `{#if onPosts}`) | `EmptyState`; nothing else | S | Low | 9 |
| `/posts` | PARTLY | 1018 lines, 5 raw buttons; filters are the documented pills. It is the most-visited page and it LOOKS right (`posts-390.png`) | Leave the layout; replace raw buttons with `ui/Button` only when the file is touched for another reason | S | Medium: the feed is perf-sensitive | 12 |
| `/shop` | PARTLY (nearly REDONE) | `SegmentedControl`, `CardTile`, no raw buttons. Product card has an empty top-right area with a lone bag icon; "Autre / Gratuit / Test" reads in the wrong order | Card layout pass only | S | Low | 10 |
| `/lists`, `/institutions` | NOT | `PageContainer` only, same 4-pill strip as `/associations`; `/institutions` empty state uses an EMOJI (the classical building) as its icon, the only one in the app's chrome | Same change as `/associations`; `EmptyState` with a Lucide icon | S | Low | 2 (with `/associations`) |
| `/documents` | PARTLY | Reviewer-only; 2 raw buttons | `EmptyState`, `ui/Button` | S | Low | 11 |
| `/calendar/export`, `/forms/create`, `/forms/[id]/edit`, `/f/[id]` | PARTLY | Editors on the shell with mixed raw and `ui/*` controls | Controls to `ui/*` when touched | S each | Low | 13 |
| `/forms/cancel`, `/forms/success` | NOT | No shared component at all | `PageContainer` + `EmptyState`-like result card | S | Low | 13 |
| `/c/join/[token]`, `/g/join/[token]` | NOT (by design) | Invite landings outside the shell | Leave | - | - | - |
| `/admin/*` sub-pages: agenda, carte, cercle, platform, read-access, spaces, storage, database | PARTLY | Inside the admin shell and breadcrumb, but with raw buttons and no `PageHeader` of their own | Controls to `ui/*` page by page; staff-only, low visibility | S each | Low | 14 |
| `/settings`, `/settings/[section]`, `/profile`, `/profile/me/[section]`, `/associations/[slug]/[[section]]`, `.../edit/[[section]]`, `/lists/[slug]/...`, `/admin`, `/admin/users`, `/admin/moderation`, `/admin/status`, `/admin/legacy-cotisations`, `/admin/profile-corrections`, `/events` | REDONE | - | - | - | - | - |
| `/communities`, `/chat`, `/camera`, `/login`, `/`, `/app-shell`, `/auth/callback`, `/legal/*` | out of scope | Thin wrappers (`MainChatPage`, the camera), redirects, or legal text | - | - | - | - |

## 4. `/dashboard` - the concrete proposal

**Who uses it today.** It is the fourth tab of the phone bar, the swipe target after Chats, and the
ONLY way a phone reaches Agenda, Boutique, Associations, Formulaires and Administration (they are
`mobileNav: false` in `lib/navigation/places.ts`). On a phone it is therefore the app's MENU, the
role Facebook's "Menu" tab plays. On desktop the sidebar already carries those places, and the
dashboard is a near-duplicate of it.

**What it shows today** (`routes/dashboard/+page.svelte`, 241 lines): Account (Profile, Settings,
Theme cycle, Logout) and Explore (Agenda, Boutique, Associations, Formulaires) for everyone;
Documents for a reviewer; one Administration card for an admin tier. No data, no count, no person.
An association manager sees nothing of what they manage.

**What the admin standard turns it into** - one `SectionHub` page, rows as links, ONE table
(`lib/navigation/dashboardSections.ts`, the same shape as `adminSections.ts`: key, href, group, label,
summary, icon, `may`), so the row and any guard are one decision:

1. **Identity row** (top, full width): avatar, name, "Voir mon profil" -> `/profile`. The profile
   tile goes; the person is the entry, as on Facebook's menu.
2. **Explorer**: Agenda, Associations, Listes, Institutions, Boutique, Formulaires, Notifications
   (with the unread count the bell already holds), Annuaire (if the user decides members may reach it).
   This is where the 4-pill strip of `/associations` goes (section 3, prio 2).
3. **Mes associations** (only when the reader holds a management flag in one): one row per managed
   association -> `/associations/<slug>/edit`, summary = what is already loaded. The data is free:
   `ensureMayOpenAdmin()` already awaits `ensureMyAssociations()`, so this costs NO extra request.
   This is the manager's view that does not exist today.
4. **Administration** (only on `ensureMayOpenAdmin()`): the one row it has today, titled by
   `adminScopeLabels`. Counts of pending events or reports ONLY if an endpoint already returns them;
   no new request for a badge.
5. **Compte**: Parametres, Documents (reviewer), and Se deconnecter as an ordinary last row in the
   danger tone the settings hub already uses for "Supprimer mon compte". The Theme tile is deleted
   (it lives in `/settings/preferences`).

**Mobile first.** One column at every width (the hub rule: no rail, the same hub on desktop), rows of
44px minimum, the identity row and Explorer above the fold at 390x844. **Member** sees 1, 2, 5;
**manager** adds 3; **staff** adds 4. **Empty states**: none needed - every group is either present
with rows or absent. **Loading**: the static rows render on first frame; 3 and 4 appear when the
membership probe resolves (today's behaviour for the admin card), without shifting rows above them
(append-only groups, below Explorer).

## 5. The order of work, and what each owes

| WP | Content | Measured or looked at before merge |
| --- | --- | --- |
| UI-1 | `/dashboard` as the hub (section 4), with `dashboardSections.ts` and its test (rows per tier: member, manager, reviewer, staff) | Both phones (Mi 9T, iPhone 12): first paint of the tab, no row shift when groups 3-4 arrive, Android Back from a row, the native tab bar; 390 and 1280 in a browser |
| UI-2 | Remove the 4-pill strip from `/associations`, `/lists`, `/institutions` (destinations now in the hub), denser association rows, `EmptyState` with a Lucide icon on `/institutions`; teach `sectionMenus.test.ts` to flag a strip of route links | 320 px: nothing wraps; the global agenda is still reachable in two taps |
| UI-3 | `/calendar` filter row, `/notifications` `EmptyState`, `/account/purchases` (fold into the profile section or `EmptyState` + `Button`) | One look on a phone each |
| UI-4 | `/directory`: one field + filter sheet; decide with the user whether members reach it | The server's read rule for the directory, before linking it |
| UI-5 | `/profile/[id]` shares the own-profile identity card | Both profiles side by side at 390 |
| UI-6 | `/forms` by role, `/forms/[id]` controls and a11y, `/forms/cancel` / `success` | The public form logged OUT; a product decision first (ask) |
| UI-7 | Remaining PARTLY pages and admin sub-pages: raw buttons to `ui/*` when the file is touched | Nothing beyond the gates |

**Constraints every WP carries.** Every new string in Paraglide (`fr.json`, `en.json`) on the first
draft; scale tokens only (`--text-*`, `--radius-*`; `rounded-2xl` is 12px here); `@lucide/svelte`;
no new primitive while `SectionHub`, `SegmentedControl`, `EmptyState` cover the need; links rather
than `goto` buttons for navigation. **No regression of the phone apps**: the dashboard is a tab of
the native tab bar, so UI-1 is not done until both phones have been read. **The speed plan**: none of
this touches `/communities` or `/chat`, and UI-1 must not add a request to the dashboard's first mount
(the hub's 0.2 s first-mount budget is [community-open-budget](community-open-budget.md); the
dashboard should hold the same bar by rendering its static rows synchronously).

## 6. Questions for the user

- May a plain member reach the Annuaire (it is linked today only from the admin hub)?
- `/forms` for a member: the forms open to them, or keep "my forms" (creation) as the page?
- Logout leaves the dashboard's first screen for the bottom of the "Compte" group: acceptable?
