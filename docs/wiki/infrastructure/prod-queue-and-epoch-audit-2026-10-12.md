# Production queue and epoch audit - 2026-10-12

**Question (user, 2026-10-12):** devices look out of date, they do not catch up to a community's
epoch, and everything feels slow. `queued_message` held 14 493 rows on 2026-09-22 and holds
**93 580** today. Is a client stuck, is the queue a backlog of the dead, and what costs the most?

**Short answer.** No client is provably stuck. The jump comes from ONE community created
yesterday evening, and from two things that were already in the design:

1. **Answers to seed requests are sent to the WHOLE community and queued for every offline seat.**
   In the 37 minutes of server log available, the new community's key group carried 391
   application frames. 22 were new seeds. At least 185 were requests and about 184 were answers,
   each answer delivered to about 100 seats. Bundles of 16 KB or more are 11 % of that group's
   queued rows and **70 % of its bytes**.
2. **42 % of all active device seats (821 of 1 952) belong to a device with no session left**, and
   those devices hold **56 % of the queue rows** (52 691). Nearly all of them are old browser
   profiles whose owner has signed in somewhere else since.

The "external-join churn" hypothesis is **REFUTED**. The new community has 137 commits from 90
devices: 80 devices committed once, and the busiest sender's 40 commits are admissions by the
person who added the members (median 6.7 KB, section 20 of
[channel-encryption](../protocols/channel-encryption.md)).

