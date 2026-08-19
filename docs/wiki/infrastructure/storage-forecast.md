# Storage forecast

**Question asked (2026-08-06):** how much storage does Canari need at several hundred users - many
1:1 DMs, groups, communities, media - and can the current server hold it?

**Short answer: the data can fit; the BACKUP SCHEME cannot.** Every byte stored costs 16 bytes on
`canari`'s disk, because the nightly job tars the whole MinIO volume into a fresh archive and keeps
15 of them. At 400 daily users the disk fills in **9 to 34 days**, before media even reach the
plateau their 30-day sweep would give them. Fixing the backup is a configuration change and divides
the requirement by ~16. It is *not optional at any scenario*, including the most conservative one.

Everything below is measured on production, not estimated, unless a line says otherwise.

**A live admin panel now exists for four of these numbers** (`/admin/storage`, WP-DEVICESTORAGE-1's
backend counterpart, added 2026-08-11): disk usage, the Postgres `auth_db` size, the object
storage bucket, and Redis memory - via `GET /api/mls/admin/storage` on chat-delivery-service
(global-admin only). It replaces the manual `df`/`psql`/`redis-cli` steps below for a QUICK check;
the detailed per-table breakdown, the backup-cost multiplier and the scenario math below still need
this page.

**The media bucket is more than a total, since 2026-08-18**, because a bucket that grows looks
identical whether people are uploading more or the retention sweep has stopped removing anything -
and those two have opposite fixes. The panel separates them without storing any state or running
any timer of its own: everything is derived from one object listing crossed with the metadata index
(`MediaService.getStorageStats`), so asking twice a month apart makes the weekly buckets the slope.

| What it shows | What it distinguishes |
| --- | --- |
| Bytes last written in each of the last four 7-day windows | Growth. Climbing bars with everything else flat = people are uploading more. |
| Overdue objects, with the age of the OLDEST | A retention verdict. Under one sweep interval it is the ordinary gap between expiry and the sweep; over it, a pass ran and did not take them. |
| Untracked objects (in the bucket, absent from the metadata) | Objects no sweep can EVER reach, since the sweep only iterates the metadata. Measured at 7 on 2026-08-11. |
| Tombstoned objects (metadata says purged, object still present) | A delete that failed. Becomes "untracked" once the tombstone is trimmed at 90 days. |
| Public assets (avatars, logos) | Exempt from retention by design, so never counted as overdue. |

The overdue predicate is deliberately the SAME expression `purgeExpiredMedia` uses, which is what
makes the number a verdict on the sweep rather than an estimate of it - and is only true while the
two stay identical.

**The object storage backend migrated from MinIO to Garage on 2026-08-14** (MinIO is no longer
maintained upstream) - see [docker](docker.md). Every measurement below predates that migration
and describes MinIO; the byte counts, the retention model (§2.4) and the backup reasoning (§5.1)
are unaffected by the backend swap and still apply to Garage as written. Left as MinIO in place,
as a historical record of when each figure was measured - see [backup](backup.md) for the
volume-name changes that came with the migration.

---

## 1. What was measured (production, 2026-08-07)

Baseline population: **190 accounts, 232 live devices, 26 communities, 51 channels, 99 posts.**

### The host

| | |
| --- | --- |
| Disk | 125 G total, **32 G used, 87 G free (27 %)** |
| RAM | 16 Gi total, 2.4 Gi used, **13 Gi available**; 8 Gi swap |
| Docker | images 9.822 GB (**5.45 GB reclaimable**), volumes 3.581 GB |

### Postgres `auth_db` - **29 MB**

That figure is *after* `VACUUM (FULL, ANALYZE)`; it was 103 MB before, the difference being dead
tuples left by the WP-GHOST-1 purge. Cost per live row, total relation size including indexes:

| Table | bytes/row | rows | grows with |
| --- | ---: | ---: | --- |
| `queued_message` | 2 239 | 1 950 | messages x recipient **devices**, deleted on ACK |
| `one_time_key_package` | 876 | 10 233 | devices (~44 held per device) |
| `mls_commit_log` | 2 526 | 373 | membership changes |
| `mls_group_info` | 13 387 | 41 | MLS groups (ratchet tree, so also with members) |
| `posts` | 5 048 | 99 | posts |
| `dm_device_group_memberships` | 2 633 | 84 | groups x devices |
| `key_package` | 1 801 | 232 | devices |
| `channel_messages` | ~960 | 128 | community messages, **365-day window** (pinned exempt) since 2026-08-19 |

