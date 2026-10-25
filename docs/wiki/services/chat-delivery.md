# chat-delivery-service

**Stack**: NestJS  
**Port**: 3010  
**Source**: `apps/chat-delivery-service/`

## Responsibilities

The chat-delivery-service is the MLS API layer. It:

- Manages device registration and key packages (static + one-time prekeys).
- Stores and routes MLS messages for offline devices (message queue in PostgreSQL).
- Publishes each queued message to Redis `chat:messages` for real-time delivery via the gateway.
- Maintains group and membership state (DeviceGroupMembership state machine).
- Handles the sync engine for cross-device conversation history (QR-code-based transfer).
- Dispatches push notifications via Firebase Cloud Messaging.
- Maintains a Redis Stream history per group (`history:{groupId}`) for replay.
- Performs background cleanup (cron jobs) for stale devices, expired messages, orphaned data.

## Databases

| Store | Purpose |
|---|---|
| PostgreSQL | Entities: KeyPackage, OneTimeKeyPackage, Group, GroupMember, DeviceGroupMembership, QueuedMessage, PinVerifier, PushToken, NotificationPreference, RevokedDevice |
| Redis | `chat:messages` pub/sub, `history:{groupId}` Streams, `group:members:{groupId}` sets, `mls:addlock:{groupId}` and `mls:commitlock:{groupId}` locks, `pending_welcome:{groupId}` sets and their per-member `pending_welcome_notify:{userId}` fan-out (drained by the gateway) |
| Firebase | Push notifications (FCM) |

## Background jobs (cron)

| Interval | Task |
|---|---|
| 1h | Detect stale devices -> reset to pending |
| 1h | Clean expired queued messages |
| 1h | Full GC of stale device entries |
| 1h | Report queue depth (observation only, deletes nothing) |
| 1h | Report stranded pending device memberships (observation only, deletes nothing) |
| 6h | Purge orphan groups: everything owned by a group with no row in `dm_groups` |
| 24h | Purge soft-deleted groups (> 90 days old), with everything they own |
| 24h | Purge stale push tokens (> 90 days) |
| 24h | Purge stale pending invitations (> 30 days) |

### One way a frame is delivered

Two routes put a frame in the queue - `POST mls/send` and `POST mls/welcome` - and both then hand
the row to a device. `deliverQueuedFrame` is the only thing that does so: publish the envelope on
`chat:messages` for the gateway to route if the device is online, push over FCM if it is not, and
arm the deferred fallback either way.

**The envelope is built from the ROW, not from the request that produced it**, because the row is
what is being delivered. The two routes each built their own from their own body until 2026-09-13,
and diverged exactly where a body differs from a row: the Welcome's envelope carried no `isCommit`,
no `createdAt`, and a `senderDeviceId` written as an empty literal.

**And `sendWelcome` never armed the deferred fallback.** That fallback answers a frozen Android app:
the kernel keeps the TCP connection and the presence key alive, so the server believes the device is
reachable and publishes into a socket no process is reading. For a message that costs one
notification. For a Welcome it costs the join - the device stays outside the group, and the next
message push then fails to decrypt with "Groupe introuvable", which is the consequence `sendWelcome`
already spelled out in the branch three lines below.

`pushable` is false for exactly one class: a TRANSPORT frame, whose rendezvous expires in 60 s
(`DIGEST_TTL_MS`). Waking a device to hand it an expired exchange is worse than not waking it.
`silent` is true for every handshake frame, so the background receiver acts without ringing.

`queuedDelivery.onePolicy.spec.ts` drives both ROUTES over one table - a route that publishes its
own envelope is what a test of the shared function would walk past - and asserts the same envelope
key set from both, the fallback armed from both, and the FCM visibility each owes.

### What a group owns, and the one list that says so

A group's rows live in **seven** tables, and `GROUP_OWNED_TABLES`
([`utils/group-purge.ts`](../../../apps/chat-delivery-service/src/utils/group-purge.ts)) is the only
definition of that set: `queued_message`, `dm_group_members`, `dm_device_group_memberships`,
`mls_commit_log`, `mls_group_info`, `group_invites` - plus `dm_user_dismissed_groups`, which
`deleteGroupOwnedRows` takes only on a HARD delete. Plus three Redis key shapes in
`GROUP_REDIS_KEY_PREFIXES`: `history:`, `group:members:`, `pending_welcome:`. The MLS locks
(`mls:addlock:`, `mls:commitlock:`) are **not** in it, and deliberately: both are written with an
`EX` TTL, so they collect themselves.

**AND ONE FUNCTION IS THE WAY A GROUP ENDS: `tombstoneGroups`.** The allowlist settled WHAT a group
owns; the sequence around it - tombstone, sweep, Redis keys, in that order, and the soft-delete flag
that keeps the dismissal markers - was still written out by each of the three routes that end a
group, which is how two of them came to write a tombstone and sweep nothing. They now pass a group
id and, for the one route that owns a scope, a flag releasing it. `groupEnds.onePolicy.spec.ts`
drives all three ROUTES over one table rather than the function, because a route that keeps its own
pair of statements is exactly what the function cannot see.

**REMOVING THE RESIDUE AND FINDING IT ARE THE SAME TWO LISTS, READ TWICE.** `deleteGroupOwnedRows`
and `deleteGroupRedisKeys` walk them to delete; `findOrphanGroupIds` and `scanGroupRedisKeyOwners`
walk them to ask which groups still own something with no `dm_groups` row left. Those were four
hand-written lists until 2026-09-13 and two of them were short - see the orphan sweep below.

**Five call sites, and until 2026-08-21 only the two collectors were among them.** This page used to
say "both ways a group ends call it" and name the 90-day tombstone reaper
(`cleanupSoftDeletedGroups`) and the orphan sweep (`purgeOrphanGroups`, reached from
`cleanupOrphanGroups`) - which are the two things that COLLECT a group, not the ways one ends.
The three routes that actually end a group each still carried a hand-written shorter list, or none at
all:

| Where a group ends (all three now call `tombstoneGroups`) | What it swept before | Missing |
|---|---|---|
| `DELETE /api/mls/groups/:id` (`groups.controller`) | 4 tables, 2 Redis keys | `mls_commit_log`, `mls_group_info`, `group_invites`, `dm_user_dismissed_groups`, `pending_welcome:` |
| `DELETE /api/internal/users/:id`, DM branch | 3 tables, 2 Redis keys | the same five |
| `DELETE /api/internal/distribution-groups/...` | **nothing at all** | everything |

And what a soft-delete leaks is **permanent**, which is what made this worse than the 2026-08-18
case: the orphan sweep only finds groups with NO row in `dm_groups`, so it can never see the residue
of a group whose tombstone survives on purpose. Nothing collects it before the 90-day reaper.
**Measured on prod 2026-08-21**, four community distribution groups deleted during the COMM campaign
runs the same day: 71 `queued_message`, 28 `mls_commit_log`, 10 `dm_device_group_memberships` and 4
`mls_group_info` rows, all four groups tombstoned between 00:08 and 05:50 that morning. All three
routes now go through the shared list, in one transaction with the tombstone.

It exists because each caller used to carry its own shorter list. **Measured on prod 2026-08-18**,
before the fix: `mls_group_info` 21 orphan rows of 69 (30%), `mls_commit_log` 293 of 452 (65%),
`queued_message` 220, `group_invites` 3 of 4 - each naming a `groupId` absent from `dm_groups`.
`mls_commit_log` at least ages out through `pruneExpiredCommitLog`; **`mls_group_info` had no
collector of any kind**, so those rows were permanent.

### The orphan sweep: two discoveries, one repair

A group with no row in `dm_groups` that still owns rows or Redis keys is a deletion that did not
finish. **One function repairs it - `purgeOrphanGroups` - and three paths reach it**: a frame fetch
and a history read repair the ids in front of them, and `cleanupOrphanGroups` (6 h) goes looking.

Until 2026-09-13 there were two sweeps and two answers, and both halves were short:

| The sweep | How it looked | What it did |
|---|---|---|
| `cleanupOrphanedMemberRows` (24h) | a hand-written UNION over **2** of the 6 owned tables | `purgeOrphanGroups` - the full repair |
| `cleanupOrphanedRedisGroups` (6h) | `SCAN group:members:*`, **1** of the 3 key shapes | `DEL` on that key, and nothing else |

The second is the one that bites, and it is worse than an incomplete repair: `group:members:<id>`
was the only key through which an orphan could still be reached in Redis, so deleting it stranded
the `history:` stream **for ever**. No tombstone for the 90-day reaper, no membership row for the
other sweep, no key left for this one - the repair destroyed the evidence of the residue it left.
A group whose members were already gone but whose commit log, stored base or invites were not was
invisible to both.

Now both halves only FIND, from the two lists above, and hand every candidate to the one repair.
The Redis half returns **owners, not orphans** - live groups included - because deciding presence
there would be a second copy of the read `purgeOrphanGroups` already does; candidates go over in
chunks so one `IN (...)` never carries the estate. `dm_user_dismissed_groups` is swept but is
deliberately **not** a discovery source: a dismissal is a fact about a PERSON that may outlive the
group. `queued_message.groupId` is nullable, so the join excludes nulls explicitly - a system frame
belongs to no group and would otherwise be reported as an orphan with a null id.

`orphanGroups.onePolicy.spec.ts` drives all three PATHS over one table rather than asserting on
`purgeOrphanGroups`: a path that deletes a key or a row itself is exactly what a test of the shared
function walks past, and that is how these came apart.

What made it invisible for so long is worth keeping: `dm_group_members` and
`dm_device_group_memberships` measured **zero** orphans. That is not health, it is the diagnosis.
`cleanupOrphanedMemberRows` finds orphans by joining FROM those two tables - the ones the reaper
deletes one step before it deletes the group - so the sweep was looking in the only two places where
nothing can ever survive, and was structurally blind to every group that died normally. The fix is
therefore the shared list, **not** a wider sweep predicate: asking "which rows have no group" on a
recurring job would race the reaper that is mid-way through the same deletes.

The reaper deletes the owned rows and the `dm_groups` row in **one transaction**, so no window
exists in which the group is gone and its rows are not. Redis comes after the commit, because it
cannot join the transaction: a crash between the two leaves keys that
`cleanupOrphanedRedisGroups` collects, whereas the reverse order would strip a live group's history
if the transaction then rolled back.

