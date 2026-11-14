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
| `retentionIdleMediaDays` | `retention_idle_media_days` | 90 | 1-3650 | a file sent in a conversation (`ephemeral`), from its last download | media-service, `idleRetentionMs` on the index entry |

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
- **media-service** has no database; it asks social-service's internal relay
  `GET /api/internal/retention` (`InternalRetentionController`, `X-Internal-Secret`) at each upload of
  an `ephemeral` or `chat-reel` file and at each chat hold (`media/retention-settings.ts`, the
  `lives-mode.ts` pattern). It FAILS CLOSED: an unreachable relay is a `503` before a byte is stored.
  A file uploaded before 2026-11-14 carries no stamp and keeps the window it was promised (90 days
  idle, 30 days for a chat reel). The bench override `MEDIA_CHAT_REEL_RETENTION_MS` still wins over
  the setting when set, so a bench can cross the window in seconds.
- **core-service** owns the columns: `RETENTION_SETTINGS` (`platform/retention.ts`) lists each with
  its default and bounds, the DTO refuses a value outside them as a `400` (the column's CHECK would
  make it a `500`), and a change is logged at WARN with the actor (`retentionReelDays 365 -> 180 days
  by=...`). `GET /api/version` publishes the four as `retention: { reelDays, liveReplayDays,
  chatReelDays, idleMediaDays }`.

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
2. this session's cached answer (`sessionStorage`, the version check's own cache) - offline, or a
   probe that failed;
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