`channel_messages.content` averages **137 bytes** (max 480) - a base64 AES-256-GCM ciphertext of a
short text. Channels are not MLS: they use `HKDF(masterSecret, channelId, keyVersion)`, so the blob
carries no per-message MLS framing. That is why a community message costs a fiftieth of a DM one.

### MinIO `canari-media` - **61 MB, 158 objects**

Two populations, and they must be modelled separately:

| | count | median | mean | p90 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Real uploads (own part file) | 35 | 600 KB | **1.65 MB** | 4.25 MB | 8.06 MB |
| Small objects (inlined in `xl.meta`) | 123 | 16 KB | ~26 KB | - | 120 KB |

**Media are stored once and shared by every recipient and every device** - the client encrypts with
one CEK and uploads once; only the small message ciphertext is copied per device. So blob storage
scales with *uploads*, never with audience.

**Encrypted blobs are incompressible.** 61 MB of media produce a 65 MB nightly archive: gzip gains
approximately nothing on AES-GCM output. This matters twice below - it kills compression as a
mitigation, and it makes deduplication near-perfect.

### Redis - 2.08 MB, 37 keys

17 `history:<groupId>` streams, one per MLS group, capped `MAXLEN ~1000`, each carrying a **~90-day
TTL**. Measured cost **~460 bytes per entry** (109 068 B for 240 entries; 16 776 B for 33). A stream
at its cap therefore weighs **~460 KB**.

`maxmemory` is **0 (unlimited)** and the policy is **`noeviction`**. See §5.4.

### Backups - 1.2 G local, mirrored offsite

15 archives of 65-79 MB (`BACKUP_RETENTION_DAYS=14` + today), cron 03:30, `rsync` to `mitv`
(438 G, **376 G free**) with aligned retention. `backup.sh` takes a `pg_dump`, then
`tar czf minio_data.tar.gz -C /data .` over the **entire** MinIO volume, every night. See
[backup](backup.md).

---

## 2. The four storage classes

Getting the forecast right depends on four structural facts, each verified rather than assumed.

### 2.1 Chat history is NOT on the server

Canari is E2E. Plaintext lives in the client's IndexedDB / `mls.bin`. `queued_message` is a
**transit buffer**: a row is deleted the moment its device ACKs it, and an hourly job deletes
anything older than `RETENTION_WINDOW_MS = 90 days`. So DM and group-DM volume does **not**
accumulate server-side the way it would on a classical chat server. This is the single largest
difference from an ordinary capacity model.

### 2.2 But a DM is stored once per recipient DEVICE

`MessagingService.sendMessage` creates one `queued_message` row per `(userId, deviceId)`, each
carrying a full copy of the base64 MLS `proto`. **DM and group DM are the identical code path** - the
only difference is the length of the recipient list. This per-device fan-out is the multiplier that
WP-GHOST-1 exploited, and it is why nine dead devices were able to produce 150 MB.

### 2.3 Community channels do NOT fan out

Verified directly against production: **`SELECT count(*) FROM queued_message WHERE groupId IS a
channel id` returns 0.** A channel message is one row in `channel_messages` regardless of how many
members or devices exist; online clients get it over Redis pub/sub and offline ones get a direct FCM
push. Communities are therefore the *cheapest* surface per message and the model must not treat them
like groups.

The cost used to be on the other axis - nothing ever GC'd `channel_messages`, so community history
grew monotonically at ~960 B/row. **Since 2026-08-19 a message expires after 365 days**
(`ChannelRetentionScheduler`, daily at 03:45), pinned messages exempt, which turns that growth into
a rolling window the same way media's idle retention does. Account deletion still anonymises the
author rather than removing rows, and deleting a community drops its rows outright.

**The window was armed with the table EMPTY**, so nothing here is a forecast of what it saves: THE
CUT deleted every community on 2026-08-18 and `channel_messages` held 0 rows when the scheduler
shipped. The figure is owed once communities have been recreated and a year has passed - and until
then, the per-year line below is still the un-windowed model.

