# Calendar module

**Routes**: `src/routes/calendar/`, `src/routes/events/`  
**Components**: `src/lib/components/calendar/`, `src/lib/components/associations/AssociationCalendarSection.svelte`

## Responsibilities

- Display a global campus calendar (all associations' public events).
- Show individual association calendars.
- Allow association admins to create/edit events.
- ICS export for subscribing in external calendar apps.

## Calendar views

| View | Description |
|---|---|
| Global calendar (`/calendar`) | All upcoming events across associations |
| Association calendar | Events for a single association (inside detail page) |
| Event detail (`/events/:id`) | Full event info, location, registration |

## AssociationCalendarSection

Used inside the association detail view (`/associations/:id`). It:
- Fetches events for the association from `GET /api/associations/:id/events`.
- Shows events in a timeline or month view.
- For admins: inline form to create new events (`POST /api/associations/:id/events`).

### ONE AGENDA, TWO SHAPES, AND THE SAME PREDICATE PICKS THEM

Both agenda surfaces answer `isScheduleAgendaViewport()` (`viewport.ts`, Tailwind `md`, WIDTH alone -
seven columns is a question about room, so a touch laptop keeps the grid):

| | below `md` | at or above `md` |
| --- | --- | --- |
| `/calendar` | `CalendarScheduleList`, no grid | 360px rail (nav, filter, export, day panel) + `MonthCalendarGridRich` |
| `AssociationCalendarSection` | `CalendarScheduleList`, no grid | 360px rail (nav, day panel) + `MonthCalendarGridRich` |

The association's section drew the grid at EVERY width until 2026-09-14 - 48px a day on a 390px
phone - because the 2026-09-09 phone rule and the 2026-09-10 rail were written for `/calendar` and
nothing carried them across. **Both halves are shared now**, and the rail needed a width before it
needed markup: the association page was `tool` (1024px), where a 360px rail leaves the month 91px a
day. `AssociationDetailView` therefore picks its `PageContainer` width from the ACTIVE TAB - `grid`
for `calendar`, `shop` and `partnerships`, `tool` for `about` and `members` - so the calendar tab
has the same 1600px `/calendar` has, and the rail costs the month nothing (user, 2026-09-14: *"les
pages doivent utiliser l'espace disponible. Donc si on a besoin de la largeur, on prend la
largeur"*).

The rail's two differences from `/calendar`'s are absences, not variants: no association filter (the
page IS the filter) and no export block (the section's own header carries subscribe/export). The
track is `lg:grid-cols-[360px_minmax(0,1fr)]` in both, `minmax(0,1fr)` rather than `1fr` for the
reason written at `/calendar`'s copy - `1fr` is `minmax(auto,1fr)`, and `auto` will not shrink below
the seven-column grid's min-content width.

### THE PAGE IS NOT THE OWNER OF EVERYTHING IT LISTS

`GET /api/associations/:id/events` returns the events that association **co-owns** as well as the
ones it owns - the `WHERE` clause is `e.associationId = :id OR EXISTS (co-owner row)`. So "the
association whose page this is" and "the association that owns this row" are two different facts,
and **only the row may answer the second one**. The endpoint therefore returns `associationName`,
`associationSlug`, `associationColor` and `associationLogoUrl` per event, the same four fields the
aggregated feed has always returned; `listCalendarEvents` batch-loads them next to the co-owners.

Until 2026-09-14 it did not, and `AssociationCalendarSection` filled them in from its own props. On
a co-owner's page that named one association twice on the same event - owner slot and co-owner slot
- and **`MonthCalendarGridRich` keyed its logo bands on the association NAME**, so the two entries
collided and Svelte threw `each_key_duplicate`. That is not a mis-painted logo: the page died
(production, `/associations/mitv`, one event owned by another club). The global agenda never had it,
because there the owner has always travelled with the event.

Owner + co-owners are now built once, by `eventOwners()` in `$lib/calendar/feedEvents.ts`, for the
grid's bands, the day panel and the event dialog - and every list of them is keyed on
`associationId`. **A name is a label two associations may share and a slug is a URL; neither is an
identity, and a key that can repeat is a crash rather than a cosmetic slip.**

The same fact decides what a row says: the day panel takes `ownAssociationId` (not a
`hideAssociationName` boolean) and the dialog is told `showAssociation` per event, so a row the page
merely co-owns still names, colours and badges its real owner.

## The event form - ONE component, and capabilities decide the rest

Four modals ("Proposer", "Modifier" on an association's page; "Deposer", "Modifier" on the global
agenda) were two implementations of the same form under three names, 840 and 732 lines declaring the
same six fields twice - and neither could do what the other could. They are now one component,
`$lib/components/calendar/EventFormModal.svelte`, over one module, `$lib/calendar/eventForm.ts`.

**What differed was never the form. It was which fields each surface may DECIDE**, so that is a
prop:

| Capability | Granted to | Effect when unset |
| --- | --- | --- |
| `canSetKind` | the association page, for a BDE or global admin (`canDeclareBreak`) | the `event`/`break` toggle is not rendered AND `kind` is not written to the payload |
| `canLinkForm` | the association page, for an editor of that association (`canEdit`) | the registration-form select is not rendered AND `linkedFormId` is not written |
| `canTargetAnotherAssociation` | the global agenda | the "on behalf of" select is not rendered AND the co-owner picker excludes the seeded owner |

**A field a surface cannot see is never written, and that is the point rather than a nicety.**
`linkedFormId: null` on an update DETACHES a registration form: the agenda's form holds `''` because
it has no such input, so writing it from there would silently clear a link the association's own page
had set. `toCreatePayload` / `toUpdatePayload` take the capabilities for exactly this reason, and
`eventForm.test.ts` pins it. Every capability defaults to the NARROWEST answer, so a new call site
that forgets a flag renders the plain form rather than quietly offering a right.

The component owns the form: its values, its validation, the `saving` flag, the error line, and the
mapping of a refusal to a sentence (`calendarErrors.ts` - the date rules arrive as CODES, never as
the server's English). **The CALLER owns the endpoint**, which is the one thing the two surfaces
genuinely disagree about:

| Surface | Create | Update |
| --- | --- | --- |
| `AssociationCalendarSection` | `POST /api/associations/:id/events` on itself | `PATCH` on itself |
| `/calendar` (global admin) | `POST` on the target association | `PATCH` on the OWNING association |
| `/calendar` (BDE validator) | `POST` on their own BDE association, with `targetAssocId` | `PATCH` on the OWNING association |

An event never changes owner, so the update URL is the owning association on both surfaces.

The poster is offered only while EDITING, because the upload endpoint addresses an existing row.
That is a consequence of the endpoint rather than a policy, and it lives in the component rather than
being re-derived by each surface. Its two endpoints RETHROW into the modal's error line, since the
component that owns a line owns everything that can fill it.

Creation is a PROPOSAL on the association page (a BDE validation queue applies) and is
auto-validated when a global admin or a BDE validator deposits from `/calendar`.

## Entry kind: event vs break

Each calendar entry has a `kind`: `event` (default) or `break`. A `break` is a no-course /
vacation / public-holiday period. It is created and edited exactly like an event (with the `Type`
toggle in the event modal), and is BDE/association-managed - not tied to the national calendar, so it
matches the school's real schedule. Rendering differs:
- `event`: a card occupying an event slot.
- `break`: a full-day background band (faint cell tint + a colored strip along the bottom edge,
  continuous across the period; the title shows on empty days). It takes no slot and does not prevent
  other associations' events on those days - purely graphical.

Breaks are excluded from the event-slot layout in both the interactive grid
(`MonthCalendarGridRich`) and the PDF export (`$lib/utils/calendarExport.ts`), but still appear in the
day panel so they remain editable/deletable.

## PDF export

`src/routes/calendar/export/+page.svelte` + `$lib/utils/calendarExport.ts` render a monthly A4
landscape PDF (html2canvas -> jsPDF). The live preview is rendered **in-document** (not an iframe) so
it uses the app's real fonts (`Fredoka Variable` / `Nunito Variable`) and matches the export
pixel-for-pixel. Colors, a background image, and an optional Canva-style block shadow (a hard-offset
colored text duplicate, configurable color + offset) are all adjustable. Break entries render as the
same background band described above.

## ICS export

`GET /api/associations/calendar/feed.ics` returns an ICS file for the aggregated agenda, optionally
filtered to one association via `?associationId=`. There is no separate per-association route - it's
the same aggregated feed as `GET /api/associations/calendar/feed` (JSON), with an ICS body instead.

`from`/`to` are optional on both routes: a "subscribe by URL" link is saved once by the calendar app
and re-polled forever with the exact same URL, so the caller can never add parameters to it after the
fact. When omitted, `AssociationsService.defaultCalendarFeedRange()` supplies a rolling
3-months-back/12-months-forward window - the same window the frontend computes for the link it
builds (`icsSubscriptionRangeISO()` in `frontend/src/lib/associations/api.ts`, shared by
`AssociationCalendarSection.svelte` and `routes/calendar/+page.svelte`).
