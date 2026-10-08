# Section navigation - going deeper instead of showing every tab (design, 2026-10-08)

Requested by the user on 2026-10-08, after reading both existing patterns on a phone: *"Le but n'est pas d'avoir des menus caches"*, and *"on navigue en profondeur"*, like a file explorer or Android's Settings, with at most a path (`Associations > BDE - Bureau des Eleves > Partenariats`).

## State (2026-10-08)

**Lot 1 SHIPPED: the shared foundation and the edit page** (`routes/associations/[slug]/edit/[[section]]`). User decisions of 2026-10-08: scope is EVERY menu in the app, in lots; **no persistent rail on wide screens** (the same hub as on a phone - this supersedes point 4 below); the path A > B > C has EVERY crumb clickable, the last being the title, and the back arrow is the previous crumb; hub rows carry icon, title, a summary where a count is already loaded (members) and a chevron.

What exists now, to reuse in the next lots:

- `lib/components/navigation/Breadcrumb.svelte` (+ `breadcrumb.ts`: `previousCrumb`, `foldedCrumbCount`, the `HubRow` type): arrow, then the path; on a phone the middle folds behind an ellipsis, a wide screen shows it all. `PageHeader` takes `crumbs` in place of `backHref`.
- `lib/components/navigation/SectionHub.svelte`: rows as real links (`data-hub-row`), no strip so no `data-swipe-nav-ignore`.
- `lib/associations/editSections.ts`: the section keys, `editRights`, `mayOpenEditSection` (the ONE rule the hub and the route both ask), `editTrail` (the path, hence the Back behaviour of every level), `editSectionHref`.
- `[[section]]/+page.ts` redirects `?section=<key>` (notification deep links, the form-creation return, the post-creation landing) to the segment, an unknown name to the hub. The three producers now write the segment themselves.
- **The permission gap is closed**: a typed `/edit/danger` used to open whatever `EDIT_SECTIONS` allowed; the page now sends a section its reader may not open back to the hub once the roster is known (the server was already the authority on every write). Tested in `editSections.test.ts`.
- `seo/resolve.ts` `ASSOCIATION_EDIT_PATH` accepts the segment.
- Back behaviour is pinned per level (section -> hub -> public page -> directory) by `editSections.test.ts` and `SectionNavigation.svelte.test.ts`. `frontend/` has no Playwright setup, so the router-level reading (browser Back, reload on a section, an Android hardware back) is a **manual check owed on both phones**.

**Left, by occurrence** (inventory 2026-10-08): `AssociationDetailView` (5 tabs, scrolling row; the `?section=` it reads for itself, `calendar&fromPost=` included), `routes/lists/[slug]/edit` (its own 3-tab strip, `list_edit_sections_aria`), `routes/admin/+layout.svelte` and `AdminNavGroup` (groups/dropdowns), `ChannelSettingsPanel`, `SidebarCommunityAdminPanel`, and `routes/admin/moderation` and `legacy-cotisations` (local tab state).

## What exists (measured 2026-10-08)

No tab set in the app is a route or a history entry; state is local `$state`, Back leaves the page. There is no shared Tab component and no breadcrumb component. Two patterns the user rejects:

| Pattern | Where | Defect |
| --- | --- | --- |
| Scrolling row | `AssociationDetailView.svelte` (up to 5 tabs), `ChannelSettingsPanel`, `SidebarCommunityAdminPanel`, `routes/admin/+layout.svelte` | Tabs past the edge are unreachable and nothing says they exist |
| Wrapped grid | `routes/associations/[slug]/edit/+page.svelte` (12 keys, permission-gated) | Takes half of a phone screen, never retracts |

Small sets that fit (shop 2, moderation 3, notifications 2, posts feed 3, media panel 3) are NOT the problem.

## The target

1. **A hub screen** lists sections as rows (icon, label, one-line summary, chevron), the way Android Settings does. Tapping a row goes to that section's own screen.
2. **A section is a ROUTE segment**: `/associations/[slug]/[section]` and `/associations/[slug]/edit/[section]`. Back goes up ONE level, a reload keeps the place, a link can be shared. `?section=` (notification deep links `republications`, `payments`, the "create a form" return flow) redirects to the segment.
3. **A path in the header**, one component, truncating the middle on a phone, the last crumb being the title. The back arrow is the previous crumb.
4. **Wide screens** (>= `lg`) keep a persistent left rail with the SAME entries: one information architecture, two presentations. A rail has room; a phone does not.
5. **A set of 3 or fewer short labels that fits at 320 px stays a segmented control.** Over that, it is a hub. This is the rule that ends the third pattern appearing.

## Order

1. The edit page (12 sections, the worst). 2. `AssociationDetailView` (5). 3. The admin layout. 4. Panels only if a reading shows a clipped strip.

## Traps already found

- **The edit page renders a requested section its user may not see**: `editSection` is validated against the static `EDIT_SECTIONS`, not against the `canManage*` permissions. Route segments must authorise per section on the server and the client. Check this FIRST.
- `data-swipe-nav-ignore` exists because strips must not turn the global tab swipe; a hub has no strip, so it goes with the strips, but the sticky `-mx-4` containers and `.page-scroll-wrap` (`will-change: transform`, containing block of `fixed`) must be re-read.
- Any `pushState` goes through `historyOverlayStack` or SvelteKit navigation, never raw: ghost entries are what the stack's `skipPops` exists for.
- `aria-label="Edit sections"` is a hard-coded English string; the new component is Paraglide from its first draft.
- Back behaviour is a GATE, not an impression: a test per level (section -> hub -> parent -> previous page), and one reading on both phones.

## Decisions still the user's

Whether wide screens keep the rail (proposed: yes), and whether the hub rows carry a summary line (proposed: yes, it is what makes a hub better than a list of labels).