### 2.4 Media have a 30-day IDLE retention

`MediaService.purgeExpiredMedia` sweeps hourly and deletes any object whose `lastAccessAt` is older
than **30 days**, leaving a tombstone (trimmed at 90 days); public assets (association logos, event
images, form banners) are exempt and are permanent.

This bounds media storage to roughly a rolling window rather than letting it grow forever - which is
what makes the numbers below survivable at all. **It also has a product consequence that is a human
decision, not a technical one: see §6.**

#### The clock was measuring something it could not see (fixed 2026-08-11)

An earlier version of this page said `lastAccessAt` is refreshed on every download, "so anything
still being viewed survives indefinitely". The first half was true and the conclusion did not
follow. The client caches the **ciphertext** locally and indefinitely
(`canari-media-ciphertext-v1`), so once a device holds an object it never asks the server for it
again. A photograph opened daily by everyone in a conversation therefore left exactly the same
server-side trace as one nobody ever opened twice - the initial download - and both were deleted on
the same day. What the predicate actually measured was *"30 days since the last device that did not
already have it fetched it"*.

**The generalisation is the reusable part: a server-side clock can only measure the requests that
reach the server, so any cache in front of it silently changes what the clock means.** The name
`lastAccessAt` made that invisible - it described the intent, not the observation - and no test can
catch this, because the server behaves exactly as written.

`POST /api/media/touch` closes the gap: the client reports a cache hit and the object is treated as
used. Two rules keep it cheap, and both are about information rather than pacing - a report is
worthless twice on the same day when the clock has 30-day granularity, so it is **one report per
object per calendar day**, remembered durably so a reload does not re-report, and reports are
**merged into one request**. The day marker is written only after the server acknowledges: marking
on enqueue would cost the object a day of clock for one dropped request, and the failure mode of
this feature must always be "expires as it would have before", never "expires sooner".
`utils/mediaTouch.ts` (8 tests, two of which fail if the marker moves before the request) and
`media.service.touch.spec.ts` (6 tests, the important ones being the refusals: a tombstone is never
revived and an unknown id never creates an entry).

There is **no message-linked deletion**, deliberately: forwarding copies the `MediaRef` and the
server counts no references, so deleting a message's blob would break other people's messages. The
sweep takes it. **Account deletion IS wired** since 2026-08-11 (`ownerId` recorded at upload,
`DELETE /api/media/internal/users/:userId` called by `deleteUser`); objects stored before that date
carry no `ownerId` and remain reachable only by the sweep. See §5.3.

---

## 3. The model

Scale, as given: **300-500 daily users; the model uses 400 DAU / ~500 accounts.**

| Parameter | Value | Basis |
| --- | --- | --- |
| Devices per user | 2.5 | phone + laptop, plus re-enrolments. Cap is `MAX_DEVICES_PER_USER = 15` |
| Devices total | 1 250 | |
| Active DM threads per user | 25 | -> ~5 000 DM groups |
| Group DMs | ~170 | 5 per user, ~12 members each |
| Community channels | ~160 | ~40 associations x 4 |
| MLS messages per user per day | 30 | DM + group DM only |
| Community messages per day | 500 | platform-wide |

Fan-out per MLS message: a DM reaches the peer's 2.5 devices plus the sender's other ~1.5 = **4
rows**; a 12-member group DM reaches ~27.5. At 70 % DM / 30 % group that is **~11 rows per message**,
so **12 000 messages/day -> ~132 000 rows/day -> ~295 MB/day of inserts and deletes**.

Media are the free parameter, so they get three scenarios (mean upload **1.65 MB**, measured):

| Scenario | uploads/user/day | per day | steady state (~40 d) |
| --- | ---: | ---: | ---: |
| Low | 0.3 | 198 MB | **7.9 GB** |
| Central | 1.0 | 660 MB | **26 GB** |
| High | 3.0 | 1.98 GB | **79 GB** |

"~40 days" is the 30-day idle window plus the tail during which a photo is still being opened.

---

## 4. Result

### Live data, at steady state, 400 DAU

