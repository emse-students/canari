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
| `/calendar` | `CalendarScheduleList`, no grid, no month nav | 360px rail (nav, filter, export, day panel) + `MonthCalendarGridRich` |
| `AssociationCalendarSection` | `CalendarScheduleList`, no grid, no month nav | 360px rail (nav, day panel) + `MonthCalendarGridRich` |

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

### BELOW `md` THE UNIT IS A WINDOW, NOT A MONTH - AND THE ARROWS WENT WITH IT

The schedule list drew ONE CALENDAR MONTH until 2026-09-20, which is the grid's unit wearing a
list's clothes. A grid has to be a month: it draws squares, so it needs a first and a last one. A
list has neither, and inheriting the constraint cost the reader the two things the view exists for -
opening the agenda on the 28th meant scrolling past 27 days that had already happened, and reaching
next week meant finding a month arrow (user: *"plutot que d'afficher le mois courant [...] on
affiche le mois glissant"*).

So below `md` the agenda starts at TODAY and grows forward on scroll. Four facts decide the shape,
and all four are in `agendaMonth.svelte.ts`:

| | value | why that one |
| --- | --- | --- |
| first day | `calendarDayOf(new Date())` | the day the READER is in, which at 01:00 is still yesterday's evening - a party running 23:00-02:00 is still on, and plain midnight would drop its row out from under someone who is at it |
| step | 3 months, one request | the endpoints take a RANGE; a month was never the fetch unit. At one month per scroll tick, July and August cost a round trip each to say nothing |
| horizon | `ROLLING_HORIZON_MONTHS = 12` | the range the `.ics` subscription already publishes and the backend already defaults to - the horizon the app had, now visible to the reader too |
| backwards | nothing | the past is a desktop question (user, 2026-09-20). No bidirectional scroll, so no upward scroll anchoring, so no list that moves under the thumb |

**THE MONTH NAME SURVIVES AS A SEPARATOR, NOT AS A CONTROL.** The day gutter says `12 / mar.`; in a
flow that crosses months, nothing else distinguishes 3 December from 3 January. It is a `sticky`
heading per month section, which is why each month is its own block and the card is drawn UNDER the
heading rather than around it: an ancestor with a clipped overflow becomes the scrollport a sticky
child sticks inside, and one that cannot scroll simply carries the heading off the top. `top-0` is
the top of `.page-scroll-wrap`, which begins below the mobile header.

**`focusDate` DOES NOT STOP MEANING ANYTHING, IT STOPS BEING CHOSEN BY ARROWS.** It still decides
which month `/calendar/export` exports and which month a phone turned sideways gets, so the list
reports the month crossing the top band of the viewport back through `rolling.setVisibleMonth`.
Without that the PDF button would silently export whatever month the window opened in.

**THREE THINGS THIS SHAPE OWES, EACH WRITTEN AFTER ASKING WHAT ITS ABSENCE WOULD LOOK LIKE:**

- **The chunks are merged BY EVENT ID.** The server's range predicate is an overlap, so a WEI
  running 31 October to 2 November comes back in the chunk that ends in October *and* the one that
  starts in November. Concatenating puts one id in the list twice, and a keyed `{#each}` over that
  does not paint a row twice - it throws `each_key_duplicate` and takes the page down, which this
  module has already shipped once (prod, 2026-09-14, above).
- **The observer is RE-ARMED after every step.** An `IntersectionObserver` reports transitions, and
  appending a chunk below a sentinel that never left the screen is not one - so a quiet stretch
  ends the scroll for good, on a build that works wherever the data is dense.
  `CalendarScheduleList.rolling.svelte.test.ts` pins it, because nothing else can.
- **A failed APPEND keeps the rows already drawn** and offers a retry, where a failed FIRST window
  still clears everything. The two are different: rows already on screen are still exactly what
  they claim to be, while a stale month under an error banner is a month the header is lying about.
  A stall also stops the automatic retries - an observer that re-fires on every scroll turns one
  failing request into a stream of them.

A ROTATION REFETCHES. The two shapes hold different ranges and neither answers the other's question:
turning a phone sideways mid-scroll would hand the grid a September built out of a year of events,
and turning it back would hand the list one month under a heading that promises twelve.

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

### WHO MAY DEPOSIT FROM THE GLOBAL AGENDA, AND WHOSE `:id` CARRIES THE RIGHT

`POST /associations/:id/events` is guarded by `AssociationPermissionFlag.PROPOSE_EVENT` on `:id`
(`associations.controller.ts`) and by nothing else. So three kinds of caller reach it, and `/calendar`
must tell them apart because **only one of them posts through an association other than the target**:

| Caller | URL `:id` | `targetAssocId` | Why |
| --- | --- | --- | --- |
| Global admin | the target | not sent | the guard lets them through on any `:id` |
| `PROPOSE_EVENT` holder on the target | the target | not sent | the right lives ON the target |
| BDE `VALIDATE_EVENTS` holder | their BDE association | the target | they hold nothing on the target; the service reads `targetAssocId` only from a validator (`isValidator && dto.targetAssocId`) |

Until 2026-09-16 the button was gated on `canDepositEvent` - global admin or BDE validator - so an
ordinary proposer was sent to their association's page to file a request this page would have made
identically. **The client was hiding a permission the server already grants**, and the fix widens no
server rule: `canCreateEvent = canDepositEvent || proposeAssocIds.size > 0`, and the picker is
narrowed to `depositableAssociations` so a proposer can only aim at an association they hold the flag
on rather than aim anywhere and be refused. `canTargetAnotherAssociation` follows that list's length,
because a picker with one entry is a control with no choice in it.

The endpoint keys on `isGlobalAdmin() || proposeAssocIds.has(target)`, **not on `isGlobalAdmin()`
alone**: that older test sent every non-admin through `depositAuthorityAssoId`, which is `''` for a
proposer, so the request would have gone to `/associations//events`. The association's own page is
unchanged and still works - it always posted the third-column request for its own members.

## WHAT A DAY IS, AND WHERE AN EVENT SITS IN ITS SQUARE

Three rules, all stated ONCE and read by both agenda surfaces and by the PDF export. Two of them
were asked for by the user on 2026-09-16, and the third is what the first one broke if left alone.

### FOUR COPIES OF THE SAME MONTH, AND WHY THAT IS THE DEFECT ITSELF

**Two defects shipped on 2026-09-16 and both were a private copy**, which is the argument for this
section existing. The agenda has THREE surfaces - the month grid, the PDF sheet, and the day panel /
schedule list - and the first two each held their own answer to questions the third asked of a
shared module. A rule with more than one implementation does not stay wrong everywhere; it gets
half-fixed, which is worse, because the surface that was corrected proves the rule works.

| the question | where it is answered now | how many copies before |
| --- | --- | --- |
| which day does this event belong to | `eventCoversDay` / `eventCardsOnDay` / `breaksOnDay` | 3 - and only ONE took the 05:00 rule |
| how much of THIS day does it fill | `dayOccupancy` | 0 - the rule read a start hour that was not about the day |
| which squares does this month have | `monthGridDays` | 2 |
| what is written above the columns | `localizedWeekdays` | 2, disagreeing: "lun" on screen, "Lun" on the sheet |
| is this square today | `isToday` in `utils/dates.ts` | 2 |

`monthGrid.ts` holds the squares and the labels; `feedEvents.ts` holds everything about which events
land on them. **Anything the grid and the sheet must agree on goes in one of those two, and a helper
written inside either renderer is the defect, not a shortcut.**

### A DAY BEGINS AT 05:00, NOT AT MIDNIGHT

`DAY_STARTS_AT_HOUR` in [`feedEvents.ts`](../../../../frontend/src/lib/calendar/feedEvents.ts) - the
only place it is written. A party announced 23:00-02:00 is ONE evening to everybody who goes to it,
and midnight split it across two squares: the grid drew it twice, and the second square claimed an
event on a morning when nothing happens. Five is the hour campus life is actually over, and early
enough that nothing legitimately scheduled starts before it.

**THE TWO ARGUMENTS OF `eventCoversDay` ARE NOT THE SAME KIND OF THING**, and reading them with one
function is how this went wrong the first time. An event's `startsAt` is an INSTANT that has to be
assigned to a day (`calendarDayOf`, which shifts); a `day` is ALREADY a day's identity (`squareOf`,
which does not). Shifting both would have answered the 4th for the square labelled 5, moving every
event back a day - the rule applied twice, once where it belongs and once where it means nothing.
`feedEvents.test.ts` pins that case explicitly with an ordinary daytime lecture.

