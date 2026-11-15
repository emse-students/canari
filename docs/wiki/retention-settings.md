# Retention durations - the admin settings, and every duration the platform applies

**Decided by the owner, 2026-11-14:** *"every retention duration becomes a platform admin setting,
and the privacy policy renders the values in force from the same source, so they can never disagree;
a lowered duration applies to new content only."*

This page is the ONE inventory of how long the platform keeps what it stores, which of those
durations an administrator sets, and how a setting reaches the code that deletes and the text that
promises.

## What is a setting today, and how it works

Four durations are `platform_config` columns (core migration `025_platform_config_retention.sql`),
moved by a global admin at `/admin/platform` ("Durées de conservation"):

| Setting (admin route key) | Column | Default (= the value before) | Bounds | Applies to | Stamped by |
| --- | --- | --- | --- | --- | --- |
| `retentionReelDays` | `retention_reel_days` | 365 | 1-3650 | a feed CanaReel, from its publication | social-service, `posts."expiresAt"` at `createPost` |
| `retentionLiveReplayDays` | `retention_live_replay_days` | 3 | 1-365 | a live replay, from the live's end | social-service, `posts."expiresAt"` at `publishReplay` |
| `retentionChatReelDays` | `retention_chat_reel_days` | 30 | 1-365 | a CanaReel sent in a conversation, from its upload or its chat hold | media-service, the chat hold's `dueAt` on the index entry |
| `retentionIdleFileDays` | `retention_idle_file_days` | 90 | 1-3650 | a file sent in a conversation (`ephemeral`), from its last download | media-service, `idleRetentionMs` on the index entry |

**READ AT CREATION, NEVER AT THE SWEEP.** Each service reads the column when it CREATES the item and
writes the resulting expiry onto the item; the deleting job reads only the item. So a lowered
duration applies to new content only - and a raised one too: nothing already stored moves. This is
the owner's rule made structural rather than a promise: no sweep can apply a later value, because no
sweep reads the setting.

