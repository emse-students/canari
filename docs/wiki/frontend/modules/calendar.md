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

## Event creation

Events are created via `POST /api/associations/:id/events` with:
- Title, description, start/end datetime, location
- Optional: capacity limit, registration form link

Association admins can create events; a validation queue may apply depending on the platform configuration.

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

## ICS export

`GET /api/associations/:id/events/ics` (or global `/api/calendar/ics`) returns an ICS file for calendar subscription.