**No foreign key enforces this, and for `dm_user_dismissed_groups` no foreign key MAY.** That row is
not a fact about the group - it is a fact about a PERSON, recording that they asked for a
conversation to be gone from all their devices, and it is BUILT to outlive the group row: its entity
stores `groupId` as text rather than a relation, saying so in as many words ("so it outlives the
group row", "independent of the group's own lifecycle"). A `ON DELETE CASCADE` there would delete the
answer to a question still being asked - discovery reads the marker to tell "I dismissed this" from
"somebody else deleted it", and only the first may be purged silently. The `character varying` type
is the CONSEQUENCE of that design, not an obstacle to a cascade somebody would otherwise want.

**Both endpoints that touch it are idempotent, and their logs say how much of that was needed.**
`POST dismissed-groups` upserts (`ON CONFLICT DO NOTHING` on `(userId, groupId)`) and the `DELETE`
means *ensure this group is not dismissed* - so every Welcome calls it, almost always with nothing to
lift. The marker is per USER and the call is per DEVICE, which makes one re-add on a two-device
account exactly two requests and at most one lift. `[DISMISS] ... recorded=N` and
`[UNDISMISS] ... lifted=N` therefore print the affected row count, not the endpoint's intention: the
harness classifies a non-zero count as notable and a zero as benign, and before the counts existed a
single re-add printed two notable lines for zero events.

Which is why `deleteGroupOwnedRows` takes `groupRowSurvives`: a soft delete keeps the tombstone,
so it keeps the marker; a hard delete may take it, because nothing will ever ask again. The three
routes that end a group softly all pass it. **This was learnt by breaking it** - the day the three
were unified onto the shared list, all three began dropping the marker, and a by-hand repair of
tombstoned residue took 25 rows with it before anybody noticed. Those 25 conversations now show a
"deleted" banner to the one person who had asked for silence.

The one-shot that collected the rows already there is
[`016_group_owned_orphans.sql`](../../../apps/chat-delivery-service/src/migrations/016_group_owned_orphans.sql).

### A row in `dm_groups` is not a place a frame can go

`purgeOrphanGroups` is asked, by both its callers, which of a set of groups may still be handed
data. It used to answer **presence** while its own doc named the other question - "the set still
present in `dm_groups` (deliverable)". The two differ by exactly the tombstones, and a tombstone is
not a destination: its members, its keys and its history went with it, so a frame addressed to one
can never be decrypted and never be ACKed. `deletedAt` is a plain `@Column` rather than a
`@DeleteDateColumn`, so `find` returns tombstones and only naming them excludes them.

**The loop that follows has no termination.** The client is handed a frame for a group it does not
hold, asks for a Welcome (`welcome_request`) that no peer will answer, keeps the frame unACKed, and
meets it again on the next connection - for ever, because nothing in the loop consumes the frame.
Measured on prod 2026-08-21: 7 `queued_message` rows for W1's own device, addressed to a distribution
group tombstoned five hours earlier, redelivered on every connection since, and visible from the
client as `[BUFFER] welcome_request sent for unknown group b0192801` (worded `recovery started for
unknown group` since 2026-10-01: the old sentence announced a send that had not happened).

The call now returns two named sets, and the distinction is not cosmetic - the two causes accuse
different code:

| Group state | Frame | Residue | Log |
|---|---|---|---|
| present, active | delivered | - | - |
| **absent** from `dm_groups` | dropped | purged here, through the shared list | `[ORPHAN_PURGE]` WARN, with per-table counts |
| **tombstoned** | dropped | **left alone** | `[MSG_FETCH] ... undeliverable` WARN naming the group |

**The accusation is made once per group per process, and that was learned the hard way.** Written per
fetch it became the loudest line on the server within minutes of shipping: 134 warnings in one
three-minute window, the same four group ids over and over, because the residue is a STANDING FACT
rather than an event - every client asks on every reconnection and the rows do not go away when they
are read. Once is enough to be found, which is the line's whole job, and a restart re-announces
whatever is still there. The in-process set answers "have I already said this here", which differs
from "is this still broken" only in lifetime - so it is deliberately not durable, or it would silence
the trigger the day somebody wanted it again.

A tombstoned group's residue is deliberately **not** swept from the fetch path. It exists because a
delete route failed to take it, the fix belongs at that route, and a second collector here would hide
that route's failure - the tombstone is already counting down to the reaper. So the line accuses
instead: a queued row for a tombstoned group means a delete path leaked, and it names which group.

History follows the same rule and says so once: `deleteGroupOwnedRows` drops the `history:` stream
with the rest, so a tombstone can only ever answer an empty page. `getHistory` therefore returns
`{ rows: [] }` without a Redis round-trip - and at LOG, not WARN: a client that still holds the
conversation locally and asks for it is the most ordinary request there is. That line used to say
`orphaned - purged` for both causes, which is the wrong accusation for one of them.

### Dead devices are reaped, but only after 90 days

`detectStaleDevices` (hourly) keys liveness on `KeyPackage.createdAt`, which every WebSocket
reconnect refreshes. Past `RETENTION_WINDOW_MS` it `srem`s the device from the Redis routing set
and resets its row to `pending`; `cleanupStaleDevices` then purges the whole footprint.

Until that window elapses, a churned device id keeps receiving fan-out. That is the designed
offline window - a device that is merely off for a fortnight must still get its messages - not a
leak. Anything that needs a device to stop receiving *immediately* (a revocation) must act on the
Redis set directly rather than wait for the reaper.

### The device cap counts LIVE devices, because leaves are what it bounds

`MAX_DEVICES_PER_USER = 15` refuses `POST /api/mls/register-device`. What it protects is the
**ratchet tree**: every device is a leaf in every group it belongs to, so devices MULTIPLY rather
than add, and Welcome size, ratchet-tree export and push fan-out are all per-leaf. That resource is
consumed by a device that JOINED something, and by nothing else.

Until 2026-09-12 the number compared against the limit was `key_package` rows inside
`RETENTION_WINDOW_MS`, which is an account's **enrolment attempts over 90 days** - a different
quantity that happens to be larger. Measured on production the same day:

| | |
| --- | --- |
| `key_package` rows | 667 across 361 accounts |
| of those, devices with an active membership or a push token | **213** |
| of those, enrolled within 7 days and not yet proved | 87 |
| **dead weight the old rule counted** | **367 (55%)** |
| busiest account, under the old rule / under the new one | 15 / **6** |

The single account the old rule ever refused held fifteen enrolments, **zero** group memberships and
**zero** push tokens: a user refused a device because he had failed to get one working fifteen times,
each failure making the next likelier to be refused. Raising the limit would have bought thirty
failures. Its dead rows were purged (2026-09-12, user-authorised) with the same footprint the product
deletes itself, and the account is free.

`countLiveDevices` is the predicate now: **an active `dm_device_group_memberships` row, or a
`push_token` row, or an enrolment newer than `DEVICE_ENROLMENT_GRACE_MS` (7 d)**. The two halves
bound two different resources and are deliberately not merged - membership and push token bound TREE
LEAVES, the grace window bounds ROWS, since a device that joined nothing still costs one key package
and fifty prekeys. The device being registered is excluded from its own count, so re-registering an
id the account already holds can no longer refuse it.

`updatedAt` on either table is **not** consulted: a liveness clock must be written by the thing whose
liveness it measures, and both of those are written by whatever last touched the row, the server
included.

### The shared log keeps mutations, and records what may notify

`history:{groupId}` is the only **shared** copy of a conversation: the per-device queue is deleted on
ACK, and MLS forward secrecy means the server can never re-derive a frame it did not keep. What is
not written here is recoverable only from a peer that still holds it, and only while that peer is
online.

Until 2026-08-12 the write was gated on `!body.silent`. `silent` is a UI property - do not notify -
and **every** control frame is silent by construction, so that one condition excluded every reaction,
edit, deletion and read receipt from the only shared copy that exists. The client now declares the
two independently (`silent`, `durable`); the server classifies nothing, because it holds ciphertext.
Reconciliation traffic stays out: it restates state held elsewhere, and a 200-message bundle chunk
would evict the messages the log exists to carry.

Nothing notifies from the stream. Until 2026-09-28 one consumer did - a replay at activation
(DF2) re-sent a reactivated device what a five-minute window still held, filtered on a per-entry
`silent` field so it did not ring for every reaction. It is deleted with that field: a device a
commit admits is a recipient from that commit's epoch on, at SEND time
([channel-encryption section 20](../protocols/channel-encryption.md)).

Each entry also records the DEVICE that wrote it (`sender_device_id`, since 2026-08-15), and that
field exists for one reason: the stream is shared, so it necessarily holds the reader's own frames,
and MLS refuses every one of them by construction (`CannotDecryptOwnMessage`). `sender_id` cannot
filter them - the same account's OTHER device wrote frames that are both decryptable and wanted - so
without the device the replay learnt which rows were its own only by handing each one to MLS to be
refused. Measured before the fix: 5 certain-to-fail decrypts per MSG capture, in every capture, and
thousands per full replay of a 4 282-message DM. **Never learn by failing what a fact could have
told you** - the server holds the discriminator in the request body and now writes it down. Rows
predating the deploy still reach MLS and are still recognised by their refusal; that arm is the shim
and its removal date is in [legacy-compatibility](../legacy-compatibility.md).

Sizing is `HISTORY_STREAM_MAXLEN` (`retention.constants.ts`), raised 1000 → 8000 the same day. The
order matters and is not cosmetic: the store must be durable, then `maxmemory` must have headroom,
then the per-group cap may rise. Raising the per-group cap first lets eviction choose which
conversations keep a shared copy. Full reasoning in
[history-reconciliation](../protocols/history-reconciliation.md).

### The SENDER is checked before any recipient is resolved (2026-09-02)

**`status = 'active'` gated recipient resolution twice, and nothing gated the sender.** A device
whose membership row is not `active` holds NO LEAF in the ratchet tree, so whatever it encrypts is
undecryptable by construction for every member: accepting the frame does not deliver a message, it
manufactures one that will fail to open on every recipient, for ever. Measured on production
2026-09-02, DM `7da231f8`: the peer's web device, `pending` since 2026-08-27 and still
holding two undelivered Welcomes, sent six messages in 24 seconds that were fanned to five devices -
**thirty rows of ciphertext nobody in the group can ever open**. The sender saw them sent.

`sendMessage` now reads the sender's own `dm_device_group_memberships` row before resolving anybody
and answers **`403 sender_not_active`**, carrying the status so the client learns the fact rather
than inferring it. Two things the gate must not do, both asserted in `messaging.durability.spec.ts`:

- **Handshake frames are exempt.** A Welcome and a Commit carry no application payload and are
  precisely the path OUT of `pending`; refusing them makes the gate a deadlock.
- **A MISSING row is logged, not refused.** The row is written by the commit that admits the device,
  so a send racing just ahead of it is normal - though the same shape is also what a ghost looks
  like, which is why it is logged at all.

The discriminator was in the row the server already reads to address the recipients: this is the
rule about never learning by failing what a fact could have told you, applied to a seam that held
the fact and forwarded the frame anyway.

### Who a frame is queued for, and who owns the gateway's routing set

Two different questions that a single `sadd` used to blur together.

**The recipient set is resolved from `dm_device_group_memberships`, and that is the only way it has
ever been resolved.** `SendMessageBody.recipients` exists, `libs/proto/canari.proto` carries it, and
the branch that reads it was written first with the membership query behind
`if (ops.length === 0 && body.groupId)` under a comment reading *"Fallback: recipients not provided
(Redis cache miss). Resolve from DB and repopulate `group:members` so subsequent messages no longer
need this round-trip."*

No caller has ever populated the field. Not `postApplicationMessage`, which posts six keys and none
is `recipients`; not the gateway, where the word does not occur in the source at all; not
`POST mls/push/send` or the background-Welcome route; not the commit fan-out in `validateCommit`.
The proto file says as much itself - *"leave empty = derive from group members"*. So the guard was
true on every send, the fallback was the design, and `FALLBACK_MEMBERS_CACHE` announced a Redis
cache miss on **279 of 279 sends in a 23-minute window** for a cache `sendMessage` never reads. The
branch is now unconditional and named for what it does. **A fallback is a signal, never a path**: it
went unexamined for as long as it had a name that excused it.

That also had a second victim: five assertions in `messaging.durability.spec.ts` supplied their
recipients through `body.recipients`, so the suite was green while measuring the branch production
never takes and leaving the branch it always takes unasserted. They now declare membership rows and
KeyPackages, the way a real send finds them.

**The routing set is owned by `activateDeviceMembership`**, which writes `group:members:{groupId}`
at the pending→active transition - the moment membership is decided. What is left on the send path
is a reconciliation, and it exists for one historical reason: Redis ran without a volume until
2026-08-12, so the sets that died with the container have no other writer until each device happens
to re-activate.

Measured on prod 2026-08-15, which is what settled the design: of the 23 groups holding active
memberships, the 15 that **have** a set are complete to the row - **0 missing, 0 stale** - and all
11 missing rows live in the 8 groups that have no set at all. The reconciliation therefore adds
nothing on any group it has ever run against, so it reports only when it **changes** something, and
it accuses when it does: `MEMBERS_CACHE_REPAIRED` is a `warn`, matched by no rule in `srvlog.mjs`,
so a campaign run stops on it. An active device absent from that set is one
`broadcast_to_group_members` silently fails to reach (it proceeds with an empty member list and
sends to nobody) and one `forward_to_one_peer` can never elect to answer a `welcome_request` or a
`history_request`.

It reconciles against every **live** member, sender included. Reconciling against the delivery set
instead left the sender - and any `excludeDeviceIds` entry - out for ever, which made the repair
incomplete by construction.

**A frame may narrow the recipient set, never widen it: `recipientDevices` (2026-10-12).** A Graine seed
answer names the one device that asked, as `userId:deviceId`. `readAddressedDevices` refuses it on
a commit or a Welcome, as an empty list, above 16 keys or as a malformed key. `sendMessage` also refuses it (`addressed_not_key_group`, 400) on any group that is
not a key-distribution group: on a conversation group it would let a member show different
ciphertexts to different members, each kept out of the history stream. `sendMessage` keeps only
the resolved live members that match (user id compared lower-case) and logs `[SEND][trace]
ADDRESSED matched=N of M`, or warns `ADDRESSED_NOBODY` when nobody matches. **An addressed frame is
never appended to the history stream**: that stream is replayed to every member, and the frame
belongs to one device's queue only. Why and what it costs:
[channel-encryption §23](../protocols/channel-encryption.md#23-a-seed-answer-goes-only-to-the-device-that-asked---fixed-2026-10-12).

### The queue is bounded on ONE axis, and observed on the other

`cleanupExpiredQueuedMessages` bounds the queue by AGE, and that is the only axis on which
dropping a frame is defensible: past the retention window the recipient could not have used it.
There is deliberately **no size cap**. Capping a device's queue would convert a disk problem into
silent message loss, which is the failure class the whole delivery path exists to prevent.

So the answer to "one device is running away" is to NAME it. `reportQueueDepth` (hourly, added
2026-08-11) logs the total depth plus the five deepest per-device queues, and WARNs above
`QUEUE_DEPTH_WARN_PER_DEVICE`. It deletes nothing.

It exists because of a measurement, not a theory. The retransmission storm of 2026-08-10
(WP-RETRANSMIT-1) put **28 124 frames on a single web device in five hours** - 39 MB of ciphertext,
thirty times the rest of the platform combined, addressed to a browser generation that had already
been replaced and would therefore never drain it. The table reached 70 MB. Every mechanism behaved
as designed: the frames were inside the 90-day window, and the device held a valid `KeyPackage`, so
**no ghost predicate applied to it** - which is the correction to make if you are reading an older
note: "reap frames addressed to devices with no key package" would have matched ZERO of these rows,
and on the day it was checked every one of the 52 devices with a queue had a key package. Nothing
logged, nothing warned; it was found by a manual `GROUP BY "deviceId"` a day later.

The threshold is set from those two measurements rather than from taste: healthy per-device
backlogs were <= 84 frames, one storm hour was 21 597. 2000 is ~24x the former and ~1/10 of the
latter, so ordinary traffic and a genuinely offline weekend never trip it while a runaway sender is
named within minutes.

The WARN carries the device's **last `KeyPackage` upload** because that is the evidence separating
the two causes, which call for opposite responses: a recent upload means a live device that cannot
keep up ([WP-PENDING-1](../../../CLAUDE.md), a client bug to chase), a stale one means debris
awaiting the GC. A line reporting only the depth cannot tell them apart and sends the reader to the
wrong fix.

`app.controller.queue-depth.spec.ts` pins the decision - the threshold boundary and the evidence in
the line. It cannot pin the SQL: a mocked repository never parses a query, so the builder's output
is verified only by the prod deploy log.

#### The report worked, and its discriminator earned its keep (2026-08-11)

First real use, hours after it shipped. The hourly line named
`web-d82cd226…-msi13yl3-ytaa=1419`, and a follow-up `GROUP BY` showed it climbing to 1 513 with its
oldest row timestamped **02:00:46 that same morning** — i.e. the queue had reconstituted itself from
zero since the storm rows were purged overnight, at roughly 2.4 frames a minute of ordinary traffic.

It reads exactly like WP-PENDING-1's symptom: a device receiving and never draining. It is not, and
the thing that settled it in one query was the evidence the WARN carries — a **last `KeyPackage` of
2026-08-10 19:47**, against a live browser on that same account whose device id is
`…msgm5z5j-136y`. Different generation, so nobody will ever drain it: debris, not a client bug.

Two things follow, and both are the point of building the report rather than a cap:

- **The device id is the identity, and it must be read from the client under test, never recalled.**
  The whole distinction between "a bug to chase" and "rows to sweep" rested on comparing two strings
  that differ in eight characters.
- **The reaper still cannot touch it.** A valid key package is what disqualifies it from every ghost
  predicate, so the frames accumulate until the 90-day `RETENTION_WINDOW_MS` takes them. That is the
  open half, and it is the one a future GC has to answer — with a predicate re-measured on the
  population it will actually run against, not the one that named the last incident.

#### The answer was a REVOCATION, not a sweep (2026-08-11)

The debris was closed the same day, and by the mechanism the product already has rather than by the
new predicate the report seemed to be asking for. `web-d82cd226…-msi13yl3-ytaa` was revoked from
Settings > Appareils connectés; measured immediately after, on prod:

| | before | after |
| --- | --- | --- |
| `queued_message` for that device | 2 073 | **0** |
| `dm_device_group_memberships` for it | 6 | **0** |
| `revoked_device` rows for it | 0 | **1** |
| platform-wide `queued_message` | 2 916 | **847** |

**A DELETE WOULD HAVE BEEN THE WRONG SHAPE, AND IT WOULD HAVE LOOKED RIGHT FOR A DAY.** The rows were
the symptom; the cause is that the device is still a valid fan-out target. Emptying the table leaves
the six routing memberships in place, so the next message re-queues to it and the count starts over —
which is precisely what the report had already caught happening once, the queue reconstituting itself
from zero at ~2.4 frames a minute after the overnight purge. The revoke removes the membership, the
key packages and the queue together, and records the fact in `revoked_device` so nothing re-adds it.

The generalisation, and the reason this is filed as a rule rather than an incident: **when a resource
keeps refilling, the disposal is not the fix — find the mechanism that keeps naming it as a
destination, and use the product's own control over that mechanism.** A GC predicate written for this
would have had to distinguish "a generation the user replaced" from "a device that is merely offline",
which is a judgement the server cannot make and the user already made by replacing it.

What the remaining 847 rows say is that there was nothing else of this shape: the deepest per-device
queue is **84**, on a real user's phone whose key package predates it — the ordinary profile the
threshold was set against, not a second runaway.

#### The placeholder that took a conversation's first seat, cleaned by hand (2026-08-30)

The `(userId='unknown', deviceId='pending')` member — cause, guards and story in `CHANGELOG.md` — had
no product control that could revoke it: the revoke path above needs a real device to revoke, and this
was not one. It was removed by hand on prod with the owner's go-ahead, in the order the rule above
gives, and the counts are here because the frames are gone and this is the only record of what they
were.

| | before | after |
| --- | --- | --- |
| `dm_device_group_memberships` | 1 (`active`) | **0** |
| `key_package` | 1 | **0** |
| `one_time_key_package` | 50 | **0** |
| `queued_message` | 194 | **0** |
| real device rows in that DM | 8 | **8** |

**The allowlist is an IDENTITY, and that is what made it safe** — the mistake the defect itself was:
a shape allowlist is not an identity allowlist. `unknown` and `pending` are two literals no client can
produce, since a real `userId` is 64 hex characters and a real `deviceId` is `web-<64 hex>-…` or
`tauri-<64 hex>-…`. The post-check used `OR` where the delete used `AND`, a deliberately WIDER
predicate, so it proves no row of that shape survives anywhere rather than merely that the delete ran.

**What the frames were**, read before deletion: 194 in a single group from two senders — 117 commits
and 77 application frames, **no Welcome at all**, spanning 2026-08-27 22:04 to 2026-08-30 15:28.
Bodies are ciphertext no device could ever open, so the shape is the entire evidence.

**A CLOCK NEARLY SAID THE BLEEDING HAD STOPPED.** The newest frame was 2 h 47 old at measurement,
which reads like the guards had closed it. Bucketed by hour against ALL traffic to the same group,
the ghost took 2 frames where real members took 6, then 5 against 15, then 1 against 3 — about one in
four, **unchanged across the deploy that shipped the guards**. The quiet was nobody writing in the
conversation. The guards stop a NEW placeholder; only removing the membership row stopped this one.

**What this did NOT do.** The server row is not the MLS tree. If the placeholder ever took a leaf,
only a Remove commit from a member drops it, and no server query can tell — the group sat at epoch
118 and the placeholder held a `key_package`, so an Add is likely to have happened. That question is
answered from a member's own client, not from here.

#### WP-PENDING-1 verified on hardware, and what the run could not establish

The defect: a single `AbortController(10_000)` wrapped the **whole** paginated pull, and nothing was
ingested or ACKed until the pull returned, so a backlog bigger than 10 s of transfer aborted on every
reconnect, ACKed nothing, and only grew (measured at 5 526 rows = 12 pages). The fix moves the
deadline onto one PAGE and hands each page to `onPage` as it lands
(`mlsDeliveryApi.pullPendingMessagesJson`, `BaseMlsService.fetchPendingMessages`).

Verified on A1 by parking the phone (`am force-stop`), sending 1 100 messages from the peer browser
into the two-test-account DM, and unparking it under continuous logcat with the server-side queue
polled every 4 s. Both halves agree:

| Evidence | Reading |
| --- | --- |
| `[PENDING] Fetched 500 … (500 so far)` then `Fetched 287 … (787 so far)` | the pull really paginates |
| a `[QUEUE] Drain start` **between** those two lines | page 1 was ingested before page 2 was fetched |
| depth series `795 → 305` at 54 s, then `417 → 6` at 100 s | two distinct ACK steps, ~490 then ~411 |
| final depth `0`; 0 ACK failures, 0 transport failures, 0 SQLite errors | the backlog is discharged |

The depth *rises* through the first 48 s (`693 → 795`) because the fan-out lags the last send by
minutes at this volume — which is also why the harness now polls until the depth stops growing
instead of reading it once after a fixed pause. A single read 8 s after the last send reported 615
of the ~1 100 on their way; it cost nothing here, but it is the number a verdict quotes.

**What this run does NOT establish, stated because the tempting claim is the wrong one:** 1 100 rows
is two pages and a few seconds of transfer, so the *old* code would very likely have finished inside
its 10 s budget too. The original timeout is not reproduced. What is established is the structural
property the fix is made of, which is independent of link speed — partial progress, page by page —
and reproducing the timeout would need a backlog no composer can build in under an hour.

#### A page is a unit of transfer, so it is bounded in BYTES (2026-08-13)

WP-PENDING-1 bounded the DEADLINE per page and left the page itself bounded in ROWS, which is the
wrong unit and only moved the failure. Measured on production: one phone was asked for 500 rows,
which for its queue meant **12 MB**, because a quarter of its frames carried media at up to 89 kB
each. It aborted on its own 10 s per-page deadline having received nothing, ACKed nothing, and met
the same 12 MB on every later attempt. The backlog went **959 -> 965 -> 976** over three consecutive
hourly reports and never once fell, for weeks.

Nobody was told, and that half matters as much: `QUEUE_DEPTH_WARN_PER_DEVICE` is **2000 rows**,
calibrated on the retransmission storm of 2026-08-10, and 976 rows weighing 36 MB never came near
it - a predicate that named the last incident does not name the next one. The report now warns on
`QUEUE_BYTES_WARN_PER_DEVICE` as well and orders the top-N by size.

Three mechanisms, each independently sufficient for a different failure:

| Where | What | Why it is not the others |
| --- | --- | --- |
| `fetchMessages` | fills a page to `PENDING_PAGE_MAX_BYTES` (1 MB), reading `PENDING_FETCH_CHUNK_ROWS` (50) at a time | bounds the SERVICE's memory too: reading 500 rows before trimming would load 44 MB to return 1 MB |
| `pullPendingMessagesJson` | halves `limit` when a page does not arrive, down to 1 | survives an OLD server, and a link too slow for any fixed budget; terminates on a proof (nine steps), never a clock. What counts as "does not arrive" is the progress deadline below; a request nobody answered is rethrown at once, never halved, while a body cut after the head (`BodyInterruptedError`) still halves (2026-10-15) |
| both | a page always carries **at least one row**, whatever its size | an oversized frame must stay deliverable, or it blocks its own queue for ever |

**Verified on production the same evening.** The server logged
`page capped by bytes at 53 row(s), 1 039 524 byte(s)` for that device and the queue fell **976 ->
923** - the first downward movement ever recorded on it. Total fleet queue 2266 rows / 38 MB across
55 devices, largest frame 89 600 bytes, **0 frames above 1 MB**, so a one-row page is at most 87 kB
and the halving ladder really does terminate.

**Two faults that only running it revealed**, both now fixed and both worth keeping in the head:

- **Termination was an inference.** The client stopped when `batch.length < pageLimit`, which was
  true only while rows were the sole bound. With the byte cap it read 53 < 500 as "queue empty" and
  stopped with 870 frames waiting - one reconnection per page. **Only an empty page proves there is
  nothing left**, and that is now the terminator; it costs one extra request per drain.
- **The cursor is not a total order.** The client resumes at `createdAt > last`, strict, and
  `@CreateDateColumn` writes milliseconds from the application - so two rows can share an instant
  (one such pair was in the live queue that day). A page split inside such a group drops its tail
  from every later page: queued for ever, delivered never. Byte-capping makes truncation the normal
  case, so this went from theoretical to likely. **A page never ends inside a group sharing one
  `createdAt`**, even when finishing the group takes it past its budget or its row limit. Fixed
  server-side on purpose: it covers clients too old to send a better cursor.

#### The per-page deadline measures SILENCE, not elapsed time (2026-08-17)

The residual imperfection the section above recorded rather than hid: 10 s was a TOTAL, so it could
not tell a transfer arriving slowly from one that had stopped arriving at all. That is the wrong
question. A total deadline has to be large enough for the biggest plausible answer on the slowest
plausible link - a product nobody can bound, hence a number nobody could justify. Ten seconds was
that number.

**`fetchJsonUnderProgressDeadline` asks the question that has an answer: is anything still coming.**
The timer is armed once before the request and RE-ARMED on every arrival - the response head, then
each body chunk - so it fires only on `PENDING_PAGE_STALL_MS` of complete silence. The constant did
not change and its justification did: it no longer has to cover a transfer, only the longest quiet
stretch the design permits, and there is exactly one - the server assembling a page it already
bounds at 1 MB reading 50 rows at a time. Ten seconds of total silence against that is pathological,
which is what a hang-guard should be.

Both halves are real on both platforms: the browser streams `res.body`, and Tauri's `plugin-http`
builds its `Response` over a `ReadableStream` pulling chunks across the IPC boundary, so a chunk
arriving there is a chunk arriving here. **The reader is raced against the abort rather than trusted
to honour it** - aborting the signal stops the REQUEST, not a `read()` already awaiting a chunk from
a stream that was never handed the signal, and a hang-guard that can itself hang is not one.

**The halving ladder stays, and the question of whether it still earns its place is settled: it
does.** The deadline decides when to stop waiting, the ladder decides what to ask next - a detector
and a response, not two answers to one question. Neither can do the other's job: without the
deadline the ladder never fires, and without the ladder the deadline only ever reports.

What the deadline now adds is EVIDENCE. `StalledRequestError` carries whether the response head had
arrived, so the log separates the two causes halving treats alike - a server that never started
answering (the size question, the one asking less can fix) from a transfer that started and stopped
(the link). Nine identical `page did not arrive` lines said neither. Pinned by
`progressDeadline.test.ts` (the mechanism, both outcomes) and
`mlsDeliveryApi.pending.test.ts` (a body taking six times the window and never halved).

#### A drain that acknowledges nothing now says so

WP-PENDING-1 fixed the pull. What it did not fix is that **a row nothing acknowledges is invisible
from either end**. Only what reaches `enqueueMessage` can ever be ACKed, and two places drop a row
before that without a word:

- `BaseMlsService.enqueuePendingRows` skips a row whose `proto` is absent or decodes to zero bytes
  (and used to swallow a decode failure into a single `console.error` with no tally);
- the inbound handler returns `false` for an unknown group (buffered pending a Welcome) or an absent
  conversation (waiting on the store restore) - correct in both cases, and silent in aggregate.

A device in either state re-fetches the same rows on every reconnect for the 90 days of the
retention window, and the only external symptom is a backlog that grows and never shrinks. That
reads identically to "the pull never runs", to "the pull runs and everything fails", and to a device
with nothing to do - three causes, three opposite fixes, and no server-side count separates them.
This is exactly the rule about a report having to carry the evidence that separates the causes it
cannot itself distinguish.

So both are counted and named. `enqueuePendingRows` emits one line per page splitting **empty
payload** from **undecodable payload** with a sample of ids; `unackedFrames.ts` tallies the handler's
refusals by reason with a sample of group ids, and `fetchPendingMessages` reports it **after
`waitForMessageQueueIdle`** - the rows are enqueued, not handled, so what was refused is only known
once the queue has drained. Silent when there is nothing to say.

### The background Welcome answers what happened, and the stage is merged only on an acceptance (2026-10-22)

A killed Android phone answers a `welcome_request_pending` push from its `mls.bin`
(`processWelcomeRequestBackground` in `CanariFirebaseMessagingService.kt`, Rust
`prepare_welcome_background_with_key` / `settle_background_welcome` in `mobile/background.rs`). Read on the Mi 9T on 2026-10-22: the phone had been shut while its group moved
from epoch 1 to 3, built its add on base 1, the gate refused it (`epoch_mismatch`), the route answered
`201`, and the phone logged "Welcome sent". Worse, it had merged the add into `mls.bin` before the
answer, so it held an epoch nobody else had and could not read the group's next message.

- **The route's answer is typed.** `201 {status: 'accepted', newEpoch}` after the gate accepted;
  `409 {status: 'rejected', reason, currentEpoch?}` otherwise. The phone classifies
  the body's `status` token (`push/BackgroundWelcomeAnswer.kt`), so it reads a pre-2026-10-22 server
  (`201 {status: 'rejected'}`, `201 {status: 'done'}`) correctly too.
- **The phone stages the Add IN `mls.bin`, and merges it only on an acceptance** - the foreground's
  order since C7, and its recorded stage (`add_members_recorded`, `mls-core/src/pending_submission.rs`):
  the pending commit and its submission record are written by compare-and-swap over the bytes the Add
  was built from, BEFORE the commit leaves. `accepted` merges it, a refusal clears it, each written by
  compare-and-swap over the `mls.bin` loaded at that moment. A transport failure or a 5xx is
  `unknown`: nothing is settled, because guessing either way is the fork this exists to prevent.
  So is every untyped 4xx but a WHITELIST - 400 and 413 (`BYTES_REFUSALS`), which refuse the bytes
  and so every wire copy alike: Android's `HttpURLConnection` silently retries a POST on a reused
  connection, so the request read may be a copy of one the server accepted, and a 401/403/408/429 from
  the guards or a 404/405/409 from an edge says nothing of it. The stage is left for the foreground's
  resubmission. A typed
  `concurrent_commit` is left too: the lock it reports may be this commit's own first copy, as the
  client's resubmission rule reads it (`resubmissionVerdict`), and the group answers `commit-pending`
  until the foreground settles it. A 400, a 413 and every other typed `rejected` body still clear. One
  route-side gap is owed: the membership guard answers `not_a_member` before the duplicate check
  ([backlog](../backlog.md#p3---the-background-welcome-route-refuses-not_a_member-before-it-asks-whether-these-bytes-already-landed-review-of-2329-2026-10-24)).
- **Only a COLD process stages or settles** (`background_write_mls_bin_if_unchanged_and_cold`, the
  key-group join's writer). In a process whose foreground manager is loaded
  (`live_manager_in_process`), that manager persists over `mls.bin` at its next resume or checkpoint
  and would erase the stage while the server holds the commit. The prepare refuses `warm-process`
  and sends nothing - the app's own load answers the request, and the newcomer re-asks every 60 s; a
  settle in a process warmed inside the round trip is `left-to-foreground`, whose loaded state holds
  the stage. The stage's ledger entry is written under the same hold of the `mls.bin` write lock as
  the stage, and the sign-out sweep (`remove_mls_state_in`) takes that lock, so it removes both or
  neither. The entry names its commit's digest, so a settle forgets its own stage and never a later
  one of the same group. The warm mark is STICKY (set by the first foreground load, never cleared while
  the process lives), so a process Android keeps alive refuses every background Welcome; its rate is
  owed a measurement ([backlog](../backlog.md#p3---the-background-welcomes-warm-process-refusal-its-rate-its-wasted-round-trip-and-the-old-pin-path-review-of-2329-2026-10-24)).
- **What the background cannot settle, the foreground does - and nothing waits.** No answer read, a
  busy state lock, a foreground that started or wrote inside the round trip: the stage stays in
  `mls.bin`, and whoever loads it next holds it. The foreground settles it as it settles its own
  commits (`settleUnresolvedCommits`, at connect, before a send in that group, and after a resume
  reload that installed a new state): it resubmits the recorded commit, the gate answers an accepted
  one `duplicate`, and it merges - then sends the Welcome its record owes (`excludeDeviceIds` and
  `keyPackageDevices` name the admitted device; the intent is pinned on both sides by
  `src/lib/mls-client/test/fixtures/background-welcome-intent.json`). The joiner refuses the second
  copy of a Welcome it already took. A group holding an unsettled stage is not answered again
  (`commit-pending`), and the background outbox seals nothing in it (the entry stays queued).
- **The KeyPackage is bound to the requester, as the foreground's Add binds it.** The phone hands
  Rust the `userId:deviceId` the push named (`WelcomeRequest.requester`). A package whose credential
  names another device, or that device under a key the phone never pinned for it, is refused BEFORE
  anything is staged (`MlsManager::key_package_verdict`, the check the Add re-runs). The answer's
  reason is the skip's wire name: `identity-mismatch` or `signature-key-changed`, logged at ERROR.
  Pinned by `a_substituted_key_package_is_refused_on_the_background_path` and
  `a_key_package_under_an_unpinned_key_is_refused_on_the_background_path`.
- **No catch-up and no retry.** The background never applies the group's commits to `mls.bin` (the
  foreground's replay owns that, and what it does around a commit); a stale phone is refused, and the
  request is left to the foreground or another member. An `epoch_mismatch` whose server epoch is
  AHEAD of the base (never a base at or past a lagging counter) is recorded in
  `welcome_request_stale.json` against the digest of `mls.bin`, so the newcomer's re-ask every 60 s is
  not answered again from the same bytes; any write to `mls.bin` lifts it. A refused TARGET
  (`welcome_target_unknown` / `welcome_target_not_member`) is remembered the same way, for that target
  alone (`{group}|{userId:deviceId}`), so a holder does not commit and get refused on every ask; a
  target admitted later is answered from the next bytes, or by another holder or the foreground. The memo of a refusal is written
  against the bytes the clear WROTE, which are the bytes the next request is answered from. Deleting
  the MLS state (`remove_mls_state_in`) sweeps the memo and its `.tmp` with it - and deletes
  `mls.bin` after them, so a sweep that fails part-way leaves the state intact for the next reset to
  finish; the owner record
  (`mls.owner` and its `.tmp`) goes after `mls.bin`, so a failed removal never leaves a state nobody
  is named for.
- **The newcomer heals on its own cadence**: `requestReAdd` re-asks every 60 s while its app is open
  (external join first, then `welcome_request`), so it joins as soon as a base is published again or a
  member with a current state answers. A shut, stale phone alone never serves it.
- **The base of the new epoch travels with the commit** (COMM-22), as the foreground's does: the
  prepare exports it (`add_members_bulk_with_base`), the phone sends it as `groupInfo`, and
  `validateCommit` publishes it in the advance's own transaction. So an accepted background add never
  leaves the published base one epoch behind, whether or not the phone's install then succeeds.
- **An accepted commit always has its Welcome.** The route hands the Welcome to `validateCommit`
  (`ValidateCommitBody.welcome`), which holds its target to `sendWelcome`'s bar (a registered device,
  on the roster or entitled by social-service) BEFORE the epoch moves - a refusal is a typed
  `welcome_target_unknown` / `welcome_target_not_member` 409 - and writes the Welcome row in the
  advance's own transaction, then delivers it from that row. The Welcome used to be queued by a second
  call after the advance; when that failed, the newcomer sat in the tree with no Welcome, every holder
  then answered it `already-member`, and nothing durable recovered it. A failed realtime delivery now
  costs nothing: the row is the delivery, and the device takes it on its next pull.
  `welcome` is the background route's alone: `POST /mls/commit` hands the gate an allowlist of the
  fields `submitCommit` sends (`foregroundCommitBody` in `messaging.controller.ts`), so a foreground
  body carrying one stores nothing. And **every path that ends a device's membership deletes the
  Welcomes still queued for it, in the transaction that ends it**, through one helper,
  `endDeviceMemberships` (`utils/group-membership.ts`): a device pulls its queue whatever the roster
  says, so a Welcome left behind would let it enter the epoch it was built for. The paths: a removal
  or self-leave (`removeGroupMember`), a key-group eviction - community kick, leave, salon removal -
  (`evictFromDistributionGroup`, whole queue), account erasure (`deleteUserData`, whole queue), a
  deleted, revoked or collected device (`purgeDeviceFootprint`, whole queue), and the three device
  routes `DELETE device-memberships/...` and `force_leave`. Deliberately NOT: a kick back to
  `pending` and the cron's purge of a stale pending seat, where the person stays on the roster and a
  queued Welcome is the Add the device is owed. The helper refuses an empty or missing `userId`, and
  an empty `deviceId` or `groupId` when the scope names one, because a criterion left out of a delete
  widens it to every row.
- **A removal and a Welcome store serialise on the target's roster row.** `addGroupMember` and
  `removeGroupMember` write `dm_group_members` first, then the membership interval, then the device
  rows and (on a removal) the queued Welcomes. Two transactions that take the same rows in the same
  order wait for each other instead of deadlocking (`members.controller.lock-order.spec.ts` reads
  that order off the SQL the real TypeORM builder generates, via `testing/recordingDataSource.ts`;
  it cannot run two live sessions, so it proves the order and not the wait). Both Welcome stores -
  `validateCommit`'s transaction and `sendWelcome`'s `enqueueForLiveGroup` - re-read the target's
  `dm_group_members` row `FOR SHARE` after the group row and before writing (`lockWelcomeSeat`).
  If the removal committed first, the row is gone and the store is refused `welcome_target_not_member`
  with nothing written. If the store got there first, the removal waits on that lock, then deletes
  the Welcome it just stored. A key-distribution group has no roster row on this side (social-service
  holds its roster), so its target is checked by the entitlement read instead.
- **The commit is fanned out once.** `validateCommit` fans an accepted commit out itself; the route used
  to broadcast it a second time.
- **What the phone does with the answer is decided in `BackgroundWelcomeAnswer.apply`**, behind a
  `StagedWelcome` seam the JVM tests drive: a merge or a clear that finds the MLS state lock busy never
  ran, and the stage is left to the foreground (`stage left in mls.bin (lock busy)`).
- **The state refuses what its index allows.** The WebView keeps an index of the groups holding a
  staged commit, and a resume reload swaps the state under it. So the index is dropped BEFORE the
  swap, and the native send (`envoyer_message_bytes`) refuses, typed, a group whose state holds a
  staged commit (`Scellement::CommitPending`, `StagedCommitPendingError`): `sendMessage` settles it
  and seals once more, or answers `CommitOutcomeUnknownError`. The background outbox holds such a
  group without spending a slot of its batch (`maxAttempts` counts only the entries attempted).
- **Every stage is traced to its end.** The prepare names the stage in `background_stages.json`; a
  settlement by the background forgets it; the foreground's next load reports each one left
  (`report_background_stages`): `found in the loaded state` (settled by resubmission), `already
  merged`, or `is ABSENT from the state this foreground keeps` at ERROR.
- **What is left open:** the foreground's checkpoint is a BLIND write (`write_mls_state_blob`). A live
  manager that never loaded the stage - a resume reload refused as `live-ahead` (which then persists
  the live state) or as an epoch regression - writes over it, and an accepted Add is then held by the
  server and not by this device. Staging only in a cold process closes that for a process warmed
  BEFORE the prepare; what is left is a process warmed inside the round trip, whose load read the
  stage, and a manager that then never re-reads the file. It is SAID, not prevented: before the
  persist - whether or not a stage is noted, since a Welcome received in the background joins a group
  with nothing in the ledger - `... ERASES` at ERROR
  with the counts and group prefixes of the stages and later epochs the file holds; at the
  background's answer, `ACCEPTED AND NOT HELD`; at the next load, `is ABSENT`. The device recovers
  through the usual ladder. The same write loses any background advance, not only this one; it is its
  own work package
  ([backlog](../backlog.md#p2---wp-checkpoint-cas-the-foreground-checkpoint-writes-over-a-file-it-did-not-load-2026-10-23-design-one-mls-manager-per-process-owed-a-review-before-code)).
  iOS has no background re-add (its branch was unreachable and is deleted).

### A key-group frame is stored once (migration 034, 2026-10-22)

**Measured on production 2026-10-21:** each key-group payload sat in 31 `queued_message` rows on
average, and the key groups held **883 MB of a 1.5 GB queue**
([dm-vs-community-encryption](../protocols/dm-vs-community-encryption.md#where-each-system-can-improve)).
The ciphertext of one fan-out is the same for every seat, so it is now stored once.

**The per-device row is still the DELIVERY RECORD, and nothing a device sees changed.** Its `id` is
what the device ACKs, what a push names (`queuedMessageId`, `fetch-proto`), what the deferred push
checks, and what the client deduplicates on. Its `createdAt` is what the pull pages on. So the
record keeps every column. On a key-group fan-out its `proto` is NULL and `payloadId` points at one
`queued_payload` row (`groupId`, `proto`, `createdAt`). All the code is in
[`utils/queued-payload.ts`](../../../apps/chat-delivery-service/src/utils/queued-payload.ts):

| Step | Function | What it guarantees |
| --- | --- | --- |
| Decide | `sharesPayload` | A key-distribution group (community or salon), at least 2 records, the same `proto` on all of them, no Welcome. A DM, a group conversation and a single addressed seat stay inline |
| Write | `saveWithSharedPayload`, from `enqueueForLiveGroup`, **only while `QUEUED_PAYLOAD_SHARED_WRITES=true`** (OFF as shipped, see below) | The payload and all its records in ONE transaction, under the `dm_groups` row lock the send already takes. The records come back with `proto` set in memory, because the realtime envelope is built from them. OFF, the fan-out is the inline per-seat write every release has made |
| Read | `materializeDeliveries`, from `fetchMessages` (per chunk, before the byte budget) and `fetch-proto` | The payload is JOINED in the statement that reads the record (`q.payload`, a many-to-one with no foreign key), so the pair is one snapshot and cannot race the collector. The function puts `proto` back and REMOVES `payloadId` and `payload`, so the pull's JSON keeps the shape every shipped client parses. The pull pages with SQL `OFFSET`/`LIMIT`: TypeORM's `skip`/`take` would turn the join into a second query. A record whose payload is missing is logged as a `[PAYLOAD] MISSING` error and WITHHELD - never served as an empty frame, which the device would ACK, deleting the only evidence of the loss; `fetch-proto` answers it as absent |
| Collect | `collectUnreferencedPayloads`, hourly after the 90-day retention delete | `DELETE ... WHERE NOT EXISTS` a record pointing at it, in one statement. This is an allowlist based on durable state, never on age |
| End a group | `deleteGroupOwnedRows` | `queued_payload` is in `GROUP_OWNED_TABLES`, right after `queued_message`, so a group's payloads go with its records in the same transaction, and orphan discovery sees them |

**Why one collector is enough, and what would break it.** A payload's reference set only shrinks:
all its records are inserted in the transaction that inserts it, and nothing ever adds a record to
an existing payload. So "no record references it now" means no record ever will. Every path that
deletes RECORDS (an ACK, `purgeDeviceFootprint`, the retention, an account erasure, the internal
deletes) never touches a payload. Whichever of them removes the last record, the next hourly pass
takes the payload. The cost is that a payload can outlive its last record by up to an hour. **A
future writer that points a new record at an existing payload breaks this argument** and must take
the payload row `FOR SHARE` to restore it.

**No backfill, no transition logic.** Rows written before migration 034 carry their `proto` inline
and `payloadId` NULL. That is exactly what every reader already serves, so they stay correct untouched
and leave the queue by ACK or retention as before. There is no foreign key, like every other column
that joins this service's tables.

**THE READERS SHIP FIRST, AND THE WRITER IS A SWITCH THAT SHIPS OFF.** Once a shared record
exists, its `proto` column is NULL. An image older than the readers does not join `queued_payload`,
so it would serve that record as an empty frame, and the device would ACK it away: the message is
lost, silently - and re-running an older release IS the documented rollback. So the release that
carries migration 034 carries the join, `materializeDeliveries` and the collector, and writes NOTHING
shared: `enqueueForLiveGroup` calls the writer only while `QUEUED_PAYLOAD_SHARED_WRITES` is `true`
(`readSharedPayloadWrites` in `utils/queued-payload.ts`, read once at boot; unset or `false` is OFF,
anything else stops the boot). The key is a `literal:false` row of
`infrastructure/deploy/env-manifest.tsv`, passed by both estate compose files.

**Turning the writer on is a code change in a LATER release, never an operator flip.** Once the
release carrying the readers is the STABLE in production (so every image a rollback can land on reads
the join), a pull request changes that manifest row to `literal:true` and the matching expectation
of `.github/scripts/tests/deploy-env.test.sh`; it ships in the next pre-release, then the next stable.
From then on a rollback may go back as far as the readers' release and no further.

**The migration sets `lock_timeout = '5s'`** (`migrations.lock-timeout.spec.ts` asserts it for 034
and 035). `ADD COLUMN` takes ACCESS EXCLUSIVE on `queued_message`, the service's busiest table, and
every send would queue behind it while it waits. A timeout fails the deploy instead, and a re-run is
safe because every statement is idempotent. The `payloadId` index is PARTIAL (`WHERE "payloadId" IS
NOT NULL`) and built `CONCURRENTLY`, which the runner allows: `infrastructure/lib/migrations.sh`
feeds the file to psql on stdin with no `--single-transaction`. A concurrent build that fails leaves
an INVALID index under its name that `IF NOT EXISTS` would keep for ever, so a `DO` block drops an
invalid leftover first (a plain `DROP INDEX`, an instant under the same timeout).

**Where it is tested.** `queued-payload.integration.spec.ts` runs against the production Postgres
digest in CI's `test-chat-delivery-integration` job, which fails if any integration spec of the
service did not run or was skipped; it applies the migration statement by statement over one
session, as psql does, over an INVALID leftover, twice. The pull also orders by `q.id` after
`createdAt`, so records sharing a timestamp page in a total order: `messaging.pending-page.spec.ts`
fails without it (a fake that orders by nothing it was not told), because a quiet PostgreSQL happens
to repeat its tie order and passes either way.

**What the reports count.** `reportQueueDepth` sizes a shared record by its payload
(`LEFT JOIN queued_payload`), because draining it costs the device the whole payload. The admin
storage panel lists `queued_payload` beside `queued_message`.

**Scope is the key groups only, deliberately.** That is where the bytes are. A group conversation
of 109 seats has the same shape, and widening `sharesPayload` to it is a one-line change once its
queue is measured. A DM (2 to 5 rows) would pay a second row and a join for almost nothing.

Pinned by `queued-payload.spec.ts` (the switch, the decision, the write shape, the read shape),
`messaging.send-race.spec.ts` (the same fan-out OFF, ON, and a bad value refusing the boot) and
`queued-payload.integration.spec.ts`. The integration spec runs against PostgreSQL through the
service's own `sendMessage` (booted ON, and once OFF), `fetchMessages`, `acknowledgeMessages`,
`purgeDeviceFootprint`, the retention cron and `reportQueueDepth`, and it is gated on
`CHAT_DELIVERY_IT_DATABASE_URL`.

### A roster seat is not a key, and only a Welcome tells the two apart

`addGroupMember` writes a `dm_device_group_memberships` row with `status: 'pending'` for **every**
device of the invited user that holds a `KeyPackage` in the retention window. The Welcome, on the
other hand, only reaches the devices the inviter's `addMembersBulk` actually managed to add - a
device whose KeyPackage the WASM layer rejects lands in `skipped` (device + typed reason) and is dropped there. The
two counts are written by different actors and nothing compared them, so a device could hold a seat
on a group's roster it had never been given the keys for: present in the roster, receiving nothing,
notifying nothing. `warnSkippedKeyPackages` logged it in the **inviter's** console and nowhere else,
which is the one place nobody reads - a correct mechanism with no report.

It was found by hand, a day late, exactly as the rule predicts. A member created a new DM on
2026-09-01; the peer's phone got its pending row at `20:45:47.420` and **no `queued_message` with
`isWelcome = true` was ever written for it**, while the account's four other devices each got one.
It sat stranded for **3 h 41**, until the phone healed itself by external join at `00:26:54` and
republished its key package at `00:53` with 39 one-time key packages. The peer read the message on a
web session and got no notification on his phone, which is how the defect surfaced at all.

`reportStrandedDeviceMemberships` (hourly, added 2026-09-01) closes the gap on the server, where
both facts are known. It selects the `pending` rows older than `STRANDED_PENDING_MEMBERSHIP_MS`
(1 h - long enough that an ordinary invitation in flight is never counted) and partitions them with
ONE grouped query against `queued_message` on the pair the row cannot carry by itself: **is a
Welcome actually queued for this device AND this group**.

- **awaiting a queued Welcome** - healthy. The Welcome exists, the device is simply offline. Logged,
  never warned; this half is the population the WARN would otherwise drown in.
- **no Welcome ever queued** - the defect, and since 2026-09-04 it is **split again**, because that
  footprint has two opposite causes wanting opposite fixes:
  - **never added** (`kickedAt IS NULL`) - the device was registered onto the roster and its
    KeyPackage was skipped, so it was never in the MLS tree. WARNed. The reader's next stop is the
    inviter's KeyPackage handling.
  - **kicked with no re-add** (`kickedAt IS NOT NULL`) - a member REMOVED this device's stale leaf
    and undertook to Add it back, and the Add threw. The device WAS in the tree. Logged at **ERROR**,
    because this is a failure rather than a state, and it is the ONLY place it is ever reported: the
    `addMember` fails on the answering device, which is a phone, and the failure is swallowed there.
    Dated by the KICK rather than by `updatedAt` - the age that matters is how long the promise has
    been outstanding.

  Both halves name the oldest `STRANDED_MEMBERSHIP_REPORT_TOP_N` as `deviceId@groupId(ISO)`, because
  a count cannot be chased and a device id can.

**THE SKIP NOW NAMES ITS OWN CAUSE, IN THE INVITER'S LOG (2026-10-04).** `add_members_bulk` returns
`skipped: { index, reason }[]` and `reason` is `SkippedKeyPackageReason` (`mls-core/src/lib.rs`),
classified at the throw from the openmls `KeyPackageVerifyError` variant by an EXHAUSTIVE match -
never from a message: `undecodable`, `expired`, `not-yet-valid` (the minter's clock is ahead),
`missing-lifetime`, `invalid-signature`, `unsupported-protocol-version`, `malformed`, `internal`
(openmls or THIS device's clock). It crosses the WASM boundary as `{ index, reason }` objects and
Tauri serialises the same struct; `addMembersBulk` maps it to `skipped: { deviceId, reason }[]`
(the old `skippedDeviceIds` is gone, every consumer migrated: `groupCreation.ts` x3 through
`warnSkippedKeyPackages`, and `admitNewcomer.ts`), and both print ONE line per reason.
**Last-resort vs one-time is NOT knowable on the client**: the `LastResort` extension sits in the
payload `KeyPackageIn` keeps private until `validate` succeeds, and a refused package never does -
and the server hands over a bare `keyPackage` string. The server's own `[KP] one-time pool EMPTY`
line (it chose the row) is the witness for that half. **What is still missing is the SERVER half**:
the hourly report partitions on the queue, not on the reason, because nothing sends the reason
there - that is a new write path and a table, so it stays in the [backlog](../backlog.md).

`kickedAt` is what makes that split possible, and it is a column written to answer exactly that one
question - never a second `updatedAt`, which moves for every write and would read an invitation, a
Welcome queue and a demotion as the same event. It is **set** by `kickStaleDevice` and
`kickStaleUser`, the only endpoints that reset a live membership (one instant for a whole batch,
because one Remove commit reset all of them), and **cleared** by the three writes that answer the
question the other way: `queueWelcome` (a Welcome exists, so the re-add landed),
`activateDeviceMembership` and `updateInvitationStatus('active')` (the device is in). A demotion to
`pending` does NOT clear it - that is a step towards cleanup and promises no Add. Left uncleared,
every successful kick-and-re-add would be reported as a failed one; never set, the ERROR half counts
zero for ever and reads as health, which is why the write sites have their own spec
(`invitations.controller.kick-marker.spec.ts`) rather than being covered only through the report.

**It cannot be backfilled**, and is not: null is the honest reading of "no kick is recorded" for
every row that predates the column, so the first passes after the deploy report the standing backlog
as *never added* and the split becomes exact as the population turns over.

It deletes nothing - `purgeOrphanedMemberRows` and the fourteen-day queue retention still own that -
and the point of the hour-scale threshold is that the report names these rows about thirteen days
before the purge erases the evidence that would explain them. `app.controller.stranded-memberships.spec.ts`
pins the partition, the threshold boundary and the shape of the WARN; as with `reportQueueDepth`, a
mocked repository never parses SQL, so the builder's output is verified only by the deploy log.

### The commit log is observed hourly: a re-key RATE and any HOLE (`reportCommitLogHealth`, 2026-10-04)

The fifth hourly report, purely a report (deletes and repairs nothing, and could not: a missing
commit is ciphertext only its author held). It exists because DM `7da231f8` took **129 epochs in six
days** - 16 commits in 48 minutes from one web session - and lost epoch 121 for good, while nothing
counted commits per group and nothing looked for a gap; a user's impression found it four days late
(the four defects behind it are fixed, story in `CHANGELOG.md`). Scheduled hourly, in
`runInitialSweep` after `pruneExpiredCommitLog`, cleared in `onModuleDestroy`; pinned by
`app.controller.commit-log-report.spec.ts` (what it says, the threshold boundary, the SQL's span
and that it is one grouped query - a mocked repository cannot execute the SQL itself).

- **Rate.** One query over the last hour of `mls_commit_log`, grouped by `(groupId, senderDeviceId)`
  then by group. Every hour it LOGs the whole distribution - `per group p50/p90/max` and `busiest
  single committer per group p50/p90/max` - so the predicate can be re-measured from the log alone.
  It WARNs, one line, only for groups where **one device** made `COMMIT_RATE_WARN_PER_DEVICE_HOUR`
  (8) or more commits, naming the committer, how many devices committed and the epoch. **Per
  committer, not per group**: a community taking ten newcomers records ten commits by ten devices
  (growth); the churn this watches is one device re-keying repeatedly (the incident ran ~20/h).
  **8 is set from the mechanism and the incident, NOT from a measured population** (no production
  access from the session that wrote it): the first hourly distribution lines are the measurement,
  and the constant's doc says what to compare it against. The 12-commits-in-2h14 phone of the same
  incident stays under it on purpose.
- **Hole.** ONE query (window `LEAD` over the log, `GROUP BY` group, `HAVING BOOL_OR(gap)`) for any
  epoch in `[min(baseEpoch), activeEpoch - 1]` with no row, ERROR, one line, newest hole first so a
  new one is not buried behind the known permanent ones. The floor is the oldest RETAINED commit,
  because `pruneExpiredCommitLog` trims from the bottom and a trimmed floor is not a hole (the same
  distinction `getCommitsSince` makes with `belowFloor`/`gapAt`). Unlike `getCommitsSince`, which only
  names a hole when a lagging device asks across it, this names it the hour it exists.
- **Not a counter on the fanout, and why that is covered.** The backlog also asked for a counter of
  sends undecryptable by construction. Today the one such class the server can see - an application
  frame from a device whose membership is not `active` - is **refused** (`403 sender_not_active`, in
  `sendMessage`) and the refusal already logs at ERROR, `[SEND][trace] REJECT sender_not_active
  group= device= status=`, once per refused send. A refused send writes **no row**, so its count
  cannot be derived from durable state, and a new in-process counter would reset on every deploy -
  a clock-and-memory stand-in for a log line that already accuses. The other half of the original
  incident class, frames emitted between a device's own commit and its acceptance, is the client's
  `epochSendBarrier` and the server has no fact distinguishing those frames. So the evidence for
  both is the ERROR line plus this report's rate line (the churn that makes them fire).

### A silent reader learns its seat from the groups list (additive, 2026-10-04)

`reportStrandedDeviceMemberships` names the population; `recoverRosterDisagreement` repairs the
device that tries to SEND (the refusal is its proof). A device that holds the tree and never sends
produces no evidence, so the fact travels on the read every device already makes on every connection:
`GET /api/mls/users/:userId/groups` carries `deviceMembership` on each row - `{ status, welcomeQueued,
addInFlight, admitted }` for the device named by the `X-Canari-Device` header (the same self-asserted
header the other device-scoped reads use), or `null` when the header is absent (an older client) or
the device has no row. `welcomeQueued` / `addInFlight` are the two facts of
`GET /device-memberships/...`, read by ONE helper (`utils/pending-membership-facts.ts`, two queries
for the whole set); `admitted` is `admittedAtEpoch IS NOT NULL` - a commit admitted the device and its
Welcome is owed, a window the add lock does not cover on every path. The row is `[USER_GROUPS] ...
stranded=N` on the log when any seat is pending with all three false. Client side:
[mls-recovery-ladder](../protocols/mls-recovery-ladder.md#a-silent-reader-is-handed-to-the-roster-repair-by-the-groups-list).

### An invitation-link ask is announced to every online member, and so is its outcome (2026-10-25)

`utils/join-ask-announce.ts` is the one place both frames are built. The audience is every `active`
device row of every ADMITTED seat (`ADMITTED_SEAT`, so an awaiting seat never hears another's ask),
minus the asker. Each device gets ONE Redis script (`publishIfAddressable` with `JOIN_ASK_CAPABILITY`,
`services/addressing.ts`) that checks the presence key (`devicePresenceKey`, the one implementation,
shared with `messaging.service.ts`) and that every live session declared `join-ask-1` - read from the
gateway's twin hash `addressing:join-ask:*` (`JOIN_ASK_PUBLISH_LUA`), never from the history value,
which stays what every shipped chat-delivery compares whole - and publishes in the same call; all
devices go concurrently. A retired replica finishes the join-ask work in flight when its drain reaches
`beforeExit` (`finishJoinAskWorkInFlight`, a fixed set read once - never work started later), and the
stale-pending cron is ONE tracked unit from its first read (`trackJoinAskWork`), so a SIGTERM during
it cannot leave an ask expired unannounced. A publish that never returns is bounded by the release's
own drain (`ROLLING_DRAIN_SECONDS`), not by a timer here. The commit door takes the asks it admitted
as soon as its transaction commits, so a later step that throws cannot lose their announcement. A device with a session that did not declare it - a build
older than these frames - gets nothing, so it never logs a frame no handler took. Each frame goes out
on the generic control path (`chat:messages`, `isWelcomeRequest: true`, `proto` = the JSON frame,
`requiresCapability: 'join-ask-1'`), which the gateway delivers only to sessions holding it.

Every frame carries `askId`, the awaiting seat's row id - the ask's identity, which the client settles
by ([mls-protocol](../protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23)); the pending sweep
rows and the roster rows of an awaiting seat carry it too.

- `group.join_ask` from `acceptGroupInvite`, after the seat is written, beside the existing
  `welcome_request` to ONE elected device (that election now only answers a member's own devices);
- `group.join_ask.settled` with `outcome: 'declined'` from `declineJoinRequest` on `withdrawn` only
  and from `removeGroupMember` on an awaiting seat removed by someone else; `withdrawn` when the asker
  removes their own awaiting seat; `expired` for each seat `expireUnansweredAsks` deletes; and
  `admitted` after the transaction in which `liftAwaitingAdmission` cleared a flag commits - the
  commit door and the Welcome door, which return the asks they lifted, so a second Add announces
  nothing.

Announcing is fire-and-forget (`dispatch`, tracked so `joinAskAnnouncementsSettled()` can await it in
tests): no caller awaits it, so no HTTP answer waits on Redis, and the commit door announces in its
`finally`, after the commit lock is released.

An offline member gets nothing and learns it at its next sweep (`GET mls/invitations/pending`); a
failed publish is logged `[JOIN_ASK]` at WARN and changes no outcome. The log is
`[JOIN_ASK] ANNOUNCED|SETTLED ... devices=N`. Client side and the race it settles:
[mls-protocol](../protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23).

### A fulfilled invitation is retired by whoever can PROVE it, and a vouch does not replay

`getPendingInvitations` serves every `pending` row in the caller's groups, and the caller's first
question about each is whether the Add is already done. It answers that from its own MLS tree
(`leafIsInLocalTree`, in `frontend/src/lib/utils/chat/actions.ts`), because the routing table
answers a different question and a fresh-started device clears its routing rows while its leaf sits
in the ratchet tree.

**Until 2026-09-15 that answer was thrown away.** A leaf found in the tree was skipped - correctly,
since re-Adding it inflates the epoch, invalidates the queued Welcome and starts a kick/re-add
churn - and the `pending` row was left exactly as found. So every member of the group re-derived
the same answer on every sync, for ever. Production on 2026-09-15 held **104 pending rows across 47
groups and 55 devices, 98 of them older than a day and 19 of them thirteen days old**, and one
client's startup trace spent 25 of its 31 invitations printing `already in tree - skip`.

The endpoint that retires a row had authorised this since it was written - *"any active member of
the group vouches that another user's device is already in the shared MLS tree ... it only stops
`getPendingInvitations` from re-serving a device provably already in the tree every sync"* - and no
caller was ever written for it. The authority argument holds precisely: the same local tree read is
**already** trusted for the more dangerous decision, which is not to Add. Vouching risks nothing
the skip does not. It is best-effort and re-driven; a refusal leaves the row pending and the next
sync says it again, which is what every sync did before.

The two callers of `status: 'active'` - a device reporting on ITSELF, a member VOUCHING that the
leaf is in the tree - used to differ on one flag: only the self-report replayed the pending window
(DF2), because only it fixes a moment the device could decrypt from. DF2 is deleted (2026-09-28),
so both now make the same call through the one writer; `invitations.controller.vouch.spec.ts` pins
that, and that a non-member may do neither.

### A revoked device id does not come back for ten years

`DELETE /mls/devices/:userId/:deviceId` purges the device footprint **and** writes a
`revoked_device` row. The client deliberately restores the *same* device id after a reinstall
(`resolveDeviceId` reads `localStorage`, then `push_context.json`) - so the denylist and
re-registration meet on every reinstall of a deleted device.

The ban lapses after `DEVICE_REVOCATION_TTL_MS` (10 years, 2026-08-13). That is hygiene, not a
security parameter: a table that only ever grows is one nobody can reason about, and an identifier
retired a decade ago has no hardware left to come back on. **The bound is applied at the QUESTION,
not by the purge** - `activeRevocationWhere` at all six sites that ask "is this device banned" - so
a lapsed row stops banning whether or not `cleanupExpiredRevocations` has run; the daily job only
reclaims space. If the purge were what enforced it, a service that failed to run it would go on
banning devices it had promised to release and nothing would say so.

The write-side lookup in `deleteDevice` is deliberately NOT filtered by the window: it asks "have I
already got a row for this device", which has no age, and filtering there would insert a duplicate
the unique constraint rejects. Re-revoking refreshes `revokedAt`, so a device banned, un-banned and
banned again is banned from today - a second, deliberate revocation must never be born expired.

### A deleted device is told at once, and erases itself

The denylist is the DURABLE half of a revocation and would be met at the device's next login anyway.
It is not the immediate half, and a device its owner has just declared lost keeping a live session
until then is the wrong answer to what they asked. So `deleteDevice` also calls
`notifyDeviceRevoked`, which publishes a `device_revoked` control frame on `chat:messages` addressed
to that `userId:deviceId`. **No gateway change was needed**: `isWelcomeRequest` is that path's
generic "relay this base64 JSON to the device" flag and the inner `type` is what drives the client.

On the client, `onDeviceRevoked` fires and **confirms the revocation against the server before
destroying anything** - `GET /mls/devices/:userId/:deviceId/revoked`, over the authenticated
channel. A frame is a message, not an authority, and a total wipe is a destructive control. That
check answers `false` when it cannot reach the server, so a transport failure can never erase a
device: a status code is an answer, a transport failure is not.

Confirmed, the device is returned to a fresh install by `wipeDeviceToFactory` - MLS state, local
databases, cached responses, every stored preference, and the biometric key - then signed out. Three
steps in a fixed order: tear the session down, revoke the refresh cookie while the network context
still exists, then delete everything local, so nothing still running can write a key back after the
wipe. `IStorage.close()` exists for this: `deleteDatabase` does not fail on an open connection, it
BLOCKS, and a wipe that completes at some later moment nobody controls is not one you can assert on.

This is the immediate half only. A device that is offline when it is deleted learns at its next
login, from the denylist, exactly as before.

`registerDevice` therefore refuses a revoked id with **403 `{ code: 'DEVICE_REVOKED' }`**. Before
that check existed, registration succeeded and the device was then filtered out of `getUserDevices`
and resolved to a `null` KeyPackage by `resolveKeyPackagePayloadForDevice` - registered, absent from
its own device list, never invitable to a group, with no error surfaced anywhere. That silent state
was [WP-DEV-PANEL-1](../../../CLAUDE.md).

The client answers the refusal by becoming a new device: `BaseMlsService.generateKeyPackage` catches
the typed `DeviceRevokedError` and calls `rotateDeviceIdentity`, which mints a fresh id, reloads
empty MLS state, persists it, and deregisters the abandoned id. Retried exactly once - a second
refusal is a server bug, not a state to keep rotating through. The MLS credential is
`userId:deviceId`, so a new id *is* a new device: local history is gone and every group must
re-invite it. That is the intended cost of a revocation being real.

## Refusal codes - one stable name per refusal a member can act on (2026-10-19)

A refusal's `message` is dev-facing English and a client never shows or branches on it. What it keys
on is the body's `code`, from ONE registry per service (`src/utils/refusal-codes.ts` here,
`src/common/refusal-codes.ts` in core-service; `refusalBody(code, message, extra)` builds the body),
and it words the code through Paraglide in `frontend/src/lib/utils/refusalCodes.ts`
(`describeRefusalCode(refusalCode(error))`). `refusalCodes.test.ts` reads both registries and fails
when a code is neither worded nor declared `TYPED_ELSEWHERE_CODES`. Codes are additive: the old
`message` text stays beside the code, so an older client reads what it always read and no shim exists.
A code is a contract - a rename is a new code plus the old one kept until `minClientVersion` drops
every client that reads it. Social-service keeps its own table ([social-service](social-service.md)).

| Service | Code | Status | Raised when | Worded on |
| --- | --- | --- | --- | --- |
| delivery | `DEVICE_REVOKED`, `DEVICE_LIMIT_REACHED`, `KEY_PACKAGE_IDENTITY_INVALID`, `KEY_DISTRIBUTION_GROUP` | 403/400 | already coded before this pass | typed flows, never a sentence |
| delivery | `USER_BLOCKED` | 403 | a block stands between two people (add, call) | call and add-member screens, neutral |
| delivery | `NOT_A_MEMBER` | 403 | invite link, roster read or notification setting on a conversation the caller is not in | share link, panel |
| delivery | `MEMBERSHIP_NOT_ALLOWED` | 403 | a non-member changes a roster | add-member |
| delivery | `INVITE_INVALID` | 404 | unknown, expired or revoked invitation | `/g/join/[token]` |
| delivery | `INVITE_NOT_A_GROUP` | 400 | invite link requested for a 1-to-1 | share link |
| delivery | `NO_ACTIVE_DEVICE` | 400 | the joiner has no usable key package | `/g/join/[token]` |
| delivery | `PIN_INCORRECT` | 403 | wrong current PIN, or the lost compare-and-swap | PIN change |
| delivery | `PIN_NOT_SET` | 400 | PIN change on an account with no PIN | PIN change |
| core | `BLOCK_SELF`, `BLOCK_TARGET_NOT_FOUND`, `BLOCK_LIMIT_REACHED` (+`max`), `NOT_BLOCKED` | 400/404/422/404 | the block list | settings, blocked people |
| core | `ADMIN_SELF_DEMOTE` | 403 | an administrator removes their own right | no screen calls it yet |
| core | `USER_SEARCH_FILTER_REQUIRED`, `USER_SEARCH_TOO_LONG` (+`max`) | 400 | the directory with no filter, a search past 200 characters | `/directory` |

`MAINTENANCE`, `ACCOUNT_ERASURE_PENDING` and `ACCOUNT_ERASURE_BLOCKED` were coded in
`auth.controller.ts` earlier and are worded by the sign-in screen. **Not coded, on purpose:** header
and shape validation (`Missing X-User-Id`, `ids must be ...`: a client bug, not a member's), shared-secret
guards, push-token and link-preview failures (no screen words them), calls (held off, dev builds only),
Lydia payment errors (the paid half waits for WP-LYDIA-1), and anything in social-service, account
erasure, lives or reels.

## Routes

All routes are under `/api/mls/*` or `/api/calls/*` and require `X-User-Id` (injected by Nginx) unless noted.

### Device management

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/register-device` | Register static key package for a device |
| POST | `/api/mls/register-device/prekeys` | Bulk-upload one-time prekeys |
| PATCH | `/api/mls/devices/:userId/:deviceId/metadata` | Update device name/OS/version |
| GET | `/api/mls/devices/:userId/:deviceId/key-package` | Get a consumable key package |
| GET | `/api/mls/devices/:userId/:deviceId/signature-keys` | Every MLS signature key the device ever published (Graine v2 endorsements) |
| GET | `/api/mls/devices/:userId` | List all registered devices for a user |
| GET | `/api/mls/devices/:userId/:deviceId/revoked` | Is this device denylisted (gates the wipe) |
| GET | `/api/mls/devices/:userId/:deviceId/prekeys/count` | Count remaining OTKPs |
| GET | `/api/mls/devices/:userId/:deviceId/prekeys/list` | List published prekey IDs |
| POST | `/api/mls/devices/:userId/:deviceId/prekeys/prune` | Delete targeted orphaned prekeys |
| DELETE | `/api/mls/devices/:userId/:deviceId/prekeys` | Purge all prekeys for a device |
| DELETE | `/api/mls/devices/:userId/:deviceId` | Delete device and all its data |

**WHAT A 400 MEANS HERE, AND WHY TWO OF THESE ROUTES STOPPED USING ONE (2026-09-15).** The device
cap makes 400 a load-bearing code in this controller: `POST /api/mls/register-device` refuses an
account over `MAX_DEVICES_PER_USER` with a 400 carrying `code: DEVICE_LIMIT_REACHED`, and that 400
is **terminal** - no retry lifts it, the account has to lose a device first - where every 5xx and
every other 400 is retryable. A client must be able to tell those apart without reading prose, so
each extra meaning folded into 400 costs that classification something.

Two routes were folding "the row is not there" into it. `GET .../key-package` did so against its own
docblock, which promises *"only revoked / missing devices 404"*; `PATCH .../metadata` answered
`Device not found` the same way. Both are `NotFoundException` now, which is the same rule the link
preview cache states below for a different reason - **only an answer may be a 400** - applied to a
request that was never malformed. The statuses are pinned by
`devices.controller.not-found.spec.ts`, which carries the empty-metadata-body case as its control:
that one IS the caller's fault and keeps its 400.

**A KEY PACKAGE MUST NAME THE DEVICE UPLOADING IT, AND ITS SIGNATURE KEY IS KEPT FOR EVER
(2026-09-29, Graine v2).** Both upload routes read every package's clear leaf
(`utils/key-package-leaf.ts`, on `utils/mls-tls.ts`, the one RFC 9420 varint reader
`mls-frame-epoch.ts` also uses). The batch is refused whole, with a 400 carrying
`code: KEY_PACKAGE_IDENTITY_INVALID` and a `[DEVICE_KEY] REFUSED` line at ERROR, if any package does
not parse or if its BasicCredential identity is not `userId:deviceId`. Such a package would be added
to a group as someone else, and until then nothing looked. **It was measured before it was refused**:
every stored package on both estates, 38 525 in production over 870 devices and 38 177 in dev over
857, parsed, named its uploader, and carried the one key of its device. So no shipped client can hit
this 400, and like the others it is not classified.

Each key read is appended to `device_signature_key` (migration 027, unique on
`(userId, deviceId, signatureKey)`, never updated) BEFORE the packages are stored, so a failure
fails the upload and the client's retry re-sends it. `GET .../signature-keys` serves that history
plus the key in the device's CURRENT static package, so no backfill is needed. It answers `{keys}`,
oldest first, and an empty list rather than a 404. It is for a member checking a relayed Graine v2
seed's endorsement once the minter's device has left the tree
([channel-encryption §21.3](../protocols/channel-encryption.md#213-the-data-model-carries-the-minter-and-its-key-wp-g2-3)).
Any authenticated caller may read it, like `key-package`, which already serves the same bytes.


### Group management

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/groups` | Create group record |
| GET | `/api/mls/groups/:groupId` | Get group metadata |
| PATCH | `/api/mls/groups/:groupId` | Rename group (admitted member; never a key-distribution group) |
| PATCH | `/api/mls/groups/:groupId/image` | Set/clear group avatar (admitted member; never a key-distribution group) |
| DELETE | `/api/mls/groups/:groupId` | Soft-delete group (admitted member; never a key-distribution group) |

**A ROUTE KEYED BY A GROUP ID ASKS THE GROUP, NOT ONLY THE LOGIN (2026-10-25).** `HeaderAuthGuard`
says who is asking; `assertCallerActsOnGroup` (`utils/group-membership.ts`) says whether that person
may act on THIS group, and is the one check the group's metadata and lifecycle routes, the add-lock's
two doors and the device-membership deletions share. An admitted member passes - any member, as the
conversation panel offers rename, photo and delete to every member; a caller with no seat (never a
member, removed, or the group absent or tombstoned) gets the 403 `NOT_A_MEMBER`, the same for an
unknown and a known id; a seat awaiting admission gets the 409 `awaiting_admission`. A key group
answers from its active device rows (`standingOnGroupOfKind`, which `memberOfGroupKind` also reads).
A tombstoned group is read as absent by its `deletedAt`, never inferred from the purge of its seats,
so a replayed delete is the 403 the client's owed-exit drain reads as done. Two narrower rules sit on
top: rename, photo and delete-for-everyone refuse a key-distribution group to EVERY caller (403
`KEY_DISTRIBUTION_GROUP`, after the membership check, so a stranger still reads `NOT_A_MEMBER`) -
its lifecycle is the internal `mls/distribution-groups` routes'; and a member ending ANOTHER user's
device row may end only a row that is not `active` (the pending invitation the group cannot honour),
and never one in a key-distribution group. The condition rides the delete itself (`status <> 'active'`),
after the queue's delete, so the statements keep the one delete order of `utils/seat-eviction.ts` -
locking the device row first would invert it and can deadlock; a row left behind is active and is the
403 `MEMBERSHIP_NOT_ALLOWED`, whose rollback restores the Welcomes. The pending list a member's client
sweeps (`GET mls/invitations/pending`) names conversations only, never a key-distribution group. Pinned by `groups.controller.authz.spec.ts` and `addLock.onePolicy.spec.ts`.

### Membership

| Method | Path | Description |
|---|---|---|
| GET | `/api/mls/users/:userId/groups` | List user's groups |
| GET | `/api/mls/users/:userId/dismissed-groups` | List dismissed group IDs |
| POST | `/api/mls/users/:userId/dismissed-groups` | Mark group as dismissed |
| DELETE | `/api/mls/users/:userId/dismissed-groups/:groupId` | Un-dismiss group |
| POST | `/api/mls/groups/:groupId/members` | Add member record to group |
| GET | `/api/mls/groups/:groupId/user-members` | Get user-level members |
| GET | `/api/mls/groups/:groupId/exclusions` | Exclusion windows of every current member, for history answers ([history-reconciliation](../protocols/history-reconciliation.md#a-remove-holds-against-a-later-re-add---the-answering-peer-withholds-the-window-decided-by-the-user-2026-10-14)); current members only |
| POST | `/api/mls/group-rosters` | User-level rosters of up to 200 groups in one read (`{ rosters, refused, revoked }`) |
| GET | `/api/mls/groups/:groupId/members` | Get active device members |
| DELETE | `/api/mls/groups/:groupId/members/:userId` | Remove user from group |

#### Many rosters in one read - `POST /api/mls/group-rosters` (2026-10-13)

**Why.** Every connection compares each held conversation's tree with its roster (`removeStrayLeaves`,
the collection of a leaver's leaf) and read the rosters one `GET user-members` at a time: 81 in
series, 5.0 s, on the 2026-10-12 production console
([startup-load-audit](../frontend/startup-load-audit-2026-10-12.md), finding 5).

**What.** Body `{ groupIds: string[] }`, at most `GROUP_ROSTERS_MAX_GROUPS` = 200 (mirrored in
`mlsDeliveryApi.ts`, which chunks by it). Answer `{ rosters: { [groupId]: userId[] }, refused:
groupId[] }`, from ONE `dm_group_members ... WHERE groupId IN (...)` query. **The authorization is
the single read's, per group**: a group the caller holds no roster row in - or that does not exist -
is listed in `refused` instead of failing the request, so a refusal and a nonexistent group read
alike; a global admin is answered for every group. **An absent `x-user-id` is NOT a wildcard here**,
unlike `assertCallerIsGroupMember`: `HeaderAuthGuard` refuses it first anyway, and a route reading
many rosters at once does not carry a branch that would hand every one of them to a caller nobody
identified. No display names: nobody reading rosters in bulk asks for them.

**Compatibility, and no second path.** The single `GET .../user-members` is unchanged and is still
what every other caller reads (membership guards, peer resolution). A client meeting a server
without the route (a store build ahead of the production deploy) gets a 404, logs one `[ROSTER]
batch ... not answered` warning per connection, and **removes nobody** in those groups until the
server deploys - the direction the sweep already fails in. It deliberately does NOT read each roster
on its own instead: that would be a fallback silent the day the batch broke, and on a failing
network the very storm the batch removed. So nothing is registered on
[legacy-compatibility](../legacy-compatibility.md): there is no shim to retire. **Deploy the server
before the client** (a pre-release does both in one run).

**What keeps the batch sound** (client, `strayLeaves.ts`): every TREE is read before the rosters,
so a leaf joining after the read is in no tree this pass compares and is never a candidate. The
batch roster is as old as the start of the pass, and a removal by user id takes EVERY leaf of that
user - so a member who left before the batch read and rejoined after it would lose the fresh leaf
with the stale one. **The batch therefore only says which groups need no work**: a group it names a
stray in is decided again - its tree, then its single `GET user-members`, then the diff - right
before the commit, which puts the roster-to-commit window back at the one round trip the per-group
read had. That extra read is paid only by a group holding a stray.

**Measured.** Same server build, same scratch database (81 groups of 9 members among 18 729 rows),
loopback, 7 rounds: 81 serial `GET` **182 ms** median [168-240] against one `POST` **4 ms** [3-5]
(first round 164 ms, cold), identical rosters. That is the server and database half only; the
production cost is the round trips (81 x ~62 ms on the console above), which the batch replaces by
one. Pinned by `members.controller.group-rosters.spec.ts` (one query, refusal per group) and
`strayLeaves.test.ts` (one roster read for every held group, after every tree; a leaver who
rejoined after the batch read is spared).

**And the revoked devices of each roster (2026-10-22).** The answer carries `revoked`: per ANSWERED
group, the `userId:deviceId` of every active revocation (`activeRevocationWhere`) among that group's
roster users, read in ONE `revoked_device` query over every answered user. A refused or unanswered
group names nobody. The client removes exactly those leaves
([mls-protocol](../protocols/mls-protocol.md#a-revoked-devices-leaf-is-removed-from-every-conversation)).

### Messaging

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/send` | Send MLS message/commit (publishes to Redis, queues for offline devices); answers `receivedAt`, the `Date` written into every queued copy's `createdAt` ([history-reconciliation](../protocols/history-reconciliation.md#a-remove-holds-against-a-later-re-add---the-answering-peer-withholds-the-window-decided-by-the-user-2026-10-14)) |
| POST | `/api/mls/commit` | Validate commit epoch + store in commit-log + fan out (one atomic call). An optional `groupInfo` carries the external-join base for the epoch the commit CREATES; it is written with the epoch advance in one transaction, so a joiner can never leave the base behind (COMM-22). A RESUBMISSION of the exact bytes the log already holds at that base epoch from the same device is answered `{ accepted: true, duplicate: true }` with nothing advanced or fanned out again - how a committer whose first answer was lost learns the outcome ([mls-protocol](../protocols/mls-protocol.md#the-periodic-leaf-refresh)). A device under an active revocation is refused `403 DEVICE_REVOKED` before the lock and before that duplicate answer, read by the pair on the denylist's `(userId, deviceId)` unique index ([mls-protocol](../protocols/mls-protocol.md#a-revoked-devices-leaf-is-removed-from-every-conversation)) |
| GET | `/api/mls/commits/:groupId?sinceEpoch=N` | Rung-1 replay: ordered commits to catch up a lagging device |
| GET | `/api/mls/group-info/:groupId` | Latest GroupInfo for external-join (membership-gated) |
| POST | `/api/mls/group-info/:groupId` | Refresh stored GroupInfo (membership-gated, monotonic) |
| POST | `/api/mls/welcome` | Deliver Welcome message to a device |
| POST | `/api/mls/welcome-request` | Broadcast welcome_request signal |
| POST | `/api/mls/sender-mismatch` | A client reporting that a frame's envelope named another sender than the one MLS verified - logs `[SENDER_MISMATCH]`, stores nothing ([channel-encryption §21](../protocols/channel-encryption.md#21-graine-v2-an-author-that-is-proven-a-ciphertext-bound-to-its-place---decided-by-the-user-2026-09-28)) |
| POST | `/api/mls/history/batch` | Get message history batch, **at most 50 groups** (response carries `heads`, one stream head per group) |
| GET | `/api/mls/history/:groupId?after=&until=&limit=` | Incremental Redis Stream history; head in `X-History-Head` |
| GET | `/api/mls/messages/:userId/:deviceId` | Fetch queued messages for device |
| POST | `/api/mls/messages/ack` | Acknowledge received messages |
| POST | `/api/mls/notify-reaction` | Fire-and-forget reaction push |

**A history walk is bounded by the head it was given.** `until` is an INCLUSIVE upper bound used as
the `XRANGE` end in place of `+`; the head is read (one `XREVRANGE ... COUNT 1`) only when the caller
supplies none, so a walk pays for it once and never per page. It exists because the stream holds every
frame *including the ones still queued for live delivery*, so an unbounded walk reads the rows the
queue is about to hand over and both paths present the same ciphertext to MLS - see
[history-reconciliation](../protocols/history-reconciliation.md#the-exchange). A malformed `after` or
`until` is dropped rather than rejected: a client that has lost its place gets the unbounded read it
would have had with no cursor, not a 500 it cannot act on.

**The batch cap is a contract with the client, and it is not on the wire.** `history/batch` refuses
more than `HISTORY_BATCH_MAX_GROUPS` (50) with a 400, and the client chunks at a constant of the same
name in `frontend/src/lib/mls-client/mlsDeliveryApi.ts`. Neither side asks the other what the number
is, so the two are pinned by `messaging.history-bound.spec.ts` on this side and by
`mlsDeliveryApi.history.test.ts` on the other, each naming the file that has to change with it.
Until 2026-08-24 the client sent its whole conversation list in one request and *learned the cap by
being refused*: measured on production with 110 conversations, that was one 400 followed by a
sequential re-fetch of all 110 - exactly the cost the route exists to remove, paid by every client
past fifty conversations, and reported only as a `console.warn` carrying the bare status. A chunk
refused now leaves its groups unprimed and says so with the server's own words; the replay reads
those groups' first pages itself, which is the path every group took before the route existed.

### Invitations / device sync

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/groups/:groupId/invites` | Create shareable invite link |
| GET | `/api/mls/group-invites/:token` | Preview group invite |
| POST | `/api/mls/group-invites/:token/accept` | Accept group invite |
| GET | `/api/mls/invitations/pending/:userId/:deviceId` | Get pending invitations |
| GET | `/api/mls/device-memberships/:userId/:deviceId` | Get device memberships |
| POST | `/api/mls/invitations/status` | Upsert DeviceGroupMembership status |
| POST | `/api/mls/kick-stale-user` | Reset all devices for a user to pending |
| POST | `/api/mls/kick-stale-device` | Reset single device to pending |
| DELETE | `/api/mls/device-memberships/:userId/:deviceId/:groupId` | Delete specific membership (own device; an admitted member of the group may end another user's row only while it is not `active`) |
| DELETE | `/api/mls/device-memberships/:userId/:deviceId` | Delete all device memberships (own device) |
| POST | `/api/mls/groups/:groupId/force_leave` | Force device exit from group |

### Push notifications

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/mls/push/register` | JWT | Register/refresh FCM push token (+ iOS `voipToken`: a token, or `null` from a build without the native ring, which clears it) |
| DELETE | `/api/mls/push/unregister/:deviceId` | JWT | Unregister push token |
| GET / PUT | `/api/mls/notification-preferences` | JWT | The account's switched-off notification categories (`{ disabled: string[] }`); PUT replaces the set and refuses an unknown id |
| GET | `/api/mls/push/fetch-proto` | PushSecret | Fetch proto for background push service |
| GET | `/api/mls/push/avatar/:targetUserId` | PushSecret | Get avatar URL for notification display |
| GET | `/api/mls/push/media/:mediaId` | PushSecret | Proxy encrypted media ciphertext (2 MB cap) for a notification thumbnail |
| POST | `/api/mls/push/channel-read` | PushSecret | A shut phone's "Mark as read" on a SALON notification: forwarded to social-service's internal read-mark route ([social-service](social-service.md)); 403 when the user cannot read the salon, 502/503 when social-service refuses or is down |
| POST | `/api/mls/push/refresh-token` | PushSecret | Refresh FCM token and/or PushKit `voipToken` |
| POST | `/api/mls/push/membership-active` | PushSecret | Mark membership active after push-triggered add |
| POST | `/api/mls/push/acquire-add-lock` | PushSecret | Acquire add-lock from background service |
| DELETE | `/api/mls/push/release-add-lock` | PushSecret | Release add-lock |
| GET | `/api/mls/push/key-package` | PushSecret | Get key package for background service |
| POST | `/api/mls/push/commits` | PushSecret | Replayable commits since `sinceEpoch`, for the in-memory catch-up of a device whose app is killed |
| POST | `/api/mls/push/send-welcome-and-commit` | PushSecret | Send Welcome + commit from background service. **`baseEpoch` and `commitPayload` are both REQUIRED**, and both reach `validateCommit`, which records the commit, stores its Welcome in the same transaction, fans the commit out and delivers the Welcome from its row. **The answer is typed** ([background Welcome](#the-background-welcome-answers-what-happened-and-the-stage-is-merged-only-on-an-acceptance-2026-10-22)): `201 {status: 'accepted', newEpoch}`, or `409 {status: 'rejected', reason, currentEpoch?}` with `reason` one of `epoch_mismatch`, `concurrent_commit`, `not_a_member`, `welcome_target_unknown`, `welcome_target_not_member` |
| POST | `/api/mls/push/key-group-base` | PushSecret, then 64 per user per minute (`PushSecretGuard` -> `PushSecretThrottlerGuard`, 429) | A shut phone's read of a KEY GROUP's scope and external-join base, for the join from a salon push ([channel-encryption section 26](../protocols/channel-encryption.md#26-a-shut-phone-joins-a-salons-key-group-from-the-push---decided-by-the-user-2026-10-22)). 403 not a key group or not entitled, 503 entitlement unanswered; `welcomeOwed` instead of a base when a Welcome is queued or the add lock is held |
| POST | `/api/mls/push/key-group-join` | PushSecret, then 64 per user per minute (429, its own bucket) | That phone's external commit into the key group. External commits into key groups only (400 / 403 otherwise), then `validateCommit` unchanged; admits, removes and excludes are not taken here |
| POST | `/api/mls/push/send` | PushSecret | Send message from background service |
| POST | `/api/mls/push/broadcast-test` | JWT | Test push to all devices of caller |
| POST | `/api/mls/push/unavailable` | JWT | A device reporting that it CANNOT obtain a push token (writes nothing - see below) |

#### A device that cannot get a push token at all

**`POST /api/mls/push/unavailable`, and it deliberately stores nothing.** A client that exhausts its
registration retries without ever holding a token POSTs `{deviceId, platform, reason}`; the
controller sanitises the three, logs
`[PUSH_UNAVAILABLE] user=<uuid> device=<id> platform=<android|ios> reason=<reason>` at WARN, and
returns `{recorded: true}`.

**Why a report and not a row.** `push_token` already owns the state of a device's push chain, one row
per `(userId, deviceId)`; a second table saying "this one has no row" would be a second source of
truth for a fact the first table already carries, and would go stale the moment the device recovers.
What was missing was never storage - it was that **the absence of a row is indistinguishable from a
device nobody opened.** Measured 2026-08-27: 49 `android` rows, zero `ios` rows ever, no message
alert or CallKit ring deliverable to an iPhone for the platform's entire life, and nothing anywhere
said so, because the client's only witness was a `console.warn` in a WebView console that cannot be
opened on iOS from a Windows machine. The healthy platform's rows stood in for both.

**The reason is the client's classification and the server never rewrites it.** `no-token` (the OS
never produced one) and `rejected` (the token existed and the backend refused the registration) are
different defects with different owners, and a server that normalised an unrecognised value into a
known one would delete the only evidence that a client had learnt something the server has not been
taught. Unknown reasons are printed verbatim, capped at 120 characters; a missing reason prints
`unstated`, never an empty field.

**It is reported ONCE, at the end.** An early attempt can fail for a reason the next one fixes -
which is what the retry ladder exists for on slow Android token generation - so reporting one of
those would file a defect against a device that goes on to work. `PushNotificationService` therefore
returns a typed `PushRegistrationOutcome` rather than a boolean, and only the exhausted ladder
reports. Tests: `push.controller.unavailable.spec.ts` (server, including that it writes nothing) and
`PushNotificationService.unavailable.test.ts` (client - in its own file, because `pushAttempted` is
module state that latches).

#### Transport — single gateway (FCM)

Both platforms are delivered through **Firebase Cloud Messaging**; there is no direct
APNs provider in the backend. For each `PushToken`, `MessagingService` issues one
`getMessaging().send()` carrying **only the half that token's platform reads**:

- an Android token gets the `data` map — read by `onMessageReceived` (fires foreground **and**
  background) — plus an `android` block (`priority: high`, 24 h TTL);
- an iOS token gets the `apns` block alone, shaped by `buildApnsRequest` in `push-payload.ts`,
  which spreads the same fields into a self-contained APNs payload.

**Why it is split, and it was not until 2026-08-30.** Every message used to carry both blocks, so
the ciphertext travelled **twice** in one message - and FCM sizes the MESSAGE, not the half the
device will read. On the shape that failed: `data` 3 789 B + `apns` 4 005 B = **7 794 B against a
4 096 B limit**, for a proto the guard had passed. That refused ten pushes in one run, to one
Android device, twice over (2026-08-29 and 2026-08-30, `Message is too large. The maximum is 4K`).
FCM ignores the `apns` block for an Android token and the `data` map is redundant for an iOS one,
so nothing was gained by sending both. `push-payload.spec.ts` pins the arithmetic, including the
case where each representation alone fits and their sum does not.

**The inline-ciphertext budget is computed from the fields, never chosen ahead of them.** The guard
was `Buffer.byteLength(protoB64) <= 3_500` applied to the ciphertext ALONE, under a comment
correctly stating the 4 KB budget belongs to the payload - so it bounded a quantity strictly
smaller than the one the limit is about. `inlineProtoBudget` now builds the payload with an empty
proto, measures **both** representations and leaves what the tighter one allows: the APNs framing
plus its `aps` block costs about 216 B more than the raw data map, and one payload is built for all
of a user's devices. What it protects against is `senderName` and `groupName`, which are unbounded
user text that nothing upstream caps. A proto that does not fit is not an error - the client fetches
the ciphertext instead - but it is logged, because a budget routinely too small is the fixed fields
growing and nothing else watches them.

A size refusal now logs `[PUSH_SIZE]` naming what was actually sent, both representations and the
largest single field: FCM's own error names no quantity at all, which is why ten identical refusals
said only "too large".

##### WHAT THE PAYLOAD TELLS GOOGLE, AND THE HALF THAT STOPPED (2026-09-22)

The MLS ciphertext protects what was SAID. Everything around it is cleartext to FCM, and to APNs for
an iOS token: `groupId` and `queuedMessageId`, `senderId`, the `silent` / `isWelcome` /
`isGroup` / `isKeyDistribution` flags, `createdAt` - and, until this date, `senderName` and
`groupName` on every frame. **Those last two are the only unbounded USER TEXT in the payload**: a
real student's display name and a conversation's title.

**A silent frame draws nothing, so nothing read them there**, measured on both clients:

- the Android service returns out of `onMessageReceived` before any notification is built. The one
  decision it does take on a silent frame - the cross-device dismissal - reads `groupId`, `senderId`
  and `silent` and nothing else. The only other reader was a `Log.d` line;
- the iOS NSE is **not woken at all**. It runs on `mutable-content: 1` ALERT pushes, and every
  silent frame is sent `content-available: 1` / `apns-push-type: background`.

At least **28% of queued frames are commits** (4 082 of 14 493 rows on production, 2026-09-22),
before counting read receipts, own-device copies and Graine seeds, which are silent too. So the two
keys are now **absent** - not empty, because FCM counts key names as well as values - on any frame
with `silent: true`, and the bytes they freed go to the inline ciphertext. `push-payload.spec.ts`
pins both directions, and the one consumer that will want them back is listed with the switches that
revive calls ([calls](../frontend/modules/calls.md)).

**What still travels, and is not a defect to be fixed quietly.** A VISIBLE message still carries both
names, because they are what the banner draws before anything is decrypted, and the APNs
`alert.title` is `senderName || groupName` - what an iPhone shows when the extension cannot run. That
is a genuine trade: removing it costs a user the ability to tell who a notification is from when
decryption fails. It is recorded here rather than left implicit, so the next reader knows the
remaining disclosure is a decision and not an oversight.

#### The one sentence this server still composes, and the column that tells it the language

Every other sentence on the push path is written BY the device: `push-content.ts` sends
`contentKey` + `actorName` + `contentArg` and the native tables build the wording, precisely because
the server cannot know who is reading. **One sentence cannot follow that rule** - `APNS_FALLBACK_BODY`,
the `alert.body` of a visible MLS message push. It is what an iPhone shows when the Notification
Service Extension does not run or cannot decrypt, and in that state the device has composed nothing.
It was `'Nouveau message'`, hard-coded, for every user in every language.

**So the language is CARRIED to the decision rather than guessed at it.** `push_token.locale`
(migration `020`) is written by `POST /mls/push/register` from `getLocale()`, the app's own choice -
the same fact `push_context.json` already mirrors natively for the NSE. `buildApnsRequest` takes it
and picks from a two-entry table; null reads as the base locale, and so does a tag the table does not
know, because refusing a registration over a language would cost the device every notification to
spare it one word.

**Two things this cost, and neither was visible from the column alone.**

- **The client's skip predicate had to be re-visited.** `registerPushToken` skipped the POST when the
  FCM token was unchanged - and `changeLocale` reloads the document while `sessionStorage` survives a
  reload, so the one registration that exists to record a language change is exactly the one that
  would have been skipped. The stored value is now `<token>|<locale>`: a skip key, not a token, and
  `stopPushService` reads it for presence only. Adding a second discriminator means re-visiting every
  predicate that tested the first.
- **The inline-ciphertext budget is one number for devices that may read different languages.** It is
  computed once per message, the ciphertext it admits is chosen once, and only then is the payload
  built per device - so a per-device body must never be able to make a payload larger than the one
  the budget measured. `inlineProtoBudget` sizes on `LONGEST_FALLBACK_LOCALE`, derived from the table
  rather than typed, so adding a language can only ever make the budget tighter. `push-payload.spec.ts`
  pins it by filling a payload to the budget and asserting every language still fits; sizing on the
  short language instead fails three of its tests.

**Why not an APNs `loc-key`, which looks cleaner.** It would need no column at all: iOS resolves it
against the app's own `Localizable.strings`, in the device's language. It is a REGRESSION today. iOS
shows the RAW KEY when a `loc-key` does not resolve - it does not fall back to `body`, so sending
both does not help - and `notif.message.encrypted` entered `canari_iOS/*.lproj` only on 2026-08-15
(`e3593d4e`) while the NSE has existed since 2026-07-21. A build from that window would show the
literal text `notif.message.encrypted` on precisely the path this is meant to fix. It also reads the
DEVICE's language, where everything else here reads the in-app Canari locale.


FCM applies the `android` block to Android tokens and **relays the `apns` block to Apple's
APNs** for iOS tokens, using the APNs `.p8` auth key uploaded in the Firebase console
(Project Settings → Cloud Messaging → APNs Authentication Key). Visible iOS pushes carry
`mutable-content: 1` so a Notification Service Extension can decrypt and rewrite the alert
(until that extension ships, the generic fallback title/body is shown); silent frames carry
`content-available: 1`, mirroring the Android data-only push. iOS clients register their
**FCM** token (not a raw APNs device token) via `/api/mls/push/register` with `platform: "ios"`.

**One send, two payload builders.** Every push leaving this service goes through
`MessagingService` and carries an `apns` block: `buildApnsRequest` shapes the MLS one,
`buildInternalApnsRequest` the non-MLS one (community channel messages and their silent
`channel_read` frames, posts, form reminders — everything arriving from social-service on
`POST /api/internal/push/notify`). That endpoint **delegates to `sendPushToUser` and sends nothing
itself**: it used to hold a second copy of the send loop, identical minus the `apns` block, and FCM
turns a message with no `apns` block into a data-only push — never surfaced by iOS, never handed to
the NSE. Every salon message, post, form reminder and cross-device read frame was therefore dropped
by every iPhone while the endpoint answered `sent` (fixed 2026-08-16; `internal.controller.push.spec.ts`
asserts the block on the message that actually reaches FCM, because `push-payload.spec.ts` had
covered the builder field by field and none of it applied to a caller that never called it).

**Which iOS process a push reaches is decided here.** `mutable-content: 1` (alert) runs the
Notification Service Extension; `content-available: 1` (background) is meant for the app
(`canari_push.mm` `CanariHandleBackgroundFrame`, an allowlist of dismissals since 2026-10-17 -
before that the hook taking it was never installed, see
[mobile](../frontend/mobile.md#silent-frames-reach-the-app-through-a-method-canari-adds-2026-10-17))
and never goes to the extension. So a silent type such as `channel_read` is acted on by the app
alone, and listing one in the NSE's switch is a branch that cannot execute.

**The alert's `sound` names a palette-A trill** (`IOS_NOTIFICATION_SOUND`, bundled in the app and
the extension, [sounds](../frontend/sounds.md)): the "message" trill on an MLS alert (a `mentions`
frame stays soundless and the extension sets the "mention" trill once it reads a mention); on an
internal alert, the trill of the Android channel the same push lands on - a salon message "mention"
or "message" by the per-recipient `mentioned`, a message reaction "reaction", and posts, comments and
forms the system default (`canari_social`, `canari_forms`). `frontend/src/lib/mobile/channelPushFields.test.ts` pins both directions across the
seam.

**Client config & build:** the Firebase client config files are gitignored and injected by CI
from secrets — `GOOGLE_SERVICES_JSON` (Android → `google-services.json`) and
`GOOGLE_SERVICE_INFO_PLIST` (iOS → `canari_iOS/GoogleService-Info.plist`). The iOS Firebase
SDK is pulled via **Swift Package Manager** (not CocoaPods). The APNs↔FCM token bridge relies
on Firebase's App Delegate Proxy (`FirebaseAppDelegateProxyEnabled`, which must stay enabled).
The iOS `aps-environment` entitlement is `production` for TestFlight/App Store builds.

#### iOS background execution

Android drains the pending MLS state from an expedited `MlsBackgroundWorker` (WorkManager). The
iOS peer is a **`BGProcessingTask`** (`fr.emse.canari.cleanup`, listed in
`BGTaskSchedulerPermittedIdentifiers`): its launch handler is registered in `canari_ios_bootstrap`
(before `UIApplicationMain`, as `BGTaskScheduler` demands) and runs
`canari_native_cleanup_pending_db` to clear `mls_pending.db`. A request is re-submitted on every
background entry (`willResignActive`) and after each run, but iOS decides when — there is no
guaranteed cadence.

**Force-quit is terminal on iOS:** once the user swipes the app away, iOS delivers **no** silent
`content-available` data pushes and runs **no** `BGTask` until the app is manually relaunched. This
is a platform constraint with no workaround; visible (`mutable-content`) alert pushes still arrive
and wake the (future) Notification Service Extension, so the user is never fully silenced, but
background state-sync only resumes on next open. Android has no equivalent restriction.

#### Notification quick actions (reply / mark as read)

Both platforms attach two inline actions to an MLS message notification (never on a `channel_`
conversation - channels are server-authoritative, no MLS outbox to route through): "Repondre"
(text input) and "Marquer comme lu". Both fire while the app is fully killed - Android via a
`BroadcastReceiver`, iOS via a brief OS relaunch to deliver `didReceiveNotificationResponse`.

Since the TS runtime that normally builds an `AppMessage` proto isn't running, a minimal
dependency-free protobuf encoder (`mobile::proto_fields::build_text_app_message` /
`build_read_receipt_app_message` in `frontend/src-tauri/src/mobile/proto_fields.rs`) is exposed
identically to Android JNI (`nativeBuildTextMessageProto`/`nativeBuildReadReceiptProto` on
`CanariFirebaseMessagingService`) and iOS FFI (`canari_native_build_text_message_proto`/
`canari_native_build_read_receipt_proto`). Both actions reuse the existing outbox-drain path
unchanged: the built proto is appended to the `outbox_pending.ndjson` mirror and drained
immediately via the same `drainOutboxBackground`/JNI-or-FFI encrypt + `/api/mls/push/send` call
the background welcome-join/decrypt flows already use.

- **Reply** queues a plaintext `TextMsg` entry (`silent: false`) and only clears the notification
  once the drain actually delivers it (0 remaining) - a queued-but-undelivered reply keeps the
  notification so the user can retry from the app.
- **Mark as read** clears the notification immediately (visible feedback), then best-effort sends
  a silent `SystemMsg{event:"read_receipt"}` (`silent: true`) covering every messageId cached for
  that conversation in `fcm_message_cache.ndjson`. This is cross-device sync only - a peer/sibling
  device receiving that silent push cancels its own notification (existing read-state-sync path);
  this device's local unread-badge/readBy state is not reconciled and self-corrects next time the
  conversation is opened in-app.
- Android: `CanariNotificationActionReceiver.kt` (`ACTION_QUICK_REPLY`/`ACTION_MARK_READ`
  broadcasts). The outbox/notification helpers it shares with `CanariFirebaseMessagingService` live
  in that service's companion object, taking an explicit `Context` param (a bare
  `CanariFirebaseMessagingService()` instance is Context-unsafe - `Service` extends
  `ContextWrapper`, and `attachBaseContext` is never called on a manually-instantiated one).
- iOS: `CanariRegisterNotificationCategories`/`CanariHandleQuickReplyAction`/
  `CanariHandleMarkReadAction` in `canari_push.mm`, wired into `CanariNotificationDelegate`'s
  `didReceiveNotificationResponse`.
- iOS gotcha: the action buttons only appear when the delivered notification carries
  `categoryIdentifier == "canari_message_category"`. The app-alive path stamps it in
  `CanariShowLocalNotification`, but when the app is fully killed the NSE
  (`canari_NSE/NotificationService.swift` `applyMessageContent`) is the ONLY path that builds the
  visible alert, so it must stamp the same id too (MLS DM/group only) - the backend APNs payload
  does not send `aps.category`. iOS retains the category the app registered across termination, so
  the stamp is enough.
- Gotcha: the outbox mirror rewrite (both platforms) must persist the `silent` flag on every
  write, or a control event that survives one failed drain attempt loses its silent flag on retry
  and resends as a visible push.

#### App-icon unread badge

The launcher/home-screen badge mirrors the number of **distinct unread conversations** (not
messages). It is driven entirely off the currently displayed message notifications, so it moves up
on push receipt and down on read-state cancel with no separate counter to keep in sync.

- **Android** (`CanariFirebaseMessagingService`): `countUnreadConversations` counts the active
  message notifications (excluding the group summary and the pending-sync nudge), and
  `refreshBadgeSummary` rebuilds the group summary carrying that count via `setNumber(count)` (or
  cancels the summary when it hits 0). It is the single source of truth for both the summary and the
  badge, called after every message notification post (`showNotification`) and every cancel
  (`cancelConversationNotification`); `cancelAllMessageNotifications` clears the summary and thus the
  badge on app open. **THE COUNT IS CORRECTED BY THE CALLER, AND THAT IS NOT AN OPTIMISATION** -
  see [the banner its own badge refresh cancelled](#the-banner-its-own-badge-refresh-cancelled---fixed-2026-09-21). Numeric badges are honored by stock Android / Pixel / recent OEM launchers;
  some older launchers only show a dot (no third-party ShortcutBadger dependency).
- **iOS** has two writers because the badge owner depends on process state:
  - App alive (`canari_push.mm`): `CanariUpdateAppBadge` recomputes from the delivered chat
    notifications and calls `setBadgeCount` (iOS 16+) / `applicationIconBadgeNumber`, after
    `CanariShowLocalNotification` (message threads only) and both cancel paths
    (`CanariCancelConversationNotification`, `CanariPushCancelMessageNotifications`).
  - App killed (`canari_NSE/NotificationService.swift`): the extension writes `content.badge`
    directly (no `UIApplication` in an extension) via `applyBadgeCount`, counting the delivered chat
    conversations plus the incoming one.
  - Both count a conversation by its per-conversation `threadIdentifier` (NSE deliveries, WP-iOS-7)
    or the stable request id (app-alive deliveries, both now use per-conversation `groupId` as
    `threadIdentifier` since WP-XP-7) - both are unique per conversation - and gate on a
    `fr.emse.canari://chat` deep link so social/form notifications never count.

#### Rich media notifications (image/GIF thumbnail)

An image or GIF message shows its decrypted thumbnail inside the notification, on both platforms and
while the app is fully killed (WP-XP-3). Scope is **images + GIF only**: video/audio keep the existing
text preview (`📷 Photo` / `🎥 Vidéo` ...). This is the MLS DM/group path only - community channels
keep their text preview.

Because media is end-to-end encrypted (the media service stores only opaque AES-256-GCM ciphertext,
the CEK/IV live inside the MLS message), the native notification builder must fetch and decrypt the
blob itself:

1. **Decrypt metadata**: the shared Rust parser `extract_full_message_info` (`proto_fields.rs`) now
   emits `mediaId` + base64 `mediaKey`/`mediaIv` + `mimeType` alongside `mediaKind` for a `MediaMsg`.
   These ride the same decrypt JSON both platforms already parse.
2. **Fetch ciphertext**: a killed app has no user JWT, so the blob is pulled through a new
   PushSecret-authed proxy `GET /api/mls/push/media/:mediaId` (chat-delivery), which relays it from
   media-service's server-to-server `GET /api/media/internal/:id` (X-Internal-Secret gate). A **2 MB
   cap** (matching client-side send compression) keeps videos and oversized blobs out - above it the
   proxy returns 413 and the native side shows the text-only notification.
3. **Decrypt blob**: a new leaf FFI decrypts the ciphertext with the CEK, reusing the channel AES-GCM
   path (`background::decrypt_media_blob`). Android JNI `nativeDecryptMedia(keyB64, ivB64, ciphertext)`
   returns the plaintext bytes; iOS C-ABI `canari_native_decrypt_media(..., out_len)` returns a heap
   buffer freed with `canari_free_bytes`. The plaintext (original image bytes) never transits the
   server or FCM.
4. **Attach**:
   - **Android** (`CanariFirebaseMessagingService.fetchAndDecryptMedia`): writes the decrypted image
     under the FileProvider-mapped cache dir (`cacheDir/tauri/notif_media/`, 24 h sweep) and attaches
     it inline via `MessagingStyle.Message.setData(mime, contentUri)` - preserving conversation
     stacking + quick actions. NotificationManager grants SystemUI read access to the content URI.
   - **iOS** attaches a `UNNotificationAttachment` from a decrypted temp file. Since iOS shows only the
     first image attachment as the banner preview, the **media thumbnail outranks the sender avatar**
     (avatar is used only for text/non-image). App alive: `canari_push.mm`
     `CanariFetchAndDecryptMedia` → `CanariShowLocalNotification`. App killed:
     `canari_NSE/NotificationService.swift` `fetchAndDecryptMedia` → `attachImage`.

Gotcha: only `mediaKind == "image"` (which also covers GIF, mime `image/gif`) is rendered; the
extension budget (~30 s) and the 2 MB cap bound the background download + decrypt.

#### Boot/relaunch re-registration (WP-XP-4)

An FCM token can rotate while the phone is off; `onNewToken` only fires on **change events the
process observes**, so a rotation missed during downtime leaves the backend pushing to a dead
token until the app is manually opened. Outbox messages queued before a reboot wait just as long.

- **Android** — `CanariBootReceiver` (manifest receiver, `BOOT_COMPLETED` +
  `MY_PACKAGE_REPLACED`, `exported="false"` — both are protected system broadcasts; requires
  `RECEIVE_BOOT_COMPLETED`). On fire (`goAsync` + wake lock + worker thread, like
  `CanariNotificationActionReceiver`):
  1. Force-reads the current FCM token (`Tasks.await(FirebaseMessaging.getInstance().token)`),
     persists it (`fcm_token.txt` + prefs) and re-registers it on the backend via the PushSecret
     endpoint `POST /api/mls/push/refresh-token`
     (`CanariFirebaseMessagingService.refreshTokenOnBackend`, now a companion function). The
     backend refresh is unconditional — even an unchanged token heals a server-side entry that
     expired while the device was off.
  2. Drains the outbox mirror through the shared `drainOutboxBackground` path (which also warms
     the MLS state via the JNI). Skipped silently when the device is not enrolled
     (`push_context.json` / pushSecret absent).
  `BOOT_COMPLETED` is delivered post-unlock, so credential-encrypted storage is available.
- **iOS** — no OS boot hook exists, and the equivalent CANNOT be a launch-time fetch. Until
  2026-08-28 `canari_push.mm` `CanariPushSetup` called `tokenWithCompletion` at the bottom of
  `canari_ios_bootstrap()`, as the declared mirror of Android's step 1 - but FIRMessaging cannot mint
  an FCM token before an APNs token exists, and that only arrives after
  `registerForRemoteNotifications`, which the same bootstrap schedules for `DidFinishLaunching`. That
  call could only ever fail. The equivalent is now `CanariSyncFcmTokenIfApnsReady()`, called from
  `CanariOnDidBecomeActive`: it returns with a line if `[FIRMessaging messaging].APNSToken` is nil,
  otherwise it fetches, persists and refreshes on the backend. `didBecomeActive` fires after launch
  completes and on every foreground, so first-open-after-reboot is still covered - see
  [mobile](../frontend/mobile.md#the-fcm-token-an-iphone-could-never-obtain-and-the-silence-that-hid-it-for-the-platforms-life).

CI guard: `src/lib/mobile/androidFcmManifest.test.ts` fails if the receiver, its actions, or the
`RECEIVE_BOOT_COMPLETED` permission are dropped from the manifest (e.g. by `tauri android init`).

#### Priority notifications - calls & @mentions (WP-XP-5)

Incoming calls ring like real phone calls and @mentions break through the normal notification
tier, on both platforms, app killed included.

**Ring signal - why an explicit endpoint.** The server cannot read MLS ciphertexts, so it cannot
tell a call invite apart from a text message. Instead the **caller's client** POSTs
`/api/calls/ring` (JWT) right after sending the MLS `CallMsg` invite - which is now sent
**silent**, like all call signaling (invite/answered/hangup), killing the old generic
"Nouveau message de X" push for call traffic. The backend verifies membership and fans out
per member token:

- **Android** → high-priority FCM data `{type: "call_ring", groupId, callId, callerId,
  callerName, senderName, groupName, hasVideo}`. `senderName` is a legacy alias so old builds
  show a normal "message" notification instead of nothing.
- **iOS with a `voipToken`** → **direct APNs VoIP push** (`ApnsVoipService`) - the single
  deliberate exception to the all-FCM rule, because FCM cannot carry `apns-push-type: voip`
  and only a VoIP push may wake CallKit from a killed state. ES256 provider JWT (cached 40 min)
  over node:http2, topic `<bundle>.voip`, `apns-expiration` = the ring's answer deadline; a 410
  response clears the stored `voipToken`. The payload carries ids and the deadline, never a name,
  and is sent only while the ring is live; without the APNs key such a device is not rung (ERROR,
  no FCM alert instead) - [calls](../frontend/modules/calls.md#the-native-ring-on-the-iphone---pushkit-and-callkit-wp-c6-owner-2026-10-22).
- **iOS without `voipToken`** (legacy builds) → FCM alert banner ("📞 Appel entrant").

`/api/calls/ring-end` (reason `answered`/`cancelled`/`ended`) is sent to **all** members
including the caller's own devices and stops the ring everywhere; both platforms also arm a
local 60 s timeout as a safety net. Ordering gotcha: `call_ring_end` must be processed **before**
the foreground guard on both platforms - a stale ring must clear even if the user has since
opened the app.

- **Android** (`CanariFirebaseMessagingService`): channel `canari_calls` (IMPORTANCE_HIGH,
  ringtone audio attributes, `setBypassDnd`). `showIncomingCallNotification` builds a
  `NotificationCompat.CallStyle.forIncomingCall` (API 31+; two-action fallback below) with
  full-screen intent (`USE_FULL_SCREEN_INTENT`), `FLAG_INSISTENT` looping ringtone,
  `CATEGORY_CALL`, 60 s `setTimeoutAfter`. Answer = deep link
  `fr.emse.canari://chat/<groupId>?acceptCall=<callId>&video=<0|1>`; decline = local dismiss
  broadcast (`ACTION_CALL_DECLINE` - group decline only means "stop ringing me").
  `activeCallRings` dedupes the explicit `call_ring` against the MLS invite push
  (`call_invite` typed extraction is the fallback ring for pre-WP-XP-5 callers).
- **iOS** (`canari_push.mm`): PushKit `PKPushRegistry` delivers the VoIP push;
  `CanariReportIncomingCall` **must** report a CallKit call immediately (Apple contract -
  missing it terminates the app). Answer cannot start audio directly (MLS/WebRTC live in the
  webview behind the PIN): `performAnswerCallAction` writes `pending_call_accept.json` + fires
  the accept deep link; the TS store `pendingCallAccept` drains it
  (`read_and_clear_pending_call_accept`) and `CallService` auto-accepts when the matching MLS
  invite arrives over WS post-unlock. The CallKit session is ended (`AnsweredElsewhere`) on
  `didBecomeActive` - handover to the in-app call UI. The PushKit token is persisted to
  `voip_token.txt` and registered via `/api/mls/push/register` (`voipToken` field) and rotations
  via `/api/mls/push/refresh-token`.
- **@mentions**: for an MLS message, native detection = decrypted text contains `@[<myUserId>]`
  (case-insensitive; userId from `push_context.json`) - the server cannot read the message, so the
  device has to look. **A CHANNEL MESSAGE IS TOLD INSTEAD**: it carries the sender's cleartext
  `mentionedUserIds`, so the social-service computes `mentioned` per recipient (the same fact that
  honours the `mentions` level) and all three handlers read it since 2026-08-16 - the only answer
  that still works when the ciphertext was too large to inline and there is no text to scan. Both
  paths then land in the same place: Android posts on `canari_mentions` (IMPORTANCE_HIGH,
  `setBypassDnd`; posted-notification channel switches require cancel-then-notify). iOS sets
  `interruptionLevel = .timeSensitive` (app-alive path and NSE), which needs the
  `com.apple.developer.usernotifications.time-sensitive` entitlement - without it iOS silently
  downgrades to `.active`.
- **NSE** (`NotificationService.swift`): `call_invite` → ringtone + time-sensitive banner with
  the accept deep link; `call_control` with `callEnded` → blank passive content + removes any
  delivered notification whose `userInfo["canariCallId"]` matches.

#### Unified rich notification grouping (WP-XP-7)

One conceptual notification model shared across both platforms: per-conversation stacking, a
group summary, avatar/initials fallback, and sender-name subtitles inside group chats.

**Per-conversation stacking**

- **Android** — `NotificationCompat.MessagingStyle` already stacks successive messages of the same
  conversation into a single notification since the initial implementation. Each conversation gets a
  stable `notifId` (`getStableNotifId(groupId)`); rebuilding from the active notification (bounded to
  `MAX_NOTIF_MESSAGES = 6`) preserves history across pushes. All conversation notifications carry
  `.setGroup(GROUP_KEY_MESSAGES)` so Android bundles them under one expandable group.
- **iOS** — two paths, unified under the same `threadIdentifier = groupId` model:
  - **App killed** (`NotificationService.swift`): the NSE already set per-conversation
    `threadIdentifier` (WP-iOS-7), so successive pushes from the same groupId stack naturally.
  - **App alive** (`canari_push.mm`): `CanariShowMessageNotification` previously passed the flat
    `@"canari_messages"` thread for every chat notification — successive messages overwrote each
    other regardless of conversation. Now it passes `groupId` as `threadIdentifier` (fallback
    `@"canari_messages"` when empty), mirroring the NSE. Social/form notifications keep their own
    threads (`canari_social`/`canari_forms`).

**Reactions to a post** (2026-10-08): both platforms group them per POST. Android keeps one
notification per post updated in place; iOS files them under the APNs thread `post_reaction_<postId>`
(`buildInternalApnsRequest`). Detail and what iOS still lacks: [mobile](../frontend/mobile.md#the-face-on-a-notification-and-what-happens-when-there-is-none).

**Group summary**

- **Android** — `refreshBadgeSummary` builds a group-summary notification (`.setGroupSummary(true)`)
  on `GROUP_KEY_MESSAGES` every time a message notification is posted or cancelled. The summary
  carries the unread-conversation count via `.setNumber(count)` which also serves as the launcher
  badge (WP-XP-2). When the count hits 0 the summary is cancelled.

##### The banner its own badge refresh cancelled - FIXED 2026-09-21

**A SALON NOTIFICATION WAS BUILT AND THE SHADE STAYED EMPTY FOR 120 SECONDS**, on a phone that had
decrypted the push correctly. Measured on hardware by `NOTIF-18`
([board](../cross-client-testing.md)).

`NotificationManager.notify` and `cancel` hand the record to `system_server` over a binder queue
and return; `activeNotifications` is a SECOND binder call, answered from whatever has already been
processed. `countUnreadConversations` read it microseconds after the post and answered 0 about the
notification that had just been posted. `refreshBadgeSummary` then took its `count == 0` branch and
cancelled the group summary - **and cancelling a group summary cancels that group's children, the
ones still ENQUEUED included**. The banner died between being built and being posted.

Nothing in the app could see it. It logged a successful `showNotification: notifId=N` and finished;
only the OS said otherwise, with `NotificationService: Cannot find enqueued record for key:
0|fr.emse.canari|N|...`. *A correct mechanism with no report is found by hand, a day late* - this
one had no report at all, and the row that found it had to be taught to read the other process's log.

It is ONE defect in two directions, and the second arms the first. On a CANCEL the same stale read
runs the other way: `activeNotifications` still holds the conversation that was just cancelled, the
count is one too high, and the summary survives its own last child. That leftover summary is
exactly what the post-side branch then cancels - with a child of its own attached.

The fix is that neither caller asks a layer that has not caught up about a record it moved itself:
`refreshBadgeSummary(context, justPosted, justCancelled)` carries the id forward, and
`countUnreadConversations` adds or removes it from the set it counts. A reaction passes nothing -
it is deliberately not part of the messages bundle. *Never learn by failing what a fact could have
told you.*
- **iOS 15+** — `UNMutableNotificationContent.summaryArgument` is set to the conversation title
  (group name for groups, sender name for DMs, `"Canari"` fallback). The system shows this text in
  the stacked-notification group summary line. Set by both paths:
  - App alive: `CanariShowLocalNotification` (new `summaryArgument` parameter).
  - App killed: `NotificationService.swift` `applyMessageContent`.

**Subtitle (group chats)**

- **Android** — `MessagingStyle.Message` already carries the sender `Person` object, so the sender
  name is shown inline with each stacked message.
- **iOS** — `UNMutableNotificationContent.subtitle` is set to the sender name inside group
  conversations (when `isGroup && senderName` is non-empty). Both the app-alive path
  (`CanariShowLocalNotification` new `subtitle` parameter) and the NSE path
  (`applyMessageContent`) set it. Flat DMs already have the sender as the title, so no subtitle is
  set.

**App-open cancel**

When the app opens, `CanariPushCancelMessageNotifications` now clears every delivered chat
notification — both the legacy flat-thread ones and the new per-conversation ones — by checking
the `deepLink` prefix (`fr.emse.canari://chat`) in addition to the `threadIdentifier`.

#### Shared deferred-retry engine (WP-XP-8)

When the opportunistic outbox drain (FCM push, Welcome join, boot receiver) leaves messages unsent
(network down, server unreachable), a shared deferred-retry engine automatically retries with
exponential backoff on both platforms.

- **Android** — `OutboxRetryWorker` (WorkManager): expedited one-shot work request with exponential
  backoff (30s → 60s → 120s …). After 3 consecutive failures it enters a persistent failure state
  and shows the "open the app" nudge (`showPendingSyncNotification`). The flag resets when the user
  opens the app (`MainActivity.onResume`). A foreground guard defers retry when the TS outbox
  flusher is active (avoids double-send).
- **iOS** — `BGTaskScheduler` handler `fr.emse.canari.outboxRetry`: `BGProcessingTaskRequest` with
  `requiresNetworkConnectivity = YES`. The handler drains the outbox mirror and re-submits the
  request on failure so a window always stays queued. Unlike Android WorkManager, iOS
  BGTaskScheduler offers no guaranteed cadence — the "open the app" nudge (`CanariShowPendingSyncNotification`)
  remains the safety net. The existing cleanup handler (`fr.emse.canari.cleanup`) is unchanged.

Both platforms trigger the retry from the same seam: `maybeNotifyPendingSync` /
`CanariMaybeNotifyPendingSync` — when the opportunistic drain leaves `remaining > 0`, it shows the
nudge AND schedules the next automatic retry. This closes the "Foreground/background service"
parity row.

### Security / PIN

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/security/pin-check` | Check/register PIN verifier (PBKDF2) |
| GET | `/api/mls/security/pin-status/:userId` | Check if PIN is registered |
| POST | `/api/mls/security/pin-change` | Change PIN verifier |
| POST | `/api/mls/security/pin-reset` | Reset PIN (purge devices, keep memberships) |
| GET | `/api/mls/link-preview` | Fetch safe external URL preview |
| GET | `/api/mls/link-preview/image?url=` | Proxy a preview's `og:image` or favicon |
| GET | `/api/mls/link-safety?url=` | Google Safe Browsing verdict for a URL (WP-SAFELINK-1) |
| GET | `/api/mls/gifs?q=&page=` | The GIF picker's search/trending, asked of KLIPY by the server with `KLIPY_API_KEY`; per-user throttled; the query reaches no log line, nginx's access line included ([chat](../frontend/modules/chat.md#the-gif-search-goes-through-canari-2026-10-16)) |
| GET | `/api/mls/gifs/media?url=&t=` | The GIF relay: one GIF from KLIPY's CDN only (no query), streamed, 12 MiB, byte-cached 24 h, single-flight, 16 in flight (`busy` 503 beyond), 600/min per address; gated by the day-long `gifTicket` the ticket route also returns; query dropped from this repo's nginx log, NOT from the host nginx's or the edge's ([chat](../frontend/modules/chat.md#the-gif-relay-no-readers-browser-asks-klipy-for-a-gif-2026-10-18)) |

#### Who carries the MiGallery key, and who does not

One rule, decided on 2026-08-17: **an image is public and needs no key, a metadata read does.**

`fetchMiGalleryPreview` calls `/api/albums/:id/info` with `MIGALLERY_API_KEY`, because that
endpoint stays gated for private albums - it is the only credentialed call to MiGallery in this
service. Cover images are not: MiGallery serves `/cover` (square) and `/og-cover` (wide) publicly
for every visibility, since an external site embeds one from an `<img>` tag, which carries no key.
They go through the ordinary `/api/mls/link-preview/image` proxy like any other preview image -
which is also the only path with the SSRF guard and the content-type check.

A second, key-carrying `/api/mls/gallery-cover/:albumId` proxy existed until then, from when covers
were gated. Deleting it is what makes the rule true rather than aspirational: with two doors to one
site, which credential applied depended on which field of the payload the client happened to read.

#### Link preview is a user-controlled server-side fetch (SSRF)

`/api/mls/link-preview` takes a URL from a chat message and fetches it from inside the cluster, so
`utils/url-guard.ts` is what stands between a pasted link and the internal network. Two barriers,
because one is not enough:

- **`assertSafeExternalUrl`** rejects non-http(s) schemes, embedded credentials, `localhost`, and
  any host that DNS-resolves to a non-public address. Redirects are handled manually
  (`redirect: 'manual'`, 3 max) and each hop is re-validated - an allowed host that answers `302
  http://127.0.0.1/` is the obvious bypass otherwise.
- **`ssrfSafeDispatcher`** re-checks at connect time through undici's `lookup`, so the IP the
  socket reaches is the IP that was validated. This closes the DNS-rebinding window: the two
  resolutions are separate events and an attacker-controlled zone can answer differently.

**The dispatcher and the `fetch` that carries it must come from the same undici copy**, which is
why every call site goes through `ssrfSafeFetch` rather than passing `dispatcher:` to the global
`fetch`. Node bundles its own undici behind the global `fetch`; handed an `Agent` built from the
`undici` package, it throws `InvalidArgumentError: invalid onRequestStart method` before opening a
socket - the two copies disagree on the dispatch handler interface. That mismatch broke *every*
non-YouTube preview in production after the undici major bump, and it was invisible because `fetch`
reports it as a bare `TypeError: fetch failed` and the handler answered a generic
`Link preview failed`. The failure is now logged (`[LINK_PREVIEW] <host> failed: <cause>`), and
`url-guard.spec.ts` pins the pairing offline: a fetch to `localhost` must fail with `ESSRFBLOCKED`
(our lookup ran) and nothing else.

#### One fetch per page per six hours, not one per reader per render

`TtlCache` (`utils/ttl-cache.ts`) is a bounded map with a per-entry TTL and LRU eviction, and
`SecurityController` holds two static instances of it: 500 previews and 200 proxied images.

| | TTL | why |
|---|---|---|
| preview, success | 6 h | Open Graph tags change on the scale of an edit, not of a render |
| preview, refused (400) | 10 min | the site ANSWERED something unusable - a 404, a non-HTML body, a page over 1 MB, a redirect to a private address. A fact about this URL, and re-downloading the page to rediscover it is what the cache exists to stop |
| preview, **unreachable (502)** | **never** | not a fact about the URL at all |
| proxied image | 6 h | and only when the body is <= 256 KB - a favicon is asked for constantly and costs a kilobyte, a full-size `og:image` would evict a hundred of them to save one request |

**ONLY AN ANSWER MAY BE CACHED, AND ONLY AN ANSWER MAY BE A 400.** Both halves were wrong until
2026-08-16 and they compounded: a Wikipedia connect timeout was stored as a refusal and replayed as
`400` - *your request was malformed* - to every reader for ten minutes, for a page that answered
normally six minutes later (`cache hit ... ok=true`, same log). The distinction is carried by a TYPE,
`UpstreamUnreachableError`, thrown where the failure happens rather than recovered from a message at
the top: every outbound call inside `resolveLinkPreview` goes through its `reachOr` wrapper, so
"the site said something unusable" and "the site said nothing" cannot be confused by the handler.
An unexpected error - a parser fault, a bug in this file - is neither cached nor blamed on the
caller: it is a `500`, logged at `error`.

**One budget, and every mechanism that can enforce it agrees.** `OUTBOUND_BUDGET_MS` (4 000 ms) arms
the endpoint's `AbortController` for the whole operation - redirect chain and oEmbed follow-up - AND
the dispatcher's `connect.timeout`, `headersTimeout` and `bodyTimeout` for each individual leg.
There used to be two: the stated 4 s abort, and undici's untouched 10 s defaults, which is the one
that actually fired (`ConnectTimeoutError ... timeout: 10000ms`). A stated budget that is not the one
that fires is a comment, not a rule. `fetchYouTubeOEmbed` was outside both - no signal reached it at
all, on the FIRST outbound request the preview path makes - and it now takes the same signal.

The endpoint answers cached entries with a matching `Cache-Control: public, max-age=`, which is the
only way to stop the browser asking at all. Before this, every render of every message re-downloaded
the remote page: a conversation scrolled back through hammered a site that never agreed to any of
it, and each of those requests announced that somebody was reading.

The cache is per-process, and deliberately so - chat-delivery runs as a single instance, so a shared
store would be infrastructure bought for nothing. Replicating the service costs hit rate, never
correctness, which is what makes the choice reversible.

#### Link safety is its own endpoint, deliberately not a field on the preview (WP-SAFELINK-1)

`/api/mls/link-safety?url=` answers `{ unsafe: boolean }` from Google Safe Browsing's Lookup API
(`utils/safe-browsing.ts`), gating navigation client-side through `confirmUnsafeLinkIfNeeded`
(`frontend/src/lib/utils/checkLinkSafety.ts`), which only shows a confirmation (`showConfirm`,
danger-styled) at the point of an actual click on a flagged link - never a badge decorating every
rendered link, which would be alert fatigue for a check that is almost always going to say "fine".

**The gate lives in `openExternal()` (`frontend/src/lib/utils/openExternal.ts`), not in the two
components that render a link.** It shipped there first (`AppLink`/`LinkPreviewCard` each gating
their own bubble-phase `onclick`), which worked on the web and was silently dead on every Tauri
build: a document-level CAPTURE-phase listener installed by `hooks.client.ts`, pre-existing since
April for unrelated in-app-link routing, already intercepts and `stopPropagation()`s the same click
before it reaches the anchor, and opens the URL through `openExternal` directly. Moving the check
into `openExternal` itself - the one function every path to an actually-opened URL calls, including
that interceptor and the conversation's shared-links tab (which had no check on any platform) -
means no future caller can bypass it by forgetting to call `confirmUnsafeLinkIfNeeded` first. See
[durable-rules](../durable-rules.md#mobile-and-native---frontendmobile).

- **A separate endpoint from `getLinkPreview` on purpose.** The two checks have unrelated failure
  modes: a page with a broken `<title>` or a redirect loop makes `getLinkPreview` throw and return
  nothing at all. Folding the safety verdict into that response would have taken it down with the
  metadata fetch, and `AppLink` cares only about the verdict, never about whether the site also has
  good Open Graph tags.
- **No SSRF guard needed for the Safe Browsing call itself** - unlike the preview fetch, the target
  of this request is always Google's own fixed endpoint; the caller-supplied URL only ever appears
  as a JSON string in the POST body, never as something this service connects to. `assertSafeExternalUrl`
  is still run first, same as the preview endpoint, since the URL has to be validated before being
  used as a cache key either way.
- **Fails OPEN at every layer** - no `GOOGLE_SAFE_BROWSING_API_KEY` configured, a network error, a
  timeout, or a non-2xx response from Google all resolve to "not flagged". A safety check that
  cannot answer must never become an outage for every link in the app; the config-side warning
  (`::warning::GOOGLE_SAFE_BROWSING_API_KEY is not set...` in `serve-prod.yml`) is the only trace of it.
- **Cached in its own `TtlCache<boolean>`**, independent of `previewCache` for the reason above.
  Google gives no cache guidance for a clean verdict (only a flagged match carries its own
  `cacheDuration`, e.g. `"300s"` - the longest one wins when several matches disagree), so a clean
  result gets a conservative 30-minute TTL chosen here; a failed lookup gets 5 minutes, short enough
  that a transient outage or a bad key self-heals on the next request rather than silently
  disabling the check for as long as a real answer would be trusted.
- **Client-side dedup, not a client-side TTL**: `checkLinkSafety` keeps a `Map<string, Promise<boolean>>`
  for the page's lifetime so `AppLink` and `LinkPreviewCard` asking about the same URL around the
  same time produce one request, not two - freshness across page loads is entirely the server
  cache's job.

#### Preview images are proxied, so the site never sees the reader

`/api/mls/link-preview/image?url=` fetches an image server-side and relays it. The card used to
point an `<img src>` straight at the remote host, so every reader of a message opened a connection
to a third party **from inside an end-to-end encrypted conversation**: the site learned each
reader's IP, their user agent, and the moment they scrolled to the message. Encrypting the body and
then fetching its illustration in clear gives a good part of that back.

- Same SSRF guard as the page fetch - the URL is caller-supplied, so it is exactly as
  attacker-controlled as the pasted link. Redirects are *followed* here rather than walked by hand
  (a CDN answers image requests with two or three), which is safe because `ssrfSafeDispatcher`
  re-validates at every connect.
- `image/*` only, **SVG excluded**: an SVG is a document that can carry script, and it would be
  served from our own origin. `X-Content-Type-Options: nosniff` on the way out.
- 3 MB ceiling, checked on `content-length` *and* on the received body, because the header can be
  absent or wrong.
- **Gated by a ticket rather than a guard, since 2026-09-10** - the URL goes into an `<img src>`, so
  the browser carries no `Authorization` header and `HeaderAuthGuard` would refuse every mobile
  reader. `utils/previewTicket.ts` is minted by an authenticated call and carried in `&t=`. What
  being unauthenticated bought anybody, measured, was an image proxy: 5 430 bytes of a Google
  favicon relayed on Canari's address with no session.

Client-side the rewrite is one helper, `frontend/src/lib/utils/previewImageProxy.ts`, applied to the
`og:image` and to **every** favicon candidate - the conventional paths are derived in the browser, so
nothing server-side would have rewritten them. It skips URLs already on our own origin, which is
what keeps the MiGallery cover proxy from being proxied twice.

The CSP `img-src` is deliberately **not** tightened to match: the feed renders arbitrary user-posted
images. GIFs do not come through this route: KLIPY's go through the GIF relay,
`/api/mls/gifs/media` (`gif-media.controller.ts` - its own 12 MiB ceiling, streamed, a byte cache,
single-flight, a day-long ticket kind), and a GIF from any other host still loads directly in the
reader's browser, as before (owner decision; unmeasured; routing it here is one line in
`proxiedGifUrl`). Both
share `writeRelayedImageHeaders` (`utils/gif-media.ts`) and `requireTicketSecret`
(`utils/previewTicket.ts`); the mechanism is on
[chat](../frontend/modules/chat.md#the-gif-relay-no-readers-browser-asks-klipy-for-a-gif-2026-10-18).

#### A relative reference belongs to the page that answered, not to the link that was written (2026-09-23)

`resolveLinkPreview` walks the redirect chain by hand and keeps the result in `currentUrl` - and then
built the payload from `targetUrl`, the link as the message wrote it. Every relative reference in the
markup was therefore resolved against the wrong origin. A shortened link whose destination declares
`og:image="/files/event/150/1461421.jpg"` produced

```
GET /api/mls/link-preview/image?url=https://bit.ly/files/event/150/1461421.jpg   404
```

which the image cache then remembered, so the card stayed illustration-less for six hours. **The
redirect walk was correct and its result was discarded at the last step**, which is why nothing in
the SSRF or caching work ever found it: no test in this repo redirected. It affects every shortener,
every `http` -> `https` hop and every locale redirect, not `bit.ly` in particular.

**Two URLs, and they answer different questions.** `buildLinkPreviewPayload`, `extractIconUrl`,
`extractOEmbedEndpoint` and `mergeOEmbedIntoPayload` now take a `baseUrl` beside the target:

| | what it is | what it decides |
| --- | --- | --- |
| `targetUrl` | the link the message wrote | the payload's `url`, the hostname fallbacks for title and site name, and the cache key |
| `baseUrl` | where the HTML came from | every relative reference: `og:image`, the declared icon, the `/favicon.ico` convention, the oEmbed href, an oEmbed thumbnail |

It defaults to `targetUrl`, which is what it means when nothing redirected. **The identity of the
link was never wrong and is deliberately unchanged**: the card still shows and opens what was
written, and a shortened link still reads as its shortener - making the card open the resolved
destination instead is a separate decision, not a consequence of this one.

What is NOT fixed by it: the conventional favicon paths are derived in the browser from the URL as
written (`faviconCandidates(parsed.href, ...)`), so for a shortened link they still hang off the
shortener's origin. The declared icon - candidate #1, and the one sites actually have - now resolves
correctly, and closing the rest needs the resolved URL in the payload.

Pinned by `security.controller.link-preview.spec.ts`: a `301` to another host whose page declares a
relative image and icon, asserted to resolve against the destination while `url` stays the written
link. Verified by reverting the one argument - the test then reports the production URL exactly.

#### The card's illustration is a cascade, and it has to come back down (2026-09-23)

`og:image` -> declared icon -> conventional favicon paths -> globe. The first rung used to be
decided by the payload merely CARRYING an `og:image`: `{#if previewImageUrl}` is true of a URL that
404s, so the defect above left an empty 64 px square on screen **with a usable favicon one rung
below that nothing ever asked for**. Two independent faults, and the second one is what made the
first one visible instead of invisible.

`LinkPreviewCard` now proves the image before it counts as drawn, with the same off-screen probe the
favicon chain already used - an `onerror` on the displayed element cannot be trusted here, because
that element is reused as the payload arrives and a failure queued for the previous `src` still
fires against the next one. It costs no second download: the proxy answers `max-age`, so the
displayed `<img>` reads the probe's cache entry.

**The chain is walked only when it is what the card would draw**, which is the other half of the
same change. It stays empty for a cover card (as before), while the card is still pending, and while
the Open Graph image holds - previously the conventional paths were probed on mount, against the
written URL, before the payload could say which icon the site declares, and every one of those
answers was discarded the moment it arrived. That early walk is where the `404` on
`gallery.mitv.fr/favicon.svg` came from.

Pinned by `LinkPreviewCard.cascade.svelte.test.ts`, which stubs `Image` so the verdict is supplied
rather than awaited: the image decoding means no favicon is probed at all, the image failing means
the declared icon is drawn, and nothing decoding means the globe rather than an empty square.

#### oEmbed discovery covers Spotify, Vimeo, Bandcamp and X in one path

A page that declares `<link rel="alternate" type="application/json+oembed">` is publishing metadata
*for* embedders, and usually describes itself better there than in its Open Graph tags.
`extractOEmbedEndpoint` reads the declaration out of the HTML already downloaded, so discovery is
free; only following it costs a request, through the same SSRF guard (the href is someone else's
markup, so its scheme is checked, not merely its parse - the `extractIconUrl` trap again).

`mergeOEmbedIntoPayload` is written so it can be applied blindly: **Open Graph wins wherever both
speak.** oEmbed only fills gaps - a title where the page fell back to its hostname, a
`thumbnail_url` where there was no `og:image`, a `provider_name` where the site name was just the
host - and adds the one thing Open Graph has no field for, `author_name`, which becomes the
description when the page declared none. A site with good tags is never made worse.

The YouTube short-circuit stays ahead of all of it: it needs no HTML fetch at all, so it is strictly
cheaper.

#### What counts as the app: an exact host, never a suffix

`isPublicAppUrl` (`publicAppUrl.ts`) accepts `PUBLIC_APP_HOSTS` plus the host of the origin the build
advertises (`publicAppOrigin()`, so `dev.canari-emse.fr` is the app on the dev estate only). It used
to accept every `*.canari-emse.fr` / `*.canari.emse.fr`, so a link to `archives.canari-emse.fr` (a
separate Omeka site) was treated as the app: `AppLink` replaced its text with a generic label and
navigated to the same path on the current origin. Sibling subdomains are external and keep their own
host, text and preview card.

#### Ecosystem sites are named, not spelled out

`frontend/src/lib/utils/ecosystemHosts.ts` maps the four hosts we share users with -
`gallery.mitv.fr`, `sky.mitv.fr`, `cercle.canari-emse.fr`, `portail-etu.emse.fr` - to the name the
reader knows them by. The badge rule below is unchanged; `sky.mitv.fr` simply names the destination
to nobody but whoever deployed it. The registry also carries the paths worth a cover-first card
(`EcosystemCoverPreview.svelte`, a MiGallery album today), which is what the hostname compared in
place used to decide. Adding a fifth site is one entry there. It carries no bundled logos on
purpose: the card already resolves each site's own favicon, which survives a rebrand.

#### Favicons come from the site, never from an icon service

`extractIconUrl` reads the page's own `<link rel="icon">` - the page is already downloaded for its
Open Graph tags, so the icon is free, and the site is the only authority on it. A third-party icon
service answers a generic placeholder for any host it has not crawled, indistinguishable from a
real icon, which is what made every self-hosted site look iconless; it would also leak every
browsed hostname out of an end-to-end encrypted conversation. The largest declared `sizes` wins,
then an `apple-touch-icon`, then anything else. The `href` reaches an `<img src>`, so its scheme is
checked explicitly - `new URL('javascript:...', base)` resolves rather than throws.

Client-side, `faviconCandidates` (frontend) turns that into an ordered list: the declared icon
first, then `/favicon.ico`, `/favicon.svg`, `/favicon.png`, `/apple-touch-icon.png`. Only the globe
is left once every candidate has failed - a site whose SPA answers `index.html` on `/favicon.ico`
(a 200 that is not an image) still gets its real icon, because the probe decides on the bytes.

**The list is walked with off-screen `Image` probes, never by cascading the displayed `<img>`
through its own `onerror`.** That `<img>` is one element reused across every candidate: assigning a
new `src` aborts the previous load but does not unqueue an error already fired for it, so a stale
event advances the pointer past the candidate now on screen. The chain is rebuilt exactly when the
preview payload arrives with the declared icon - i.e. while a conventional path is in flight - so
the race is the normal case, not an edge one: the icon appeared and was then replaced by the globe.
A probe owns its element, so an answer can only be about the URL that was asked.

#### The badge says where the link goes; the title says what is there

`LinkPreviewCard.svelte` draws two text lines, and the rule that keeps them from colliding is the
same on both branches: **the badge must carry what the title does not already say.**

| | badge | title |
|---|---|---|
| external | the HOST (`parsed.host`) | `og:title` |
| external, ecosystem | the site's NAME (`ecosystemSiteFor`) | `og:title` |
| in-app, typed | the KIND (Publication, Association, Formulaire, Profil) | the entity's name |
| in-app, plain route | `CANARI_BADGE_LABEL` | `publicAppLinkLabel()` (Accueil, Agenda...) |

Never `og:site_name` on the external branch: a great many sites set it to the page title, so the
card printed the same sentence twice. The in-app branch had the mirror-image bug - a plain route
has no entity, and both fields were fed the same `publicAppLinkLabel()`, giving "ACCUEIL CANARI"
over "Accueil Canari". The badge now falls back to the brand (the in-app counterpart of the host
chip) and the label is the title alone; correspondingly, `publicAppLinkLabel` names the
destination and never the app, since every surface that shows it already says Canari beside it.

**Deciding "is this address reachable" is the whole guard, and the address space is wider than
RFC 1918.** `isPrivateIpAddress` also rejects `0.0.0.0/8` (on Linux a connection to `0.0.0.0`
lands on loopback), CGNAT, the benchmark/protocol blocks, multicast and reserved space; on IPv6
the unspecified address, the full `fe80::/10` (not just the `fe80:` hextet) and multicast. Any
form embedding an IPv4 - `::ffff:127.0.0.1`, its hex spelling `::ffff:7f00:1`, `::127.0.0.1`,
NAT64 - is judged on the **embedded** address, because that is where the socket lands. A host that
cannot be parsed counts as private.

One parsing trap: `URL.hostname` keeps the brackets around an IPv6 literal, so `isIP('[::1]')`
answers "not an address" and skips the literal check entirely. `unbracketHost` strips them first.

### Distributed locks

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/add-lock` | Acquire distributed add-lock (admitted member; so does the PushSecret door) |
| DELETE | `/api/mls/add-lock` | Release add-lock |

### Calls

| Method | Path | Description |
|---|---|---|
| POST | `/api/calls/initiate` | Verify membership, bind the room ID to the group and its caller (Redis `call:room:<id>`, TTL = 60 s ring window + 4 h), return a room token + room ID + `ringTimeoutMs` for the in-repo `call-service`. The answer window is NOT open yet: `/api/calls/ring` opens it. 403 `USER_BLOCKED` when a block stands between the caller and the other member - no room is bound ([calls](../frontend/modules/calls.md#the-switches-agree-and-a-silent-frame-stays-unread)) |
| GET | `/api/calls/room-token` | Get room token for recipient: 403 for a room bound to another group, 403 `USER_BLOCKED` for a block set while it rang, 410 for an unknown/expired room or after the ring window ([calls lot 1](../frontend/modules/calls.md#lot-1-2026-10-17---11-audio-peer-to-peer-dev-builds-only)) |
| GET | `/api/calls/ice-servers` | Get ICE server configuration. STUN only, typed `turn: { status: 'unavailable', code }`, once the month's egress METERED by Cloudflare (GraphQL analytics, account-wide, `TurnUsageMeter`) reaches `CLOUDFLARE_TURN_MONTHLY_BUDGET_GB` (`TURN_BUDGET_REACHED`), or when that meter is unconfigured or unreadable (`TURN_METER_UNAVAILABLE`, error log, failure cached 30 s; every readable day re-asked and stored in `turn:metered:days:<YYYY-MM>` for the days past retention, meter readings single-flight (credentials never shared), 5 s timeouts, an hourly `[TURN-METER]` report while calls are open) - no TURN credential without a budget, and no refused call that needs no relay ([calls](../frontend/modules/calls.md#the-servers-kill-switch-and-the-metered-turn-budget-b12-b7-2026-10-21)) |
| POST | `/api/calls/presence` | Report device presence in call |
| GET | `/api/calls/sibling-status` | Check sibling device call status |
| POST | `/api/calls/ring` | Open the room's 60 s answer window (`call:room:<id>:answer_by`, one `SET NX` expiring with the binding; once, from its caller only; 403 otherwise, 410 for an unknown or expired room), then fan out an incoming-call ring to all group members (WP-XP-5) |
| POST | `/api/calls/ring-end` | Stop the ring everywhere (reason: answered/cancelled/ended) |

**The kill switch.** `initiate`, `room-token`, `ring` and `ice-servers` first read
`platform_config.calls_mode` (core-service's row, plain SQL, every request): `off` answers 403
`CALLS_DISABLED`, `audio` answers a video ring 403 `CALLS_VIDEO_DISABLED`. `ring-end`, `presence`
and `sibling-status` are never gated ([calls](../frontend/modules/calls.md#the-servers-kill-switch-and-the-metered-turn-budget-b12-b7-2026-10-21)).

The room id returned by `/api/calls/initiate` **is** the `callId` used by every other call route and
by the SFU, so this service's `[call] invite` / `[ring] call=` lines and call-service's
`[call] session ...` records join on that one value. The whole record, its disposition tokens and
how to read it are on [`call-service`](call-service.md#the-call-record) - keep no second copy here.

### Internal / health

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/internal/push/notify` | InternalSecret | Send push via internal secret |
| DELETE | `/api/internal/users/:userId` | InternalSecret | Idempotent account erasure, every column in `ACCOUNT_ERASURE_COVERAGE` ([account-erasure](../account-erasure.md)) |
| GET | `/api/health` | none | Liveness probe |

## Notification categories - one switch per kind, decided before the send

Settings holds one switch per category (default: all ON), **per account** so it follows the user
across devices. The server decides: **a muted category is never sent**, and no client has to filter
what was never delivered. Storage is `notification_preference` (migration 028, one row per account
that ever changed it, holding the DISABLED set - so an account with no row and a category added later
are both ON with no backfill). It lives in THIS service because every push is sent from here.

| Category | Pushes filed under it | Decided in |
|---|---|---|
| `messages` | MLS 1-to-1 and group messages (`type: 'message'`) | `sendFcmForQueued`: delivered **silent**, not dropped |
| `channels` | community salon messages (`type: 'channel'`) | `sendPushToUser`: not sent |
| `posts` | `social_association_post`, `social_followed_post` | `sendPushToUser` |
| `comments` | `social_comment`, `social_reply` | `sendPushToUser` |
| `mentions` | `social_mention` (post or comment) | `sendPushToUser` |
| `reactions` | `social_reaction`, and the DM reaction (`reaction: 'true'`) | `sendPushToUser` |
| `events` | the six `event_*` keys | `sendPushToUser` |
| `forms` | `form_opening_soon`, `form_open`, `form_paid_over_capacity` (the organiser alert, [forms](../frontend/modules/forms.md#the-organiser-is-told-when-a-payment-lands-over-capacity-d3-built-2026-10-22-switched-off): filed under the EXISTING id, since a new id is a switch older clients cannot draw), `type: 'form_reminder'` | `sendPushToUser` |

The id list and the push-to-category map are ONE file, `services/push-category.ts`; the frontend
mirrors the ids (`frontend/src/lib/notifications/categories.ts`) and `categories.contract.test.ts`
reads the server file so the two cannot drift.

- **A MESSAGE IS SILENCED, NEVER DROPPED.** An MLS ciphertext is state the account needs to stay
  decryptable, so a muted `messages` category sends the same frame with `silent: 'true'` - the flag
  own-device copies and receipts already use, honoured by Android and the iOS path - and the device
  draws nothing. The recipient's own sends and already-silent frames never cost a read.
- **Filed under no category, on purpose**: `channel_read`, `call_ring` / `call_ring_end` and every MLS
  control frame (welcome, history, device revoked). Filtering one would break a conversation or a
  ring rather than quiet it. Calls are held off anyway (`CALLS_ENABLED = false`).
- **A read that fails delivers, and logs `[NOTIF_PREF]`** - dropping a push because a preference could
  not be read loses a message the user wanted. The settings GET reads strictly and fails loudly.
- **The per-salon level is a different question and is not replaced.** `channel_members.notifLevels`
  (`all` / `mentions` / `none`, social-service) says how loud ONE salon is and is applied there
  before a push is handed here; the category switch sits below it, at the single send. A PRIVATE
  conversation's level is applied here, after the category - see the next section.
- **The client half.** A frame received over the WebSocket raises its notification on the device
  with no push involved, so `useMessaging.notifyInbound` consults `notificationPreferences` (the
  store mirroring the server set, loaded at sign-in and by the settings section) with the same
  `channel_` split. The in-app notifications LIST (bell, `/notifications`) is an inbox, not an
  alert, and is unchanged.
- **Unverified on hardware**: native delivery with a category off is covered by unit tests on what
  reaches FCM, not by a phone.

## A conversation's notification level - the server applies `none`, the device decides `mentions`

Decided 2026-10-14 (user: the salon's three levels for private groups, DMs included). A member sets
`all` / `mentions` / `none` on ONE private conversation, with the same control a salon uses
(`NotificationLevelControl.svelte`, shared by `ChannelSettingsPanel` and `ChatGroupPanel`).

**Where it is stored.** `dm_group_members.notifLevel` (migration 029, default `all`, CHECK on the
three values) - the salon's `channel_members.notifLevels` pattern: on the member's own membership
row, so it is per ACCOUNT (every device, survives a reinstall) and it ends with the membership
(leaving hard-deletes the row; a member who comes back starts at `all`). Read by
`PATCH /mls/groups/:groupId/notification-level` (403 for a non-member) and listed, non-`all` only,
in `GET /mls/notification-preferences` as `groupLevels` - the read the client already makes at
sign-in, so no second request.

**Why the server cannot decide `mentions`, and what it does instead.** In a salon the sender attaches
a cleartext `mentionedUserIds` list and social-service filters before pushing. A private MLS
conversation carries no such list - who is mentioned is inside the ciphertext - and adding one would
hand the server a social graph the encryption exists to hide. So:

| Level | Server (`sendFcmForQueued`) | Device |
|---|---|---|
| `all` | visible frame, as before | draws it |
| `none` | the frame is sent `silent` - delivered (it is MLS state), never drawn, exactly like the `messages` category switch | nothing to decide |
| `mentions` | visible frame carrying `notifLevel=mentions`; on APNs the alert is `interruption-level: passive` with NO sound | decrypts, then draws only if the WHOLE plaintext holds `@[<own user id>]` |

A DM or group REACTION (`sendPushToUser`, `reaction: 'true'`) is refused at `mentions` and `none`: a
reaction is never a mention, and the server knows the group. The level is read only for a group id
that IS a uuid (`isGroupUuid`, a type guard): a SALON reaction carries `groupId = channel_<id>`,
names no private conversation, and would be refused by the uuid column (22P02) - asked first, never
learnt from a failed query.

**ONE decision per platform, fed by that field, no timer, no fallback:**

- Android push: `push/NotificationLevelGate.decide` (pure, tested in `android-tests`), called once in
  `handleMlsFrame` before the fallback text is computed. A withheld message is still written to
  `fcm_message_cache` and a refused one still enqueues its worker - state is owed whatever is drawn.
- iOS extension: `levelDecision` in `NotificationService.swift`. An extension cannot WITHHOLD an alert
  without Apple's filtering entitlement, which the app does not hold, so iOS's "withhold" is
  `passive` (filed in the notification centre, no sound, no banner, screen stays dark); a proven
  mention is raised to `timeSensitive` with the default sound.
- A frame received over the socket (web, desktop, a backgrounded Android app that ACKed it):
  `conversationLevelRefusal` in `notifyInbound`, reading the store `notificationPreferences` by the
  GROUP id (`convo.id`, never a `me::peer` conversation key). Here the plaintext is always in hand.
  **A SALON takes the same decision** (`channel_<id>` key, category `channels`) with its own level
  from `channel_members.notifLevels`: `notificationPreferences.channelLevel`, read ONCE per salon
  (`GET /api/channels/:id/notification-level`, one shared request) when its first frame arrives, the
  frame waiting for the answer, then cached for the session - never a read per message. A failed
  read is logged and the frame raised as `all` (the account default), nothing cached, so the next
  frame reads again.
  A catch-up flush raises ONE banner (its last message) but counts as a mention if ANY of its
  inbound messages names the reader - "@me look", "ok", "lol" is a mention.

The three decisions are asserted against ONE contract, `libs/contracts/mention-decision.cases.json`:
`conversationLevel.contract.test.ts` (client), `NotificationLevelGateTest` (Android, JVM) and
`canari_NSETests/MentionDecisionContractTests.swift` (iOS - written, NOT compiled and not wired to a
target yet: there is no Xcode on the workstation that wrote it).

**When this device's copy of the levels refreshes, and why that is enough.** The store is read at
sign-in, at every visit to the notification settings, and at every opening of a conversation's
panel (a salon's: its settings panel, which also writes the cache on save). No socket event announces a level changed on ANOTHER device, so until one of those three, a
session that was already open keeps the old level for the notifications it raises ITSELF from socket
frames. That is safe: pushes are always current (the server reads the column at each send), the
error is at most one banner too many or too few on an open session, never a lost message, and the
device where the level was changed holds it at once.

Mentions are read from the whole plaintext before the 200-character preview cut, on both native
paths (`mentionedUserIds`) - a mention past the cut used to miss the mentions channel too.

**THE RULE FOR WHAT CANNOT BE DECIDED.** At `mentions`, a message the device cannot read (no state,
refused, extension timed out, push context missing) proves no mention, so it does NOT alert: Android
draws nothing, iOS leaves the server's passive alert, which is also exactly what iOS shows when the
extension never runs. The message is not lost - it is in the conversation, unread, at the next open.
The member chose to be interrupted only by a mention; a false alarm breaks that choice on every
undecryptable frame, whereas a missed mention costs one unread line they will see.

**What travels in clear.** `notifLevel=mentions` in the FCM data map and `interruption-level:
passive` in the APNs payload are cleartext to Google and Apple, like `silent` and `isGroup` already
are: they say how loud this member keeps this conversation, never what was said or who was named.

**The iOS target gap.** The extension's deployment target is 18.2 while the app's is 15.6 (and the
XcodeGen project 14.0): on an iPhone older than 18.2 the extension cannot run, so every `mentions`
frame stays the server's passive alert and a mention never rings - the undecidable rule, applied to
the whole device. Check on a device before relying on the iOS half of `mentions`.

**Older builds.** A client predating the field ignores `notifLevel` and draws a `mentions` frame as
`all` (on iOS, passive - the server's alert). `none` works on every build, because it is the server's.

**Unverified on hardware**: the Android and iOS halves are covered by unit tests on the decision and
on what reaches FCM/APNs; the iOS extension was not compiled here (no Xcode on the workstation), and
neither phone has run it.

**A conversation's CALL PERMISSION sits beside the level, on the same row (2026-10-18).**
`dm_group_members.callsAllowed` (migration 032, NULL = never chose = rings unless the level is
`none`), written by `PATCH /mls/groups/:groupId/calls`, listed as `groupCalls` in the same
`GET /mls/notification-preferences`, and applied by `CallsService.ringGroup` to the ring push. The
rule, the default and the client half:
[calls](../frontend/modules/calls.md#the-call-permission---its-own-setting-per-conversation-decided-2026-10-18).

## Two lines that report a rate, not an event

`[DEVICE_MEMBERSHIPS]` used to print on every membership poll (several per second while a device
settles) and `[PUSH_SEND] No push token` on every send to a device with no token (every web and
desktop device, for ever): together they were most of a run window's unexplained lines, and both
printed the full 64-character user id and the whole device id. Since 2026-10-05 the first prints
when a device's answer CHANGES (a row stranding or clearing always does), the second once per device
and then at its 10th, 100th... send (`utils/log-repeat.ts`), and both cut ids to 8 (user) and 12
(device, so the `web-`/`ios-` prefix the rig's classifier keys on survives). How many devices cannot
be pushed is a population question, answered by `tools/cross-client-harness/devices.mjs
--unpushable`, never by counting this line.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `REDIS_URL` | yes | Redis connection string |
| `JWT_SECRET` | yes | HS256 secret (shared with core-service) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | no | Firebase Admin SDK credentials (push notifications) |
| `PUSH_SECRET` | yes | Shared secret for background push service routes |
| `INTERNAL_SECRET` | yes | Shared secret for internal service-to-service routes |
| `CALL_ROOM_SECRET` | yes, for calls | HS256 secret signing the 5-minute room token. Unset, `/api/calls/initiate` answers 503 |
| `MEDIA_SERVICE_URL` | no | media-service base URL (rich media notification proxy) |
| `KLIPY_API_KEY` | no | KLIPY key for `GET /api/mls/gifs`; unset, that route answers 503 and the picker says GIF search is not configured |
| `APNS_VOIP_KEY_P8` | no | APNs auth key (.p8, raw PEM or base64) for direct VoIP pushes (CallKit) |
| `APNS_VOIP_KEY_ID` | no | Key ID of the APNs auth key |
| `APNS_VOIP_TEAM_ID` | no | Apple Developer Team ID (`4CLNB8SR6L`) |
| `APNS_VOIP_TOPIC` | no | VoIP topic, default `fr.emse.canari.voip` |
| `APNS_VOIP_SANDBOX` | no | `true` to target the APNs sandbox - Xcode debug builds only; a TestFlight build (dev estate included) is `aps-environment production` |

### The push avatar log line

The `GET /api/mls/push/avatar/:targetUserId` route writes ONE `[PUSH_AVATAR]` line per request
(`outcome=<o> status=<http> ms=<n> device=<bool> target=<first 8 chars>`, plus `detail=` when core is
unreachable), and core-service `GET /users/:id/avatar` writes the matching `[AVATAR]` line (no `device=`:
core never sees the requester device). Outcome vocabulary: `served` and `absent` log at info;
`unavailable`, `unreachable`, `rejected` (push secret or query refused) and, in core only, `disabled` (no
gallery key on the estate) log at warn. The full id, the secret and the image never appear. A failed
fetch is found with `grep -E "PUSH_AVATAR|\[AVATAR\]" | grep -v -E "outcome=(served|absent) "`; see also
[core-service](core-service.md#the-avatar-proxy).

### A Welcome is carried by reference, never inlined (2026-10-08)

**Measured**: a first-contact Welcome is 4608 B against a 3716 B inline budget. The FCM limit (4096 B)
applies to the whole data map, keys included, so the budget is what `inlineProtoBudget` leaves after
the fixed fields. The push was never dropped - it went out with `proto` empty - but the outcome was
an implicit `if` plus a log silenced for Welcomes (`uninlinedProtoIsWorthReporting`).

**Why by reference is the design, not a degradation**: the Android reader
(`processReceivedWelcomeBackground`) fetches the whole bundle, ciphertext AND ratchet tree, through
`/api/mls/push/fetch-proto` by `queuedMessageId`, whatever it inlined, because the tree never rides in
the push; the iOS NSE processes no Welcome at all. So inlining a Welcome could not save a request.

**The decision** is `decideProtoCarriage` in `push-payload.ts`, a typed `ProtoCarriage`: `inlined`
(a message that fits), `by-reference` (every Welcome, whatever its size; debug line, expected),
`long-frame` (a MESSAGE too long to fit even beside empty names - a long text, carried by reference,
debug; every frame is about 360 B raw longer since it carries its author's signature and a signed
epoch claim, measured in `mls-core/tests/authored_frames.rs`), `over-budget` (a MESSAGE that would
have fit beside empty names: the fixed fields grew; `warn`), `empty`. No client change
and no native work was needed. `push-payload.spec.ts` pins the 4608 B case.

**Key material over the budget is carried by reference too (2026-10-22).** A Graine seed bundle is
routinely kilobytes, and since a history answer is paged at up to 255 KiB
([channel-encryption §4.4](../protocols/channel-encryption.md#44-joining-and-what-a-share-link-is-worth)),
every multi-seed answer to an offline device was logged `over-budget` at warn, once per page.
`isKeyDistribution` (the `dm_groups` distribution columns the push already reads) now makes such a
frame `by-reference` with `reason: 'key-material'`, at debug. Key material that fits is still inlined,
because the native mirror reads seeds from it. A frame whose group row could not be read
(`isKeyDistribution` undefined) still reports `over-budget`. The device behaviour is unchanged: a push
with an empty `proto` was already fetched by `queuedMessageId`.