| Class | Low | Central | High |
| --- | ---: | ---: | ---: |
| **Media (MinIO)** | 7.9 GB | **26 GB** | 79 GB |
| `queued_message` (5 % of devices dormant across the 90 d window) | 1.3 GB | 1.3 GB | 1.3 GB |
| MLS group state (`mls_group_info` + memberships, ~5 200 groups) | 0.15 GB | 0.15 GB | 0.15 GB |
| Key material (1 250 devices x ~40 KB) | 0.05 GB | 0.05 GB | 0.05 GB |
| `channel_messages` + posts + commit log, **per year** | 0.4 GB | 0.4 GB | 0.4 GB |
| Redis history streams (worst case, all groups at cap) | 2.3 GB | 2.3 GB | 2.3 GB |
| **Total** | **~12 GB** | **~30 GB** | **~83 GB** |

Media are **87 % of the central total.** Everything else is rounding error, which is the useful
finding: there is no point optimising Postgres here.

### Then the backup multiplies it by 16

Live data L occupies `L + 15L = 16L` on `canari`'s own disk, because each nightly archive is a fresh
full copy of the same immutable, incompressible blobs.

| | Low | Central | High |
| --- | ---: | ---: | ---: |
| Live | 12 GB | 30 GB | 83 GB |
| **On disk with backups (x16)** | **127 GB** | **422 GB** | **1.27 TB** |
| Disk capacity | 125 GB | 125 GB | 125 GB |
| Verdict | **over** | **over 3.4x** | **over 10x** |

**Every scenario overruns, including the most conservative.**

### When it breaks

Not simply `87 GB / 16`: while media are still growing, an archive from ten days ago holds ten days
less media than tonight's. With media growing at `r` GB/day, day `N` occupies
`r*N` live plus `sum(r*(N-k))` for the 15 kept archives, i.e. **`16*r*N - 105*r`**. Setting that to
the 87 GB free:

| Scenario | r (GB/day) | days until the disk is full |
| --- | ---: | ---: |
| Low | 0.198 | ~34 days |
| Central | 0.66 | **~15 days** |
| High | 1.98 | ~9 days |

Media never reach their 30-40 day plateau in the central or high case: **the disk fills first.** In
the low case the two happen at about the same time, and the archives then keep growing for another
14 days as each one in turn is replaced by a full-sized copy - so it overruns shortly after.

### And if the backup is fixed

With media deduplicated instead of re-archived nightly (`L` live + ~`L` for one deduplicated copy):

| | Low | Central | High |
| --- | ---: | ---: | ---: |
| On disk | 24 GB | 60 GB | 166 GB |
| Fits in 87 GB free | yes | **yes** | no |

So the single configuration change turns "fails within a week" into "comfortable for years" at the
central scenario, and leaves only the high scenario needing a bigger disk.

---

## 5. What to do, in order of leverage

### 5.1 Stop re-archiving MinIO every night (x16, config only)

`backup.sh` step 3 tars the whole media volume nightly. Those objects are **immutable and
content-addressed**: 15 archives are 15 identical copies of bytes that never change, and gzip cannot
shrink them because they are AES-GCM output. Replace that one step with a deduplicating backup
(`restic` / `borg`) or a plain `rclone sync` to `mitv`, and keep the current 14-day full-archive
scheme for the `pg_dump` - which is 29 MB and where point-in-time copies are actually worth having.

This is the whole difference between the two tables above, it touches no product code, and it should
be done before any growth in usage rather than after.

#### BUILT AND MEASURED 2026-08-11 - running alongside the tar, cutover NOT taken

`infrastructure/backup/backup-objects.sh` keeps `infrastructure_minio_data` and
`infrastructure_media_meta` in a restic repository (that volume list is the pre-Garage one - since
2026-08-14 the script reads `garage_data` + `garage_meta` + `media_meta`) (throwaway image, no host dependency), 14d/8w/6m
retention, `restic check` after every run, then an rsync mirror of the repository to `mitv`. It is in
the `canari` crontab at 04:00, after the tar, and was verified under cron's own environment
(`env -i` + cron `PATH`), not just from an interactive shell.

What it measured on production, which is the argument for the cutover:

| Measurement | Value |
| --- | --- |
| First snapshot | 44.26 MiB, repository 46 MB |
| Second run, nothing changed | **24 KB** added |
| Control restore vs. the live volume | 172 media objects + metadata, **sha256 identical byte for byte** |

The only files that differed on restore were under `.minio.sys/` - the bloom cycle, the usage caches
and the trash, which MinIO rewrites continuously. That is not data, and it is worth knowing before
someone reads a diff and concludes the backup is wrong: the restored `.usage.json` hash was found in
the LIVE tree under `tmp/.trash/`, i.e. MinIO had rotated it in the four minutes between the two.

#### CUTOVER TAKEN 2026-08-11

Step 3 of `backup.sh` is deleted: restic is now the only backup of the media blobs. What was done
on production alongside it, and why each half is the way it is:

| | before | after |
| --- | --- | --- |
| `/home/canari/backups` | 1019 MB | **133 MB** (of which 46 MB restic) |
| offsite mirror on `mitv` | 1019 MB | **133 MB** |
| one nightly archive | 70-76 MB | 3-4 MB |

**The 15 existing archives were NOT deleted, and that correction matters more than the numbers.**
"Purge the old tars" is the obvious reading of the cutover and it would have destroyed the only
backup of the databases: each archive holds `postgres_auth_db.sql.gz` as well as the media. Only the
`minio_data.tar.gz` member was removed from each, in place, with the original mtime restored so the
retention `find -mtime` still ages them correctly, and with the presence of the Postgres dump
asserted before every rewrite. Generalisable: **before deleting a container to reclaim what one of
its members costs, enumerate the other members.**

The immediate disk saving is modest - 87 GB were free. What the cutover changes is the **slope**: a
night now costs what changed rather than the whole volume, which is the entire content of §4.

Two consequences of no longer having a second copy, both now enforced in code rather than remembered:

- `restore.sh` restores the objects from restic automatically, and **stops** if it can find them in
  neither place. The previous `if [ -f minio_data.tar.gz ]` would have skipped them without a word
  and finished announcing a complete restore that was missing 87 % of the data. An absent branch
  that is silent is worse than one that fails.
- The manifest inside each archive says, in the archive itself, that the media are elsewhere and
  which script restores them. A restore happens on the worst day of the year; the instructions have
  to travel with the artefact, not live only in a wiki.