The value returned is still local MIDNIGHT, not 05:00: it is the day's identity, used for `isToday`
and for formatting, and every caller already reads it that way. Only the ASSIGNMENT moved.

**AND IT REACHED ONLY ONE OF THE THREE SURFACES UNTIL 2026-09-16.** `eventCoversDay` was written and
tested, and the day panel and the schedule list used it - but `MonthCalendarGridRich` and
`calendarExport` each carried a PRIVATE `entriesOnDay` cutting the month at midnight, and neither
was touched. So the evening the whole change was written for went on being drawn twice by the month
grid and by the printed sheet, which are the two surfaces a user actually looks at, while the list
beside them was right. The commit message claimed the grid was fixed; the diff never named it.

Both copies are deleted. `eventCardsOnDay` and `breaksOnDay` in `feedEvents.ts` are what the two
renderers call now, and `feedEvents.test.ts` asserts the 23:00-02:00 party stays off the following
square THROUGH that selector rather than only through `eventCoversDay`. **A rule proved on a helper
nobody paints with is not a proved rule.**

### A LONE EVENT TAKES HALF THE SQUARE, AND WHICH HALF SAYS WHEN

`daySlotLayout` in [`calendarExport.ts`](../../../../frontend/src/lib/utils/calendarExport.ts),
deciding from `dayOccupancy` in `feedEvents.ts`, which pivots on `HALF_DAY_PIVOT_HOUR` (13:00). A
square with a single event used to paint it floor to ceiling, which says nothing about WHEN. Half a
cell says "morning" or "afternoon" at a glance across a whole month, with no type at all - and a
month sheet is read at arm's length, where the times are not legible anyway. 13:00 rather than 12:00
because a midday event reads as the morning's end.

