# Storage forecast

**Question asked (2026-08-06):** how much storage does Canari need at several hundred users - many
1:1 DMs, groups, communities, media - and can the current server hold it?

**Short answer: the data can fit; the BACKUP SCHEME cannot.** Every byte stored costs 16 bytes on
`canari`'s disk, because the nightly job tars the whole MinIO volume into a fresh archive and keeps
15 of them. At 400 daily users the disk fills in **9 to 34 days**, before media even reach the
plateau their 30-day sweep would give them. Fixing the backup is a configuration change and divides
the requirement by ~16. It is *not optional at any scenario*, including the most conservative one.

Everything below is measured on production, not estimated, unless a line says otherwise.

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
| `channel_messages` | ~960 | 128 | community messages, **forever** |

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

The cost is on the other axis: **nothing ever GCs `channel_messages`.** Deleting a community only
archives it, and account deletion anonymises the author rather than removing rows. Community history
grows monotonically, forever - at ~960 B/row.

### 2.4 Media have a 30-day IDLE retention

`MediaService.purgeExpiredMedia` sweeps hourly and deletes any object whose `lastAccessAt` is older
than **30 days**, leaving a tombstone (trimmed at 90 days). `lastAccessAt` is refreshed on **every
download**, so anything still being viewed survives indefinitely; public assets (association logos,
event images, form banners) are exempt and are permanent.

This bounds media storage to roughly a rolling window rather than letting it grow forever - which is
what makes the numbers below survivable at all. **It also has a product consequence that is a human
decision, not a technical one: see §6.**

There is **no content-linked deletion**. Deleting a message does not delete its blob; deleting an
account does not either (`users.service.ts` calls chat-delivery and social-service, never
media-service). The 30-day sweep is the only path.

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
`infrastructure_media_meta` in a restic repository (throwaway image, no host dependency), 14d/8w/6m
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

**The tar is still the backup of record.** The cutover is one edit - deleting step 3 of `backup.sh` -
and it is deliberately not taken here: the decision was to prove a restore first and show it before
any change to how production is backed up.

One consequence that must not be lost: the repository password lives at
`/home/canari/.config/canari/restic-password`, NOT in `infrastructure/.env`, because the CD rewrites
that file from the GitHub secrets on every deploy and a repository whose password changes is
unreadable forever. It has to be copied off the machine - the offsite mirror is a copy of an
encrypted repository, not a second chance. See [MIGRATION.md](../../../infrastructure/MIGRATION.md).

### 5.2 Cap and re-encode media at upload time (x5-10 on the dominant term)

The server cannot transcode - it only ever sees ciphertext - so this has to happen **client-side,
before encryption**, in `frontend/src/lib/media.ts`:

- a hard cap per attachment (e.g. 25 MB), refused with a clear message rather than silently;
- re-encode images to a maximum dimension (~2 048 px) at WebP/AVIF quality ~80 before encrypting.

Measured p90 is 4.25 MB and max 8.06 MB, i.e. unmodified phone photos. Re-encoded they land around
200-400 KB. This is the **only** lever that reduces the live figure rather than the copies of it, and
it also cuts every user's mobile data bill.

### 5.3 Give media a content-linked deletion path

Today the 30-day idle sweep is the only thing that ever deletes a blob. At minimum, deleting a
message and deleting an account should delete their media - the internal endpoint already exists
(`DELETE /api/media/:id`, `assertInternalSecret`) and is already used for association logos; it is
simply never called from the chat or channel paths. This is also a **GDPR** point, not only a
storage one: an account deletion that leaves the user's images on disk is a deletion that did not
happen.

### 5.4 Bound Redis

`maxmemory` is `0` with `noeviction`. Worst case above is ~2.3 GB of `history:` streams against
13 Gi available, so there is no emergency - but `noeviction` means that if it is ever reached Redis
starts **refusing writes** rather than shedding load, and every one of these keys already carries a
90-day TTL. Set an explicit `maxmemory` (e.g. 3 GB) with **`volatile-lru`**, which can only ever
evict keys that were already expiring.

### 5.5 Tune autovacuum on `queued_message`

At 400 users this table takes **~132 000 inserts and deletes per day**. A single mass delete already
left 76 MB of bloat behind 1 950 live rows. Give it its own settings rather than the cluster default:

```sql
ALTER TABLE queued_message SET (autovacuum_vacuum_scale_factor = 0.01,
                                autovacuum_vacuum_cost_limit = 2000);
```

### 5.6 Free 5.45 GB now, and plan the disk

`docker system prune` reclaims 5.45 GB of images immediately. Beyond that, 125 GB is small for this
workload: with 5.1 and 5.2 applied, a **500 GB** volume covers the high scenario for years, and
`mitv` already has 376 GB free for the offsite copy.

### 5.7 Alert on the WP-GHOST-1 shape

At this scale a cohort of ghost devices costs **~26 GB over the retention window** - the defect alone
would have filled the disk. The fix is in (`5335a71f`), but the cheap monitor is worth having:
any device holding memberships with **no** `key_package` row, and any device holding more than a few
hundred `queued_message` rows.

---

## 6. What needs a human decision

**The 30-day idle media retention is what makes the forecast survivable, and it is also a product
behaviour that may not be intended.** A photo nobody re-opens for 30 days is deleted from the server.
Clients that already downloaded it may still hold a local copy, but:

- a **new device** sees nothing older than 30 days;
- so does a **reinstall**, or anything that clears the local cache;
- and the conversation itself gives no indication that the image is gone rather than failing to load.

That is a legitimate design for a student social app, and it is the reason media do not grow without
bound - but it should be a decision, not a side effect. The alternatives are a longer window (which
scales the media line above proportionally: 90 days roughly triples it), or an explicit "expired
media" state in the UI so the deletion is visible rather than silent.

---

## Related

- [backup](backup.md) - the current scheme, its retention and the offsite copy
- [databases](databases.md) - what lives in Postgres, Mongo and Redis
- [chat-delivery](../services/chat-delivery.md) - the per-device fan-out and `queued_message`
- [social-service](../services/social-service.md) - channel storage and the symmetric channel key
- [media-service](../services/media-service.md) - upload, encryption and the retention sweep
- [cross-client-testing](../cross-client-testing.md) - the campaign that found WP-GHOST-1, the
  defect that made this question worth asking; its narrative is in `CHANGELOG.md`
