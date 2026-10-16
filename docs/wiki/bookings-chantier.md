# Bookings (reservation of rooms and slots) - the chantier, decisions as taken

**Status: BUILDING (opened 2026-10-15).** WP-B0 merged (#1904); WP-F and WP-B1 are draft pull requests. Decisions are written here the day the
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
| D5 | Withdrawal | Free for the holder, with a DELAY set by the organiser (default none). The organiser may always cancel, the holder is told. |
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

| D30 | Right to manage | **A NEW `MANAGE_BOOKINGS` right, distinct from `MANAGE_FORMS`**: one more bit in the association bitmask, granted per role. The BDA can entrust the music room to someone without giving them forms. It needs a migration of existing roles and a row in the role editor ([association-permissions](association-permissions.md)). A global admin keeps everything. |

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

| D41 | File retention in forms (WP-F) | **The SAME rule as D8 and D23, one mechanism with two starting points**: a file is purged N days after the EVENT (default 7, adjustable 1 to 30 by the manager), the event being the slot's end for a booking and the DATE OF THE ANSWER for a form. The answer row stays; the file goes. The user pointed out this was already decided: a duplicate question was asked and is recorded here so nobody asks it a third time. |

**Master's notes (2026-10-15):** no open pull request touches forms (open: #1896, #1897, #1898, #1884), so WP-F has no known conflict; rebase on `main` before each batch; **check the next free migration number on `main` when opening each pull request**, as other pull requests may take one.

D27 was re-confirmed by the user on 2026-10-15: the history is frozen only while its space exists.

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
| **WP-B1** (DRAFT PR, 2026-10-16, migration `087_bookings.sql` because #1940 holds 086: see [WP-B1 as built](#wp-b1-as-built-2026-10-16)) | Data model and migration: space, resource, availability rules, exceptions, blocked ranges, booking, participants; `btree_gist` and an EXCLUDE constraint on (resource, time range) among live bookings; deletion of a space deletes everything (D27) | `apps/social-service/src/migrations/` (next free number), `docs/wiki/infrastructure/databases.md` rules | Two concurrent inserts on the last slot: exactly one wins, in a real database |
| **WP-B2** | Slot generation on demand (step or predefined slots), booking window, quotas, withdrawal delay, zone handling, the rule that refuses an availability edit with bookings inside (D29). **A window crossing midnight is TWO rules** (22:00-24:00 and 00:00-02:00 the next day): `booking_availability_rules_order` requires `startTime < endTime`, and generation must join them back into one window | A new `bookings` module beside `forms`; `AssociationsService.mayAct` as the only rights policy | Table-driven tests across a daylight-saving change |
| **WP-B3** | API: book, cancel, participant withdraws, organiser blocks, books on behalf, cancels (D20); frozen history (D15); block honoured (`isBlockedBetween`); private fields returned only to the booking's people (D32) | `apps/social-service/src/common/user-blocks.ts`, `forms.service.ts` `assertFormManager` as the guard shape | A past booking refuses every write; a stranger never receives a private field |
| **WP-B4** | Organiser screens: five settings sections (D35), resources, availability, questions reused from forms, the entity tab. The availability editor writes a window crossing midnight as two rules (see WP-B2) | `editSections.ts`, `routes/associations/[slug]/edit/[[section]]/+page.svelte`, `FormSection.svelte` and `FormAdvancedSettings.svelte` as the pattern | Seen at 390 and 1280 on a real build |
| **WP-B5** | Booker screens: grid and planning (D14), my bookings, the dashboard card (D37), the sidebar entry, link and QR code, "Add to my calendar" with a hosted ICS route (D13) | `routes/calendar/+page.svelte`, `viewport.ts`, `AddEventToCalendarButton.svelte`, `navigation/places.ts`, `QrCodeModal.svelte`, `pageWidth.ts` | Read on the Mi 9T and the iPhone |
| **WP-B6** | Purge of files and answers after N days, the platform maximum age of one year (D19, D23), XLSX export (D24) | `reel-retention.scheduler.ts`, `forms/export-labels.ts`, `forms.service.ts` `exportSubmissions` | A purge run twice changes nothing; the export parses back |
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
| `booking_spaces` | owner (`ownerId`, `associationId` NULL for a person), name, description, zone, `slotMode` (`step` with `stepMinutes`/`maxSteps`, or `slots`), `nameVisibility` (`occupied` by default), `discoverability`, `audience`, `items` (the forms' questions), `privateInfo`, the window (`opensAt`, `minNoticeMinutes`, `horizonDays`), the quotas (`maxActiveBookings`, `maxMinutesPerPeriod` + `quotaPeriod`), `withdrawalDelayMinutes`, `maxPeople` (holder included), `retentionDays` (1..30, default 7) | D2-D9, D17, D23, D25, D26, D31-D33 |
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
specs; CI runs it once #1915's `test-social-integration` job is on `main`, and skips it until then.

Indexes beyond the exclusion's own GiST: `bookings ("holderId", "startsAt")` (my bookings),
`("resourceId", "startsAt")` (a resource's bookings in time order, the D29 refusal) and `("endsAt")`
(the purges of D18 and D19 select on the slot's end).

### A deleted account (2026-10-16, review of #1963)

`InternalController.deleteUserData` calls `deleteBookingsUserData`
(`apps/social-service/src/bookings/bookings-account-deletion.ts`), one transaction:

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