It is NOT a lone event if others are hidden behind it: a cell with one visible event and a "+N
autres" row fills as usual, because the cell is not showing one event.

**A START HOUR IS ONLY ABOUT THE DAY IT FALLS ON**, and forgetting that is what a WEI exposed on
2026-09-16. Both renderers handed the layout `startsAt.getHours()` for EVERY square a multi-day
event covered, so a Friday 18:00 departure painted the bottom half of Saturday and of Sunday too -
two days the event holds end to end, and about which its start hour says nothing.

`dayOccupancy(event, day)` asks the question from the DAY's point of view instead, and the rule it
states is simpler than the one it replaces: **a cell halves only when the event leaves half that day
genuinely free.**

| the event, relative to this square | what the square shows |
| --- | --- |
| began earlier AND ends later | `full` - one slot |
| began earlier, ends here before 13:00 | `morning` |
| began earlier, ends here at or after 13:00 | `full` |
| begins here at or after 13:00, ends later | `afternoon` |
| begins here before 13:00, ends later | `full` - it holds the day to 05:00 tomorrow |
| contained in this day | the half its start hour names |

The hours compare against the pivot without re-shifting, and that is a property of `calendarDayOf`
rather than a coincidence: an instant it assigns to a square necessarily reads between 05:00 and
23:59 local.

**THE RULE LIVES BESIDE `fitEventText` AND `splitLogoBands` FOR THE REASON THOSE TWO DO** - the
screen grid and the PDF export both import it, and a layout rule written in the component would be
a rule the sheet does not have. **The day number belongs to slot 0, and slot 0 no longer always
holds an event**: when the lone event is an afternoon one, the empty top half carries the number,
and the event block stops reserving `DAY_NUM_H` for it. Both renderers do this, and getting only
one of them right is a half-fix that shows up as a number drawn twice or not at all.

### CREATING AN EVENT ON THE SQUARE YOU CLICKED

`blankEventFormValues(onDay)` takes the selected day, via `daySquareDate(focusDate, selectedDay)` -
shared, because both surfaces hold that same `focusDate` + `selectedDay` pair. Having picked a day
and then being handed today's date is the form ignoring what was already said.

**The seeded hour is clamped to `DAY_STARTS_AT_HOUR`**, which is not cosmetic: seeding 02:00 on the
5th would open a form whose event belongs to the 4th by the rule above, so the grid would draw it on
the square BEFORE the one the user clicked.

