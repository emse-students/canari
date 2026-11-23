# The usage dashboard: who uses Canari, and how - anonymously

**Owner, 2026-11-16 and 2026-11-19** ([decisions](backlog.d/owner-decisions-of-2026-11-19.md)): the
platform admins see, as aggregated figures and never a person, how many DISTINCT people used Canari
per day, week and month (overall, per platform category, per app version), a week-by-hour map of
when it is used, and six daily activity totals. No small-number threshold. The daily figures are
kept with no limit; the sub-daily detail 30 days. The census of `/admin/status`
([chat-gateway](services/chat-gateway.md#the-anonymous-census-and-its-24-hour-series-2026-11-02))
answers a different question ("does the server hold") and is unchanged.

**The charter.** Principle 1 (*tes messages sont a toi*): messages are counted as a VOLUME for the
whole platform per day - never per conversation, per author, per hour or per platform, and nothing
of a message is read to count it (the server counts a frame it already accepted). Principle 3 (*ton
attention n'est pas a vendre*, "nous ne mesurons jamais le temps que vous passez sur Canari"): no
duration is computed or stored for anyone; the hour map says how many distinct people were connected
during an hour, never for how long any of them was, and the figures serve the platform's health,
never an engagement target.

## What is counted, and where the fact is KNOWN

| Figure | Counted at | Why there |
| --- | --- | --- |
| distinct people | `chat-gateway`, beside the presence write (`usage.rs`, called by `note_client` in `handlers.rs`) | the only place that holds the AUTHENTICATED account of a connected client, the platform its build declared and the request's `User-Agent`, together |
| messages | `chat-delivery-service`, `sendFrame` (`messaging.service.ts`), once the first copy of an application frame is accepted | the sender declares `silent` (read receipts, own-device copies, reactions, edits are silent; a message someone is told about is not) - the server reads that declaration, never the ciphertext; a REPEAT of a named message (`FrameAlreadyReceived`) returns before the count |
| calls | `chat-delivery-service`, `initiateCall` (`calls.service.ts`), once the room is minted | `POST /api/calls/initiate` is the one door a call starts through, one room per call |
| posts, CanaReels | `social-service`, `createPost` (`posts.service.ts`), after the INSERT committed | the `kind` it stamps (`post` / `reel`) is the split; a replayed client id answers from the existing row and is not counted |
| lives | `social-service`, `LivesService.start`, after the row is written | one row per live started |
| forms answered | `social-service`, `FormsService.submit`, after its transaction committed | a new NAMED answer (a member's, a guest's); a retry re-using a pending payment row is the same answer and is not counted again. **An anonymous form's answer is not counted**: it keeps only its week (owner, 2026-11-22, migration 181, charter principle 1), and a daily total would date it to the day again - the lead's reversible choice of 2026-11-23 |

Nothing is inferred from another figure, and no figure is recomputed from rows that exist for another
purpose (a post may be deleted, a live purged; the count says it was MADE that day).

## Platform categories (derived at the socket upgrade)

`usage::Category::derive(platform, user_agent)` in `chat-gateway`, the ONE implementation:

| Category | From |
| --- | --- |
| `app_android` | declared `platform=android` |
| `app_ios` | declared `platform=ios` |
| `app_desktop` | declared `platform=macos`, `windows` or `linux` |
| `web_android` | declared `platform=web`, `User-Agent` names `Android` |
| `web_ios` | declared `platform=web`, `User-Agent` names `iPhone`, `iPad` or `iPod` |
| `web_desktop` | declared `platform=web`, any other `User-Agent` |
| `other` | nothing declared (a build older than the census, 2026-11-02) or an unknown platform |

**Only the category is kept**: the `User-Agent` is read in the upgrade handler and dropped there. An
iPad whose Safari asks for the desktop site (the iPadOS default since 13) sends a Mac user agent and
counts as `web_desktop`: nothing in the request distinguishes it, and guessing from touch support
would need the client's word. The seventh bucket `other` exists so an old client is counted as a
person rather than dropped; it shrinks to nothing as builds update.

## Days, weeks and months are Paris time

A day is a calendar day in `Europe/Paris`, a week the ISO week (Monday to Sunday), a month the
calendar month - what a reader at the school means by "Monday" or "November". The writers compute
the Paris date of the instant they count; their clock is INJECTED (a test passes the instant):

- `chat-gateway` applies the EU summer-time rule (UTC+2 from the last Sunday of March 01:00 UTC to
  the last Sunday of October 01:00 UTC, else UTC+1; Directive 2000/84/EC) - `usage::paris_slot`;
- the NestJS services use `Intl.DateTimeFormat` with `timeZone: 'Europe/Paris'` - `parisDay`.

Two implementations of one fact, so they are pinned by ONE table both test suites read,
`libs/contracts/usage-paris-time.cases.json` (instants on each side of both changes of the hour, and
of midnight). A Paris hour always begins on a UTC hour (both offsets are whole hours), so "the hour a
socket was last counted in" is the UTC hour index and changes exactly when the Paris hour does.

## Where it is stored

**Live counters in Redis** (every writer already talks to it, a write costs one round trip, and
counters on a hot row are what Redis is for - `push_delivery_daily` needed a writer of its own to
survive them in PostgreSQL):

| Key | Type | Written by | Lives |
| --- | --- | --- | --- |
| `usage:people:{day}` | HyperLogLog of account ids | gateway | 40 days |
| `usage:people:{day}:cat:{category}` | HyperLogLog | gateway | 40 days |
| `usage:people:{day}:ver:{version}` | HyperLogLog | gateway | 40 days |
| `usage:people:{day}:versions` | set of the versions given a key that day | gateway | 40 days |
| `usage:people:h:{day}T{HH}` | HyperLogLog, Paris hour | gateway | 30 days |
| `usage:activity:{day}` | hash: `messages`, `posts`, `reels`, `lives`, `calls`, `forms` | chat-delivery, social | 40 days |

One Lua script per write (`usage::NOTE_PERSON`; `HINCRBY` + `EXPIRE` for activity), so a key never
exists without its expiry. **No id is stored**: a HyperLogLog keeps, per register, the longest run of
zeros seen in the hashes of what was added - an estimate of the number of distinct values (standard
error 0.81 %), not a list, and no id can be read back from it. **What it does allow, stated plainly:**
someone holding Redis itself and a given account id can test, with some probability, whether adding
that id would change a day's registers - a weak "was this account likely there" while the key lives
(40 days at most). Redis is not readable by an admin of the platform; whoever reads Redis reads the
presence keys too, which say it exactly. After 40 days only the numbers below remain.

**Bounds** (abuse, never privacy): a socket counts at most ONCE PER PARIS HOUR (`SocketUsage` keeps
the last hour index it counted, in the socket task), so the gateway costs one script call per socket
per hour, not one per pong; at most 32 distinct versions a day get their own key, a 33rd is counted
under `ver:other` (the script checks the day's `versions` set); the version grammar is the census's
(`ClientKind::from_query`).

**Durable figures in PostgreSQL**, `usage_figures` (social-service, migration 182, additive - a
`CREATE TABLE`, not held): `(period, start, metric, dimension) -> value`, `period` one of `day`,
`week`, `month`; `start` the period's first Paris day; `metric` `people` or an activity name;
`dimension` `all`, `cat:<category>` or `ver:<version>`. Kept with no limit (owner): it is anonymous,
tiny (about 25 rows a day) and in the nightly database backup, which Redis is not.

## The fold: Redis to PostgreSQL, idempotent

`UsageFold.foldOnce(now)` (social-service) reads every period whose Redis keys still live - each
Paris day of the last 38 (today included), each ISO week and calendar month STARTING in them (a
31-day month stays foldable for a week after it ends; a period that started earlier keeps the value it
was folded to while it was inside) - and upserts its figures
with `value = GREATEST(value, EXCLUDED.value)`:

- a day: `PFCOUNT` of its total key, of its seven category keys and of each key its `versions` set
  names; `HGETALL` of its activity (the six metrics, a field nobody decided ignored);
- a week or a month: `PFCOUNT` of the union of its days' keys (one command per dimension, the union of
  the days' `versions`) - a person on Monday and on Friday is one person in the week.

A category or a version with nobody is no row; a folded day always has its `people/all` row and its
six activity rows, so a day with nobody says 0, and a day never folded says nothing.

**Why GREATEST and a re-fold, never a "close" of a day:** every input only grows (a counter, a union of
registers), so the newest reading is the largest; an increment that lands after midnight in
yesterday's hash (the instant was read before midnight) is folded by the next run, instead of a
"day is closed" decision that a clock would have to make. Two replicas folding at once write the same
values, in primary-key order (no deadlock). A period whose keys have expired is no longer read and
keeps its last value. It runs every hour (`@Cron('29 * * * *')`, off the service's other minutes)
and before every read, so the page never shows a figure older than its request.

**What a gap means.** A day with no row had no fold while its keys lived (38 days of the service
down); the page draws a day without a row as a gap, never a zero it was not told.

## The read

`GET /api/admin/usage` (social-service, `NginxAuthGuard` + `GlobalAdminGuard`; nginx routes the exact
path `= /api/admin/usage` there, the rest of `/api/admin` stays on the gateway). It folds first, and a
Redis or a database that cannot be read is a 503, never an empty dashboard:

```
{ timeZone: 'Europe/Paris', today: 'YYYY-MM-DD',
  days:   [{ start, people: { all, categories: {..}, versions: {..} }, activity: { messages, .. } }],
  weeks:  [{ start, people: {..} }],
  months: [{ start, people: {..} }],
  hours:  { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', cells: number[7][24] } }
```

`days` is the last 366 (a school year and its neighbour), `weeks` and `months` everything kept. No
id, no per-person field. `hours.cells[d][h]` is the MEAN number of distinct people connected during
Paris hour `h` of weekday `d` (0 = Monday) over the 28 complete days before today - read live from the
hour keys, each local hour visited once (the autumn hour that happens twice is one key; the spring
hour that does not exist is not averaged as a zero).

## Interpretation taken, reversible

- **"The per-minute detail, 30 days"** is read as: the sub-daily detail this feature adds (the hour
  map's keys) lives 30 days, and the census's existing 5-minute series already keeps 30 days. The
  census's one-minute series stays at 24 hours: making it 30 days would cost ~50 MB of Redis for a
  resolution no chart on either page draws. Reversible: `RETENTION_SECS` in `census.rs`.
- **A person is counted when connected**, an open tab in the background included - the same meaning
  as the census, and the only one the server can know without measuring attention.

## Pinned by

- `apps/chat-gateway/src/usage.rs` - the Paris day and hour on every edge of the contract, every
  category from its platform and user agent, once per hour per socket (released on a failed write),
  and against a real Redis: one person on two devices is one person, every key expires, a 33rd version
  is counted as `other`.
- `apps/chat-delivery-service/src/utils/usage-activity.spec.ts` (the contract's days, the expiry, a
  lost count is a warn and never a throw); `messaging.durability.spec.ts` (a visible message counts,
  a silent, handshake or refused frame does not); `calls.service.spec.ts` (one room, one call).
- `apps/social-service/src/usage/usage.spec.ts` (contract, Paris arithmetic, the fold's spans and
  unions, the upsert's order, the read's shape, the hour map through both changes of the hour);
  `usage-fold.integration.spec.ts` (migration 182 on a real PostgreSQL: the larger value is kept);
  the counting sites in `posts.service.reels.spec.ts`, `lives.integration.spec.ts`,
  `forms.service.guest-identity.spec.ts` and `forms.service.anonymous.spec.ts` (an anonymous answer
  is never counted).
