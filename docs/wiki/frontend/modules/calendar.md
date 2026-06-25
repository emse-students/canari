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

## ICS export

`GET /api/associations/:id/events/ics` (or global `/api/calendar/ics`) returns an ICS file for calendar subscription.