Measured on production with read-only `SELECT`s and `docker logs`, 2026-10-12 08:53-09:10 UTC.
People are named by role only
([durable-rules](../durable-rules.md#a-measurement-taken-from-production-names-roles-and-counts-never-people---this-repository-is-public)).
Group ids are cut to 8 hex characters. Nothing was written to production.

## 1. The queue, measured

| What | Value |
| --- | --- |
| Rows / table size / ciphertext (`proto`) | 93 580 / 350 MB / 263 MB |
| Devices / users with a queue | 558 / 199 |
| Commits / Welcomes queued | 18 113 / 691 |
| Oldest row | 2026-07-28 (inside the 90-day window) |
| Rows written on 2026-10-12, before 09:00 UTC | **32 211** (2026-10-05..09: 3 676 to 6 441 a day) |

These are the rows still waiting. A row is deleted when it is acknowledged, so the number of rows
WRITTEN per day is higher than this.

| Group kind | Rows | Groups | Devices | Commits |
| --- | --- | --- | --- | --- |
| Community key group (`distributionWorkspaceId`) | 49 616 | 13 | 316 | 9 623 |
| DM | 28 016 | 172 | 326 | 3 495 |
| Group conversation | 15 822 | 9 | 184 | 4 930 |
| Salon key group | 121 | 1 | 12 | 64 |

| Rows per device | Devices | Rows |
| --- | --- | --- |
| < 10 | 161 | 808 |
| 10-99 | 175 | 5 478 |
| 100-499 | 183 | 42 982 |
| 500-1 999 | 36 | 26 625 |
| >= 2 000 | 2 | 17 682 |

| Age of row | Rows | Devices |
| --- | --- | --- |
| < 1 day | 41 410 | 471 |
| 1-7 days | 24 141 | 331 |
| 7-14 days | 13 297 | 251 |
| 14-30 days | 12 641 | 190 |
| > 30 days | 2 086 | 66 |

## 2. The community created yesterday: `1b1687d0`

The community and its key group were created on 2026-10-11 at 20:52 UTC. By 09:05 it had 93
members (70 of them joined between 21:00 and 22:00), 112 device seats and **epoch 137**. It is
the largest single source in the queue: **34 946 rows for 187 devices**, none older than the
evening before.

**Its commit log has no hole** (epochs 0 to 136, 137 rows). The commits per hour follow the joins:
79 commits at 21:00, 11 at 22:00, then 1 to 15 an hour.

| Committing devices | Commits |
| --- | --- |
| 80 devices, exactly once each (first join) | 80 |
| 10 devices, 2 or 3 times (re-join or resync) | about 17 |
| The admitter's browser (median 6.7 KB, epochs 4-86) | 40 |

**What its queued rows are**, grouped by distinct ciphertext. The server cannot read them, so the
categories come from the delivery class and the size:

| Kind | Size | Payloads | Rows | Copies per payload | MB |
| --- | --- | --- | --- | --- | --- |
| application | < 1.5 KB | 704 | 21 633 | 31 | 17.2 |
| application | 1.5-4 KB | 127 | 4 260 | 34 | 10.7 |
| application | 4-16 KB | 88 | 2 532 | 29 | 19.0 |
| application | >= 16 KB (seed bundles, up to 60 KB) | 93 | 3 877 | 42 | **136.1** |
| commit | all | 130 | 2 875 | 22 | 7.2 |
| Welcome | all | 33 | 87 | 3 | 4.0 |

**The answerers are who the election rule says they should be.** Most bundles come from the
community's lowest user ids, because `resolveAnswerer` and `requestCommunityHistory` pick the
lowest online user id. Others come from the community's main author, who minted 45 of the 136
salon sessions and is asked first for each of them as its sender. In both cases every device of
that user answers (finding G of the
[web console audit](../frontend/web-console-log-audit-2026-10-12.md)).

### The 37 minutes the delivery log still holds (08:28-09:05 UTC)

The delivery container restarted at 08:28, so only this window is left. The counts come from
`[SEND] START` and `TRANSPORT_SKIPPED_OFFLINE` lines on `group=1b1687d0`:

| What | Count |
| --- | --- |
| Application frames sent on the key group | **391** (103, 84, 82 and 114 per 10 min) |
| ... of which transport, offline recipients dropped (requests and declines) | >= 185, from 34 devices of 29 users, at most 13 per device |
| ... new salon sessions in the same window (one seed distribution each) | 22, for 34 salon messages |
| ... therefore durable answers (seed bundles) | about 184 |
| Commits | 5 |
| Offline device deliveries skipped for transport frames | 18 628 |

**About 94 % of the application frames on that key group were repair traffic** (requests plus
answers). Only 6 % were new seeds. Each durable answer is queued for every offline seat, about 100.
The steady rate of about 630 frames an hour lasted until the end of the window, while only 5
members joined that hour. **So the requests do not come from joins.** Section 5 lists what is not
proven about where they come from.

## 3. Devices with no session left - the fan-out multiplier

`auth_sessions."deviceId"` is the liveness evidence. A row exists while the device holds a
refresh token. Expired rows are deleted (0 expired rows in 409). **Control:** all 61 devices that
SENT a frame in the last two hours (35 tauri, 26 web) have a session row, so a live device without
one was not found.

| | Active seats (non-deleted groups) | No session |
| --- | --- | --- |
| tauri | 626 | 85 |
| web | 1 326 | **736** |
| all | 1 952 | **821 (42 %)** |

Devices with no session hold **52 691 queue rows (56 %), 58 MB**.

**Devices whose oldest row is more than 14 days old** (200 devices, 43 793 rows): 198 have no
session. For 167 of them the owner has signed in on another device within 7 days. 13 are tauri
phones that still hold a push token. Only 2 used a session in the last 14 days. The deepest:

| Device (role) | Rows | Oldest | Session | Owner seen |
| --- | --- | --- | --- | --- |
| member B's old browser profile (DM `46bb1cfa`) | 9 003 | 2026-09-27 | none | today |
| member A's old browser profile (DM `46bb1cfa`) | 8 741 | 2026-09-22 | none | today |
| a member's old browser profile | 766 | 2026-09-20 | none | today |
| a member's old browser profile | 530 | 2026-09-01 | none | today |
| a member's phone | 513 | 2026-09-16 | none | today |

**DM `46bb1cfa` is NOT a bench pair.** It is two real members talking: about 2 000 frames a day,
mostly 276-byte receipts and reactions, and only 7 commits. Its 18 015 rows sit on ONE abandoned
browser profile of each member. Each of them has a newer profile that sends, and both members were
active today. This is the 2026-08-11 shape again
([chat-delivery](../services/chat-delivery.md#the-answer-was-a-revocation-not-a-sweep-2026-08-11)):
a replaced generation is still a valid fan-out target. Both queues cross
`QUEUE_DEPTH_WARN_PER_DEVICE` (2 000), so the hourly report names them, and only a revocation
stops it.

## 4. How long a returning device takes to catch up

**Two per-frame costs are measured**:

- **Bulk pull:** about **0.1 s per frame** on the Mi 9T. That is WP-PENDING-1 in
  [chat-delivery](../services/chat-delivery.md#wp-pending-1-verified-on-hardware-and-what-the-run-could-not-establish):
  about 1 100 DM frames acknowledged in about 100 s, one checkpoint per page, 1 MB per page.
- **Live, one frame at a time:** at least **0.35 s per frame** on the web client. The checkpoint
  alone has a median of 348 ms (finding C of the console audit).

Neither number covers a large seed bundle. Absorbing about 70 seeds and refetching the salon
(finding B, #1761 still open) is not measured.

**How fast frames arrive** for devices absent the whole week (oldest row more than 8 days old, 275
devices), counted from rows written in the last 7 days: median **3.1 per day**, p90 **22.9**, max
849 (the DM above).

| Absent for | Rows waiting (median - p90) | Bulk drain at 0.1 s |
| --- | --- | --- |
| 1 day | 3 - 23 | < 3 s |
| 7 days | 22 - 160 | 2 - 16 s |
| 30 days | 94 - 690 | 9 - 70 s |
| 89 days (last day of retention) | 280 - 2 040 | 28 s - 3.5 min |
| One night offline in `1b1687d0` alone | about 360 rows, about 2 MB, 30 % of it bundles | about 40 s plus bundle absorption |

**The ordinary returner is fine, and today's burst is what users felt.** Of the devices that used a
session in the last 24 hours, 60 web devices hold a median of **244 rows** (45 of them more than
100) and 92 tauri devices a median of 44. Only 8 of those devices have a row older than a day, so
they are draining. Their backlog is this morning's.

**An ONLINE member pays live.** They receive every one of the about 630 frames an hour one at a
time. That is about 220 s of checkpoint an hour on the web, plus a salon refetch for every bundle
until #1761 ships.

## 5. Can a device get permanently stuck?

| Path | Evidence | Verdict |
| --- | --- | --- |
| Commit-log hole | **11 groups, unchanged** since the 2026-09-02 incident (dated 2026-08-27..09-01; DM `7da231f8` still has its one hole at epoch 121, backlog item 21). None of them is a key group. 16 devices still have rows from before 2026-09-02 in 7 of these groups, **all 16 with no session** | Stuck only for abandoned devices. If one comes back it takes rung 2 ([recovery ladder](../protocols/mls-recovery-ladder.md)) |
| Log floor | 208 groups in `mls_commit_log`, **none trimmed** (minimum `baseEpoch` 0 everywhere) | A replay can always start from 0 |
| Out-of-order queue | The pull is `ORDER BY "createdAt"` and never splits rows that share a timestamp across pages | Commits and frames arrive in sending order |
| Key group behind its server | Rung 1 replays one commit at a time; rung 2 re-joins (section 22.1 of channel-encryption). No key-group log has a hole | Bounded |
| Seed sealed at an epoch the receiver has left | `max_past_epochs(2)` (`mls-core/src/group.rs`). With 79 commits in one hour, a sender that does not yet know about a commit can seal at a stale epoch. That frame is unreadable for good on every device (finding H: 13 epochs behind) | **Not stuck**: the repair asks again. **But it is a cost multiplier**, and it is a candidate cause of the request volume in section 2 |
| Missing more than 2 000 generations of one sender in one epoch | `maximum_forward_distance` = 2 000 | Not reached today. **It limits fix F1** (section 7) |
| Away for more than 90 days | The age reaper drops queued commits, but the log is not trimmed | Replay from the log |
| The author's devices are all gone | Graine section 4.5 limit (measured 2026-09-28) | Terminal by design: `DEAD`, reported |

## 6. A reaper by age within 90 days: rejected

**Age alone cannot tell "replaced" from "offline".** Of the 200 devices with rows older than 14
days, 13 are phones still holding a push token and 2 used a session within the fortnight. Deleting
their rows by age loses messages without telling anyone, which the design forbids. The 2026-08-11
rule applies: **revoke the destination, do not sweep the rows.**

**Proposed predicate R** (an allowlist, measured, not applied). A device qualifies when all of the
following hold:

- it has **no session row** and **no push token**;
- the same user has **another device of the same platform** that holds a **live session**;
- that other device's key package is **newer than this device's oldest undelivered row**.

| | Devices | Rows | MB | Seats | Oldest row > 14 d | Oldest row > 30 d |
| --- | --- | --- | --- | --- | --- | --- |
| tauri | 21 | 2 753 | 3.6 | 50 | 19 | 14 |
| web | 144 | 33 233 | 27.9 | 480 | 84 | 29 |
| **R** | **165** | **35 986 (38 %)** | **31.5** | **530 (27 % of seats)** | 103 | 43 |

**It runs through the product's own revocation path**: `revoked_device`, plus the seats, the key
packages and the queue, in one transaction. It is staged: R with an oldest row older than 30 days
first (43 devices), then the queue is re-measured, then R in full.

**The risk that remains:** a person goes back to an old browser after its session expired (sessions
live 10 days at the median, 44 days at most). That browser is revoked and has to register again,
and its history comes back from peers and from the history stream, not from its queue. **This is
destructive, so the user's go is required** (backlog, "owed to the user").

## 7. Ranked causes and the fix plan

| # | Cause | Share | Fix | Expected gain | Risk |
| --- | --- | --- | --- | --- | --- |
| F1 | A repair ANSWER (`graineBundle`, `DELIVERY.keyMaterial`) goes to every seat of the key group and is queued for every offline one | About 47 % of key-group application frames in the window. In `1b1687d0`, roughly 28 k of 35 k rows and about 180 of 194 MB | **Target the answer**: the sender declares the requester's user id, the server delivers it to that user's devices only, and the frame stays out of the history stream | About -80 % rows and -90 % bytes on a community in its first hours. Each answer reaches 1-3 seats instead of about 100 | Non-recipients skip that sender's generations, so the 2 000 forward distance must be asserted per sender per epoch. Other members lose the seeds they used to absorb for free (B says these are mostly duplicates). Needs a server field and a client change |
| F2 | Every device of the elected answerer answers (G) | Doubles or triples each answer for a user with 2-3 devices online | The request names an answering DEVICE, chosen from presence by device, or the answerer's devices pick the lowest online device id | Duplicates go to 0 | Low |
| F3 | The request volume itself: 185 or more in 37 min from 34 devices, while only 22 new sessions were minted | About 47 % of key-group application frames (transport, so live only) | **Measure first**: give each `[GRAINE] asked` line the reason the session was missing (never received, past epoch, answer arrived after the epoch moved). Then remove whatever re-asks (for example a re-ask on every cold load or tab, since the asked set lives in memory) | Up to the whole 47 % | None for the measurement |
| F4 | Replaced device generations keep their seats | 42 % of seats, 56 % of rows | Predicate R, staged, through the revoke path (section 6). Settings > Appareils connectés could also list a stale profile | About -38 % rows now. Every future fan-out drops by 27 % of seats | Destructive. A returning old browser must register again. Requires the user's go |
| F5 | The live client pays a checkpoint per frame (C) and a salon refetch per bundle (B) | About 220 s of checkpoint per online hour on the web during a burst | B: #1761. C: already in the [backlog](../backlog.md#p2---one-encrypted-mls-checkpoint-per-inbound-application-message) | What "slow" feels like on an open client | As stated there |
| F6 | Onboarding moves the epoch once per seat, and every commit rotates every sender's seed (22 sessions for 34 messages) | 137 commits, 9 623 queued commit rows across key groups | Admit all pending newcomers in ONE Add commit. Reopen rotate-on-Add for key groups only with the numbers above | Fewer commits and seeds during a join wave | Rotate-on-Add was a deliberate security choice (channel-encryption, Graine section) |
| F7 | The pull orders by `createdAt` over an index without it | Minor | Index `("recipientId","deviceId","createdAt")` | Cheaper pages for 9 000-row queues | Migration only |

**Order:** F3's measurement and F2 are cheap and change nothing on the wire. F1 is the large gain,
and it is a protocol change for the server and the client. F4 waits for the user's go.

## 8. The SQL that produced every number

Every statement ran inside `BEGIN READ ONLY; ... ROLLBACK;` as follows:
`docker exec -i <prod-postgres-container> psql -U <db-user> -d auth_db -X -q < file.sql`, run on the production host.

```sql
-- totals
SELECT count(*), pg_size_pretty(pg_total_relation_size('queued_message')),
  count(DISTINCT "deviceId"), count(DISTINCT "recipientId"), sum(length(proto))/1048576,
  min("createdAt"), count(*) FILTER (WHERE "isCommit"), count(*) FILTER (WHERE "isWelcome")
FROM queued_message;

-- by group kind
SELECT CASE WHEN g."distributionWorkspaceId" IS NOT NULL THEN 'community-key'
            WHEN g."distributionChannelId" IS NOT NULL THEN 'salon-key'
            WHEN g."isGroup" THEN 'group-conv' ELSE 'dm' END kind,
  count(*), count(DISTINCT q."groupId"), count(DISTINCT q."deviceId"), count(*) FILTER (WHERE q."isCommit")
FROM queued_message q LEFT JOIN dm_groups g ON g.id = q."groupId" GROUP BY 1;

-- distinct payloads of one group by kind and size
WITH p AS (SELECT md5(proto) h, min("senderDeviceId") sdev, bool_or(coalesce("isCommit",false)) c,
                  bool_or(coalesce("isWelcome",false)) w, max(length(proto)) len, count(*) copies
           FROM queued_message WHERE "groupId" = :gid GROUP BY 1)
SELECT CASE WHEN w THEN 'welcome' WHEN c THEN 'commit' ELSE 'app' END,
       CASE WHEN len<1500 THEN '<1.5k' WHEN len<4000 THEN '1.5-4k' WHEN len<16000 THEN '4-16k' ELSE '>=16k' END,
       count(*), sum(copies), sum(len::bigint*copies)/1048576
FROM p GROUP BY 1,2;

-- commit-log holes
WITH s AS (SELECT "groupId", "baseEpoch", "createdAt",
                  lag("baseEpoch") OVER (PARTITION BY "groupId" ORDER BY "baseEpoch") prev FROM mls_commit_log)
SELECT "groupId", prev+1 hole_from, "baseEpoch"-1 hole_to, "createdAt" FROM s
WHERE prev IS NOT NULL AND "baseEpoch" > prev+1;

-- seats with no session (the fan-out multiplier)
SELECT split_part(m."deviceId",'-',1), count(*),
  count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM auth_sessions s WHERE s."deviceId" = m."deviceId"))
FROM dm_device_group_memberships m JOIN dm_groups g ON g.id = m."groupId" AND g."deletedAt" IS NULL
WHERE m.status = 'active' GROUP BY 1;

-- control: devices that sent in the last 2 h all have a session
WITH alive AS (SELECT DISTINCT "senderDeviceId" d FROM queued_message
               WHERE "createdAt" > now()-interval '2 hours' AND "senderDeviceId" IS NOT NULL)
SELECT count(*), count(*) FILTER (WHERE EXISTS (SELECT 1 FROM auth_sessions s WHERE s."deviceId" = alive.d)) FROM alive;

-- inflow per absent device
WITH qd AS (SELECT "deviceId" d, min("createdAt") oldest,
                   count(*) FILTER (WHERE "createdAt" > now()-interval '7 days') w7 FROM queued_message GROUP BY 1)
SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY w7/7.0), percentile_disc(0.9) WITHIN GROUP (ORDER BY w7/7.0), max(w7/7.0)
FROM qd WHERE oldest < now()-interval '8 days';

-- predicate R
WITH qd AS (SELECT "recipientId" u, "deviceId" d, min("createdAt") oldest, count(*) n FROM queued_message GROUP BY 1,2)
SELECT split_part(d,'-',1), count(*), sum(n) FROM qd
WHERE NOT EXISTS (SELECT 1 FROM auth_sessions s WHERE s."deviceId" = qd.d)
  AND NOT EXISTS (SELECT 1 FROM push_token t WHERE t."deviceId" = qd.d)
  AND EXISTS (SELECT 1 FROM key_package k JOIN auth_sessions s ON s."deviceId" = k."deviceId"
              WHERE k."userId" = qd.u AND k."deviceId" <> qd.d
                AND split_part(k."deviceId",'-',1) = split_part(qd.d,'-',1)
                AND k."createdAt" > qd.oldest)
GROUP BY 1;
```

The log counts in section 2 came from
`docker logs canari-prod-chat-delivery-service-1 | grep "group=1b1687d0"`, with awk counting
`START ... isCommit=false isWelcome=false` per sender and joining `TRANSPORT_SKIPPED_OFFLINE` on
the `[SEND][trace]` id.

## First reaper pass - 2026-10-12, 09:20 UTC

**The user gave the go for the first stage of F4** (2026-10-12): predicate R (section 8, unchanged)
restricted to devices whose oldest queued row is older than 30 days. The other stage, R in full,
still waits for its own go.

**The candidates.** Section 8's R query, plus `oldest < now() - 30 days`, run read-only at 09:15:
**43 devices** (14 tauri, 29 web), the audit's count exactly. Before anything was written, a second
read-only query checked each one again: 0 had a session row, 0 had a push token, 0 had a queued
row younger than 30 days, and all 43 had another device of the same user and platform with an
unexpired session. None was already revoked, and no row of theirs was addressed to another user.
One of them had sent a frame 24 days before; the other 42 had sent nothing for at least 59 days.
Oldest rows: 2026-07-28 to 2026-09-11.

**The mechanism is the product's own.** Each device went through `DELETE
/api/mls/devices/:userId/:deviceId` on `chat-delivery-service` (`deleteDevice` in
`devices.controller.ts`). That is `purgeDeviceFootprint` (memberships, the Redis routing set
`group:members:<groupId>`, the static key package, one-time prekeys, push tokens, queued rows),
then the `revoked_device` row, then the `device_revoked` signal. A short script inside the
container called the route on `127.0.0.1:3010` as each device's owner, signed the way nginx signs
it, one device at a time, and stopped on any status other than 200. One device went first and was
checked, then the other 42. The script was deleted from the container afterwards. No SQL was
written by hand.

| What | Before | Removed | After |
| --- | --- | --- | --- |
| Queued rows of the 43 devices | 5 771 | **5 771** (sum of `queuedMessagesDeleted`) | 0 |
| Seats (`dm_device_group_memberships`, all active) | 1 953 | **173** | 1 780 |
| Redis `group:members` entries of the 43 | 173 | 173 | 0 |
| `key_package` | 1 088 | 43 | 1 045 |
| `one_time_key_package` | 48 276 | 122 | 48 154 |
| `push_token` | 247 | 0 | 247 |
| `revoked_device` | 260 | +43 | 303 |

The queue total went from 117 641 to 113 567 while the pass ran, because fan-out kept writing.

**Nothing else lost a row.** 288 other devices have queued rows and no session, so nothing can
acknowledge their rows. All 288 had the same count or more afterwards. The delivery log holds 43
`[DELETE_DEVICE]` lines, no `ERROR` line, and no `[SEND]` line naming one of the 43 after 09:21:30.
`chat-gateway` and `core-service` logged no error in the same window. The hourly report at 09:26
read as before: no stranded membership, no stale base, no single-holder conversation, and the same
11 commit-log holes as section 5.

**Re-measured right after.** The share of active seats with no session went from 42 % to **36 %**
(648 of 1 785). R in full now names 126 devices and 30 751 rows. One of them crossed 30 days since
the morning and was left alone, because it was not in the list the user approved.

### The backup and how to restore it

The backup is on the production host, in a private directory of the operator account,
mode `700`, files `600`. It was written at 09:18, before the pass. It holds one CSV per table,
each filtered to the 43 `(userId, deviceId)` pairs, plus `candidates.csv` and `SHA256SUMS`:

| File | Rows |
| --- | --- |
| `queued_message.csv` (13 MB) | 5 771 |
| `dm_device_group_memberships.csv` | 173 |
| `key_package.csv` | 43 |
| `one_time_key_package.csv` | 122 |
| `push_token.csv`, `revoked_device.csv` | 0 (header only) |

**Restoring a device makes sense only if its owner really goes back to that browser and wants its
queue.** Otherwise registering again is the designed path. To restore all of them, or one after
filtering the CSVs by `deviceId`:

```sh
# on the production host
cd <backup-dir> && sha256sum -c SHA256SUMS
PSQL='docker exec -i canari-prod-postgres-1 psql -U canari -d auth_db -X -v ON_ERROR_STOP=1'
# 1. lift the ban, or the device cannot register again
awk -F, '{printf "DELETE FROM revoked_device WHERE \"userId\"=%c%s%c AND \"deviceId\"=%c%s%c;\n",39,$1,39,39,$2,39}' candidates.csv | $PSQL
# 2. put the rows back
for t in key_package one_time_key_package dm_device_group_memberships queued_message; do
  $PSQL -c "\copy $t FROM STDIN WITH (FORMAT csv, HEADER)" < $t.csv
done
# 3. put the seats back in the Redis routing set (columns: id, userId, deviceId, groupId, ...)
awk -F, 'NR>1 {print "SADD group:members:"$4" "$2":"$3}' dm_device_group_memberships.csv \
  | docker exec -i canari-prod-redis-1 redis-cli
```

## Second pass - 2026-10-12

**The user gave the go in chat for the second stage of F4**: predicate R in full (section 8), with
no 30-day limit.

**The candidates.** R named **131 devices**. **13 were excluded** because they had sent a frame
since 2026-09-28. That is stricter than the first pass, which kept a device that had sent 24 days
before. **118 devices were reaped.**

**The mechanism is the first pass's**: `DELETE /api/mls/devices/:userId/:deviceId`, called from
inside the `chat-delivery-service` container. The first device went alone and was checked, then the
other 117. **All 118 calls answered HTTP 200**, and the delivery log holds **0 error lines**.

| What | Removed |
| --- | --- |
| Queued rows of the 118 devices | **30 940** |
| Seats (`dm_device_group_memberships`) | **329** |
| One-time key packages | about 4 000 |

**The queue total went from 336 539 to 305 535.** The morning audit (section 1) measured 93 580
rows and the first pass saw 117 641. That jump was an open question, now answered by
[the measurement of 2026-10-13](#why-the-queue-holds-300-000-rows---measured-2026-10-13).

**The backup** is on the production host, in a private directory of the operator account,
mode `700`, files `600`, with `SHA256SUMS`. It holds one CSV per table, filtered to the 118 devices.
**To restore**, `\copy` each table's CSV back into its table, as the first pass's procedure above
does, from this directory.

## Why the queue holds 300 000 rows - measured 2026-10-13

**Question:** the morning audit counted 93 580 rows, and the second pass found 336 539. Where do
they come from? The user authorised a read-only measurement, run on production on 2026-10-13 at
about 09:00 UTC. Nothing was written.

**Short answer: one group, and the rows are for LIVE devices.** The reaper cannot help here.

| Age of row | Rows |
| --- | --- |
| < 1 hour | 13 393 |
| < 1 day | 248 261 |
| < 7 days | 27 098 |
| < 30 days | 12 446 |
| >= 30 days | 741 |
| **Total** | **301 937** |

- **One group holds nearly all of the last day.** 255 475 rows belong to group `1b1687d0`, the
  community of section 2: 106 recipient users and 90 sender users. Every other group holds at most
  1 165 rows.
- **By kind, last day:** 254 241 plain application frames, 5 575 commits and 27 Welcomes. So this
  is application traffic, not epoch churn.
- **By platform:** web 238 235 rows over 298 devices, tauri 61 928 over 150 devices. The deepest
  devices hold 7 000 to 11 000 rows each, and all of them are web.
- **266 of the 448 devices with a queue have a session.** So most of the queue is addressed to live
  devices that are not draining, not to abandoned ones. Predicate R does not name them, and it
  should not.
- **By hour:** the peak was 57 737 rows at 20:00 UTC on 2026-10-12, during the heavy console
  sessions. The 08:00 UTC hour of 2026-10-13 still added about 13 000.

**Hypothesis, NOT proven:** `1b1687d0` is the community key group whose seed requests and answers
were broadcast to every member (F1 and F3 in section 7). #1768 addresses each answer to the device
that asked. It shipped in `v1.2.6` on 2026-10-13, so the rate should fall as clients update. The
measurement that settles it is in the
[backlog](../backlog.md#p1---a-community-key-group-sends-every-repair-answer-to-every-seat-and-42--of-seats-have-no-device-behind-them-production-2026-10-12).
No deletion is proposed: these rows belong to live devices.

## How to re-measure

Run section 8's totals, kind and seat queries again after each fix. F1 is working when a new
community's bundles of 16 KB or more drop from about 40 copies per payload to 1-3. F4 is working
when the no-session share of seats falls from 42 %. The daily rows written (section 1) is the line
to watch for a regression.

## Log lines per frame, and what aggregates them (2026-10-18)

WP-LOG-AGGREGATE, decided 2026-10-18: fewer lines, NO retention change. Measured from the code path
of `MessagingService.sendMessage` (no production access): for each of the ~100 recipient devices of
one frame, `deliverQueuedFrame` wrote `recipient=... online=...` and, for an online device,
`PUBLISHED`; `sendFcmForQueued` wrote `FCM sent` per accepted token; and a transport frame's
`TRANSPORT_SKIPPED_OFFLINE` listed every offline device id (18 628 in the 37 minutes of
[section 2](#the-37-minutes-the-delivery-log-still-holds-0828-0905-utc)).

What replaces them for a fan-out (`FanOutTally`, passed as `batch`):

- `DONE queued=N realtime=M offline=K` - the existing line, plus the number of offline pushes.
- `[PUSH_SEND] FCM sent batch pushed=P of K offline device(s)` - ONE line, printed when the last
  fire-and-forget push settles.
- `TRANSPORT_SKIPPED_OFFLINE` names five devices then `+N more`; `count=` stays exact.

Kept per device, because each is a decision or an error: no push token (already rate-limited), a
refused category, FCM failures, invalid-token deletes, the deferred-fallback pair (an unACKed row),
and a lone Welcome's two lines (one device, followed by trace id). The harness classifier's patterns
(`srvlog.mjs`) still match `DONE` and `FCM sent `. **Not done:** the gateway's per-delivery
`tracing::info!` lines in `subscribers.rs` and the client-side per-frame logs - measure them against
production before touching them.

## Third pass - 2026-10-24: the key group's orphan devices

**Decided by the user on 2026-10-24**, after the measurement in
[backup](backup.md#why-the-archive-went-from-80-mb-to-700-mb-2026-10-13): revoke every device that
holds rows of key group `1b1687d0` and has **neither a session row nor a push token**, through the
revoke path of the first two passes, not by deleting rows. Deleting rows alone was rejected: the rows
include commits, so a device signing in again under the same id would meet holes, and its seats
would keep collecting new rows.

**The candidates**, read-only at 18:21 UTC: **109 devices** (106 web, 3 tauri), holding 172 132 rows
of that group and 184 457 queued rows in all, 470 seats, 109 key packages and 4 979 one-time key
packages. None was already revoked. 70 of them belong to a user with another device holding a session
or a push token. Their ids, row ids and seat rows were saved before the run, outside the repository.

**The mechanism is the first pass's**: `DELETE /api/mls/devices/:userId/:deviceId` from inside the
delivery container, one device at a time with a 1 s pause. Right before each call the device was
re-checked (no session, no push token, not revoked); the run stopped on any status other than 200,
on a purge that removed no queued row, or on a 1-minute load above 6. One device went first and was
checked (database, Redis routing set, logs), then the other 108. **All 109 answered 200**, peak load
2.09, 0 error lines in the delivery, gateway and core logs.

| What | Before | Removed (sum of the route's counts) | After |
| --- | --- | --- | --- |
| `queued_message` (all groups) | 272 166 | **184 457** | 87 645 |
| ... of key group `1b1687d0` | 204 318 | 172 132 | 32 132 |
| Seats (`dm_device_group_memberships`) | 2 332 | **470** | 1 862 |
| `key_package` | 1 010 | 109 | 902 |
| `one_time_key_package` | 47 888 | 4 979 | 42 959 |
| `revoked_device` | 428 | +109 | 537 |
| `push_token` | 272 | 0 | 272 |

The counts in the "After" column move with live traffic too (key packages republished, fan-out).

**Nothing else lost a row.** Of the 202 devices with a session or a push token that held queued rows
before, 199 held exactly the same count afterwards; the other 3 are phones with both a session and
a push token that fetched their 12 rows meanwhile. The predicate (no session, no push token, rows of
that group) now matches 0 rows.

**Space.** `VACUUM (ANALYZE) queued_message` ran in 0.7 s. A plain `VACUUM` gives the space back to
the table for reuse, not to the disk, so `pg_total_relation_size` stays 1 489 MB; the next nightly
dump is what shrinks (the table's rows went from 272 166 to 87 645). The root disk went from 72 % to
74 % during the run: the write-ahead log of the deletions, recycled at later checkpoints.

**Restore.** The nightly archive of 2026-10-24 holds the whole table (273 875 rows, dump complete).
A device that comes back registers again, the designed path; restoring one means lifting its
`revoked_device` row and copying its rows back from that archive, as the first pass describes.

**One slip, undone.** The first call of the run passed its arguments wrongly (`bun -e` drops the first
positional argument), so it revoked a device id `undefined` under a user id that does not exist and
purged nothing. That `revoked_device` row was deleted by its id a minute later, the arguments were
passed through the environment instead, and the run guards against a call that purges no queued row.

## Re-measured 2026-11-01: the same predicate names a new population

Read-only, all groups: **292 devices** hold a queue and have neither a session row nor a push token,
**70 377 rows** (about 163 MB), none revoked, all still holding a key package; none of the third
pass's 109 has a row or a seat left. **It refills**: 1 372 rows were written to 113 of them in the
last 24 hours (4 490 in 7 days), because 291 of them still hold 721 active seats. Deleting the rows
alone would therefore be refilled within a day; the fix is the revoke path above, on an allowlist
measured that day. 220 of the 292 belong to a user with a live session on another device, and 1 sent
a frame in the last 7 days, so a fourth pass must exclude what shows life. **Not run: a fourth pass
is the owner's decision.**

## Fourth pass, by hand, and the reaper that replaces the passes - 2026-11-01

**The fourth pass.** On 2026-11-01 the owner had the population of the re-measure above revoked by
hand, through the same `DELETE /api/mls/devices/:userId/:deviceId` route: **286 devices** with no
session and no push token. It is the fourth time this population was revoked by hand, and every
re-measure found it again.

**The owner then decided (2026-11-01, "Oui, la construire") to build the fix at the source**: a
scheduled reaper in `chat-delivery-service`, **built OFF**. The owner reads the rule and a dry run
of what it would revoke, then validates its activation. The mechanism, its switch and its log lines
are on the service page: [the retired-device reaper](../services/chat-delivery.md#the-retired-device-reaper-built-off-2026-11-01).

**Its predicate is R, tightened**: R's three clauses (no session, no push token, a newer device of
the same owner and platform with a live session and a key package newer than this device's oldest
queued row), plus "not revoked" and "no life signal in 7 days" (no queued frame sent, no commit
sent, no key package or one-time key package published). Every clause has a fixture that fails it
alone and is kept (`retired-device-reaper.integration.spec.ts`), and neutralising any one clause in
the statement fails that spec - checked clause by clause when it was written.

### Clause 5 against the hand passes - it would NOT have named all of them

**The third and fourth passes did not use R's owner clause; they took every device with no session
and no push token.** So the reaper, as built, would have left part of them in place. What the
recorded counts say, as lower bounds (they count "another device with a session" on ANY platform,
with no key-package age condition, so clause 5 excludes at least this many and possibly more):

| Pass | Devices revoked | Owner had another device with a session | Excluded by clause 5, at least |
| --- | --- | --- | --- |
| Third, 2026-10-24 | 109 | 70 (session OR push token) | **39 (36 %)** |
| Fourth, 2026-11-01 (the re-measure's 292) | 286 | 220 of 292 | **72 of 292 (25 %)** |
| R in full, 2026-10-12 | 126 named of about 288 with a queue and no session | - | about **56 %**, but push tokens explain part of it |

**Whether it would have excluded MOST of the 286 is not answerable from the repository**: the
same-platform and key-package-age conditions were never measured on that population, and its
queues and key packages are gone now. The 2026-10-12 figure (R named 126 of about 288) says it may
well be about half. **The clause was kept as specified, not weakened**: what it refuses is a device
whose owner has NOT provably moved to a newer device of the same kind - for example an account whose
only other device is a phone, or whose newer browser stopped too. Those devices still fill the
queue; the second statement below counts them, and whether to reap them on weaker evidence is the
owner's decision.

### The dry run, read-only, as the owner runs it

This is the reaper's statement (`RETIRED_DEVICE_PREDICATE_SQL` in
`apps/chat-delivery-service/src/services/retired-device-reaper.ts`, the authority if the two ever
differ) with its parameters written in: `$1` = now - 7 days, `$2` = now - the 10-year ban window,
`$3` = now, `$4` = the cap of 100, `$5`/`$6` = NULL. The database runs in UTC
(`checkDatabaseClockAgreement`), so `now()` compares correctly with the `timestamp` columns.

```sql
BEGIN READ ONLY;
WITH queued AS (
  SELECT q."recipientId" AS "userId", q."deviceId" AS "deviceId",
         min(q."createdAt") AS "oldestQueuedAt", count(*)::int AS "queuedRows"
    FROM queued_message q
   GROUP BY q."recipientId", q."deviceId"
)
SELECT d."userId", d."deviceId", d."oldestQueuedAt", d."queuedRows",
       count(*) OVER ()::int AS "matched"
  FROM queued d
 WHERE NOT EXISTS (SELECT 1 FROM auth_sessions s WHERE s."deviceId" = d."deviceId")
   AND NOT EXISTS (SELECT 1 FROM push_token t WHERE t."deviceId" = d."deviceId")
   AND NOT EXISTS (SELECT 1 FROM revoked_device r
                    WHERE r."userId" = d."userId" AND r."deviceId" = d."deviceId"
                      AND r."revokedAt" > now() - interval '3650 days')
   AND NOT EXISTS (SELECT 1 FROM queued_message o
                    WHERE o."senderDeviceId" = d."deviceId" AND o."createdAt" > now() - interval '7 days')
   AND NOT EXISTS (SELECT 1 FROM mls_commit_log c
                    WHERE c."senderDeviceId" = d."deviceId" AND c."createdAt" > now() - interval '7 days')
   AND NOT EXISTS (SELECT 1 FROM key_package k
                    WHERE k."deviceId" = d."deviceId" AND k."createdAt" > now() - interval '7 days')
   AND NOT EXISTS (SELECT 1 FROM one_time_key_package p
                    WHERE p."deviceId" = d."deviceId" AND p."createdAt" > now() - interval '7 days')
   AND EXISTS (SELECT 1 FROM key_package k2
                 JOIN auth_sessions s2
                   ON s2."deviceId" = k2."deviceId" AND s2."userId" = k2."userId"
                  AND s2."expiresAt" > now()
                WHERE k2."userId" = d."userId" AND k2."deviceId" <> d."deviceId"
                  AND split_part(k2."deviceId", '-', 1) = split_part(d."deviceId", '-', 1)
                  AND k2."createdAt" > d."oldestQueuedAt")
 ORDER BY d."oldestQueuedAt" ASC, d."userId" ASC, d."deviceId" ASC
 LIMIT 100;
ROLLBACK;
```

**And what clause 5 alone keeps** - the same population with and without it, so the owner sees the
devices the reaper will NOT touch:

```sql
BEGIN READ ONLY;
WITH queued AS (
  SELECT q."recipientId" AS "userId", q."deviceId" AS "deviceId", min(q."createdAt") AS oldest
    FROM queued_message q GROUP BY 1, 2
), base AS (
  SELECT d.*, EXISTS (SELECT 1 FROM key_package k2
                        JOIN auth_sessions s2
                          ON s2."deviceId" = k2."deviceId" AND s2."userId" = k2."userId"
                         AND s2."expiresAt" > now()
                       WHERE k2."userId" = d."userId" AND k2."deviceId" <> d."deviceId"
                         AND split_part(k2."deviceId", '-', 1) = split_part(d."deviceId", '-', 1)
                         AND k2."createdAt" > d.oldest) AS replaced
    FROM queued d
   WHERE NOT EXISTS (SELECT 1 FROM auth_sessions s WHERE s."deviceId" = d."deviceId")
     AND NOT EXISTS (SELECT 1 FROM push_token t WHERE t."deviceId" = d."deviceId")
     AND NOT EXISTS (SELECT 1 FROM revoked_device r
                      WHERE r."userId" = d."userId" AND r."deviceId" = d."deviceId")
     AND NOT EXISTS (SELECT 1 FROM queued_message o
                      WHERE o."senderDeviceId" = d."deviceId" AND o."createdAt" > now() - interval '7 days')
     AND NOT EXISTS (SELECT 1 FROM mls_commit_log c
                      WHERE c."senderDeviceId" = d."deviceId" AND c."createdAt" > now() - interval '7 days')
     AND NOT EXISTS (SELECT 1 FROM key_package k
                      WHERE k."deviceId" = d."deviceId" AND k."createdAt" > now() - interval '7 days')
     AND NOT EXISTS (SELECT 1 FROM one_time_key_package p
                      WHERE p."deviceId" = d."deviceId" AND p."createdAt" > now() - interval '7 days')
)
SELECT split_part("deviceId", '-', 1) AS platform, count(*) AS "clauses 1-4",
       count(*) FILTER (WHERE replaced) AS "all five (the reaper)"
  FROM base GROUP BY 1;
ROLLBACK;
```

**Not done, and the owner's**: running either statement on production, setting the switch to
`dry-run` and then `on` ([backlog](../backlog.d/retired-device-reaper-activation-owed-to-the-owner.md)).
