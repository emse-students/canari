# Bookings (reservation of rooms and slots) - the chantier, decisions as taken

**Status: BUILDING (opened 2026-10-15).** WP-B0 (#1904) and WP-F merged; WP-B1 merged as #1963 (2026-10-17); WP-B2 merged as #1993 (2026-10-17); WP-B3 (the API) merged as #2002; WP-B4's organiser API merged as #2006; its screens (#2019), WP-B5 (#2029, #2035) and WP-B6 (#2045) are merged; WP-B7 (device readings, the French guide, rig rows) is what is left. Decisions are written here the day the
user takes them; the work packages are written last, once every question is closed. Pointer in
[backlog](backlog.md) to be added when the plan is complete.

## The two use cases that bound the design (user, 2026-10-15)

| | Music room (ME, run by the BDA) | Alumni CV interviews (the PDF "Entretiens Alumni 2026") |
|---|---|---|
| Resources | ONE (the room) | 14-21 columns, one per alumni |
| Availability | recurrent, every day, all year | ponctual: two days, 14h00-18h45 |
| Slot | several steps in a row (limited duration) | one fixed 25 min slot, columns may differ (one alumni runs 16h20-16h40) |
| People per booking | several | one |
| Extra data | none | name, year (dropdown), a CV file |
| History | consultable, FROZEN, who booked when | not needed beyond the event |
| Some slots | open | "Indisponible" per column |

Another case named by the user: a personal appointment (the school psychologist) where nobody must
see who else booked.

## Decisions

| # | Question | Decision |
|---|---|---|
| D1 | New module or extension of forms? | **A NEW MODULE** (user). It reuses ownership, rights, sharing and audience; it has its own tables (space, resource, booking) because capacity and concurrency need a database constraint a form answer does not have. |
| D2 | Owner | Same four owners as a form: a person, an association, a list, an institution (all three are `associations` rows with a `kind`; rights are `MANAGE_*` on that entity or global admin). **To verify before building:** that `/forms/create` really offers lists and institutions in its picker. |
| D3 | Granularity | **The organiser chooses per space between a FIXED STEP** (1..N steps per booking, N set by the organiser) **and PREDEFINED SLOTS** (an explicit list, which may differ from one resource to the next). |
| D4 | Several people | A booking has a holder and PARTICIPANTS, all Canari accounts. Participants see it in their agenda and may withdraw alone. The organiser may cap people per slot. No free-text names. |
| D5 | Withdrawal | **Replaced by the user on 2026-10-17:** the HOLDER (and the organiser) may cancel at any time before the start; a PARTICIPANT may withdraw only until a minimum delay before it, set per space (`participantWithdrawMinMinutes`, default 0 = until the start), to avoid last-minute withdrawals. Earlier text: "Free for the holder, with a DELAY set by the organiser (default none). The organiser may always cancel, the holder is told." |
| D6 | Who may book | A signed-in account. The organiser may restrict with the forms' `AudienceCondition` (promo, formation, cotisation). **No guest access** (a booking with no identity cannot be withdrawn cleanly). |
| D7 | What a booker provides | **The forms' questions are reused** (same builder, same types, conditional questions), plus a FILE type. **The file type must also exist in forms** (user): a sibling work package, shared. |
| D8 | Retention | The FILE is purged N days after the slot (organiser sets N, platform caps it, short default - 30 days like a CanaReel). The HISTORY row (who, when, which resource) is kept FROZEN. What happens to the TEXT answers is open (Q-open-1). |
| D9 | Visibility to other bookers | **A setting per space**: identities visible, or "occupied" only (then only the organiser and the booking's people see names). Answers and files are NEVER visible to other bookers. The settings must be clearly laid out and tidy (user's requirement). |
| D10 | Resource (a column) | A named resource with its own hours, unavailabilities and a free text (sector, video link). **An optional link to an account**: that person sees their bookings and may mark themselves unavailable. Unlinked = a label the organiser manages (external alumni). |
| D11 | Availability | **A typical week + ponctual ranges + exceptions**, with a booking HORIZON (how far ahead one may book). Slots are generated on demand; only bookings are stored. No iCal RRULE. |

| D12 | A full slot | **A flat refusal, no waiting list in v1**, enforced by a database constraint, never by a client check. A waiting list is a later version. |
| D13 | Agenda and notifications | The module is **SEPARATE from the calendar**: only an "Add to my calendar" button, as for Canari events (user). **NO notification in v1** (user). Known cost: an organiser's cancellation is invisible to the holder until they come back - to be written on the screen, not hidden. |
| D14 | Views | A **grid** (resources as columns, slots as rows, as the PDF) and a **planning** (list of next free slots per resource), as the Canari calendar distinguishes them ([calendar](frontend/modules/calendar.md)). Default follows the screen width. |
| D15 | History | Readable according to the space's visibility (D9). **Untouchable by anyone, the organiser included**: a past booking can no longer be edited or deleted. A cancellation stays visible as cancelled, and by whom. A deleted account leaves the name it had. |
| D16 | Navigation | **"Reservations"**, an entry point of its own (spaces I may use, my coming bookings) and a **tab in the owning entity** (as Forms). A personal space is created from the page itself. Each space has a link and a QR code (existing `QrCodeModal`). |
| D17 | Quotas | **Two ceilings per person, none by default**: simultaneous coming bookings, and total duration per day or week. A person counts as holder or as participant. The organiser is exempt when booking for someone. |
| D18 | Text answers | **Purged with the file, the same N days after the slot** (one rule to explain). |
| D19 | Erasure | **A platform-wide maximum age, e.g. one year, purges EVERYTHING older, history included** (user). This resolves the clash between a frozen history and the right to erasure: frozen means nobody edits it, not that it lives for ever. The figure is to be fixed. |

| D20 | Organiser powers | **Block a slot or a range** ("Indisponible", reason shown or not), **book on behalf of an account** (outside the quotas), **cancel a coming booking**. **No move** (without notifications the person would not learn it changed: cancel, and they book again, which leaves a clean trace). Nothing on the past. |
| D21 | Moderation | **A block is honoured for invitations**: nobody can add as participant an account that blocked them or that they blocked, and the screen says so without saying who blocked. **No report button in v1.** To re-read [moderation-and-blocking](moderation-and-blocking.md) before building. |
| D22 | The FILE question type | **A clean work package, delivered FIRST, used by forms and then by bookings.** Server-side storage readable by the organiser (not MLS: the organiser must open the CV, as form answers are plain today), size and type limits, expiry, purge. |

| D23 | Figures | **Platform maximum age: 1 year after the slot** (D19), a constant, not adjustable. **N (D8, D18): default 7 days, adjustable from 1 to 30 days** by the organiser. |
| D24 | Export | **XLSX as forms, before the purge**: date, resource, holder, participants, answers. Headers come from the client (Paraglide), as forms' `ExportLabels`. Files are NOT exported; answers already purged are gone. |
| D25 | Time | **A local wall time plus a zone, ONE zone per space, `Europe/Paris` by default**; each booking stores the computed UTC instant. A recurrent 18:00 stays 18:00 across the daylight-saving change. A traveller sees the space's time, not theirs. |
| D26 | Booking window | **Three optional settings**: an opening date, a minimum notice, and the horizon (D11). None active by default. The server applies all three, never the client alone. |
| D27 | Deleting a space | **Immediate deletion of everything** (user). **This narrows D15**: a booking in a living space cannot be edited or deleted by anyone, but deleting the SPACE erases its history, so an organiser can erase it. Written so nobody is surprised; to re-confirm at the end. It is the opposite of forms' archive rule (migration 081). |

| D28 | Repeating bookings | **None in v1: one booking is one occurrence** (each session booked on its own, within the horizon and quotas). A series raises the cases of a blocked or taken slot in the series, cancelling one or all, and freezing a series; it is a later version. |

| D29 | Editing availability | **Refused while coming bookings fall inside the change, naming them**; the organiser cancels them explicitly (D20) and retries. Blocking a free range stays immediate. |

| D30 | Right to manage | **A NEW `MANAGE_BOOKINGS` right, distinct from `MANAGE_FORMS`**: one more bit in the association bitmask, granted per role. The BDA can entrust the music room to someone without giving them forms. It needs a migration of existing roles and a row in the role editor ([association-permissions](association-permissions.md)). A global admin keeps everything **except a booking's FILES** (WP-B6, review of #2045): a CV is downloaded by the space's own managers alone. The carve-out is the files only - a global admin still reads the answers, the views and the export. |

| D31 | Discoverability | **A setting per space**: listed on the Reservations page for those the audience (D6) allows, or **link only** (no list anywhere, reached by link or QR code - the psychologist case). The audience is enforced by the server in both modes, never by hiding it in the interface alone. |
| D32 | Private information | **An "after booking" field per resource and per space** beside the public one (sector, remark): the video link, the room code, instructions. Only the booking's people see it, while the booking exists; gone on cancellation. The server returns it only to them. |
| D33 | Exclusivity | **ONE booking per resource and instant** (user): both cases are exclusive, and D4's ceiling is the number of PARTICIPANTS inside that booking. The database constraint is therefore an EXCLUSION on overlapping time ranges per resource (no count). Shared seats (a 10-seat workshop) are a later version. |

| D34 | Adding a participant | **Direct, no acceptance**; the participant may withdraw alone (D4); a block is honoured (D21). With no notification (D13) they find out by opening the page, which the screen must say. |
| D35 | Settings layout | **Five sections, the advanced ones collapsed by default**: 1 General (name, description, poster, zone); 2 Resources and availability (typical week, ranges, exceptions, step or slots); 3 Who and how (audience, name visibility, discoverability, questions); 4 Booking rules, collapsed (opening, notice, horizon, quotas, withdrawal delay, people ceiling); 5 Data, collapsed (purge delay N, export). A badge on a collapsed section says a setting is active, as forms' advanced settings do. |

| D36 | Holder edits | **Nothing: a holder can only CANCEL** (user). Participants and answers (the CV included) are fixed at booking time; a participant may still withdraw alone (D4). Known cost, to be said on the booking screen: correcting a CV or adding a friend means cancelling and booking again, and the slot can be taken in between. |

| D37 | Mobile entry (E1) | **Desktop sidebar entry, and a "My bookings" card on the phone dashboard** (user). No bottom tab is displaced, the iOS native tab bar is unchanged. A space's link and QR code are the real way in. |
| D38 | Tab on lists (E2) | **The bookings tab opens for all three kinds** (association, list, institution), for whoever holds `MANAGE_BOOKINGS` on the entity. The short roster of lists is extended and the list role editor must offer the right. |
| D39 | Initial right (E6) | **Holders of `MANAGE_FORMS` receive `MANAGE_BOOKINGS` in the migration** (user, against my recommendation of nobody: it grants a right to people who did not ask for it, which cuts against keeping the two responsibilities apart). A BDE super-admin inherits it by default (the user did not answer; written as the existing behaviour for anything not excluded). New roles: the "administrator" preset includes it. |
| D40 | File on a public form (E3) | **Refused in v1, to reopen later** (user): the upload needs a session token and an anonymous file write is the biggest abuse surface of the chantier. Refused at save time with a clear sentence, as `assertPublicConfigValid` does for price and audience. A "public form" is `forms.isPublic`, answered at `/f/:id` with no account; its payment half is PARKED, not forbidden in principle: it needs WP-LYDIA-1 (Lydia live in production) plus a guest payment route and a fulfilment with no `userId`. The user wants a PAID PUBLIC form (ticketing for an outside event): it is its OWN chantier, [public-paid-forms-chantier](public-paid-forms-chantier.md), planned in parallel. Bookings do not depend on it (D6 needs an account). |

| D42 | Deleting a RESOURCE (review of #2006, Master's decision, the user having delegated it) | **Refused while the resource has ANY booking - past, coming or cancelled** (`resource-has-bookings`). A booking is history, and D15 freezes history while its space exists; D27 lets only the deletion of the whole SPACE erase it. A resource that is no longer offered is CLOSED instead (its availability emptied, or a closure). A resource nobody ever booked may be deleted. (Numbered D42: D36 was already the holder-edits decision.) |
| D43 | A PERSONAL space in the listing (review of #2029, Master's decision) | **A personal space is NEVER listed to anyone but its owner**, whatever its discoverability: it is reached by its link or QR code. No decision lets a member publish free text (a space's name and description) on a page the whole school reads, and v1 has no report button (D21). A space of an ARCHIVED association is not listed either. |
| D41 | File retention in forms (WP-F) | **The SAME rule as D8 and D23, one mechanism with two starting points**: a file is purged N days after the EVENT (default 7, adjustable 1 to 30 by the manager), the event being the slot's end for a booking and the DATE OF THE ANSWER for a form. The answer row stays; the file goes. The user pointed out this was already decided: a duplicate question was asked and is recorded here so nobody asks it a third time. |

## Redesign decided 2026-10-23

| D44 | One visible level (user, 2026-10-23) | A space has ONE hidden default column; an **"Ajouter une colonne"** action reveals the columns level. Supersedes the visible space/resource split of D10 **in the UI only**: the data model is unchanged. |
| D45 | Poster (2026-10-23) | Shown as a **banner on the space page** and a **thumbnail in the spaces list**. |
| D46 | Desktop main view (2026-10-23) | **Days as columns, like the agenda week**; a column selector when there are several columns; the duration is chosen by click-drag. |
| D47 | "Prochains creneaux" (2026-10-23) | **Removed.** Supersedes D14's planning. |
| D48 | Phone view (2026-10-23) | **One day at a time, with a week strip.** |
| D49 | Availability editing (2026-10-23) | A **visual week to paint**, with start templates: Toujours ouvert, Jours ouvres 8h-20h, Evenement ponctuel, Vide. |
| D50 | Organiser dashboard (2026-10-23) | Upcoming bookings, who booked, quick cancel; **blocking a slot by dragging on the grid**. |
| D51 | Settings (2026-10-23) | **Five collapsible sections in plain words.** D35 is kept, only its words are made clearer. |
| D52 | Creation wizard (2026-10-23) | An optional **3-step wizard** as a variant. |
| D53 | Notifications (2026-10-23) | **YES now**: organiser cancellation, confirmation to an added participant, a reminder before the slot with an adjustable delay. Supersedes D13's "no notification in v1". |
| D54 | Method (2026-10-23) | **Mockups first**, built in parallel with the stable (user: *"Tout de suite, en parallele de la stable"*). |

**Master's notes (2026-10-15):** no open pull request touches forms (open: #1896, #1897, #1898, #1884), so WP-F has no known conflict; rebase on `main` before each batch; **check the next free migration number on `main` when opening each pull request**, as other pull requests may take one.

D27 was re-confirmed by the user on 2026-10-15: the history is frozen only while its space exists.

## WP-R1 as built - the hidden default column (D44, 2026-10-27)

- **`POST spaces` creates the space's ONE column** (`writeDefaultColumn` in
  `booking-spaces.service.ts`), named after the space, at position 0, in the creation's own
  transaction. It answers `{ id, resourceId }`.
- **The first hours may come in the same call** (`CreateSpaceDto.availability`, the same nested
  `AvailabilityDto` as `PUT resources/:id/availability`). They are parsed before the transaction (a
  malformed line is a 400 and nothing is written) and inserted inside it, so the creation wizard
  (D52, WP-R7) can never leave a space without its hours. Without them the column starts closed.
- **THE HIDDEN COLUMN IS ONE PREDICATE, SHARED BY BOTH SIDES** (review of #2590): exactly one
  column AND it bears the space's name - `columnsHidden(spaceName, resources)` in
  `frontend/src/lib/bookings/columns.ts`, and the server's rename rule below. A single column named
  otherwise (a space set up before WP-R1, "Piano" in "Foyer") is a VISIBLE column, renamable and
  deletable. Renaming a single column to the space's own name makes it the hidden column, and it
  follows the space's later renames from then on.
- **A renamed space carries its hidden column's name** (`renameDefaultColumn`, under the update's
  space lock): only when the space has exactly one column and that column still bears the space's
  former name - the former name IS the discriminator. This keeps the name read in "my bookings",
  the `.ics` and the export right without any client rule.
- **The editor's copy of a column's name follows the server** (review of #2590, the blocker):
  `ResourceEditor` re-seeds its name from the resource when the organiser has not edited it, and
  sends a name ONLY when the organiser typed one. Before, a space renamed "Old" -> "New", then a
  column added, then the first column's fields saved, wrote "Old" back.
- **The screens hide the columns level for the hidden column.** In `SpaceEditor` it shows its hours
  and linked account only (no name, no delete, and its texts only when it already carries some, so
  nothing the server serves is out of sight); an "Une seule colonne" card offers **Ajouter une
  colonne**, which names the new column and reveals the level; the save bar says "Modifications non
  enregistrées" rather than "1 ressource(s)". `SpaceGrid` and `SpacePlanning` draw no column name
  (the grid's caption already names the space). The entity tab's list drops the count of a space
  with one column.
- **A place is never read twice**: `bookingPlace(space, column)` names the space alone when the
  column bears its name, on the client (calendar titles, "my bookings", which also drops the
  column line) and in the `.ics` summary (`booking-calendar.ts`). The sheets' titles already read
  the column's name, which IS the space's. The export keeps its column column: it is data.
- **No new cap**: the hours of a creation go through `AvailabilityDto`, which already caps lines
  (200) and closures (100) with `ArrayMaxSize`.
**Proof.** `bookings.service.integration.spec.ts`, "the hidden default column (WP-R1, D44)", on a
real PostgreSQL 18: one column named after the space; the first hours written and a booking accepted
at once; a malformed line refused with no space written; a failure INSIDE the transaction (the
database's weekday CHECK, reached by calling the service directly) leaving neither space nor column;
the rename followed by the hidden column and by nothing the organiser named, and by a single column
once renamed to the space's name. Control: with the rename call disabled, the rename test fails.
`SpaceEditor.hiddenColumn.svelte.test.ts` mounts the editor and runs the blocker's sequence (rename,
reveal, save): the former name is never sent; control: with the old copy restored, it fails. `dto/create-space.dto.spec.ts` (the nested hours
validated as a 400), `columns.test.ts`, `booking-calendar.spec.ts` (no doubled summary). **Seen** at 390 and 1280 on a local build, on a fixture space
(a temporary signed-out preview route, not committed): the card reads its title, hint and button;
at 390 the button had crushed the hint to one word a line, so the hint now holds a basis and the
button wraps below it. Not yet seen against a running API.

## WP-R2 as built - the booker's week (D45-D48, 2026-10-27)

Front only: no route, no migration. The page still reads `GET spaces/:id/slots`, now ONE read of
the week plus the day before it (`weekReadRange`, the same day-before rule as `slotsReadRange`: the
server keeps a unit by its WINDOW's date, so Monday 00:30 of a Sunday-night window is in no read that
starts on Monday).

- **One view, chosen by the width** (`SCHEDULE_AGENDA_QUERY`, as the agenda). **`SpacePlanning` and the
  grid/planning switch are deleted** (D47, Q-R8): so are `gridRows`, `gridOpeningDate`, `planning` and
  their messages. A unit sits in the column of the day it STARTS on, so the grid needs no "window
  date" and no "next day" row.
- **`weekLayout` (pure, `lib/bookings/grid.ts`)** lays ONE column's units out: a unit's top is the
  WALL minute of its start and its height its elapsed length, so 18:00 is 18:00 every day, daylight
  saving included, and nothing is ever shifted. The one disagreement between wall and elapsed time
  is a fall-back night's doubled hour: its two units sit at the same wall time, overlap, and share
  the width in lanes like two slots of a list (allowed since WP-B2), so every later unit keeps its
  own wall time. (A first version displaced the second one and carried the shift: the rest of that
  day sat an hour low, found in review.) The
  axis is whole hours around what the week offers; an hour is tall enough for the shortest unit to
  hold a line (4 to 12 rem). A night window crossing midnight is two columns, as its two days.
- **A day is `open`, `none` (nothing left to take on the device's clock) or `closed` (nothing
  offered).** On a desktop a closed day FOLDS to a narrow strip (Q-R10); on a phone the strip's dot says
  `open` / `none` / closed, from the same read as the day under it.
- **Desktop (`WeekBar`)**: previous / next week, "Aujourd'hui" only when the week shown does not hold
  today, the week's dates, and the legend, whose words are the grid's own (`bookings_cell_*`).
  **Phone (`DayStrip`)**: the seven days of the week, the chosen one marked, a week step either side,
  and ONE day on its own axis below. The chosen weekday is kept when the week moves.
- **The column selector (`ColumnSelect`, D46) shows only for several columns** (D44): pills up to five,
  a list beyond, each with how many units one may take in the week read. The drag, the 250 ms finger
  hold, the step ceiling and the chip are unchanged, now along a DAY (`dragRange` is untouched).
- **The poster is already a banner on this page** (`SpacePoster`, WP-B5): nothing changed there.
- **Kept on purpose**: the sentence that nobody is notified (D13) stays until WP-N lands, since it is
  true until then.

**Proof.** `grid.test.ts` (the week's dates, the read's first day, wall-time placement across both
2026-10-24..26, the 25 contiguous hours of the fall-back day, a Friday night and a Sunday night, folded and full days, lanes,
the hour height, no axis when empty) and `SpaceGrid.drag.svelte.test.ts` (every drag case along a day,
plus a folded closed day). **Not yet seen** on a phone or against a running API; seen only where the
next paragraph says.

## WP-R3 as built - the poster as a thumbnail (D45, 2026-10-27)

Front only. `GET spaces` already returned `poster`; the Reservations list was `SectionHub` rows,
which carry no image, so the spaces now have their own list, `SpaceList.svelte` (a real link per row,
the same look, a 48 px box leading it).

- **`SpacePoster` gained `thumb`.** The same component decrypts the banner and the thumbnail (one
  decryption path, one blob cache); `thumb` makes it a small square and defers its work until the
  box is NEAR the viewport (`nearViewport`, once - the picture stays once drawn). A list of twenty
  spaces therefore decrypts what is on screen and what is just below it, never twenty posters on
  arrival. A failed one is an icon with no sentence in a thumbnail's room.
- **A space with no poster keeps the calendar glyph in the same box**, so names line up. The line
  under the name is who runs it, then the column count FROM TWO (a single column says nothing, D44 -
  as the entity tab's list since WP-R1).
- **Not done**: the entity tab's own list of spaces is a different list (the organiser's) and is
  untouched.

**Proof.** `SpaceList.thumb.svelte.test.ts`: three posters, nothing downloaded on mount, one
downloaded when its row nears the viewport and it is the right one; the decrypted picture is drawn
in its row; a space with no poster fetches nothing and keeps a glyph. Control: without the
`nearViewport` gate, the first test fails (three downloads on mount). **Not yet seen** on a phone.

## WP-R4 as built - the painted week (D49, 2026-10-27)

Front only: the painter writes the same `PUT resources/:id/availability`, the stored lines are
unchanged. `AvailabilityEditor` now reads: the four templates, the week to paint (`WeekPainter`),
"En clair" (the weekly lines, to read and to type exact times in), the dated lines apart, closures.

- **One model: the editor's `rows`.** The painter, the templates and the typed lines all edit the
  same `rows`, so they cannot disagree and the save, the dirty flag, the 24/7 warning and the D29
  refusal (`StrandedBookings`, each booking with its cancel) are untouched. The painter reads
  `weekRunsOf(rows)` and writes `paintRows(...)`.
- **RUNS, not cells** (`lib/bookings/availabilityPaint.ts`, pure): per weekday, the merged open
  `[start, end)` minutes. A gesture is 30 min (Q-R11) but an edge typed at 18:45 stays 18:45 when
  something else is painted; only the part a rectangle covers changes. A run is written back through
  `fromStoredLines`, so Friday 22:00-24:00 plus Saturday 00:00-02:00 is ONE line again; the days are
  written Monday last because Monday's morning is Sunday night's tail.
- **One gesture, no brush**: pressing a closed cell opens the rectangle, pressing an open one closes
  it. A finger paints at once and the painter holds `touch-action: none` (Q-R11); the keyboard and
  screen readers use the typed lines, and each day column is named with its hours.
- **A line the editor refuses** (a start equal to its end) is not drawn as a run and is never
  normalised by a paint or a template: it stays in the typed lines, flagged, until fixed. The
  painter's gridlines are every hour (strong) and every half hour (faint), the grain of the gesture;
  its height is clamped (30 to 40 rem). **The keyboard's route is the typed lines below**, said in
  the hint under the painter.
- **Templates** replace the week (the dated lines stay, and it is still a draft until saved):
  Toujours ouvert (24/7, which the existing warning names), Jours ouvres 8h-20h, Vide, and
  Evenement ponctuel (an empty week plus one dated line to fill). A template wipes unsaved paint
  without a confirmation: nothing is saved until the button, and leaving warns.
- **Dated lines have their own list** and the per-line "type" select is gone (a line is weekly or
  dated by the list it sits in). Not built: hiding the week under the event template, as the mockup
  draws - the painted week stays visible.

**Proof.** `availabilityPaint.test.ts` (round trips incl. a night and a Sunday night, merge, split,
off-grain edges kept, to 24:00, the same rows back when nothing changes, mode from the pressed cell,
templates, dated lines kept) and `AvailabilityEditor.painter.svelte.test.ts` (templates, a drag over
days, a close splitting a run, a night as two stored halves, one cell, dated lines kept) on the real
editor. **Not yet seen** on a phone: the finger painting and the painter's height (clamped, 30 to 40 rem) are the
readings owed.

## Painting a fixed-slot space (decided by the owner on 2026-10-29)

**Decision: on a `slots` space, painting opens or closes WHOLE fixed slots, one by one, and NEVER
merges them.** Before it, the WP-R4 painter read every week as merged runs, so on a fixed-slot space
a paint anywhere rewrote touching slots (14:00-14:25, 14:25-14:50) as ONE line - one long slot.
The creation wizard (WP-R7) makes such spaces common, which is how it was found.

- **The mode is the SAVED one** (`fixedSlots`, from `SpaceEditor` through `ResourceEditor` to
  `AvailabilityEditor`): the server cuts by the stored mode, so an unsaved switch does not change
  what a paint means.
- **Drawn apart**: `weekSlotsOf` gives each weekly line its own run (never merged), each with its
  own border in `WeekPainter`; a `step` space keeps `weekRunsOf`, where touching hours ARE one
  window.
- **Close** (`paintSlotRows`): every slot the rectangle touches goes, whole - a slot is never cut.
- **Open**: new slots of `slotLengthFor` - the space's STORED `slotMinutes` (below), else
  `slotLengthOf` (the week's most common slot length, ties to the shorter; the 30-min grain when
  there is none), one for each start inside the rectangle, never past 24:00,
  skipping any that would overlap a slot already there. A tap on a closed cell opens one slot; with
  25-min slots a 30-min cell holds two starts, so it opens two. A slot crossing midnight is ONE
  slot: drawn on both days, closed whole from either.
- **THE SLOT LENGTH IS STORED (decided by the owner on 2026-10-29, built for 1.5.1).** Found in the
  review of #2691: the wizard's "Creneaux fixes" length only shaped the lines it cut
  (`fixedSlotLines`, WP-R7), so the lines were the only evidence and an emptied week fell back to
  the grain. Now **migration 116** adds a nullable `booking_spaces."slotMinutes"`, held by the CHECK
  `booking_spaces_slot_minutes` (NULL, or a `slots` space and 15 to 120 minutes - the mirror of
  `booking_spaces_step_shape`, the range the wizard's `SLOT_LENGTH_CHOICES` span). The DTO field
  (`SpaceSettingsDto.slotMinutes`, so `CreateSpaceDto` too) is validated to the same range; the
  service refuses a length on a step space, or out of range, as `slot-shape`, and a switch to
  `step` that does not name one CLEARS it, as a switch to `slots` clears the step pair. Written by
  the wizard's ONE create call (`wizardPayload`, slots only) and by the settings' mode switch: the
  "Duree d'un creneau" field under the mode in `SpaceEditor` (a SAVED step space switched to slots
  starts at 30 min; going back to the saved mode restores the saved length). Returned by the
  managed read (`managedSpaceView`), and handed through `ResourceEditor` to `AvailabilityEditor`
  as the SAVED value, read by the painter (`slotLengthFor`) BEFORE `slotLengthOf`.
  **No backfill**: a slots space created before 116 keeps `slotMinutes` NULL and keeps inferring
  its length from its lines, as it did before; its editor offers "Lue dans les creneaux existants"
  until a length is chosen and saved. **Not personal data** (one number describing a space's
  configuration), so the [register of processing](compliance/register-of-processing.md) is
  unchanged.
- **The cap** (`MAX_AVAILABILITY_LINES`, 200, the server's DTO, now in `availability.ts` and shared
  with the wizard): an open stops at it and counts what it could not open (`refused`); the painter
  says so in the wizard's sentence (`bookings_avail_lines_cap`), so a drag over a week of 25-min
  slots no longer ends in a save the server refuses whole.
- **Untouched**: dated lines, lines with a problem, the templates (they still replace the week with
  runs: on a fixed-slot space "Jours ouvres 8h-20h" is one 12 h slot a day, as before), the typed
  lines. The hint under the painter says what a press does there.

**Proof.** `availabilityPaint.test.ts` (slots read apart where the step reading merges them; the
length; a close removes only the touched slots, whole; an open lays whole slots and skips the
overlaps; a tap; the same rows when nothing changes; dated lines kept; an empty week; a slot
spanning midnight; the cap and its count; the saved lines round-tripped) and
`AvailabilityEditor.painter.svelte.test.ts` (mounted: a press closes one slot alone; a paint
elsewhere leaves touching slots three lines and three drawn runs; a step space still merges; a
paint at the cap says so and saves 200 lines).
Control: with the step painting on a fixed-slot space, the "touching slots separate" test fails.
The stored length (migration 116): `availabilityPaint.test.ts` (the stored length first, the lines
only when none is stored; an emptied week opens slots of the stored length, the grain when unstored;
a stored length beats the lines'), `AvailabilityEditor.painter.svelte.test.ts` (mounted: an emptied
week with a stored 45 min opens 14:00-14:45 and says so; an unstored space still reads its lines),
`wizard.test.ts` (the slots payload carries `slotMinutes`, the step one does not),
`spaceSettings.test.ts` (read back, unstored kept null, a switch to step sends null),
`SpaceEditor.hiddenColumn.svelte.test.ts` (the mounted switch saves 30 then null),
`create-space.dto.spec.ts` (15..120 whole or null, nothing else), and
`bookings.service.integration.spec.ts` against PostgreSQL with 087 onwards applied twice (create
and read back, the switch writes and clears it, `slot-shape` on a step space and out of range, the
CHECK under the service; the schema-equality test holds the entity's CHECK to the migration's).
**Not yet seen** on a phone.

## WP-R5 as built - the organiser's dashboard (D50, 2026-10-29)

A new page, `routes/bookings/spaces/[spaceId]/manage`, reached from the booker's page (the icon that
led to the editor) and from the entity tab's list ("Tableau de bord"). Its actions: the booker's
page, the export, the settings (the editor). A reader who does not manage the space reads one
sentence and nothing else; the server refuses every organiser read anyway.

- **THE SERVER: `GET spaces/:id/bookings` GAINED `from`** (an instant with `Z` or an offset, else
  400 `from`, `parseFrom`). With it the list is the LIVE bookings (never cancelled) that END after
  that instant - the one under way first - by start, paged as before. Without it the list is the
  whole history, unchanged (D29's `ids` and the export still read that). Before, the coming ones
  sat behind every past booking of the space.
- **"A venir"** (`UpcomingBookings.svelte`): the first page (50) from the device's now, then "Voir
  plus" continuing the SAME list (the same `from`, a row never listed twice if a cancel shifted the
  pages). Grouped as the mockup (#2579, `dashboard.html`) draws it: under the day each booking
  starts on in the space's zone - "Aujourd'hui", "Demain", then the date (`upcomingDays`; one under
  way since yesterday reads under today). Each row: the times, its column when columns are shown
  (D44), the holder, "pour son compte" (D20), the participants; the one under way is marked and has
  no cancel (D5). **The cancel opens IN ITS ROW** ("Garder" / "Annuler la réservation"), no dialog
  over the list; its sentence is the D13 one until WP-N adds the optional message and replaces it. The first read shows a spinner, never the empty sentence; a cancel that succeeded but whose
  re-read of the list failed says exactly that, and still redraws the week.
- **The layout**: from `lg` the week and "A venir" sit side by side (the mockup's desktop); below
  it a segmented control shows one at a time. The counters are one line of pills.
- **"Planning"** is `SpaceWeek.svelte` in `block` mode. **`SpaceWeek` is the booker page's week
  EXTRACTED** (column selector, week bar or day strip, grid, the three sheets, the read guard), so
  the two pages draw one implementation; the booker's page keeps only its load, poster, link and
  QR code. In block mode a tap on a free unit opens "Indisponible", and **a drag draws a RED range**
  (`SpaceGrid` `blockMode`): as long as a block may be (`BLOCK_LENGTH_CHOICES`) instead of a
  booking's step ceiling, in slots mode too, and still stopped by `dragRange` at the first unit that
  is not free - so it never crosses a booking; a stale grid still meets `bookings-inside-block`,
  whose named bookings the sheet lists with their cancel. `BlockSheet` gained `initialCount`, the
  length the drag drew. A taken unit opens the existing detail: who, answers, cancel.
- **The counters (Q-R16)** come from the SAME week read as the grid, every column
  (`lib/bookings/dashboard.ts`, pure): distinct bookings, hours taken of hours offered (overlapping
  fixed slots each count whole: it is what was offered), distinct blocks; a unit belongs to the
  day it starts on, as on the grid.
- **"Ajouter une colonne" (D44)** is a card while the space has its one hidden column; it leads to
  the editor, where a column is named (the naming lives there since WP-R1). Both tabs stay mounted,
  so the counters follow the week and a cancel in one re-reads the other.
- **The export** is one function now (`downloadSpaceExport`), shared by the editor and the dashboard.

**Proof.** `bookings.service.integration.spec.ts` "lists only the LIVE bookings still to come from
`from`" (an ended, an under way, a cancelled and two coming bookings: only the under way and the
coming, paged; the whole history without `from`; a booker refused); `bookings.controller.spec.ts`
(`from` without a zone refused before any query); `SpaceGrid.drag.svelte.test.ts` "block mode"
(past the booking ceiling, in slots mode, stopped by a unit that is not free);
`UpcomingBookings.svelte.test.ts` (read from now, under way without cancel, cancel re-reads and
tells the page, "show more" from the same instant without duplicates); `dashboard.test.ts`; the
booker page's `page.weekRead` test, unchanged, passes on the extracted week. **Not yet seen** at
390 / 1280 or on a phone: the red drag under a finger is the reading owed.

## WP-R6 as built - the settings in plain words (D51, Q-R13, 2026-10-27)

Front only: no setting is added or removed, the draft and the PATCH are unchanged.

- **Titles, as Q-R13 drew them**: L'essentiel / Quand peut-on reserver ? / Qui peut reserver, et que
  demande-t-on ? / Regles de reservation / Donnees (accents in the messages). D35's five sections and
  their order stay.
- **Each title carries the section's CURRENT answer on a line below it** (`FormSection` gained an
  optional `summary`, rendered OUTSIDE the header button, which it describes through `aria-describedby`; the heading wraps the button and the button holds only spans; `lib/bookings/spaceSummaries.ts`, pure over the
  draft, so it follows an unsaved change). "When" reads the mode (steps of N min, M at most, or fixed
  slots) and the column count from two; "who" reads audience, names, discoverability and the number
  of questions; the other three keep a fixed hint.
- **Two fields moved to "who"** (Q-R13): the people ceiling (from the collapsed rules) and the
  after-booking information (from "General"). The collapsed rules' badge stopped counting the ceiling
  (`activeRuleCount`), since it is always in view now. The data section gained a badge with the
  retention (`7 j`), the rules badge is unchanged.
- **Not done**: the questions stay their own card (`FormQuestionsSection`, shared with forms) right
  after "who" instead of being merged into it, so the title "...et que demande-t-on ?" sits over the
  audience block and the card follows it; the numbered tiles of the mockup are not drawn; the radio
  "choice" cards of the mockup are the existing segmented controls and toggle. The wording of
  options other than titles is untouched.

**Proof.** `spaceSummaries.test.ts` (each line, an unsaved change, fixed slots and columns, a
half-typed step), `SpaceEditor.sections.svelte.test.ts` (the mounted editor: titles, a line under
each, the two fields in "who" and absent elsewhere, the line following a click, the two last
sections closed with the retention badge), `spaceSettings.test.ts` (the ceiling no longer counted).
`paraglideMessages.test.ts` for the strings. **Not yet seen** at 390 and 1280 or at 200 % text.

## WP-N as built - the bookings notices and the reminder (D53, 2026-10-29)

**SWITCHED ON by the flip pull request** (built off, 2026-10-29):
`BOOKING_NOTIFICATIONS_ENABLED = true` (server, `booking-notifications.service.ts`) and its mirror
`BOOKING_NOTIFICATIONS_LIVE` (client,
`lib/bookings/notified.ts`, pinned equal by `notified.contract.test.ts`). The durable rule of
[legacy-compatibility](legacy-compatibility.md) - no new notification type before the floor covers
#1911 - is why the flip is a pull request of its own, merged on the `1.2.9` read-back. Off (set
back to `false`), nothing is written or sent, the reminder cron claims nothing, and the screens keep
D13's sentences, which are then true. The user guide and the privacy policy say the notices in the
same pull request.

- **Migration 115** (`115_booking_notifications.sql`): `booking_spaces."reminderMinutes"` (the
  space's default, 60 for every space including the existing ones, NULL = none, 5..10080 by a
  CHECK), and on `bookings` (the holder) and `booking_participants` (each participant)
  `"reminderMinutes"`, `"reminderSetAt"`, `"reminderSentAt"`, with a partial index each on the due
  scan. A booking written before the migration has NULL: nobody is reminded of it. No erasure
  change: the columns hold no account reference and go with their rows.
- **Who is told** (`BookingNotificationsService`, after the commit, best-effort and logged): an
  ORGANISER's cancellation reaches the holder and every participant still in, with the organiser's
  optional word (Q-R3, `POST :id/cancel { message }`, at most 500 characters, carried by the notice
  alone); a HOLDER's cancellation the participants (Q-R2), with no word; a WITHDRAWAL the holder
  (Q-R2); a BOOKING its participants and the holder of a booking made on their behalf (D20); a
  SPACE DELETED the people of its coming live bookings, read under the space's lock before the
  delete (Q-R4), after the delete's response. The one who acted is never told, the organiser
  never (Q-R7). An organiser acting on an association space is named as the ASSOCIATION, with its
  logo; **on a space reached by its link only, an organiser is named as NOBODY** - the platform's
  name, no face, no logo (review of #2692: the association's name, or the owner's, says what the
  space is, Q-R5). **The organiser's word on a link-only space goes to the bell row ONLY, never to
  the push** (decided by Master, 2026-10-29: a word on a lock screen can name what the space
  hides); the row is written without its push and the neutral push sent on its own.
- **What it says**: four types, `booking_cancelled`, `booking_withdrawn`, `booking_added`,
  `booking_reminder`, a bell row and a push each through `PostNotificationsService` (contentKeys
  `social_booking_*`, category `bookings`, Q-R15). `text` is the place (`bookingPlace`) - or the
  word, or for a reminder the place and the start time on the space's clock - and is EMPTY on a
  space reached by its link only (Q-R5): the push then shows a fixed sentence and never the
  space's name. A tap opens Reservations (`target: 'bookings'`, host `bookings`).
- **The reminder** (`BookingReminderScheduler`, every minute): one predicate per table over the
  durable columns - a delay, not yet sent, live, not started, its instant (`startsAt` minus the
  delay) reached, and that instant still ahead when the delay was chosen (`reminderSetAt`: a booking
  made inside its delay gets none, Q-R6). Each batch is selected `FOR UPDATE SKIP LOCKED` and stamped
  in one transaction committed BEFORE any send: two replicas never both send, a crash after the
  commit loses that reminder (at most once, as the forms reminder). The reference test runs two at
  once and counts one per person.
- **Each person's delay** (Q-R1): the holder's from the booking request (`reminderMinutes`, absent =
  the space's default; never for an account booked on behalf of), a participant's the space's
  default; `PATCH bookings/:id/reminder { minutes }` for the holder or a participant still in,
  refused once cancelled or started; choosing re-arms the claim. `mine` returns the reader's own.
  The organiser's default is a space setting (`reminderMinutes`).
- **The bell row's place and slot** (cancellation, withdrawal, booking; fix of 2026-10-30, measured on
  dev `1.5.1-alpha.8`: the word had replaced the space's name and no row named the slot) ride a nullable
  `post_notifications.meta` jsonb (**migration 117**, approved by the owner 2026-10-30, applied with the
  1.5.2 deploy): `{ place, startsAt, timeZone, word }` - the place (empty on a link-only space, Q-R5),
  the slot's START as a UTC instant, the space's IANA zone, the organiser's word ('' when none).
  **`text` KEEPS what it always was - the word, else the place - because every client older than the
  column draws `text` and nothing else, and the native apps embed old frontends** (a `text` of the word
  alone showed them "X a annule votre reservation" with no place: review of #2707). Nothing is parsed out
  of `text`; the new client (`lib/bookings/noticeText.ts`) reads `meta`, draws the slot on the SPACE's
  clock in the reader's language, as the reminder does, and quotes the word through a Paraglide key. A
  row with null `meta` (every row before the migration) renders exactly as before. **The push is
  unchanged** (place, or the word off a link-only space; never the slot). C17 and the privacy policy's
  Reservations paragraph say it: the notice names the place (the space AND the resource, which may bear a
  person's name) and the slot's start, kept 90 days, after the space is deleted too. The bell badge is the
  shared 60 s `postNotifStore` poll for EVERY notification type; no type has a live signal, so a booking
  notice not showing at once is the design, not an omission.
  **No deploy gap**: the entity selects `meta`, but `deploy-environment.sh` applies the migrations (after
  starting only postgres) BEFORE it replaces any service, so new code never meets the old schema; only a
  rollback meets old code on the newer schema, and old code ignores an additive nullable column
  ([social-service](services/social-service.md#a-query-at-boot-runs-before-the-migration-that-adds-its-column-2026-10-02)).
- **The client** knows the four types (`KNOWN_NOTIFICATION_TYPES`, `notificationHref` ->
  `/bookings`, `NotificationRow` sentences and glyphs), the `bookings` host, the `bookings`
  settings category, and the three native tables carry the four keys.
- **Preset delays** offered by the screens: 15 min, 1 h, 24 h ("la veille"), none. The mockup's
  "la veille a 18:00" is a wall-clock time, not a delay, and is not built: 24 h before stands in.
- **The screens** (all behind `BOOKING_NOTIFICATIONS_LIVE`, so off they are exactly D13's): the
  space's default reminder in its settings (`SpaceEditor`, sent only when live), the booker's own
  in the booking sheet (never when booking on behalf of), each person's own on their booking card
  (`MyBookingCard`, holder or participant still in, reverted on a refusal); the organiser's
  optional word in the dashboard's in-place cancel (`UpcomingBookings`, trimmed, a blank word is
  no message, capped at the server's 500); and every "nobody is told" sentence swapped for the one
  saying who is (delete space, organiser cancel, booking for someone, stranded bookings, the
  booker's notes). Presets and their labels: `lib/bookings/reminder.ts`.

## WP-R7 as built - the creation wizard (D52, Q-R14, 2026-10-29)

Front only: `POST spaces` already took every setting, a poster and the first hours (WP-R1), so the
wizard is ONE call and a space is never half made.

- **Offered on every creation** (Q-R14): the name typed in the tab (`EditBookingsTab`, the entity
  tab and the personal spaces of Reservations alike) opens `SpaceWizard` with it. "Je regle tout
  moi-meme" creates by the name alone, as before, and both land on the space's editor. "Annuler" on
  the first step closes it with nothing written.
- **Three steps, as the mockup** (`wizard.html`): C'est quoi ? (name, one sentence, poster);
  Quand ? (the four templates of D49, the week painted with the same `WeekPainter`, or the one
  dated line of "Evenement ponctuel"; how long a booking lasts: "Au choix" up to N by steps of M,
  or "Creneaux fixes" of one length); Pour qui ? (everybody or the audience editor, names or
  "Occupe", listed or link only).
- **Only what the steps asked is sent** (`wizardPayload`, `lib/bookings/wizard.ts`): everything
  else keeps the SERVER's default (no rule, answers kept 7 days). The defaults drawn are the
  mockup's: a working week 8h-20h, up to 2 h by 30 min, everybody, names hidden, listed.
- **Fixed slots are cut on the client** (`fixedSlotLines`): in a `slots` space each line IS a slot
  (WP-B2), so the painted hours become one line per slot; a tail shorter than a slot is not
  offered and no slot crosses midnight. More than `MAX_AVAILABILITY_LINES` (200) is said on the
  step before the server would refuse it (a 24/7 week in 30-min slots is 336).
- **The poster is uploaded when picked and claimed by the creation** (`SpacePosterField` with
  `spaceId` null): a wizard abandoned leaves a `poster-pending` upload to the media sweep
  (`POSTER_PENDING_TTL_MS`). "Je regle tout moi-meme" does not carry a picked poster. **While the
  upload runs, "Suivant" and the creation are held** (`onBusy`, review of #2687): otherwise a fast
  organiser created the space before the reference came back, and the poster was silently lost.
- **The focus moves to the new step's heading** on "Suivant" and "Retour", so a screen reader
  follows the step change.
- **Factored**: the weekday names of the painter (`weekdayNames`, `availability.ts`), shared with
  `AvailabilityEditor`.

**Found building this, decided by the owner on 2026-10-29:** the WP-R4 painter read every week as
merged runs, so on a `slots` space a paint rewrote touching slots as ONE long slot - and the wizard
makes such spaces common. Decision: painting a fixed-slot space opens or closes WHOLE slots, one by
one, and never merges them. Built apart from the wizard, in #2691 ("Painting a fixed-slot space").

**Proof.** `wizard.test.ts` (slot cutting, the problems, the payload, and the WP's proof: a wizard
payload over the server's defaults read back through `draftFromSpace`/`settingsFromDraft` is the
same settings) and `SpaceWizard.svelte.test.ts` (the mounted wizard: three steps, a step held with
its sentence, ONE `createSpace` with the hours and fields, the owner passed, the steps held during a
poster upload and the poster then carried - control: without `onBusy` that test fails -, the dated
line of "Evenement ponctuel" held until dated then sent, the focus on each step's heading, the skip
creating nothing). **Not yet seen** at 390 and 1280, on a phone, or against a running API.

## Decisions taken by Master on 2026-10-27 (user delegated)

The user delegated the sixteen questions the redesign's mockups raised (#2579, Q-R1..Q-R16) to
Master, who took the default the mockups drew for each, except Q-R1, Q-R2, Q-R4, Q-R5 and Q-R15.

| # | Question | Decision |
|---|---|---|
| Q-R1 | Who sets the reminder delay (D53) | **The organiser sets the space's default; each person may change it on their booking; "no reminder" is allowed.** |
| Q-R2 | Notify on a holder's own cancellation, a participant's withdrawal | **Yes, both ways**: a holder's cancellation notifies the participants, a withdrawal notifies the holder. |
| Q-R3 | An optional message with an organiser's cancellation | Yes, carried by the notification only, not stored in the history. |
| Q-R4 | Notify the people of coming bookings when a space is deleted | **Yes.** |
| Q-R5 | What a push shows on a lock screen for a LINK-ONLY space | **A neutral text, never the space's name.** |
| Q-R6 | A booking made inside its reminder delay | No reminder. |
| Q-R7 | Tell the organiser when someone books or cancels | No. |
| Q-R8 | Keep the one-day grid of all columns for the organiser | No: removed with the planning. |
| Q-R9 | A space back to one column | Its column hides again (D44's rule is "exactly one column", WP-R1). |
| Q-R10 | Closed days fold to a narrow strip in the week | Yes. |
| Q-R11 | The painter's grain; a finger on the painter | 30 min, the text rows for exact times; a finger paints at once. |
| Q-R12 | "Apply these hours to every column" | Not built. |
| Q-R13 | Section placement and titles | As drawn: the people ceiling and the after-booking info in section 3; titles L'essentiel / Quand peut-on réserver ? / Qui peut réserver, et que demande-t-on ? / Règles de réservation / Données. |
| Q-R14 | When the wizard is offered | On every creation, skippable ("Je règle tout moi-même"). |
| Q-R15 | A "Réservations" category in the notification settings | **Yes.** |
| Q-R16 | The dashboard's counters | Yes, as drawn. |

## Accords recorded

User, 2026-10-15, in session (relayed by the planning session, recorded at Master's request),
covering: D1-D3 of the paid-form chantier, the backfill of migration 083, the data half of migration
084 before production, `minClientVersion` 1.2.7 (the user's own action), the anonymous-form file
question refused, and Lydia states 1 and 5 to be measured by hand. No later work package starts
until the lead session says so.

## Open

- Validation of the work-package plan below by the user, then the pull request carrying this page and the backlog pointer.

## Coordination

The user asked for coordination with the main session "Master" (identifier `eb064059`). It answered
on 2026-10-15 from the session `canari-77`. Its rules: this session plans (wiki and backlog by pull
request, no code); the user validates; then work runs in batches as DRAFT pull requests on a branch
or worktree of its own. **Only Master marks a pull request ready, merges and releases**, after an
adversarial review. The user is told when a batch is ready and passes it to Master.


## Code anchors, measured 2026-10-15 (read-only exploration, `main` at 990ba8fe9)

Paths are relative to the repository root. Line numbers drift; the symbol is the anchor.

| Need | Anchor | Note |
|---|---|---|
| Grid vs planning views | `frontend/src/routes/calendar/+page.svelte` (`CalendarScheduleList`, `MonthCalendarGridRich`); default from `frontend/src/lib/utils/viewport.ts` `SCHEDULE_AGENDA_QUERY` (below `md` = planning) | No user toggle; SSR answers "desktop" and the mount corrects it. The planning is a rolling window, not a month. |
| "Add to my calendar" | `frontend/src/lib/components/calendar/AddEventToCalendarButton.svelte`, `lib/calendar/agendaExport.ts` (`AgendaExportEvent`, `buildIcsCalendar`, `googleCalendarTemplateUrl`) | Not a native API: iOS opens a server-hosted `icsUrl`, others get a modal (ICS download plus a Google link). A booking needs a mapper like `toAgendaExport` and probably a hosted ICS route. Some modal labels are hardcoded English. |
| Rights bit | `apps/social-service/src/associations/entities/association-member.entity.ts` (`MANAGE_FORMS = 1 << 4`; next free bit `1 << 11`), `ALL_CORE_FLAGS`, `SUPER_ADMIN_EXCLUDED_FLAGS`; frontend mirror `frontend/src/lib/associations/api.ts:20-46` | Two hand-copied enums, change both. The `ALL_CORE_FLAGS` comment stated 1311 and is 3359 once bit 11 is in (draft PR #1904). `permissions.test.ts` and `association-permissions.dto.spec.ts` guard the trap. A BDE super-admin inherits every flag not excluded. |
| Role editor row | `frontend/src/lib/components/associations/AssociationMemberRow.svelte` `FLAG_LABELS`; messages `asso_flag_manage_*` in `frontend/messages/fr.json` and `en.json` | The only screen that grants a flag: omit the row and the right cannot be given. `paraglideMessages.test.ts` constrains labels. |
| Guard pattern | `apps/social-service/src/forms/forms.service.ts` `assertFormManager`, one policy `AssociationsService.mayAct` | No second axis. Route-level alternative: `PERM_FLAG_KEY` with `GlobalAdminOrAssociationRoleGuard`. |
| Entity tab | `frontend/src/lib/associations/editSections.ts` (`EDIT_SECTIONS`, `editRights`, `mayOpenEditSection`), wiring in `frontend/src/routes/associations/[slug]/edit/[[section]]/+page.svelte` | The `EditSection` type is exhaustive, so a missed case does not compile. Lists have their own SHORT roster (`LIST_EDIT_SECTIONS`). |
| Main navigation | `frontend/src/lib/navigation/places.ts` (`APP_PLACES`, `mobileNav`), `placeIcons.ts`; consumers `AppSidebar`, `BottomNav`, `NativeTabBar`; also `swipeNavigation.ts`, `seo/sitemap.ts`, `deepLinkRoutes.ts` | **The mobile bar is full at four places** (posts, communities, chat, dashboard) and feeds the iOS native tab bar. |
| Page widths | `frontend/src/lib/components/layout/pageWidth.ts` | Exactly three shapes, tested: a slot grid is `grid`, the settings page `tool`. |
| QR code | `frontend/src/lib/components/shared/QrCodeModal.svelte`, `lib/utils/publicAppUrl.ts` | Feature-agnostic; needs an absolute-URL builder for a space. |
| Block between two accounts | `apps/social-service/src/common/user-blocks.ts` `isBlockedBetween` | Symmetric, so it cannot say who blocked. A DECLARED DUPLICATE of the chat-delivery copy: never edit one side. |
| Question types | `frontend/src/lib/forms/questionTypes.ts` `QUESTION_TYPES` (plain `string`, no union), `FormBuilder.svelte` (`hasOptions` is a DENYLIST: a file type falls into the options editor unless added), `itemsPayload.ts` `TYPES_WITHOUT_OPTIONS` (second copy), `FormQuestion.svelte` (an `{#if}` chain with no `{:else}`: an unknown type renders NOTHING), `fillAnswers.ts` (`hasValue`), `submissionTable.ts` `COLUMN_TYPES` (allowlist) | Backend `FormItemDto.type` accepts any string and `forms.service.ts` never validates an answer against its item's type: ownership, size and type checks of a file are new. |
| Answer reading | `frontend/src/lib/forms/answerText.ts` and `apps/social-service/src/forms/answer-text.ts` | Byte-identical declared duplicates (`declared-duplicates.mjs`): edit both identically. |
| Answer shape | `apps/social-service/src/forms/dto/form.dto.ts` `IsValidAnswers` (string up to 2000, string[] up to 50, number) | A file answer stored as a media id string fits. Matrix answers are objects: check how they pass before relying on it. |
| File storage | `apps/media-service/src/media/storage.service.ts` (Garage, bucket `canari-media`); metadata is a JSON file (`media_meta/media_metadata.json`), not Postgres | media reads return ciphertext only; confidentiality is client-side encryption. **No precedent exists for plaintext served only to authorised readers.** |
| Server-to-server read | `media.controller.ts` `GET /media/internal/:id` (`X-Internal-Secret`) | The nearest building block, with social-service as the gate; it forces `application/octet-stream`. |
| Retention classes | `media.service.ts` `RetentionClass` (ephemeral, archive, association, reel, reel-pending, chat-reel), `internal/retention-class` special cases; mirror `frontend/src/lib/media.ts` | A new class must be added in all three. The 2026-09 incident: an upload with no class was swept. |
| Purge precedent | `apps/social-service/src/posts/reel-retention.scheduler.ts` (`@Cron`, "THE STATE IS THE ROW", blobs first then row, a `running` flag), `internal/reel-media.ts`, `media.service.ts` `purgeReels` | **It deletes the row too: there is NO "delete the file, keep the row" precedent.** Bookings need their own predicate (a file id still set and slot end + N days past) and clear the column after the blob is gone. Pattern for the scheduler: `forms/forms-reminder.scheduler.ts`. |
| XLSX | `forms.service.ts` `exportSubmissions`, `forms/export-labels.ts` (`ExportLabels`, `parseExportLabels`), `frontend/src/lib/forms/api.ts` `exportLabels()` | Hard-wired to forms: bookings reuse the PATTERN, with their own required label keys. |
| Migrations | `apps/social-service/src/migrations/`, highest `082_channel_cleared_marks.sql`, so next free is **083** (re-check at PR time); `synchronize:false`, idempotent files, never edit an applied one | Bit-flag precedent `004_manage_stripe_connect.sql`; bit 10 (`MANAGE_PARTNERSHIPS`) had no backfill migration. |
| Database | PostgreSQL 18 on both estates (`docker-compose.prod.yml:110`) | `EXCLUDE USING gist` is available. `btree_gist` is created nowhere yet: start the migration with `CREATE EXTENSION IF NOT EXISTS btree_gist` (trusted since PG13; core-service already runs `CREATE EXTENSION` as the same role). A constraint has no `IF NOT EXISTS`: guard it with a `pg_constraint` check in a `DO` block. |

## What the exploration surfaced, for the decisions it forces

- **E1. The mobile bar is full** (D16): settled by D37.
- **E2. Lists have a short edit roster** (D16): settled by D38.
- **E3. A file question on a PUBLIC form is an unauthenticated upload** (the media upload needs a JWT). Settled by D40: refused.
- **E4. Server-readable files are a NEW path** (D22): a new retention class, an owner check at upload, and a manager-gated read in social-service through the internal route, with its own `Content-Type` and `Content-Disposition`. Never `GET /media/public/:id`.
- **E5. The purge keeps the row** (D8, D18): new predicate and a column cleared after the blob is gone, idempotent from the row itself.
- **E6. Backfill of `MANAGE_BOOKINGS`** (D30): settled by D39.
- **E7. Add to calendar** (D13) needs a hosted ICS route for iOS, and a mapper.

## The work packages, in order (draft 2026-10-15, to validate)

One draft pull request per package, rebased on `main`, the next free migration number re-checked
when each is opened (083 on 2026-10-15). Only Master marks ready, merges and releases.

| WP | Scope | Named starting point | Proof it is done |
|---|---|---|---|
| **WP-F** (DRAFT PR #1908, 2026-10-15, migration 084: built; the media class `form-file` and its two internal routes `internal/form-file` and `internal/form-file-purge` are reusable as they are; the purge to reuse is `purgeExpiredFiles` in `apps/social-service/src/forms/file-retention-purge.ts`, each candidate `{ fileId, ownerId, start, retentionDays }` so for bookings `start` is the slot end; size cap 8 MiB because the host firewall drops bodies over 10 MiB; a file question is refused on PUBLIC and on ANONYMOUS forms, the second being the agent's choice to confirm with the user: the file row and the blob owner name the uploader) | FILE question type for forms: type everywhere it must exist, server validation of ownership, size and type, a new media retention class, a manager-gated read, expiry and purge, refused on a public form (D40) | `frontend/src/lib/forms/questionTypes.ts`, `FormBuilder.svelte` (`hasOptions` denylist), `FormQuestion.svelte`, `apps/media-service/.../media.service.ts` `RetentionClass`, `apps/social-service/src/posts/reel-retention.scheduler.ts` as the scheduler pattern | A manager downloads a file; a stranger holding the id gets nothing readable; a purged file leaves the row; a second purge changes nothing |
| **WP-B0** (MERGED as #1904, 2026-10-15: the backfill migration is `083_manage_bookings.sql`; a list's role editor needed NO change, so the list roster work moves to WP-B4, which adds an `EditSection` key, an `editRights` entry and a `mayOpenEditSection` case, and changes the 'list has three sections' test) | `MANAGE_BOOKINGS`: bit `1 << 11`, both enums, role-editor row, Paraglide labels, backfill of `MANAGE_FORMS` holders (D39), the list roster (D38) | `association-member.entity.ts`, `frontend/src/lib/associations/api.ts`, `AssociationMemberRow.svelte` `FLAG_LABELS`, `editSections.ts` | `permissions.test.ts` and the DTO spec pass; the right is grantable from the editor |
| **WP-B1** (MERGED as #1963, 2026-10-17, migration `087_bookings.sql` because #1940 holds 086: see [WP-B1 as built](#wp-b1-as-built-2026-10-16)) | Data model and migration: space, resource, availability rules, exceptions, blocked ranges, booking, participants; `btree_gist` and an EXCLUDE constraint on (resource, time range) among live bookings; deletion of a space deletes everything (D27) | `apps/social-service/src/migrations/` (next free number), `docs/wiki/infrastructure/databases.md` rules | Two concurrent inserts on the last slot: exactly one wins, in a real database |
| **WP-B2** (DRAFT PR, 2026-10-17: see [WP-B2 as built](#wp-b2-as-built-2026-10-17)) | Slot generation on demand (step or predefined slots), booking window, quotas, withdrawal delay, zone handling, the rule that refuses an availability edit with bookings inside (D29). **A window crossing midnight is TWO rules** (22:00-24:00 and 00:00-02:00 the next day): `booking_availability_rules_order` requires `startTime < endTime`, and generation must join them back into one window | A new `bookings` module beside `forms`; `AssociationsService.mayAct` as the only rights policy | Table-driven tests across a daylight-saving change |
| **WP-B3** | API: book, cancel, participant withdraws, organiser blocks, books on behalf, cancels (D20); frozen history (D15); block honoured (`isBlockedBetween`); private fields returned only to the booking's people (D32) | `apps/social-service/src/common/user-blocks.ts`, `forms.service.ts` `assertFormManager` as the guard shape | A past booking refuses every write; a stranger never receives a private field |
| **WP-B4** | Organiser screens: five settings sections (D35), resources, availability, questions reused from forms, the entity tab. The availability editor writes a window crossing midnight as two rules (see WP-B2) | `editSections.ts`, `routes/associations/[slug]/edit/[[section]]/+page.svelte`, `FormSection.svelte` and `FormAdvancedSettings.svelte` as the pattern | Seen at 390 and 1280 on a real build |
| **WP-B5** | Booker screens: grid and planning (D14), my bookings, the dashboard card (D37), the sidebar entry, link and QR code, "Add to my calendar" with a hosted ICS route (D13) | `routes/calendar/+page.svelte`, `viewport.ts`, `AddEventToCalendarButton.svelte`, `navigation/places.ts`, `QrCodeModal.svelte`, `pageWidth.ts` | Read on the Mi 9T and the iPhone |
| **WP-B6** | Purge of files and answers after N days, the platform maximum age of one year (D19, D23), XLSX export (D24); **the FILE question for bookings** (refused `file-question-not-yet` until then) and **the space POSTER (D35): its column, by migration, and its purge** - both carried over from WP-B4 | `reel-retention.scheduler.ts`, `forms/export-labels.ts`, `forms.service.ts` `exportSubmissions` | A purge run twice changes nothing; the export parses back |
| **WP-B7** | Device readings, a concurrency run with two real clients on one slot, the wiki page of the module, the user guide in French | `docs/wiki/frontend/modules/`, `docs/user-guide/` | Both phones read; the board of readings recorded |

Order: **WP-F and WP-B0 can start in parallel** (they share nothing); B1 follows B0; B2 and B3
follow B1; B4 and B5 follow B3; B6 needs B3 and WP-F; B7 closes.

## WP-B1 as built (2026-10-16)

The data model only: migration `apps/social-service/src/migrations/087_bookings.sql`, the entities
in `apps/social-service/src/bookings/entities/`, and `BookingsModule` registering them. No service,
no route, no slot generation: nothing reads these tables before WP-B2.

**One tree, everything under a RESOURCE.** `booking_spaces` -> `booking_resources` -> {
`booking_availability_rules`, `booking_availability_exceptions`, `booking_blocks`, `bookings` ->
`booking_participants` }. Hours are per resource (D10), so there is no space-level rule: "the same
hours for every column" is written once per resource by the organiser screen (WP-B4). One parent
per row means a row can never name a resource of another space, and one cascade path. Every foreign
key cascades: deleting a space deletes everything, history included (D27), and an association's
spaces go with the association.

| Table | Holds | Decisions |
|---|---|---|
| `booking_spaces` | owner (`ownerId`, `associationId` NULL for a person), name, description, zone, `slotMode` (`step` with `stepMinutes`/`maxSteps`, or `slots`), `nameVisibility` (`occupied` by default), `discoverability`, `audience`, `items` (the forms' questions), `privateInfo`, the window (`opensAt`, `minNoticeMinutes`, `horizonDays`), the quotas (`maxActiveBookings`, `maxMinutesPerPeriod` + `quotaPeriod`), `participantWithdrawMinMinutes` (renamed from `withdrawalDelayMinutes` by 088), `maxPeople` (holder included), `retentionDays` (1..30, default 7) | D2-D9, D17, D23, D25, D26, D31-D33 |
| `booking_resources` | name, public `description`, `privateInfo`, optional `linkedUserId`, `position` | D10, D32 |
| `booking_availability_rules` | a LOCAL wall-time line: `weekday` (ISO 1..7) XOR `onDate`, `startTime` < `endTime`. In a `step` space a window cut into steps, in a `slots` space ONE slot | D3, D11, D25 |
| `booking_availability_exceptions` | whole local days removed, `fromDate`..`toDate` both INCLUDED | D11 |
| `booking_blocks` | "Indisponible" `[startsAt, endsAt)`, `reason`, `reasonVisible`, `createdById` | D10, D20 |
| `bookings` | `resourceId`, holder (id + name snapshot), `bookedById`, UTC `[startsAt, endsAt)`, `answers` + `answersPurgedAt`, `cancelledAt` + `cancelledById` (both or neither) | D4, D7, D15, D18, D20, D25 |
| `booking_participants` | surrogate `id`, `bookingId`, `userId` (one row per booking and account, a withdrawn row included (D36): a partial unique index that leaves the `'[deleted]'` tombstones out), name snapshot, `withdrawnAt` | D4, D15, D34 |

**The rule: `bookings_live_no_overlap`**, `EXCLUDE USING gist ("resourceId" WITH =,
tstzrange("startsAt", "endsAt", '[)') WITH &&) WHERE ("cancelledAt" IS NULL)`. Half-open, so
10:00-10:30 and 10:30-11:00 both fit; a cancelled row stays as history and frees its range; reviving
it over a live booking is refused. The text lives ONCE in `booking.entity.ts`
(`BOOKINGS_NO_OVERLAP_EXPRESSION`) and `booking.entity.spec.ts` requires the migration to carry it,
with every check, index and foreign-key name the entities declare.

**`btree_gist`** (the `=` on a uuid inside GiST) is created by 087 in `public`. Production's
migration role is a superuser (read 2026-10-16: `rolsuper = t`, `btree_gist` 1.8 available, not
installed), so nobody has to do anything; were that to change, the deploy fails with the sentence
naming the superuser command, and there is no application-level overlap check behind it. Where
`synchronize` builds the schema (development, the CI boot probe), `createDataSource`
(`src/common/synchronize-prerequisites.ts`) creates the extension first. Probed on a fresh database:
the extension and the exclusion are built, a second `synchronize` has nothing to do, and a schema
built by 087 differs from the entities in nothing.

**FOR WP-B3, MEASURED, NOT ASSUMED: lock the resource row before writing a booking.** Eight bare
concurrent inserts on one slot gave one winner and seven `40P01` deadlocks, not `23P01`. With
`SELECT id FROM booking_resources WHERE id = $1 FOR UPDATE` first, in the same transaction, every
loser is told `23P01` (`isExclusionViolation` in `src/common/pg-errors.ts`). The same lock is what
must serialise a block against a booking (D29): no constraint stops a block overlapping a live
booking. **For WP-B3: an ASSOCIATION space is managed through `MANAGE_BOOKINGS` on its association (`AssociationsService.mayAct`), NEVER through `ownerId`** - that column names the creator, becomes `'[deleted]'` with the creator's account, and grants nothing; only a PERSONAL space (`associationId` NULL) is managed by its `ownerId`. Also left to B3: the holder must not also be a participant (no cross-table check), and the
name snapshots are filled at write time. The file of a booking answer (D22) reuses WP-F's mechanism
in WP-B6, so B1 adds no file table. The poster of D35 is not a column yet: WP-B4 adds it with the
screen that sets it.

**Proof**, `apps/social-service/src/bookings/bookings.integration.spec.ts`, against PostgreSQL 18.6
(the production image): 087 applied twice; two transactions on the last slot, the second seen
WAITING on a lock (`pg_stat_activity`) and then refused `23P01` once the first commits, or accepted
once it rolls back; eight racers over twenty rounds, exactly one winner, all losers `23P01` with the
lock; adjacent ranges, another resource, a cancellation; the checks; deleting a space or its
association empties every child table and touches no other space. Controls: with the exclusion's
predicate made false, 6 tests fail; with the constraint absent, 8 (the two that read it from the
catalogue and the entity parity join them). Gated on `SOCIAL_IT_DATABASE_URL` like the other integration
specs; CI runs it in `test-social-integration` (#1915), on production's digest, the race tests included.

Indexes beyond the exclusion's own GiST: `bookings ("holderId", "startsAt")` (my bookings),
`("resourceId", "startsAt")` (a resource's bookings in time order, the D29 refusal) and `("endsAt")`
(the purges of D18 and D19 select on the slot's end).

### A deleted account (2026-10-16, review of #1963)

The bookings part of the account erasure ([account-erasure](account-erasure.md)) is
`BOOKINGS_ERASURE_STATEMENTS` in `apps/social-service/src/internal/account-erasure.ts`, spread into
`ERASURE_STATEMENTS` and run in the erasure's ONE transaction; every column below has its line in
`ACCOUNT_ERASURE_COVERAGE`, which the coverage spec checks against the entities. The shared contract
`libs/contracts/account-reference-columns.json` gained `holder`, `bookedby` and `cancelledby`, so a
column named like these can never ship unclassified:

| What the account left | What happens | Why |
|---|---|---|
| A PERSONAL space it owns (`associationId` NULL) | deleted, everything under it with it, **OTHER PEOPLE'S COMING BOOKINGS THERE INCLUDED: hard-deleted, and nobody is told** (no notification in v1, D13) | nobody else can manage it (D2); D27. A known cost, to be said on the booking screen of a personal space (WP-B5) |
| An association space it created | kept; `ownerId` becomes `'[deleted]'` | the association manages it |
| A COMING live booking it holds | cancelled, `cancelledById = '[deleted]'`, slot freed | a deleted account will not come |
| A coming participation | withdrawn (`withdrawnAt`) | same |
| The answers of every booking it held | purged now (`answers` NULL, `answersPurgedAt`) | its own data; nothing needs them any more (D18 applied early) |
| Its ids in history: holder, booked by, cancelled by, participant, block author | `'[deleted]'`, the tombstone every other social table uses | the history stays frozen (D15) without a link to a person |
| Its name snapshots (`holderName`, `userName`) | KEPT | D15: "a deleted account leaves the name it had"; bounded by the one-year maximum age of D19 (purge built in WP-B6) |
| A resource linked to it | unlinked (`linkedUserId` NULL) | the link grants a view, it is not history |

Proved on a real PostgreSQL by `bookings.integration.spec.ts` (one test per line above, two
tombstoned participants in one booking, and a second run changing nothing). Recorded as row C17 of
the [register of processing](compliance/register-of-processing.md).

**The statements run in the booking path's lock order: spaces, then resources, then bookings**
(review of #2002). Run the other way, an erasure racing a booking on a resource LINKED to the
account deadlocked: the booking held the space and resource and waited on the booking row the
erasure had just cancelled, while the erasure went on to unlink that resource. Measured, not
argued: `bookings.service.integration.spec.ts` runs both orders against a live booking; the right
one lets the booking land, the old one makes PostgreSQL abort the booking with `40P01`. A stray
`40P01` in `book` is answered 409 `try-again` (the transaction was rolled back whole), never a 500.

## WP-B2 as built (2026-10-17)

Pure functions, with no clock and no database, so every case is a table-driven test. One service
reads the tables for them. Nothing here is a route yet (that is WP-B3).

| File | Holds |
|---|---|
| `src/bookings/zoned-time.ts` | Local wall time in a zone <-> UTC, with `Intl` alone and no library. The holes are resolved as `Temporal`'s `'compatible'`: a time in a spring-forward GAP moves forward by the gap, and a time that exists TWICE is the EARLIER instant. `24:00` is the next day's 00:00. |
| `src/bookings/slots.ts` | `availabilityWindows`, `slotUnits`, `checkRangeShape`, `unitStates`, `bookingsOutsideAvailability` (D29) |
| `src/bookings/booking-rules.ts` | `checkBookingWindow` (D26, over `booking-window.ts`, the file the screen copies), `checkQuotas` (D17), `participantMayWithdraw` (D5), each refusal a CODE |
| `src/bookings/booking-slots.service.ts` | `spaceSlots(spaceId, from, to)` (at most 62 local days) and `assertAvailabilityChangeAllowed` (409 `bookings-inside-change`, naming the booking ids) |

**Generation.** A line applied to one local date is a PIECE.

- **Step space.** The pieces of ONE DATE are UNITED (overlapping or touching) into a window. A
  window is cut into steps of ELAPSED time from its start. A booking is 1..`maxSteps` consecutive
  steps of one window.
- **Slots space.** Each DISTINCT piece is a slot: two lines giving the same slot are one slot.
  Two OVERLAPPING slots stay two slots, and this is allowed on purpose: both are offered, and
  booking one shows the other as booked, because the exclusion holds one live booking per instant.
  Refusing them is left to the editor of WP-B4, which may warn.
- **A WINDOW CROSSES AT MOST ONE MIDNIGHT** (review of #1993, 2026-10-17). A date's window
  ending at 24:00 takes in the next date's TAIL: a window starting at 00:00 and ending before
  24:00. That tail is then no window of its own. A WHOLE day (00:00-24:00) is never a tail, so:
  - a 24/7 resource is one window per day, and a booking in it cannot cross midnight;
  - Monday 20:00 to Wednesday 02:00, written as three lines, is Monday 20:00-24:00, then Tuesday
    00:00 to Wednesday 02:00;
  - whole-day predefined slots stay one slot per day.

  Before this rule, every touching pair chained across any number of days: a 24/7 resource gave no
  window at all, so every booking was refused.

  **The cost, which organisers WILL meet:** on a 24/7 step resource a booking across midnight
  (23:00-01:00) is refused `outside-availability`, because each whole day is its own window
  (`slots.spec.ts` pins it). **The WP-B4 editor MUST warn** when a resource is open 00:00-24:00 on
  consecutive days that no booking can cross midnight there; a night that must be bookable across
  midnight is written as an evening line ending at 24:00 plus a morning line from 00:00 that ends
  before 24:00, which joins.
- **Which day a window belongs to.** A window belongs to the local date it STARTS on. Each date
  is decided from itself and its two neighbours only, so asking for one day gives exactly that
  day's part of a range. The invariant is tested over six availabilities in both modes, and the
  grid, `spaceSlots` and the D29 check all read the same windows.
- **Dates asked.** They must be real calendar dates (2026-02-30 is not). They are counted
  arithmetically before anything is built, so `z` or a range to 9999-12-31 is a 400 `slot-range`.
- **Change nights.** A 01:00-04:00 line lasts four hours on the fall-back night (eight steps of
  30 min) and two on the spring-forward night.

**The booking window (D26).** It refuses:

- `started`: a slot that has begun;
- `notice`: a slot starting sooner than `minNoticeMinutes`;
- `beyond-horizon`: a slot starting more than `horizonDays` x 24 h away (elapsed time, so the horizon
  slides with the clock);
- `not-open-yet`: anything before `opensAt`.

**Quotas (D17).** They count the person's LIVE bookings of the space, as holder or as a
participant who has not withdrawn.

- `active-bookings` counts the bookings not yet ENDED, so one in progress still counts.
- `minutes-per-period` sums the bookings STARTING in the same local day, or the same ISO week
  (keyed by its Monday).
- The organiser booking on someone's behalf is exempt: the caller (WP-B3) does not run the check.

**Withdrawal (D5), DECIDED BY THE USER ON 2026-10-17.** A PARTICIPANT may withdraw only until
`participantWithdrawMinMinutes` before the start, set per space (0 = until the start), so that a
last-minute withdrawal does not leave the holder short (`participantMayWithdraw`). The HOLDER and
the organiser may cancel AT ANY TIME before the start. After the start nothing moves, for anyone
(D15). The column was `withdrawalDelayMinutes` in 087, named after a holder delay that no longer
exists; migration 088 RENAMES it (and its CHECK) rather than adding a second column nothing would
read. It has had no reader yet, so there is no data to translate.

**D29.** A change of a resource's availability, or of the space's step, mode or step ceiling, is
checked against the coming LIVE bookings. Any booking that is no longer a bookable shape refuses
the change and is named. Blocking a free range is not such a change.

**Proof.** `zoned-time.spec.ts`, `slots.spec.ts`, `booking-rules.spec.ts` and
`booking-slots.service.spec.ts`, all table-driven. They cover both 2026 Paris changes, New York's
gap, the midnight join in both modes, exceptions, dated lines, alignment, the step ceiling and
every refusal code.

## WP-B3 as built (2026-10-17)

The API, under `/api/bookings` (nginx `location /api/bookings`, `auth_request` like `/api/forms`,
upstream `social-service:3014`). `BookingsController` reads the account from `x-user-id` and the
admin flag from `x-global-admin`, parses every id with `ParseUUIDPipe`, and reads the clock ONCE
per request; `BookingsService` takes that `nowMs`, so no rule reads a wall clock.

| Route | Who | Refusal codes |
|---|---|---|
| `GET mine` | anyone: at most 200, newest first - their bookings as holder or participant (withdrawn ones marked), and every booking of a resource LINKED to them (`linked: true`, D10); private texts of the LIVE ones they are one of the people of (D32) | - |
| `GET spaces/:id` | the audience (D6, D31) or the organiser; no private text | `space-not-found`, `audience` |
| `GET spaces/:id/slots?from&to` | same; each booking cut to what the viewer may read (D9) | `slot-range` |
| `GET spaces/:id/bookings?offset&limit&ids&from` | the organiser: names and answers, by start, pages of at most 200 (`{ items, nextOffset }`); `ids` (comma-separated, at most 200) narrows it to the bookings a D29 refusal named, an id of another space not answered; `from` (an instant, WP-R5) to the live bookings ending after it | `not-manager`, `offset`, `ids`, `from` |
| `POST spaces/:id/bookings` | the audience; the organiser alone books on behalf (`holderId`, outside quotas) | `range`, `holder-is-participant`, `answer-required`, `resource-not-found`, `space-changed`, `too-many-people`, `outside-availability`, `misaligned`, `too-many-steps`, `not-open-yet`, `started`, `notice`, `beyond-horizon`, `blocked`, `unknown-account`, `participant-blocked`, `active-bookings`, `minutes-per-period`, `slot-taken`, `try-again` (a deadlock: send it again) |
| `POST :id/cancel` | the holder or the organiser, ANY TIME before the start (D5) | `not-yours`, then `already-cancelled`, `history-frozen` |
| `POST :id/withdraw` | a participant still in, until `participantWithdrawMinMinutes` before the start (D5) | `not-a-participant`, then `already-cancelled`, `history-frozen`, `withdrawal-delay` |
| `POST resources/:id/blocks` | the organiser or the resource's linked account (D10) | `not-manager`, `history-frozen` (a start more than `NEAR_NOW_MS`, 10 s, behind the server's now; a nearer one is the screen's "from now" and moves up to the server's now), `range` (over 366 days, or empty once moved up), `bookings-inside-block` (with `bookingIds`, D29), `block-overlap` (any overlap with a block of the same resource: the same "Indisponible" written twice, e.g. a retry after a lost answer; so a block cannot be extended in place: lift it first or add one next to it, and a resource's linked account cannot lift the organiser's block) |
| `DELETE blocks/:id` | the organiser any; the linked account only a block IT created | `block-not-found`, `not-yours`, `history-frozen` (ended) |

- **THE LOCK ORDER: the SPACE row, then the RESOURCE row, both `FOR UPDATE`, in every colliding
  write.** The resource lock turns a losing racer into `23P01`, answered 409 `slot-taken`, rather
  than a deadlock (measured in WP-B1). The space lock makes quotas (D17) and a block against a
  booking hold ACROSS resources. The exclusion constraint stays the last word on overlap.
- **A booking decides on the space AS LOCKED.** Rights, the audience and the answers are judged
  before the lock, because the answers may need the profile service and a lock must not wait on
  it. Every other setting (the ceiling of people, the step, the window, the quotas) is read from
  the locked row. If the QUESTIONS changed in between, the answers were judged against the wrong
  ones: `space-changed`, and the booker retries.
- **Under the lock, a constant number of queries, whatever the party.** The D21 check is ONE
  `user_blocks` query over every pair (`= ANY`), the D17 read ONE query over every person
  (`unnest`), bounded to the bookings a quota can still count (ending after `min(now, start)`
  minus eight days: a week of local dates plus a zone). The participants are inserted in one
  statement.
- **Rights.** `mayManage` = a global admin, else `MANAGE_BOOKINGS` on the association
  (`AssociationsService.mayAct`), else the owner of a PERSONAL space. `ownerId` grants nothing on
  an association space.
- **WHO BEFORE WHAT.** `cancel` and `withdraw` judge the actor before the booking's state: booking
  ids are published in the grid, so a stranger learns only `not-yours` / `not-a-participant`,
  never whether a booking is cancelled or started.
- **What a viewer receives** is decided in `booking-views.ts`, pure. The organiser reads names,
  answers and private texts. The booking's PEOPLE - its holder, a participant still in, and the
  account LINKED to its resource (D10: the alumni of a column reads who comes, on an 'occupied'
  space too) - read the names, and the private texts while it is live, never the answers. Anyone
  else reads names only when `nameVisibility = 'names'`. **A participant who withdrew is anyone
  else again**: on an 'occupied' space they no longer read the names, in the grid or in `mine`.
- **Blocks and the past (D15, D20).** A block may not START before now (the screen offers now as
  the earliest start), so no past instant is ever marked. A booking already under way can no
  longer be cancelled, so it neither refuses a block nor is named by one. Lifting a block under way
  ENDS it now; its past part stays as history. The linked account lifts only the blocks it
  created, never the organiser's.
- **The window binds the organiser too** (D26 names no exemption). Quotas do not bind a booking on
  behalf (D17, D20) and count each participant as well as the holder; `holder: false` in the
  refusal says which side broke it.
- **Blocks between accounts (D21)** are symmetric, as `isBlockedBetween`: between the one who adds
  and each participant, and, on behalf, between the holder and each participant. Which side
  blocked is never said.
- **A booking that vanishes between the grid's two reads** (an account erasure deleting a personal
  space) is left out of that answer and logged, never a 500.

**Proof.** `booking-views.spec.ts` covers every relation and setting.
`bookings.service.integration.spec.ts` runs the service against a real PostgreSQL. The rights stub
answers per account, per association and per flag, as the real policy does. It covers:

- eight simultaneous bookings of one slot, five rounds: one winner, seven `slot-taken`;
- a quota held across two resources under concurrency;
- the holder cancelling five minutes before the start against a 120-minute participant delay, and
  the participant refused at the exact boundary;
- nothing moving once started; a stranger told `not-yours` whatever the state;
- a block refused over a live booking and honoured after; a block in the past refused; a booking
  under way ignored; a block under way ended now; a linked account unable to lift the organiser's
  block;
- names and private texts per viewer, the linked account, a withdrawn participant;
- the creator of an association space managing nothing; the organiser of A on B's space; a
  resource of another space; the audience on every read and write; too many people; the holder as
  a participant; D21 on behalf;
- a ceiling and the questions changed between the first read and the lock;
- the organiser list paged; a booking vanishing between two reads.

It runs in CI with the other integration specs (#1915).

## WP-B4 as built - the organiser's API (2026-10-17)

`BookingSpacesController` and `BookingSpacesService`, under the same prefix and guard as WP-B3. The
screens come in a pull request of their own; this half is what they write through.

| Route | Who | Refusal codes |
|---|---|---|
| `GET managed?associationId` | the entity's organiser; without the parameter, the actor's PERSONAL spaces | `not-manager` |
| `POST spaces` | anyone for a personal space (D16), at most 20 per account; `MANAGE_BOOKINGS` for an entity's (`associationId`) | `not-manager`, `too-many-spaces`, `association-not-found` (an id that names no entity, which only a global admin can send), and the settings codes below |
| `GET spaces/:id/manage` | the organiser: every setting, every resource with its linked account, private text and availability | `space-not-found`, `not-manager` |
| `PATCH spaces/:id` | the organiser; any subset of the settings (D35), `null` clears | `time-zone`, `step-shape`, `quota-pair`, `item-id` (missing or DUPLICATE), `opens-at` (an instant without `Z` or an offset), `audience-invalid`, `bookings-inside-change` (with `bookingIds`) |
| `DELETE spaces/:id` | the organiser: the space and EVERYTHING under it (D27), other people's coming bookings included, with no notice (D13); how many is logged | `not-manager` |
| `POST spaces/:id/resources`, `PATCH resources/:id` | the organiser; a linked account must exist; at most 60 resources per space | `unknown-account`, `too-many-resources` |
| `DELETE resources/:id` | the organiser; only a resource that was NEVER booked (D42) | `resource-has-bookings` |
| `PUT resources/:id/availability` | the organiser: the resource's WHOLE availability (weekly and dated lines, closures), replaced | `line-kind`, `line-date`, `line-order`, `exception-range`, `bookings-inside-change` |

- **D29 UNDER THE SPACE LOCK.** A change of availability, of the zone, the mode, the step or the
  step ceiling takes the SPACE row lock - the first lock every booking takes - and only then runs
  `assertAvailabilityChangeAllowed`. No booking can be made between the check and the write; a
  test races the two and only one ever succeeds. The deletion of a resource takes the same lock
  for its own check (D42), and so do the resource cap and, for spaces, the deletion's count.
- **WHAT D29 DOES NOT CHECK, AND THAT IS DELIBERATE.** Only a change of SHAPE (zone, mode, step,
  step ceiling, availability) is held against the coming bookings. Every other setting - the
  ceiling of people (`maxPeople`), the notice, the horizon, the opening, the quotas, the questions,
  the audience - applies to the NEXT booking and leaves the live ones as they are: a booking made
  under the old rule stays, even one that the new rule would refuse.
- **THE BODY NEVER NAMES WHAT IS WRITTEN** (review of #2006: CodeQL's "remote property
  injection"). A settings or resource write copies the keys of `SPACE_SETTING_KEYS` /
  `RESOURCE_KEYS` and nothing else, so `id`, `ownerId`, `associationId` or `spaceId` in a body are
  ignored even where no ValidationPipe whitelist strips them - proved through the HTTP layer with no
  pipe at all. `booking-spaces.keys.spec.ts` holds both lists against their DTOs, so a setting added
  to a DTO cannot be validated and then silently never saved.
- **Caps** (review of #2006): 20 PERSONAL spaces per account (counted under an advisory lock on
  the account) and 60 resources per space (under the space lock) - far above the cases that bound
  the design (one music room; 14-21 alumni columns), low enough that one account cannot fill a
  table. Every instant the module reads (a booking's range, a block's, the opening) must carry `Z`
  or an offset: without one, `Date.parse` reads it in the SERVER's zone.
- **D10's linked account and `unknown-account`, a disclosure stated.** An organiser who links a
  resource to an id learns from `unknown-account` whether that account EXISTS. Only an organiser
  can ask, ids are opaque, and the user picker of the screen already answers the same question for
  any signed-in member; it is a cost accepted, not an oversight.
- **The database's CHECKs are refused first, as codes** (`step-shape`, `quota-pair`), so a
  constraint violation is never a 500. Switching to predefined slots clears the step.
- **Rights** are the module's: `MANAGE_BOOKINGS` on the owning entity, the owner of a personal
  space, a global admin. Creating an entity's space asks the same right.
- **The audience and each question's condition** go through the forms' `parseAudienceCondition`,
  with the entity's cotisation tiers, so a space and a form agree on who an ICM is.
- **A FILE question was refused (`file-question-not-yet`) until WP-B6**, which brought the bookings
  half of WP-F's storage and purge and lifted the refusal ([WP-B6 as built](#wp-b6-as-built---file-answers-the-poster-the-purge-the-export-2026-10-18)).
- **Times** are stored `HH:MM:SS`, `24:00` included; a window crossing midnight is two lines (WP-B2).
- **The poster (D35) was SCHEDULED IN WP-B6, not dropped** (Master, 2026-10-17), and WP-B6 built
  it: migration 092 adds the column, the General section the field.
- **Nothing new to erase**: no column was added. The linked account was already covered by
  `BOOKINGS_ERASURE_STATEMENTS` (WP-B1).

**Proof.** In `bookings.service.integration.spec.ts`, "the organiser (WP-B4)": rights per entity,
the settings codes, availability written and read back, D29 naming the booking for availability
and step, a resource with history (cancelled included) never deleted and one never booked deleted
(D42), a booking racing an availability change (five rounds, never both), a linked account that
must exist, a space deleted with everything, duplicate question ids, a zoneless opening, an entity
that does not exist, both caps, and a forged body (`id`, `ownerId`, `associationId`, `spaceId`)
sent through the real HTTP layer with no ValidationPipe, changing none of them.

## WP-B4 as built - the organiser's screens (2026-10-18)

| Where | What |
|---|---|
| `associations/editSections.ts` | a `reservations` section, opened on `MANAGE_BOOKINGS` alone (D30), for associations, institutions AND lists (`LIST_EDIT_SECTIONS`, D38) |
| `components/bookings/organiser/EditBookingsTab.svelte` | the entity's tab: its spaces (`GET managed`), a new one by its name, which opens its editor |
| `routes/bookings/spaces/[spaceId]/edit` | loads the space and its entity (name, tiers, formations); the editing is `SpaceEditor.svelte` |
| `SpaceEditor.svelte` | D35's five sections: General; Resources and availability; Who and how (the forms' audience switch and editor, then the questions); Booking rules and Data, collapsed, the first with a badge counting what is set |
| `ResourceEditor.svelte`, `AvailabilityEditor.svelte` | per resource: its fields and linked account, then its availability - each SAVED ON ITS OWN, because each is its own call and a D29 refusal of one must not lose what was typed in the other |
| `lib/bookings/api.ts` | the typed client; a refusal is a `BookingsApiError` carrying `bookingIds` |
| `lib/bookings/refusals.ts` | every organiser code to its sentence, then the status, then the generic line - never the server's message |
| `lib/bookings/spaceSettings.svelte.ts` | the editor's text draft to the API and back, the DTO's bounds per field, the badge's count. A `.svelte.ts` module because its input is a `$state` PROXY (the page's loaded space, handed down as a prop): the draft copies `items` and `audience` with `$state.snapshot`, never `structuredClone`, which throws `DataCloneError` on a proxy and crashed the editor on every client in `v1.3.0-alpha.2`. `spaceSettings.proxy.svelte.test.ts` reads a real proxy - the plain-object tests could not see it |
| `lib/bookings/availability.ts` | the ranges as the organiser thinks of them to the stored lines and back (see WP-B2), the times offered, the 24/7 warning |
| `StrandedBookings.svelte`, `lib/bookings/stranded.ts` | the bookings a D29 refusal NAMED, listed under the refused save - when (on the space's clock), which resource, whose - each with its cancel, then "save again" |
| `lib/bookings/zonedTime.ts`, `wallTime.ts` | the space's wall clock to UTC and back: `zonedTime.ts` is the server's `zoned-time.ts` COPIED BYTE FOR BYTE (a declared duplicate, both DST holes resolved the same way), `wallTime.ts` puts the date field's value on it |
| `lib/navigation/unsavedChanges.ts` | asks before an editor with unsaved changes is left: the browser's prompt on a tab close, the app's dialog on an in-app navigation, replayed on yes |

- **A range crossing midnight is ONE range on screen** ("Friday 22:00 to 02:00", marked "ends the
  next day") and two stored lines; reading folds the pair back once, never a whole day.
- **THE 24/7 WARNING IS SHOWN** when whole days (00:00-24:00) follow each other, naming them: no
  booking can cross the midnight between two whole days (WP-B2's rule).
- **Every choice is drawn by the app** ([durable-rules](durable-rules.md)): times are a `Select` on
  the space's saved step (15 min for fixed slots), keeping an off-step value; a date is
  `DateTimeField`, which gained `dateOnly` (value `YYYY-MM-DD`, no time columns).
- **Deleting a resource that has history is refused (D42)**: the confirmation and the refusal both
  say so, and point at closing it instead (its hours removed, or a closure).
- **D29 NAMES THE BOOKINGS, AND SO DOES THE SCREEN.** A refused availability or settings save lists
  the bookings in the way (`GET spaces/:id/bookings?ids=`, the first 200; the rest are named by the
  next refusal), each with a cancel button that says the holder is not notified (D13). When none is
  left, "save again" replays the save.
- **DELETING A SPACE SAYS WHAT IT COSTS OTHERS**: its coming bookings disappear and the people who
  made them are NOT told (D13, D27) - the confirmation asks the organiser to tell them first.
- **The opening date is the SPACE's wall time (D25)**, named under the field; a change of zone
  keeps the wall time on screen and moves the instant saved.
- **Unsaved changes are asked about** before leaving the editor (settings, a resource's fields, an
  availability), and the editor reloads when the route's space id changes, not only on mount.
- **The file question was not offered until WP-B6**, which deleted `FormQuestionsSection`'s
  `withoutTypes` with its only use.
- **Large text**: `FormSection`'s header wraps at 200 % text (the badge and the chevron left the
  card before - forms' sections too).

**Seen** at 390 and 1280 and at 200 % text on a local build, on a fixture space (a temporary
signed-out preview route, not committed): no horizontal scroll, the night range folded, the 24/7
warning, the date sheet. Not yet seen against a running API - the first organiser to use it on dev
is that reading. **Proof**: `availability.test.ts`, `spaceSettings.test.ts` (the opening in the
space's zone), `refusals.test.ts`, `stranded.test.ts`, `wallTime.test.ts` (both DST holes),
`unsavedChanges.test.ts`, `editSections.test.ts`, `DateTimeField.svelte.test.ts`; on the server,
`bookings.controller.spec.ts` (the `ids` filter's shape) and the integration case "narrows the
organiser list to the bookings a D29 refusal named".

## WP-B5 as built - the booker's API (2026-10-18)

What the booker's screens need and WP-B3 did not serve. Three additions, no migration.

| Route | Who | Refusal codes |
|---|---|---|
| `GET spaces` | anyone signed in: every LISTED association space (D31) of a live association whose audience (D6) admits them, or that they manage, and their OWN listed personal spaces (D43), by name, at most 200 (the limit is in SQL) - with its entity's name and its resource count; never a private text | - |
| `GET :id/calendar-link` | the booking's PEOPLE (holder, participant still in, the account linked to its resource) and its organiser: `{ path }` of a `.ics` signed FOR THEM | `not-yours` (also for an id that names nothing, and for a global admin who is not of the booking), then `already-cancelled` |
| `GET :id/calendar.ics?u=&sig=` | NO SESSION - a calendar app; authorised by `sig` over the booking AND the recipient `u` | 400 for a malformed id, 400 `query-not-a-string` for a repeated `u` or `sig` (Express would hand it over as an array; `OptionalStringPipe`), `calendar-signature` (checked before anything is read), `booking-not-found`, `calendar-revoked`, 410 `booking-cancelled` |

`GET spaces/:id` now names `hiddenItemIds`: the questions the reader's PROFILE hides (promo,
formation, cotisation), decided by `profileHiddenItemIds` in `forms/visibility.ts` - the one rule
a form's page and a space's share. The screen evaluates the answer half as the booker types, so it
never asks a question the server would drop.

And in `GET spaces/:id/slots`, a blocked unit carries `blockId` for whoever may LIFT it - the
organiser, and the account linked to the resource (the server still lets that account lift only
the blocks it created). Nobody else is sent it.

- **A LINK-ONLY SPACE IS NEVER LISTED, WHOEVER ASKS** - its organiser included: it is reached by
  its link or QR code (the psychologist case). **A PERSONAL space is listed to its owner alone
  (D43), and an ARCHIVED association's to nobody.** The audience is judged per space with that
  space's own association's facts, as `assertMayUse` judges a read, so a listed space always opens.
- **THE LISTING COSTS A FIXED NUMBER OF QUERIES, NOT ONE PER SPACE**: the rows (limit in SQL), the
  manage rights in one `mayActOnAny`, the cotisations of every association in one
  `cotisationTiersByAssociation`, and the profile (core-service) ONCE, only when some audience needs
  it. **If core-service fails, the page stays**: only the spaces whose audience needs the profile
  are left out, with an error logged - a 503 would hide spaces that need nothing from it, and
  listing one would open onto a refusal.
- **THE `.ics` IS SIGNED FOR ONE RECIPIENT** (`booking-calendar.ts`). A calendar app sends no
  identity, so the link carries it: `sig` is an HMAC of `booking-ics|v1|<id>|<recipient>` under
  `AGENDA_SIGNING_KEY` - the agenda's key, through one `signWithAgendaKey`, the prefix keeping the
  two kinds of link from ever reading as each other, in both directions (tested). No new secret,
  nothing to deploy. The comparison is constant-time and comes before any read.
- **REVOCATION IS PER PERSON, AT EVERY FETCH**: after the signature, the route checks that the
  recipient's account still exists and is still OF the booking (the same `isOfBooking` that issued
  the link). A withdrawn participant, an account unlinked from the resource, an organiser whose
  right was taken away, an ERASED account (its `users` row is gone) - each gets `calendar-revoked`,
  and an erased account's past bookings stop being fetchable. **Rotating the key is the last
  resort**: it ends every saved link of both kinds at once, and the app fetches a fresh one the
  next time someone taps "Add to my calendar". An unset key is a 503 (fails closed), never an
  unsigned link; so is an unset `FRONTEND_URL` (`common/frontend-url.ts`, no default).
- **WHAT THE FILE CARRIES: the names of the place - the space's and the resource's, which may be a
  PERSON's (D10, a resource can be someone) - the start, the end, a link back to the space. NEVER
  the answers, the private texts (D32), the holder's or the participants' names** - a link can be
  forwarded, and on an 'occupied' space (D9) names are not the link-holder's to read. A cancelled
  booking answers 410, so a stale import cannot write it back. The link back is
  `/bookings/spaces/:id`, a screen WP-B5's screens (#2035) add.
- **The route is declared public by intent** in `.github/scripts/tests/auth-request-coverage.test.mjs`
  (its own controller, `BookingCalendarController`, without the session guard); it sits behind the
  same `/api/bookings` location, whose `auth_request` identifies and refuses nobody.

**Proof.** `booking-calendar.spec.ts` (only that booking and that recipient, never an agenda
signature and never read as one, dead after a rotation, no key no link, nothing but the place and
the range). `booking-calendar.controller.spec.ts` at the HTTP layer: `text/calendar`,
`Cache-Control: private, no-store`, a malformed id a 400 before the service is called. In
`bookings.service.integration.spec.ts`, "the booker's page and the calendar link (WP-B5)": the
listing per audience, manager and link-only, a personal space to its owner alone, an archived
association's to nobody, the page kept when core-service fails; a distinct link per person,
refused to strangers (a global admin included), to a withdrawn participant and for a cancelled
booking; the file without the answer, the private texts or the holder's name, refused for another
booking's or another recipient's signature, a forged or missing one and after a rotation, 410 once
cancelled; revoked when its recipient withdraws, is unlinked, loses the right or is erased; a block
id to the organiser and the linked account, not to a booker.
## WP-B5 as built - the booker's screens (2026-10-18)

| Where | What |
|---|---|
| `routes/bookings` | **Reservations** (D16): my coming bookings first (soonest first), the past, cancelled and left ones folded below, the listed spaces (a `SectionHub`), then my PERSONAL spaces, created here (`EditBookingsTab` with `associationId` null - the same panel as an entity's tab) |
| `routes/bookings/spaces/[spaceId]` | the booker's page of a space: grid or planning, the three sheets, the link and the QR code (`QrCodeModal`), a pencil to the editor for whoever manages it |
| `components/bookings/booker/SpaceGrid.svelte` | the grid of ONE date (D14): resources as columns, units as rows; every cell a button named with its whole reading; the table scrolls inside its own box, never the page |
| `SpacePlanning.svelte` | per resource, its next six units bookable NOW over the next 14 days; a resource with none says so |
| `BookingSheet.svelte` | the range (a slot whole, or 1..`maxSteps` steps from the one tapped), the participants (`UserAutocomplete`, up to `maxPeople`), the questions (`FormQuestion`, `visibleItems` with the server's `hiddenItemIds`), and - for an organiser - "book for someone" (D20) |
| `BlockSheet.svelte` | (a `bookings-inside-block` refusal keeps the sheet open for a MANAGER and lists the named bookings with `StrandedBookings.svelte`, each with its cancel, then "save again"; the linked account keeps the count and the re-read grid) "Indisponible" from the unit tapped over a run of free units (at most `BLOCK_LENGTH_CHOICES` = 48 lengths, each naming its end's day when it is not the start's), a reason, shown or not (D20) |
| `UnitDetailSheet.svelte` | a taken unit: names as D9 allows, private texts to the booking's people (D32), answers to the organiser, cancel / leave / "Add to my calendar"; a block's reason and lifting it |
| `MyBookingCard.svelte` | one of my bookings on Reservations: where, when (the space's zone), my part, the private texts while live, the same three gestures |
| `lib/bookings/grid.ts` | pure: a unit's day, the ranges as text, the grid rows, the free run a booking or a block may cover, the planning, and `windowRefusal` - on `zonedTime.ts` and `bookingWindow.ts`, both the server's own files copied byte for byte |
| `lib/bookings/bookingWindow.ts` | the booking window (D26) - `apps/social-service/src/bookings/booking-window.ts` COPIED, a declared duplicate, both copies answering `libs/contracts/booking-window.cases.json` |
| `lib/bookings/redrawClock.ts` | the redraw: every minute, at the opening instant, and when the page is seen again |
| `lib/bookings/bookingActions.ts` | cancel, leave and lift: ONE implementation each (ask, call, say), shared by both pages; the calendar event of a booking |
| `lib/bookings/refusals.ts` | every booker code (`BOOKER_REFUSAL_CODES`) to its sentence, beside the organiser's |

- **A DRAG PICKS A RANGE (user, 2026-10-21)**: press a free unit of the grid and drag along the same
  resource's column; the range follows the pointer (a yellow outline and a chip with its hours at the
  bottom of the screen) and letting go opens the booking sheet with that length already chosen
  (`initialCount`). The range is `dragRange` in `lib/bookings/grid.ts`: it grows from the pressed row,
  up or down, and stops at the first row that is not a FREE unit touching the previous one, or when
  `bookingUnitLimit` units are covered - so it can never cover a taken unit nor exceed `maxSteps`.
  **A mouse or a pen drags at once; a finger must HOLD 250 ms first** (a quicker drag is the page
  scrolling and is left alone), and the page does not scroll while a range is drawn (a non-passive
  `touchmove`). A plain tap still opens the sheet with one unit, and a drag is never also a click.
  Not offered in slots mode (a slot is booked whole). **Seen** at 390 px in a headless Chrome on a
  fixture grid (mouse): 4 units at the ceiling, 2 before a taken unit. **NOT seen on a phone**: the
  hold-then-drag and the scroll lock are the part only a finger can judge.
- **THE GRID IS DENSER (user, 2026-10-21, after seeing both)**: a row is 32 px (was 44), touching free
  units, touching blocked units and the units of ONE booking are drawn as a single block (rounded
  only at its ends, its label said once, `sameRun` in `SpaceGrid.svelte`), and the time column
  carries a bold label on the hour and a faint one on the half hours. **Every unit is still its own
  button**, so a press or a drag lands on the step under the pointer. Measured on a 12 h fixture day
  at 390 px: the table went from 1196 px to 827 px (-31 %). **The cost, accepted by the user: a row
  is under the 44 px touch target on a phone**, which the drag partly offsets (no need to aim a
  single tap at one step). The next lever, if more is wanted, is not density but the hours shown
  (fold the unused ones) or a horizontal strip for a one-resource space.
- **THE DEFAULT VIEW FOLLOWS THE WIDTH** as the agenda's (`SCHEDULE_AGENDA_QUERY`): the planning
  on a phone, the grid wider - until the reader picks one, then theirs holds.
- **TIMES ARE THE SPACE'S** (D25), read in its zone; when the device's clock reads differently,
  the page names the zone. **A unit's DAY is the local date of its START**, not the date its
  window started (which the server stamps on it): a night window stays one block of rows on the
  grid of the day it opened, its rows after midnight marked "(lendemain)", and every sentence that
  names a day names the right one. An end at midnight reads `24:00`; a time in a fall-back night's
  doubled hour carries its offset ("02:00 (UTC+2) - 02:00 (UTC+1)"), so two ranges never read alike.
- **THE CLOCK THAT DECIDES IS THE SERVER'S.** The device's clock only DRAWS: a unit outside the
  window is drawn "Non réservable", redrawn every minute and at the opening instant, and it STILL
  OPENS - the sheet says the device thinks it is not bookable, and the server answers. Like the
  server, only the START of a range is judged: a run of steps is never trimmed by the window.
- **A NIGHT WINDOW STILL RUNNING AFTER MIDNIGHT STAYS IN VIEW** (review of #2035). The server
  keeps a unit in `spaceSlots(from, to)` when its WINDOW's date is in the range, so every read
  starts THE DAY BEFORE the date shown (`slotsReadRange`), and the grid opens - and "today" leads -
  on that window's date while it runs (`gridOpeningDate`). At Saturday 00:15 the 00:30 of a Friday
  22:00-02:00 window is on Friday's grid, marked the next day, and first in the planning.
- **AN ANSWER THAT NEVER CAME IS SAID AS SUCH**: a booking or a block whose call reached nobody
  (a timeout, a lost connection) or came back 5xx with no code may have been written
  (`outcomeUnknown`); any 4xx, a validation 400 with no code included, is a refusal. The booking
  sheet says the outcome is unknown and re-reads the grid and my bookings. **The block sheet
  re-reads and CLOSES**: a second tap from the open sheet is now refused by the server
  (`block-overlap`), and the sheet also closes on it, the grid showing whether it landed.
  Every failed read or gesture is logged, transport failures included.
- **"Add to my calendar" asks for its signed link ON THE TAP** (`bookingIcsUrl`), never once per
  card on screen; a browser tab is opened inside the tap and pointed at it.
- **A refusal that means the grid is stale** (`slot-taken`, `blocked`, `space-changed`) closes the
  sheet and re-reads the grid and my bookings, so the reader sees why.
- **The holder's gestures come from `GET mine`**: a unit's view says `mine` but not holder or
  participant, so the page indexes my own bookings by id - which also carries the private texts.
- **THE KNOWN COSTS ARE SAID ON SCREEN, NOT HIDDEN**: no notification (D13, on both pages and in
  the organiser's cancel confirmation); people added directly, no acceptance (D34); a booking is
  never edited, cancel and book again (D36); a personal space's coming bookings vanish with its
  owner's account (WP-B1's erasure).
- **Navigation (D37)**: a `bookings` place in `places.ts` (the desktop sidebar, which now draws
  `PLACE_ICONS` rather than its own copy), a row in the dashboard's Explorer group, no bottom tab.
  `/bookings` is private for search (`PRIVATE_PREFIXES`), an in-app route, and an app link on iOS
  and Android (`MOBILE_UNIVERSAL_LINK_PATHS`, `tauri.conf.json`, `AndroidManifest.xml`), so a
  shared link or a scanned QR code opens the app.
- **A personal space's editor** now leads back to Reservations (its crumbs, and after deletion).

**Seen** at 390 and 1280 and at 200 % text on a local build, on a fixture space (a temporary
signed-out preview route, not committed): no page scroll sideways (the grid's third column
scrolls in its box), the booking sheet with steps, people and questions, the detail with answers;
after the review, a fall-back night window on the grid and the block lengths over it. Not yet
seen against a running API, nor on a phone - WP-B7's readings. **Proof**: `grid.test.ts` (a
unit's day, `24:00`, the next-day and further-day ends, both DST nights, a night window's rows,
the free run, the planning, a night window read at Saturday 00:15), `BlockSheet.svelte.test.ts`
(an unknown outcome closes, a 400 with no code does not), `bookingWindow.contract.test.ts` and the server's
`booking-window.spec.ts` (one contract), `redrawClock.test.ts`, `refusals.test.ts` (every booker
code worded), the dashboard's row order.

## WP-B6 as built - file answers, the poster, the purge, the export (2026-10-18)

Draft #2045, stacked on #2035. Migration **092** (`092_booking_files_and_poster.sql`; renumbered from 091, which the lives server #2044 took) adds two things, and is idempotent: it is applied twice in its spec, and its catalogue check is scoped to the schema.
- `booking_files`: what a FILE answer's id names.
- `booking_spaces.poster`: the poster.

| Route | Who | Refusal codes |
|---|---|---|
| `POST spaces/:id/files` (multipart `file`, `itemId`) | anyone the space's audience admits (`assertMayUse`) | `file-question` (not a FILE question of this space), `file-empty`, 413 `file-too-large`, `file-type` (read from the bytes), 429 `files-pending` (ten unsent on this space), 429 `files-pending-account` (thirty unsent across spaces) |
| `GET :bookingId/files/:fileId` | the organiser only (D22), judged before the file is looked at - a global admin who is not an organiser is refused too (review of #2045) | `not-manager`, `file-not-found`, 410 `file-purged` |
| `GET spaces/:id/export?labels=` | the organiser; served `nosniff` | `not-manager`, `export-labels` (a word missing, empty or over 200 characters) |
| `PATCH spaces/:id` `{ poster }` | the organiser; `null` removes it | a malformed reference is a validation 400; `poster-not-yours` (not the actor's own fresh `poster-pending` upload, or already another space's poster); 503 `try-again` (the media service did not answer the claim) |

`POST spaces/:id/bookings` can now refuse a file answer in two ways:
- `file-answer`: the value is not a file id.
- `file-not-yours`: the uploader, the question, the space, the one-day window or the unsent state does not match. The claim is one `UPDATE`, so the booking rolls back with it.

**File answers**
- **ONE STORAGE FOR BOTH MODULES.** The bytes go through the media service's `form-file` class, through `FormFilesService` (`storeBlob`, `fetchBlob`, `purgeBlobs`), now exported by `FormsModule`.
  - The bytes are plaintext, served to social-service alone, and the organiser reads them (D22). So this is NOT the client-encrypted media path, and the register says so (C17).
  - The forms' loop over due files is now `runFileRetentionPass` (`forms/file-retention-purge.ts`), shared by both schedulers.
- **THE STATE IS THE ROW.**
  - `bookingId` NULL means uploaded and not sent: it can be attached for a day, then the blob is purged, then the row.
  - `bookingId` set means it belongs to a booking.
  - `purgedAt` means the blob is gone, and the organiser reads "file deleted".
  - The foreign key to `bookings` is the module's one `ON DELETE SET NULL`. A booking deleted with its space (D27) or past one year (D19) turns its file back into an unsent upload, and the next purge takes it. A cascade would drop the only record of a blob that still exists.
  - `spaceId` has no foreign key, for the same reason.
- **The organiser books on someone's behalf with their own upload**: the uploader is whoever booked, which is what the claim checks.
- **Who sees what.**
  - The organiser's views carry `fileNames`, and `deletedFileIds` for the files that are purged, erased or another booking's.
  - Nobody else is sent answers (D9).
  - A file answer is never shown as its id. `answerText` throws without its words.

**The poster (D35)**
- **ENCRYPTED BY THE CLIENT, AS A POST'S IMAGE.** The client uses `preparePostMedia`, then `encryptAndUpload(..., 'poster-pending')` - a class ONLY the poster field names, swept by age (48 h) if no save claims it. The row stores the reference, field by field (`posterOf`).
- **`BookingPosterMedia` handles its life at the media service.**
  - **IT IS CLAIMED INSIDE THE TRANSACTION THAT STORES THE ROW** (media-service `POST media/internal/poster-claim`, review of #2045), under an advisory lock on the media id (`booking-poster:<id>`) held until the commit. The claim succeeds only on the ACTING member's own `poster-pending` upload, at most a day old, not purged, not a public asset. It then becomes `poster-association` for an entity's space (it survives its uploader's erasure, as an association document does) or `poster` for a personal one, BOUND TO THAT SPACE (`claimedFor`). A refused claim refuses the save (`poster-not-yours`); an unanswered one too (`try-again`). Before this, any member could cite an id they had seen - a stranger's image, an association document, even their OWN post's photo - then remove the poster and hand that object to the idle sweep.
  - **ONE POSTER, ONE SPACE, AND A REPEATED CLAIM IS IDEMPOTENT.** A claim by the same member for the same space answers claimed again and changes nothing (a double submit, a retried save); for another space it is refused. So two spaces never share a poster. A create's space id is chosen before its transaction, so the claim can name it.
  - **THE RELEASE TOUCHES CLAIMED POSTERS ONLY.** `internal/poster-release` moves `poster`/`poster-association` to `ephemeral` and refuses every other class, so a release can never reach a post's image or a document. `internal/retention-class` never moves a claimed poster either. It runs when a poster is replaced or removed, when its space or association is deleted (`associations.service.ts` `remove`), and when a save that claimed one fails - each id in its own transaction, under the same lock, the citation re-read there (`releaseUncitedPosters`). A release racing a claim in flight therefore waits for its commit and finds it cited.
  - **A CRASH BETWEEN A CLAIM AND ITS COMMIT IS RECONCILED, NOT TIMED OUT.** `BookingPosterMedia.reconcileOnce` (hourly at :47) lists the claimed posters (`internal/poster-list`) and releases those no space cites, through the same locked release. No grace period: a claim in flight holds the lock, so "uncited" is only ever read once nothing can still commit a citation. A release the media service did not answer is found again the next hour.
  - Every release is best-effort and logs what it left.
- **The editor saves it ON ITS OWN, the moment it is picked** (`SpacePosterField.svelte`). An image uploaded and left in an unsaved draft would be ciphertext nobody cites.
- **The space page shows it** (`SpacePoster.svelte`), decrypted on the device.
- **Reservations' space rows do not show it**: `SectionHub` rows carry an icon, not an image.

**The purge** (`booking-retention.scheduler.ts`, hourly at :41, one database clock per run, intervals in hours). It runs four passes, then sweeps the rows of unsent files that are already gone.
1. A booking's files go `retentionDays` after its slot's END (D8, D41): the blob first, then the row is marked.
2. Unsent uploads go after a day: the blob, then the row - **CLAIMED UNDER A ROW LOCK** (`purgeUnsent`, `FOR UPDATE SKIP LOCKED`, held across the blob delete and the row delete, review of #2045). `attach` reads the window with its transaction's `NOW()`, so a booking that began inside the window could commit after an unlocked purge read the row, citing a deleted blob with `purgedAt` NULL. Now a row a booking holds is skipped, and a booking reaching a row the purge holds waits and finds it gone (`file-not-yours`).
3. Answers go after the same N days: they are set NULL and `answersPurgedAt` is stamped (D18).
4. Bookings and blocks whose slot ended over a year ago are deleted, in batches of 100 (D19).

A blob the media service refuses to delete keeps its row, which is retried next hour. **A deleted space's files wait for the unsent pass**, up to a day and an hour after the deletion.

**The export (D24)**, `booking-export.ts`:
- **The client supplies every word**, as in the forms' `ExportLabels`; there is no default.
- **Each row has**:
  - the local date and times in the space's zone (an end on another day is prefixed with its date);
  - the resource, the holder and the participants still in;
  - the cancelled word;
  - one column per question, through `answerText`.
- **What a cell holds once data is purged**:
  - A FILE answer is a word, never the file.
  - A purged answer is an empty cell.
- **The workbook is named after the space**, and the client names the downloaded file the same way.

**Account erasure**:
- `bookings_files` deletes the account's uploads.
- The coverage map lists `booking_files.uploaderId` and `.fileName`.
- `booking_spaces.poster` is marked as naming no account.

**Proof.**
- `bookings.files.integration.spec.ts`, against PostgreSQL (migrations applied twice), covers:
  - upload refusals and the audience;
  - attaching one's own file versus another's, with the rollback;
  - booking on someone's behalf;
  - who sees the answers, and the download rights;
  - a blob gone at the media service, marked purged;
  - the purge after N days, run twice;
  - a refused blob kept;
  - an unsent upload purged;
  - a deleted space's files;
  - the one-year age;
  - erasure;
  - the poster claimed, released and forged, over the REAL `BookingPosterMedia` and a fake media service that applies the claim rule: a stranger's image refused (and left untouched), the member's own post image, a document and a stale upload refused, one poster refused to a second space, a failed create's claim released, a release that waits for a claim in flight (FAILS without the lock), and the reconciliation releasing an orphan and nothing cited;
  - the two orders of a booking and the purge on one unsent file (both FAILED on the unlocked purge: it deadlocked on the booking's row lock);
  - the per-account cap across spaces, and a global admin refused a file;
  - the export parsed back with ExcelJS.
- `associations.service.remove-forms.spec.ts`: an association's deletion releases its spaces' posters, except one another space still cites.
- `booking-export.spec.ts`: a text starting with `=`, `+`, `-` or `@` lands as a STRING cell, never a formula, in every column and header.
- media-service `media.service.poster-claim.spec.ts`: the claim rule (own fresh `poster-pending` only, idempotent for its space), the release allowlist (claimed posters only), the list, and the age sweep of an unclaimed upload.
- Frontend:
  - `refusals.test.ts` puts a sentence on every new code.
  - `exportLabels.test.ts` checks every word the server requires.
  - `spaceSettings.test.ts` checks that the settings bar never sends the poster.

**WP-B7, 2026-10-18.**
- **The live API was run against the LOCAL estate** (nginx, migration 092 applied twice over the synchronized schema) and every row answered as specified:
  - refusals: `file-question`, `file-type` on a text file named `.pdf`, `file-not-yours` (another's file, and one file cited twice), `not-manager` to a booker downloading or exporting, `export-labels`;
  - the organiser's slot carried `fileNames`, and the booker's carried no answers;
  - the download was byte-identical, with `Content-Disposition`;
  - the export returned an `.xlsx`;
  - the poster was set, read back and removed;
  - deleting the space left its files unsent (`bookingId` NULL) for the purge.
- **Screens, in Chrome with an override, at 390, at 1280 and at 200 % text.** This covered the editor (poster field, FILE question, Data section with the export), the booking sheet with a FILE question, and the detail with a file answer. Two defects were found and fixed:
  - the question editor said a FILE question's file is read by "the form's managers, see Advanced settings" (`FormQuestionsSection` now takes `fileHint`);
  - a long file name broke letter by letter at 200 % text (the whole row is now the download, the name cut, the full name its title).
- **NOT SEEN**: a real poster picked, encrypted and decrypted on screen, and a real file picked on a phone - both need a signed-in device.

**The privacy policy** (`routes/legal/privacy`) carries bookings since #2072, written against the
code, and register row C17 says the same: answers are read by the organiser AND a global admin
(`mayManage`, D30; the export likewise), the FILE by the organiser alone, a booking's rows go one
year after the slot, answers and files N days after it (an unsent upload after one day), an erased
account's coming bookings are cancelled and its ids tombstoned. The first draft proposed here said
"answers readable by the organisers only", which the code contradicted; the published text names
the platform administrators. **What the code bounds and neither text states**: 20 personal spaces
per account, 60 resources per space, 10 unsent files per space and 30 per account.

**Left after WP-B6** (2026-10-18): the device readings of WP-B7 (a real poster and a real file on a
phone, both phones, a two-client run on one slot), the French user guide, and the bookings rows of
the cross-client rig (nothing there asserts the module yet).
