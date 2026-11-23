# The usage dashboard: who uses Canari, and how - anonymously

**Owner, 2026-11-16 and 2026-11-19** ([decisions](decisions/owner-decisions-of-2026-11-19.md)): the
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

`usage::category(platform, user_agent)` in `chat-gateway`, the ONE implementation:

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
`libs/contracts/usage-dashboard.json`, its `parisTime` cases (instants on each side of both changes of the hour, and
of midnight). A Paris hour always begins on a UTC hour (both offsets are whole hours), so "the hour a
socket was last counted in" is the UTC hour index and changes exactly when the Paris hour does.

## Where it is stored

**Live counters in Redis** (every writer already talks to it, a write costs one round trip, and
counters on a hot row are what Redis is for - `push_delivery_daily` needed a writer of its own to
survive them in PostgreSQL):

| Key | Type | Written by | Lives |
| --- | --- | --- | --- |
| `usage:people:{day}` | HyperLogLog of keyed elements, never an id | gateway | 40 days |
| `usage:people:{day}:cat:{category}` | HyperLogLog | gateway | 40 days |
| `usage:people:{day}:ver:{version}` | HyperLogLog | gateway | 40 days |
| `usage:people:{day}:versions` | set of the versions given a key that day | gateway | 40 days |
| `usage:people:h:{day}T{HH}` | HyperLogLog, Paris hour | gateway | 30 days |
| `usage:activity:{day}` | hash: `messages`, `posts`, `reels`, `lives`, `calls`, `forms` | chat-delivery, social | 40 days |

One Lua script per write (`usage::NOTE_PERSON`; `HINCRBY` + `EXPIRE` for activity), so a key never
exists without its expiry.

**No account id reaches Redis** (review of #4004, 2026-11-23). A HyperLogLog hashes what it is
given with a FIXED, PUBLIC function (MurmurHash64A), and at the sizes this dashboard runs at it keeps
those hashes almost exactly (the sparse encoding). Adding the raw id would therefore make each key a
membership oracle: whoever holds Redis, or a copy of its RDB or AOF, could `DUMP` a key, `RESTORE` it
elsewhere, `PFADD` a candidate id and read 0 or 1 - and with the hour keys that is a near-exact
hourly presence trace per account over 30 days. So the gateway adds an ELEMENT, not the id:

- the element is `HMAC-SHA256(k, account id)`, in hex (`usage::UsageKey::element`); the same id
  always gives the same element, so one person on two devices stays one person;
- `k` is DERIVED, HKDF-SHA256 (RFC 5869) with salt `canari-usage` and label `usage-hll/v1`, from the
  gateway's existing `JWT_SECRET` - nothing new is provisioned, and `k` exists only in the gateway
  process: never in Redis, never in a log, never in the socket (which holds the element only);
- without `k`, a copy of a key answers no question about any account. Whoever holds `k`'s source -
  the `JWT_SECRET` - could still test an id, but that secret already lets its holder sign a session
  for any account, so the dashboard adds no reach to it.

**A rotation of `JWT_SECRET`** changes every element. A person counted before it and again after it
is counted TWICE in that day's, that week's and that month's figures (and that hour's): the counts
of the current periods restart on top of what they held. The figures already folded into
PostgreSQL are untouched. A deliberate re-key of the dashboard alone is a new label (`usage-hll/v2`),
with the same effect.

**Operating note: rotate at a month boundary.** The double count of a rotation lands in the day,
week, month and hour that SPAN it, and once those periods are folded it is PERMANENT (the fold keeps
the larger value, and the periods stop being re-read when their keys expire). Rotating `JWT_SECRET`
just after midnight on the first of a month confines it to that day, its ISO week and its hour, and
leaves every month's figure clean.