While rewriting the manifest, one of its claims turned out to be false: it described
`mongo_chat_db.archive.gz` as "blobs MLS chiffres / historique". That dump is **116 bytes** because
production's MongoDB holds no application database at all (`admin`, `config`, `local` only) and
nothing connects to it - there is no MongoDB connection string anywhere in the code. The MLS history
is in PostgreSQL and was always backed up correctly. **Only the documentation was wrong, which
during an incident is worse than the documentation being absent**: it names a recovery source that
does not exist. The `mongo` service, its volume and its dump were deleted on 2026-08-18 - see
[databases](databases.md#mongodb---removed-2026-08-18).

One consequence that must not be lost: the repository password lives at
`/home/canari/.config/canari/restic-password`, NOT in `infrastructure/.env`, because the CD rewrites
that file from the GitHub secrets on every deploy and a repository whose password changes is
unreadable forever. It has to be copied off the machine - the offsite mirror is a copy of an
encrypted repository, not a second chance. See [MIGRATION.md](../../../infrastructure/MIGRATION.md).

### 5.2 Cap and re-encode media at upload time - **MEASURED AND REFUTED 2026-08-11**

> This section used to read "x5-10 on the dominant term ... measured p90 4.25 MB and max 8.06 MB,
> i.e. unmodified phone photos ... the **only** lever that reduces the live figure". Every clause of
> that is wrong, and it is kept here because the way it was wrong is the reusable part: **a
> distribution was attributed to a cause without checking whether the mechanism that would have
> prevented it was already running.** It was.

The server cannot transcode - it only ever sees ciphertext - so any re-encoding must happen
client-side, before encryption, in `frontend/src/lib/media.ts`. **It already does, on every upload
path**: `compressImage` (WebP, `IMAGE_COMPRESS_PRESETS`) is called by `useMessaging`
(`handleFilesSelected`, chat), `CreatePostForm`, `EditPostForm` and `PostComments`, and the outbox
flush re-uses the bytes it produced. There is no bypass.

**What one photo actually costs.** Twelve photographic 3840x2400 sources (~9 MP, comparable to a
phone photo) through Chrome's own canvas/WebP encoder - the same encoder the app uses - scored
against the original downscaled to the same output size:

| preset | output | mean size | vs today | PSNR |
| --- | --- | --- | --- | --- |
| **2560 / 0.92 (ships today)** | 2560x1600 | **245 KB** | x1.00 | 43.29 dB |
| 2048 / 0.92 | 2048x1280 | 175 KB | x0.71 | 42.39 dB |
| 2048 / 0.85 | 2048x1280 | 107 KB | x0.44 | 41.18 dB |
| 2048 / 0.80 | 2048x1280 | 86 KB | x0.35 | 40.52 dB |
| 1600 / 0.80 | 1600x1000 | 61 KB | x0.25 | 39.78 dB |

**245 KB, not 4.25 MB.** So the multi-megabyte objects are not images that escaped the compressor;
no setting of this preset produces them. Production on 2026-08-11, 26 live objects totalling
41.6 MB: the ten objects above 1 MB hold **35.3 MB, i.e. 85 % of the bytes**, and the five largest
are 4.15 to 7.86 MB - **16 to 32 times** what a full-resolution photograph costs here.

**So lowering the preset would halve the class that is not the problem.** It is not taken: the whole
image class is the small end of the distribution, and 43.29 -> 41.18 dB is a real quality loss paid
for bytes that do not exist. Should this ever be revisited, 2048/0.85 is the point to take - the
table is the argument, not taste.

**Where those bytes actually come from**, in order:

1. **Video, which is not compressed at all.** `handleFilesSelected` re-encodes images only; a clip
   goes up exactly as the camera wrote it. Nothing else in the app can produce a 7.86 MB object as
   routinely.
2. **The passthrough branches of `compressImage`**, which returned the original *silently* until
   2026-08-11. `decode-failed` is the expensive one: **HEIC** cannot be decoded by an engine without
   a HEIC codec, `img.onerror` fires, and a full-size iPhone photo is uploaded untouched. GIF and SVG
   are deliberate (re-encoding a GIF drops the animation). Each branch now logs its reason and the
   size, so the next large object is attributable from the client log instead of being a mystery on
   disk - see `PassthroughReason`.
3. The per-attachment cap, which already exists and is admin-configurable (`mediaMaxSizeBytes`).

**The honest conclusion for the forecast**: the 87 % media share is real, but it is a VIDEO
forecast, not a photo one, and the lever that would move it is client-side transcoding - expensive,
platform-specific, and not obviously worth it at this scale. The cheap win claimed by the old text
does not exist.

**One incidental finding, and its mechanism is in the code**: 7 of the 26 objects on disk have no
entry in `media_metadata.json` (~11 MB, including the two largest). `purgeExpiredMedia` iterates
`this.meta.items`, so an object with no entry is invisible to it **for ever** - it is not "not yet
due", it is unreachable. One way in is visible three lines apart in the same function: the
`storage.delete` failure was swallowed, the entry was still marked purged, and the tombstone trim
(`META_TOMBSTONE_MAX_AGE_MS`) later deleted the entry - after which nothing on the server knows the
object exists. That branch now logs (2026-08-11); an upload that wrote the object and died before
persisting the metadata is a second way in. **Reaping them needs a pass driven by the BUCKET rather
than the index**, which does not exist today - the same shape as 5.3, and the same GDPR point: an
object nothing can enumerate is an object no deletion request can reach.

### 5.3 Content-linked deletion - **HALF DONE 2026-08-11, and the other half must NOT be built**

The 30-day idle sweep used to be the only thing that ever deleted a blob, so an account deletion
left the account's images on disk: a **GDPR** point as much as a storage one, since a deletion that
leaves the data is a deletion that did not happen.

**Account deletion now reaches them.** The blocker was not the delete, it was attribution: the
service holds only ciphertext, and `upload` discarded the JWT's `sub` after using it to authenticate.
It records it (`MediaMetaEntry.ownerId`, simple and chunked uploads alike), and `deleteUser` fans out
to `DELETE /api/media/internal/users/:userId` alongside the existing chat-delivery and social calls -
best-effort with its own catch, like its siblings, because the user row must go even if a service is
down. `removeAllOwnedBy` skips public assets on purpose: an association logo outlives the member who
uploaded it. **Objects stored before this change carry no owner** and remain reachable only by the
retention sweep - there is no backfill, because nothing on the server knows who uploaded them.

**Message deletion deliberately does NOT delete the blob.** Forwarding copies the `MediaRef`, so one
object can be cited by messages in conversations the deleter cannot see, and the server - holding
ciphertext - can count no references. Deleting on message-delete would break other people's messages
with no way to detect it beforehand; the blob goes idle instead and the 30-day sweep takes it. This
is the same reason a refcount cannot simply be added: the count would have to be maintained by
clients that cannot see each other.

**The residual gap is the orphans** (see 5.2): objects with no metadata entry are invisible to both
mechanisms, including this one, since `removeAllOwnedBy` also iterates the index. Reaping those
needs a pass driven by the bucket.

### 5.4 Bound Redis - **DONE 2026-08-11**

`maxmemory` was `0` with `noeviction`: unbounded growth, and if the worst case above (~2.3 GB of
`history:` streams) were ever reached Redis would start **refusing writes** rather than shedding
load. The compose files now start it with `--maxmemory 1gb --maxmemory-policy volatile-lru`, in dev
as well as prod so an eviction can never be an environment difference.

`volatile-lru` is **strictly safer than `noeviction`, never worse**: it evicts only keys that already
carry a TTL, and once those are exhausted it degrades to exactly the old behaviour. Measured usage at
the time of the change was **2.29 MB**, so the cap is a ceiling, not a budget.

### 5.5 Tune autovacuum on `queued_message` - **DONE 2026-08-11, and it was never the cause**

Worth stating plainly, because the earlier text implied otherwise: **autovacuum was not failing.**
Measured on production after the queue cleanup - 1 173 live rows, 234 dead, `autovacuum_count` 78,
the last run that morning, table 7.8 MB. The 70 MB was one abandoned device accumulating 28 124
undelivered rows in five hours, which is a delivery problem answered by the hourly queue-depth
report, not by vacuum.

The per-table settings are applied anyway (`013_queued_message_autovacuum.sql`) because the CHURN
PROFILE justifies them: every row is inserted, delivered and deleted, and the default scale factor of
0.2 raises the threshold with the table, so it waits longest exactly when the table is largest. A
fixed 0.05 with a 200-row floor keeps the ceiling proportional to a healthy size.

### 5.6 Plan the disk

Measured 2026-08-11: **30 G used of 125 G (25 %)**, with 6.0 GB reclaimable from Docker images.
A `docker system prune` is therefore **not urgent, and it is not free**: the CD deploys `:latest`, so
the previous images are untagged and a prune deletes the fastest rollback path (GHCR still has them,
at the cost of a pull). Beyond that, 125 GB is small for this workload: with 5.1 and 5.2 applied, a
**500 GB** volume covers the high scenario for years, and `mitv` already has 376 GB free for the
offsite copy.

### 5.7 Alert on the WP-GHOST-1 shape

At this scale a cohort of ghost devices costs **~26 GB over the retention window** - the defect alone
would have filled the disk. The fix is in (`5335a71f`), but the cheap monitor is worth having:
any device holding memberships with **no** `key_package` row, and any device holding more than a few
hundred `queued_message` rows.

### 5.8 Two MLS tables are never purged for a deleted group - measured 2026-08-11, NOT worth acting on yet

`DELETE /api/mls/groups/:groupId` (`groups.controller.ts:131-143`) soft-deletes the `dm_groups` row
and hard-deletes `dm_group_members`, `dm_device_group_memberships`, `queued_message` and the two
Redis keys. It does **not** touch `mls_group_info` or `mls_commit_log`, and neither does the 90-day
tombstone purge (`app.controller.ts:550-568`) - neither migration declares an FK to `dm_groups`, so
nothing cascades. `mls_commit_log` shrinks only by age/size pruning; `mls_group_info` rows are
deleted nowhere in the codebase at all.

Measured on production:

| Table | Rows | Orphaned (no live group) | Total size |
|---|---|---|---|
| `mls_group_info` | 52 | **24 (46 %)** | 536 kB |
| `mls_commit_log` | 390 | **313 (80 %)** | 952 kB |

**The proportion is alarming and the volume is not**, and the honest reading is the second one: 1.5 MB
against a 125 GB disk, and the ratio is inflated by this campaign - ten test groups were created and
destroyed in a single day, which is not a rate any real deployment reaches. What makes it worth
writing down is that the leak is unbounded *in principle*: it grows with group churn and nothing ever
reclaims it, so the ratio is the quantity to re-measure rather than the byte count. Add the purge to
the tombstone cron when either table becomes visible in section 1's measurements - it is two `DELETE`
statements in a place that already enumerates the ids.

---

## 6. The retention policy - DECIDED 2026-08-11

**The 30-day idle media retention is what makes the forecast survivable, and it is also a product
behaviour, so it was put to the user rather than left as a side effect.** A photo nobody re-opens for
30 days is deleted from the server. Clients that already downloaded it may still hold a local copy,
but a **new device**, a **reinstall**, or anything that clears the local cache sees nothing older
than 30 days. The alternative was a longer window, which scales the media line above proportionally:
90 days roughly triples it.

**The decision: keep 30 days, and make the clock honest instead of moving it.** The question that
settled it was not "how long" but "since when" - the answer turned out to be *"since the last device
that did not already have it fetched it"*, not *"since anyone last looked"*, because of the client's
own ciphertext cache. Lengthening a window that measures the wrong thing buys the wrong thing more
slowly. The mechanism, its two bounding rules and the tests are in §2.4.

So the policy now says what it does: **30 days after the last time anyone actually opened it**, on
any device, cached or not.

### The deletion is no longer silent (2026-08-11)

The third bullet used to read "the conversation itself gives no indication that the image is gone
rather than failing to load", and the user's decision was to make the state explicit. **Half of that
was already shipped and the note was stale**: the server has answered `410 Gone` with
`purgeReason = 'retention_expired'` and the chat bubble has rendered "Média expiré (rétention 30
jours)." since June 2026 (`d00935bd`, `d2fb58cd`). Of the 189 media rows on production, **62 are
already `retention_expired`** - so this path is live, not theoretical.