## The event form - ONE component, and capabilities decide the rest

Four modals ("Proposer", "Modifier" on an association's page; "Deposer", "Modifier" on the global
agenda) were two implementations of the same form under three names, 840 and 732 lines declaring the
same six fields twice - and neither could do what the other could. They are now one component,
`$lib/components/calendar/EventFormModal.svelte`, over one module, `$lib/calendar/eventForm.ts`.

**What differed was never the form. It was which fields each surface may DECIDE**, so that is a
prop:

| Capability | Granted to | Effect when unset |
| --- | --- | --- |
| `canSetKind` | anyone the SERVER lets decide it: `canDeclareBreak` on the association page, `canDepositEvent` on the agenda - both are `mayValidate`, a BDE validator or a global admin | the `event`/`break` toggle is not rendered AND `kind` is not written to the payload |
| `canLinkForm` | whoever may list the target's forms: `canEdit` on the association page, `isGlobalAdmin \|\| proposeAssocIds.has(target)` on the agenda | the registration-form select is not rendered AND `linkedFormId` is not written |
| `canTargetAnotherAssociation` | the global agenda | the "on behalf of" select is not rendered AND the co-owner picker excludes the seeded owner |

**THE COMPONENT WAS UNIFIED IN 2026-09; THE CALL SITES WERE NOT, UNTIL 2026-09-14.** The agenda
passed one capability and neither `linkableForms` nor `poster`, so from `/calendar` a global admin
could edit every field of an event except its kind, its registration form and its poster - and the
server would have accepted all three from exactly that person (`assertMayDecideKind` gates `kind` on
`mayValidate`, which is who `canDepositEvent` already is). A capability the API grants and no screen
offers is a right reachable only by hand.

Two mechanics make the agenda's version work, and neither exists on the association's page because
neither has to: the form picker follows `values.targetAssociationId` rather than the page, since this
is the only surface where the owning association can change mid-form; and `canLinkForm` is decided
from the associations already loaded, because `GET :id/link-candidates` wants `PROPOSE_EVENT` on the
TARGET - a fact known here, so the control is shown where the request would succeed instead of being
sent to find out.

The poster's state and its two endpoints are `$lib/calendar/eventPoster.svelte.ts`, shared: it reads
the association and the event through getters at CALL time, which is what lets one implementation
serve a surface whose target moves while the form is open.

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

**Creation is a PROPOSAL on both surfaces, and there is no caller for whom it is not** - a BDE
validator and a global admin depositing from `/calendar` land in the same queue every member's
proposal does (user, 2026-09-14). The deposit modal says so (`calendar_deposit_pending_note`) and
its button reads *Envoyer pour validation* rather than *Publier*; the badge on the `/admin/agenda`
link counts what is waiting, the deposit included. What `/calendar` still decides that the
association's page does not is WHO an event belongs to. The server side is
[social-service](../../services/social-service.md#nothing-is-validated-by-the-act-of-creating-it).

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

## A post links an event; the event does not link a post

`Post.linkedCalendarEventId` is the only column - there is no `linkedPostId` on
`AssociationCalendarEvent`, unlike `linkedFormId`, which the event DOES carry (see above).
`resolvePostCalendarEventLink` requires an `associationId` to set it, so a post carrying this field
is always an association post, never a personal or anonymous one - `mustHideAnonymousAuthor` never
has an opinion about it.

**The event's own card shows the post by asking, not by reading a column** - reported by a user
2026-09-18 after the reverse direction rendered nothing. `PostsService.findPostLinkedToCalendarEvent`
queries `posts WHERE "linkedCalendarEventId" = $1`, takes the most recent match if more than one
post ever names the same event, and runs the result through the same `shapeListRow` every other
read path does (a no-op here, since the row is always an association post). Exposed at
`GET /api/posts/calendar-link/:eventId` - the mirror of the forward lookup at
`GET /api/posts/:postId/calendar-link` - and fetched by `CalendarEventDetailModal` when it opens,
rendered as a pill beside the `linkedFormId` one when a post exists.

**Two more defects shipped in the forward direction, same report.** `listPosts` and `searchPosts`
build their rows from a raw SQL column list that never named `linkedCalendarEventId` at all - so a
post's own "see the event" pill was there right after creating or editing it (that path loads the
full TypeORM entity) and gone the moment the feed was reloaded (that path did not). And the pill's
`href` pointed at `/associations/:slug?section=agenda` - a query param NOTHING ever read
(`AssociationDetailView` had no code reading `?section=` at all) and a section name
(`agenda`) that was never this page's own name for it (`calendar`) even if something had. Fixed to
`?section=calendar&fromPost=:postId`: `AssociationDetailView` now reads `section` on mount, and
`AssociationCalendarSection` reads `fromPost`, fetches `getCalendarEventLinkedToPost(postId)` (the
forward lookup, now returning the full `AssociationCalendarFeedEvent` shape the modal renders -
association identity included - rather than the bare `serializeCalendarEvent` it used to), and
calls `agenda.openDetail(event)` directly. That call needs no month loaded: `openDetail` only ever
sets local state, so it is independent of `agenda.reload()`'s own window.