**Bounds** (abuse, never privacy): a socket counts at most ONCE PER PARIS HOUR (`SocketUsage` keeps
the last hour index it counted, in the socket task), so the gateway costs one script call per socket
per hour, not one per pong; at most 32 distinct versions a day get their own key, a 33rd is counted
under `ver:other` (the script checks the day's `versions` set).

**A version is a release or nothing** (review of #4004). A version becomes a `usage_figures` row kept
forever, which no erasure reaches, so free text a client typed in `app_version=` (a name, say) must
never become one. Only `X.Y.Z` or `X.Y.Z-alpha.N` - the contract's `versionGrammar`,
`^\d+\.\d+\.\d+(-alpha\.\d+)?$` - is counted under its own key (`usage::release_version`, at
the socket); the census's `unknown` stays `unknown`, anything else is `other`. The fold applies the
same grammar again (`isFoldableVersion`): a day's `versions` set holding anything else, which only a
writer that bypassed the gateway rule could produce, is not folded, and the fold warns with a COUNT,
never the text.

**The per-version split is indicative; the totals are not affected.** The grammar admits any digits
a client chooses. A client can therefore send 32 different release-shaped numbers in one day, take
all the day's version slots, and push every real version into `ver:other` for that day (and so for
its week and month). Only the `ver:` rows are distorted: the person is still counted once in `all`
and in their category, whatever version they declare. Nothing outside the grammar - only digits,
dots and `-alpha.` - can be kept this way.

**Durable figures in PostgreSQL**, `usage_figures` (social-service, migration 182, additive - a
`CREATE TABLE`, not held): `(period, start, metric, dimension) -> value`, `period` one of `day`,
`week`, `month`; `start` the period's first Paris day; `metric` `people` or an activity name;
`dimension` `all`, `cat:<category>` or `ver:<version>`. Kept with no limit (owner): it is anonymous,
tiny (about 25 rows a day) and in the nightly database backup, which Redis is not.

## The fold: Redis to PostgreSQL, idempotent

`UsageFold.foldOnce(now)` (social-service) reads every period whose Redis keys still live - each
Paris day of the last 38 (today included), each ISO week and calendar month STARTING in them (a
31-day month stays foldable for a week after it ends; a period that started earlier keeps the value it
was folded to while it was inside) - and upserts its figures, keeping the LARGER value
(`ON CONFLICT ... DO UPDATE SET value = EXCLUDED.value WHERE usage_figures.value < EXCLUDED.value`, so
an equal or smaller reading writes nothing):

- a day: `PFCOUNT` of its total key, of its seven category keys and of each key its `versions` set
  names; `HGETALL` of its activity (the six metrics, a field nobody decided ignored);
- a week or a month: `PFCOUNT` of the union of its days' keys (one command per dimension, the union of
  the days' `versions`) - a person on Monday and on Friday is one person in the week.

A category or a version with nobody is no row; a folded day always has its `people/all` row and its
six activity rows, so a day with nobody says 0, and a day never folded says nothing.

**Why the larger value and a re-fold, never a "close" of a day:** every input only grows (a counter, a union of
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
  category from its platform and user agent, HKDF against RFC 5869 test case 1, the element never
  the id and always the same for one id (and against a real Redis: the raw id was never added), only
  a release keeps its version (the contract's `versions` cases, a malformed one is `other`), once per hour per socket (released on a failed write),
  and against a real Redis: one person on two devices is one person, every key expires, a 33rd version
  is counted as `other`.
- `apps/chat-delivery-service/src/utils/usage-activity.spec.ts` (the contract's days, the expiry, a
  lost count is a warn and never a throw); `messaging.durability.spec.ts` (a visible message counts,
  a silent, handshake or refused frame does not); `calls.service.spec.ts` (one room, one call).
- `apps/social-service/src/usage/usage.spec.ts` (contract and its version grammar, a non-release
  never folded, Paris arithmetic, the fold's spans and
  unions, the upsert's order, the read's shape, the hour map through both changes of the hour);
  `usage-fold.integration.spec.ts` (migration 182 on a real PostgreSQL: the larger value is kept);
  the counting sites in `posts.service.reels.spec.ts`, `lives.integration.spec.ts`,
  `forms.service.guest-identity.spec.ts` and `forms.service.anonymous.spec.ts` (an anonymous answer
  is never counted).