- **social-service** reads the columns straight from the shared database
  (`common/retention-settings.ts`, the `push-mode` reader's pattern): never cached, a missing row read
  as the columns' defaults and accused ONCE per process at ERROR (`[RETENTION]`), an unusable value or
  a failed query THROWN - the publish fails rather than stamp an expiry nobody can read. The reel's
  lifetime is read before the blob is claimed, so a refused read changes nothing.
  `GET /api/posts/reel-limits` serves `retentionDays` from the same read.
- **media-service** has no database, and it HOLDS the two durations it stamps in memory
  (`MediaRetentionHolder`, `media/retention-settings.ts`) - see [below](#media-service-holds-the-durations-it-stamps).
  An upload of an `ephemeral` or `chat-reel` file, and a chat hold, read the held values and never
  the network. A file uploaded before 2026-11-14 carries no stamp and keeps the window it was promised (90 days
  idle, 30 days for a chat reel). The bench override `MEDIA_CHAT_REEL_RETENTION_MS` still wins over
  the setting when set, so a bench can cross the window in seconds.
- **core-service** owns the columns: `RETENTION_SETTINGS` (`platform/retention.ts`) lists each with
  its default and bounds, the DTO refuses a value outside them as a `400` (the column's CHECK would
  make it a `500`), and a change is logged at WARN with the actor (`retentionReelDays 365 -> 180 days
  by=...`). `GET /api/version` publishes the four as `retention: { reelDays, liveReplayDays,
  chatReelDays, idleFileDays }`.

### Media-service holds the durations it stamps

**Decided by the lead after the adversarial review of #3521 (2026-11-14), under the owner's
"architecturalement réglé" rule:** a conversation upload must not depend on social-service answering
at that moment. The first build asked social-service's relay at every upload (2 s timeout, a 503 when
it did not answer) - so a social-service restart refused every chat file for its duration. Now:

- **It reads on three events, and on no clock.**
  - **Boot:** `RetentionBootstrap` reads before the routes listen.
  - **Notice:** `POST /api/media/internal/retention-changed`, behind `X-Internal-Secret`. Core-service
    sends it after an admin moves a duration (`notifyMediaRetentionChanged`), bare.
  - **Demand:** once, when an upload finds nothing held.
- **And it is HANDED them once, by social-service's boot** (2026-11-15, below). `RetentionBootNotice`
  reads the two durations from `platform_config` and sends them in the notice's body
  (`{ chatReelDays, idleFileDays }`, parsed by `handedRetention`: both or neither, a malformed body a
  `400`). `MediaRetentionHolder.notice` holds handed values **only when it holds nothing**, with no
  read; once anything is held, a notice with values is a bare notice and a READ decides. So a handed
  snapshot ends the "nothing held" state and can never replace a value a read produced: it was taken
  before it travelled, and an admin change committed meanwhile would be overwritten by an older value.
  The reads keep the ordering below. A social-service that cannot read the columns at its boot sends
  no notice (ERROR on its side): there is nothing to hand over.
  **The one window a handed snapshot can leave stale, and what shows it:** social-service reads A, an
  admin commits B, core-service's bare notice reaches a media-service that holds nothing and its read
  fails, then the handed A is held. Nothing in media-service can tell A is older; the admin page does -
  core logged its notice as not taken, `/admin/platform` compares the held A with the column B, shows
  "pas encore appliqué aux fichiers" and offers "Renvoyer", whose read then brings B (below).
- **A read that fails after values were held behind it opens no outage** (review of #3645). A demand
  read in flight when a notice hands the values, answered 404 by the old replica afterwards, would
  otherwise reopen an outage over values newer than it (a WARN "values read 0 s ago" that no event
  closes). Each read notes the holder's hold count at its start; when the count moved, its failure is
  a debug line and the outage state is left alone.
- **Every read** asks social-service's relay `GET /api/internal/retention` (`InternalRetentionController`),
  which reads `platform_config`. **A notice never joins a read already running** (review of #3554):
  that read may have asked before the admin's `UPDATE` committed, and joining it answered
  `refreshed: true` with the old values. A notice (or the boot) gets a FRESH read started after the
  running one - one queued read, shared by every notice that arrives before it starts. An upload's
  demand only needs some value and joins whatever runs. **One read at a time, always** (delta
  review): the running read hands `inFlight` to the queued one in the callback that settles it, so a
  demand arriving in between joins rather than starting a second read, and an older read can never
  overwrite what a newer one wrote.
- **A failed re-read keeps the last values.** It logs `[RETENTION] re-read (notice) FAILED (...):
  uploads keep the values read N s ago`, naming their age. It never falls back to a default.
- **An outage is logged by state, twice** (re-review of #3521): the first failed read opens it -
  the WARN above, or an ERROR when nothing is held - and the first successful read after it closes
  it, `readable again (...) after N s: M upload(s) refused meanwhile`. Every read and refusal in
  between is a debug line, so a social-service outage is not an ERROR per upload. Nothing held always
  means an outage is open and already logged: `RetentionBootstrap` awaits the boot read before the
  routes listen (tested), and a failed boot read opens the outage. The count resets on every
  successful read, so it never carries into a later outage.
- **Nothing held at all** (the boot read failed, and nothing has succeeded since) **refuses** the
  upload with a `503`, before a byte is stored. That upload asks for the read, which runs beside the
  refusal and never in its path. The client's outbox retries a 503, and its next try finds the values.
- **A notice that fails** is an ERROR on the sender's side, and the admin's save stands. Media-service
  keeps stamping the values it read last until its next read: the next change, its own next boot, or
  social-service's next boot.
- **The admin page SEES a lost notice** (re-review of #3521). `GET /api/users/admin/platform/retention-applied`
  compares what media-service holds (`GET /api/media/internal/retention`, behind the secret) with the
  columns (`retentionAppliedState`); while they differ, `/admin/platform` shows "pas encore appliqué
  aux fichiers" with "Renvoyer" (`RetentionAppliedNotice`), which sends the notice again
  (`POST .../retention-applied/resend`). **The version is the values themselves**: the lead asked for
  a counter or an `updatedAt`; the values answer the admin's actual question - "are new files
  stamped with what I set" - with no new column, and a change and its undo (30 -> 7 -> 30, the 7
  lost) cannot read as behind. No timer and no retry: the state is read when the page loads or saves.
  **Each cause is said apart** (review of #3554), because a status code is an answer and a transport
  failure is not: `behind`; `refused` with the status media-service answered and why - `secret`
  (401/403, the internal secret is misconfigured), `route` (404, an older media-service during a
  deploy), `malformed` (a body not of the shape), `status` (anything else); `unreachable` (no
  answer - a body cut after a 2xx included, and the cause names Node's system code, e.g.
  `fetch failed (ECONNREFUSED)`); and, on the page only, `failed` - the page's OWN request to core-service failed, which
  claims nothing about media-service and offers no "Renvoyer". Only the newest answer is
  shown (a sequence number): a late answer to an older read is dropped, a failed newer read leaves
  the last good answer in place, and a "Renvoyer" answer is numbered on arrival, so no read started
  before the notice completed can replace it; a shown answer clears a failed resend's alert. A
  `refused` without its status and reason is a failed read, never worded "HTTP 0". Core and the page
  each log a CHANGE of the state (WARN, or a line on the return to `applied`), never each page view.
- **The social-service boot notice lands before social-service listens** - `onApplicationBootstrap`
  runs before `listen` - which is why it carries the values rather than asking for a read (below).

**The deploy window - stated, retried, no fallback.** The deploy replaces services in `depends_on`
order, and social-service depends on media-service, so media-service boots first.

- **On the release that introduced the relay** (`1.7.0`), the new media-service boots beside the
  old social-service, which has no relay route. Its boot read fails (ERROR), and conversation uploads
  answer `503` until the new social-service boots and HANDS it the values. That window is the time
  between the two replacements, seconds to a minute or two. The client retries those uploads; none
  is stamped with a guessed value.
- **Why the notice carries the values (P1 found on dev at the `1.7.0-alpha.1` deploy, 2026-11-15).**
  The first build's notice said only "read again", and the read goes through the mesh
  ([cicd](cicd.md#service-to-service-calls-go-through-the-mesh)). While a replica of social-service is
  replaced, the mesh's target for it is the service's DNS name - both the retiring replica and the
  booting one - until the new one is HEALTHY and `rotation_take_out` names it alone
  (`infrastructure/lib/rolling.sh`). The notice is sent from `onApplicationBootstrap`, before `listen`:
  the new replica refuses the connect (`connect() failed (111)` in the mesh at 17:08:08), the mesh
  hands it to the next address (`proxy_next_upstream error`), and the retiring replica, which predates
  the route, answered `404` (17:08:10, `read (notice) still failing`; social:
  `HTTP 201, refreshed=false`). **The overlap: the notice is proof that the NEW replica is up, the
  read is answered by whichever replica the mesh's rotation holds, and at that instant the rotation
  holds the old one.** No upload was tried before the restart that unblocked dev, so the demand read
  never ran; it would have cost one refused upload per media-service, and an ERROR at every deploy
  that adds a relay route. Now the proof of availability and the data travel together.
- **What ends "nothing held", in every order.** *media first, social second* (the release adding the
  relay): the new social-service's boot hands the values. *Social first, then media restarts*: the
  boot read reaches a social-service that answers the relay. *Both rolling* (media is replaced first,
  `depends_on`): the boot read lands on the retiring social replica, which answers the relay on every
  release after `1.7.0`, and the new one's boot hands the values anyway. *Social rolled back*: a
  rollback restores the whole release, and a media-service from before `1.7.0` holds no durations; a
  `1.7.0` media-service beside a social-service from before the relay holds nothing until a
  social-service that has it boots and hands them - refusing is the designed answer to an unreadable
  value, never a default. In every order, a read that still fails is retried by the next conversation
  upload's demand (one `503`), never by a timer
  ([`retention-settings.rolling-deploy.spec.ts`](../../apps/media-service/src/media/retention-settings.rolling-deploy.spec.ts)
  reproduces the 404-from-the-old-replica ordering).
- **On every later release**, the old social-service already answers the relay, so the boot read
  succeeds and the window is zero.
- The deploy never waits on this read: media-service's health is its liveness. A health gated on the
  read would deadlock the deploy that introduced the relay, because media-service would wait for a
  route that only the next service in the order brings.

`retentionSettingsAgree.test.ts` (frontend) holds the five copies together: the migration's
defaults and CHECKs, core's list, social-service's reader, the client's defaults, and the two pages
that render every setting.

## The privacy policy renders the values in force

`frontend/src/routes/legal/privacy/+page.svelte` prints each adjustable duration with
`durationLabel(retention.days.X)`, from `serverRetention()` - the `retention` of `/api/version` -
and never a number typed in the text. The live texts of the broadcaster (`LiveBroadcaster.svelte`,
"visible {days}") read the same value.

**The prerendered, server-rendered and offline cases - decided 2026-11-14 (lead, reversible):** the
app has NO prerendered or server-rendered body (`ssr = false` in the root layout; `frontend-ssr`
writes only the Open Graph head), so there is no HTML that could carry a stale number. The page shows,
in order:

1. the live `/api/version` answer (the page asks for one when it opens);
2. an answer read EARLIER in this session (`sessionStorage`, `canari:retention_read`, stored with
   the moment it was read) - offline, or a probe that failed. It is never presented as current:
   a notice above the table says the server could not be reached and gives the date, "valeurs du
   <date>" (`legal_privacy_retention_cached_notice`; review of #3521). The cache is `sessionStorage`,
   so it is always THIS tab's session - but a session can be long (an app left open for days), so
   the notice gives the date, which says how old the values are, and nothing more (re-review);
3. with neither - the first launch offline - the values each column is created with
   (`RETENTION_DEFAULTS`), and a notice above the table saying they could not be confirmed and may
   differ, logged at WARN. Never a blank.

A crawler or an unfurler sees no table at all, as before: the page is a client-rendered SPA.

## Every retention duration in the code (inventory of 2026-11-14)

Read from the code, not the docs; `file:line` at the time of writing. "Stamp" = the expiry is written
on the item at creation; "sweep" = the job computes "now minus N" each run.

### Settings (above)

| Data | Value | Where |
| --- | --- | --- |
| Feed CanaReels | 365 d, stamp | social `posts.service.ts` (`createPost`) |
| Live replays | 3 d after the end, stamp | social `lives.service.ts` (`publishReplay`) |
| CanaReels sent in a conversation | 30 d, stamp (hold `dueAt`) | media `media.service.ts` |
| Files sent in a conversation (`ephemeral`) | 90 d idle, stamp (`idleRetentionMs`) | media `media.service.ts` (`isDue`) |

### Not yet settings - user data and content

| # | Data | Value | Constant | Clock | Policy |
| --- | --- | --- | --- | --- | --- |
| 1 | Replay cap-eviction records | 30 d | `LIVE_REPLAY_EVICTION_KEEP_DAYS` (social `lives/live.constants.ts`) | sweep | no |
| 2 | Live segments, chat, reactions (no replay) | end of live + 60 s lease | `LIVE_RECONNECT_WINDOW_MS` | sweep | yes |
| 3 | `live_starts` | 1 h | `LIVE_START_WINDOW_MS` | sweep | yes |
| 4 | Live moderation cuts | 90 d | `LIVE_CUT_RETENTION_MS` | sweep | yes |
| 5 | Reported live chat lines | until handled, 90 d max | `LIVE_CHAT_REPORT_MAX_KEEP_MS` | sweep | yes |
| 6 | Live arrival keys (Redis) | 6 h | `LIVE_ARRIVALS_TTL_MS` | TTL | register |
| 7 | Salon messages (pinned exempt) | 365 d | `CHANNEL_MESSAGE_RETENTION_DAYS` (social `channels/channel-retention.scheduler.ts`) | sweep | yes |
| 8 | Deleted salon message traces | 30 d | `CHANNEL_MESSAGE_TOMBSTONE_RETENTION_DAYS` | sweep | yes |
| 9 | In-app notifications | 90 d | `GC_NOTIFICATION_DAYS` (social `forms/forms-reminder.scheduler.ts`) | sweep | yes |
| 10 | Opening reminders | 30 d after opening | `GC_REMINDER_DAYS` | sweep | yes |
| 11 | Expired member tags | `expiresAt` + 30 d | `GC_USER_TAG_GRACE_DAYS` | stamp + grace | no |
| 12 | Delivered webhook deliveries | 30 d | `GC_WEBHOOK_DELIVERY_DAYS` | sweep | register |
| 13 | Handled content reports | 90 d after review | `GC_CONTENT_REPORT_DAYS` | sweep | yes |
| 14 | Engagement push counters / campus trend weeks | 7 d / 14 d | `ENGAGEMENT_PUSH_DAYS_KEPT`, `CAMPUS_TREND_WEEKS_KEPT` | sweep | yes |
| 15 | Form answer files | 1-30 d per form (7 by default) | `FILE_RETENTION_*_DAYS` + `forms.fileRetentionDays` | sweep, per-form | yes |
| 16 | Unsent form uploads | 1 d | `FORM_FILE_UPLOAD_WINDOW_DAYS` | sweep | implicit |
| 17 | Uncited form-item images | 24 h | `UNCITED_IMAGE_GRACE_HOURS` | sweep | register |
| 18 | Form answers | none fixed | - | - | yes ("aucune durée") |
| 19 | Booking answers and files | 1-30 d per space after the slot | `booking_spaces.retentionDays` | sweep, per-space | yes |
| 20 | Bookings and booking blocks | 1 year after the slot | `BOOKING_MAX_AGE` | sweep | yes |
| 21 | Birthday change window / notice | 30 d / up to 300 d | `BIRTHDAY_CHANGE_WINDOW_DAYS`, `BIRTHDAY_NOTICE_EVERY_DAYS` | sweep | yes |
| 22 | Guest payment hold | 30 min | `PENDING_PAYMENT_HOLD_SECONDS` | sweep | yes |
| 23 | Queued MLS messages, sent-frame receipts | 90 d (deleted on delivery before) | `RETENTION_WINDOW_MS` (chat-delivery `retention.constants.ts`) | sweep | yes |
| 24 | Redis group history stream | 90 d + 8000 entries | same | per write | yes |
| 25 | Stale devices (no republished key package) | 90 d | same | sweep | no |
| 26 | Key package lifetime | 84 d | `KEY_PACKAGE_LIFETIME_DAYS` | stamp | no |
| 27 | MLS commit log | 365 d + 20 000 per group | `COMMIT_LOG_RETENTION_MS` | sweep | no |
| 28 | Soft-deleted group tombstones | 90 d | `TOMBSTONE_MAX_AGE_MS` | sweep | no |
| 29 | Push tokens | 90 d without renewal | `PUSH_TOKEN_MAX_AGE_MS` | sweep | yes |
| 30 | Pending device-group invitations | 14 d | `STALE_PENDING_INVITATION_MS` | sweep | no |
| 31 | Revoked device ids | 10 years | `DEVICE_REVOCATION_TTL_MS` | sweep | no |
| 32 | Group invite links | the creator's `expiresAt` | - | stamp | no |
| 33 | Call room binding / presence | ring + 4 h / 2 h | `CALL_ROOM_BINDING_TTL_SEC`, `USER_CALL_PRESENCE_TTL_SEC` | TTL | yes |
| 34 | TURN egress day totals | 70 d | `DAY_TOTALS_TTL_SEC` | TTL | register |
| 35 | Unclaimed `reel-pending` upload | 24 h | `PENDING_REEL_TTL_DEFAULT_MS` (media) | sweep | no |
| 36 | Unclaimed `poster-pending` upload | 48 h | `POSTER_PENDING_TTL_MS` | sweep | no |
| 37 | Media metadata tombstones | 90 d after purge | `META_TOMBSTONE_MAX_AGE_MS` | sweep | no |
| 38 | Resumable upload sessions | 24 h (15 min empty) | `MEDIA_UPLOAD_SESSION_TTL_MS` | stamp | no |
| 39 | Auth sessions | 7 d idle | `SESSION_TTL_SECONDS` (core) | stamp (sliding) | yes |
| 40 | `device_revoked_sessions` | 7 d + 120 s | `SESSION_TTL_SECONDS` + skew | sweep | register |
| 41 | Restore challenges | 5 min | `RESTORE_CHALLENGE_TTL_MS` | stamp | yes |
| 42 | Account-erasure journal | 30 d after completion | `JOURNAL_RETENTION_DAYS` | sweep | no |
| 43 | Online presence | 90 s | `PRESENCE_TTL_SECS` (gateway) | TTL | yes |
| 44 | Database backups | 7 d local / 14 d offsite | `LOCAL_RETENTION_DAYS`, `BACKUP_RETENTION_DAYS` (`infrastructure/backup/backup.sh`) | file age | yes |
| 45 | Object backups | 14 daily / 8 weekly / 6 monthly | `RESTIC_KEEP_*` | restic | yes |

Purely technical caches (access tokens, throttler windows, preview and GIF caches, the call
service's in-memory rooms) are not retention of user data and are left out.

**Why the others are not settings yet**: most are SWEEPS - the job computes "now minus N" - so a
setting read there would apply a lowered value to everything already stored, against the owner's
rule. Each needs its expiry stamped at creation first (a column per table, or an entry field), as the
four above have. That is the follow-up, planned in
[backlog.d](backlog.d/retention-durations-not-yet-settings.md); the infrastructure ones (backups,
TTLs of seconds or hours) are listed there with the reason each may stay a constant.