## HOW FAR BACK THE AGENDA GOES: THE READER'S OWN PROMO (2026-09-20)

*"ce serait bien de mettre une limite pour remonter sur l'agenda en regle generale, comme on a une
limite pour les posts (quelqu'un de la promo X ne peut pas voir avant aout X je crois)"* (user).
They remembered it exactly: the posts feed has cut its history at `${promo}-08-01` for a long time,
and the agenda never did - so a first-year could scroll the grid back into a school they had not
joined.

**THE RULE IS NOW ONE FUNCTION, AND THE FEED IS ITS SECOND CALLER**:
[`promo-visibility.ts`](../../../../apps/social-service/src/common/promo-visibility.ts) in
social-service, next to `user-blocks.ts` and for the same reason. It answers one question - what date
does this reader's history start at - and returns `null` for the three cases that have no answer: a
global admin, an anonymous reader, and a viewer whose row carries no promo.

**IT APPLIES TO BOTH CALENDAR READS, AND THAT IS NOT OPTIONAL.** `GET /calendar/feed` (the aggregated
agenda) and `GET /associations/:id/events` (an association's own tab) return the same rows through
two query builders. A limit only one of them honours is not a limit: the other route lists the same
events, takes the same `from`/`to`, and is already called by the same page. Both take a
`CalendarViewer` - `{ userId?, isGlobalAdmin? }` - built by the controller from the `x-user-id` and
`x-global-admin` headers nginx forwards.

**THE COLUMN IS `startsAt`, NOT `createdAt`.** What a reader means by "how far back does the agenda
go" is the date of the event; the day somebody typed it in answers a different question. This is the
one place the agenda's rule differs in shape from the posts feed's, which cuts on
`COALESCE(scheduledAt, createdAt)` because a post has no other date.

### It is a RELEVANCE limit, and calling it anything else would be a lie

The aggregated agenda is a **public** route, and its `.ics` twin is subscribed to by calendar apps
that send no identity and never will - so an event before the cutoff was never secret, and the `.ics`
feed carries no cutoff at all. That is not a hole in a security control; it is the absence of a
security control that was never claimed. **Anything that must be SECRET is refused by a guard.**
Writing this down is the point: a reader who believed the cutoff was confidentiality would find the
`.ics` route and file a P1 against a mechanism working as designed.

### The arrows are NOT clamped, and that is a decision

`createAgendaMonth` is the one implementation of "which month am I looking at", so a clamp would be
cheap to write - and it would put the rule in a second place, on a client that would then have to
fetch the viewer's promo and agree with the server about August. The posts feed does not clamp
anything either: it simply ends. Paging back past the cutoff shows empty months, which is what the
end of a history looks like. **What would make a clamp free is the feed answering with an envelope
that names its own floor** - one number, derived server-side, with nothing to drift. Nobody has asked
for it.

### What no test covers

Every test here is a unit test over a query-builder stub: they prove the clause is built, with the
right column and the right date, and that it is absent for an admin and for an anonymous reader.
**Nothing has run this against a database**, so the `::timestamptz` cast is asserted as text and not
as a plan. The population it will meet is also unmeasured - how many events on prod start before the
cutoff of a current promo is one `GROUP BY` nobody has run.