What was NOT shipped is every OTHER surface, and the audit found three of the four consumers wrong:

| Surface | Before | After |
| --- | --- | --- |
| Message bubble (`MessageMediaRenderer`) | explicit expired label | unchanged |
| Post media (`PostMedia`) | rendered `err.message` - the **raw token `MEDIA_PURGED_BY_RETENTION`** shown to the user, in red, as an error | neutral box, `post_media_expired_label` |
| Shared-media grid (`SharedMediaThumb`) | bare `ImageOff` icon, identical to a network failure | icon + "Expiré", full sentence on the tooltip and the `aria-label` |
| Shared-media lightbox (`ConversationMediaPanel`) | `.catch(() => {})` - **spun forever** on a blob the server will never return | explicit expired/error state |
| That panel's file download | `console.error` only, no user feedback | toast |

**The generalisable defect was the classification, not the wording.** The transport threw
`new Error('MEDIA_PURGED_BY_RETENTION')` and each call site was left to sniff the message with
`String.includes` - so exactly one did, and it was the only surface that behaved. `utils/mediaErrors.ts`
now exports a `MediaPurgedError` class and the single predicate `isMediaPurgedError`; nothing branches
on the prose any more (`mediaErrors.test.ts` pins that a look-alike message is NOT accepted).

---

## Related

- [backup](backup.md) - the current scheme, its retention and the offsite copy
- [databases](databases.md) - what lives in Postgres and Redis
- [chat-delivery](../services/chat-delivery.md) - the per-device fan-out and `queued_message`
- [social-service](../services/social-service.md) - channel storage and the symmetric channel key
- [media-service](../services/media-service.md) - upload, encryption and the retention sweep
- [cross-client-testing](../cross-client-testing.md) - the campaign that found WP-GHOST-1, the
  defect that made this question worth asking; its narrative is in `CHANGELOG.md`
