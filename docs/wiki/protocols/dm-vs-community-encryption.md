# DMs and communities: two encryption systems, compared on production (2026-10-21)

**Question (user, 2026-10-21):** what does a community do differently from an ordinary MLS group, what
does each system do well, and where is each one worth improving? The two designs are specified
elsewhere - [mls-protocol](mls-protocol.md) and [history-reconciliation](history-reconciliation.md)
for DMs, [channel-encryption](channel-encryption.md) for communities. **This page compares them and
re-measures the numbers their designs were sized on.** Those numbers dated from 2026-08-17, before any
real community existed, and three of them have since turned out wrong.

Measured on production with read-only `SELECT`s (`default_transaction_read_only = on`) on
2026-10-21. Counts only, no person and no group id
([durable-rules](../durable-rules.md#a-measurement-taken-from-production-names-roles-and-counts-never-people---this-repository-is-public)).

## The model in one paragraph

**A DM sends its messages THROUGH MLS. A community sends its messages BESIDE MLS, and uses MLS only
to hand out keys.** In a DM, every message is an MLS application message, so reading one needs the
group state at the right epoch, and a device that misses a commit can lose messages. In a community,
each sender seals its messages with a key derived from its own 32-byte *seed* (Graine). The server
keeps every ciphertext durably. The community's one MLS group, called the *distribution group* or
*key group*, carries only the seeds. A device that misses something is missing a seed, which is small
and can be asked for again. It is not missing the message, which is still on the server. Everything
in the comparison below follows from that difference.

## What each operation does

| Operation | DM (MLS carries the message) | Community (MLS carries the seed) |
| --- | --- | --- |
| **Send** | Encrypted with the epoch's sender ratchet and sent as an MLS application message. The server queues one copy per recipient device. | AES-GCM under `HKDF(seed, sessionId, index)` with this device's current session, then signed in v2. The ciphertext goes to the server over REST and is stored once. MLS is not involved, unless the session has to rotate first. |
| **Receive** | MLS-decrypt. The device must be at the frame's epoch with every commit before it applied in order. | Look up the session by `senderSessionId`, derive the key for the index, verify the signature, decrypt. There is no epoch to be at. |
| **Missing piece** | A commit missed is a chain: rung 1 is commit replay, rung 2 is an external join ([recovery ladder](mls-recovery-ladder.md)). A message missed is asked of a peer, which re-sends it ([history-reconciliation](history-reconciliation.md)). | A seed missed is asked of its minter, or else of the online member with the lowest id ([§4.5](channel-encryption.md#45-a-missing-seed-is-requested-and-said-out-loud)). The message itself is never missing. |
| **Member added** | A commit plus a Welcome. MLS gives the newcomer nothing from before, **but the adding device then pushes its whole local history** (`sendFullHistoryBundle`), so a new member of a group conversation reads the past. That was never decided, and the user reversed it on 2026-10-21: [history-reconciliation](history-reconciliation.md#a-new-member-receives-nothing-from-before-their-arrival-decided-by-the-user-2026-10-21). | The newcomer joins the key group by external commit, with nobody online needed, then receives a bundle of every seed held (`shared`) or none (`joined`). |
| **New device of a member** | A `welcome_request`, an online device adds it, and a Welcome follows. Its past comes from peers, re-encrypted message by message. | An external join of the key group and the same history bundle: seeds only, with the ciphertexts read from the server. |
| **Member leaves** | A Remove commit, and the next epoch excludes them. | A Remove commit on the key group, made by whoever reconciles the roster next ([§4.6](channel-encryption.md#46-ordering-rule-remove-then-distribute)). Every sender rotates at its next send. The leaver keeps what it could already read. |
| **Rotation** | Every commit is a new epoch. Every device refreshes its own leaf at its next send once 7 days have passed since its last commit in that group ([mls-protocol](mls-protocol.md#the-periodic-leaf-refresh)); key groups are excluded. | Per sender, at the next send after a key-group Remove or a new user, after 100 messages, or after 7 days (50 and 24 hours once re-distributed); a new device of a present user re-distributes the session instead ([`graineOutboundVerdict`](../../../frontend/src/lib/utils/graine/sessionManager.ts), [graine-removal-tracker](graine-removal-tracker.md), 2026-10-22, not yet shipped). |
| **Where the past lives** | On the devices. The server keeps a capped Redis stream and per-device queues, but cannot decrypt either for a later joiner. | On the server, as ciphertext. Devices hold only the keys. |

## What each system is good at

| Property | DM | Community |
| --- | --- | --- |
| Forward secrecy | **Strong** - an epoch's keys are deleted once used. | **Weak, by decision** - whoever holds a seed opens every index of its session, and old seeds are kept so that newcomers can read the past ([§4.4](channel-encryption.md#44-joining-and-what-a-share-link-is-worth)). |
| Post-compromise security | **Available but unused** - MLS heals a compromised leaf at its next update, and no device ever updates its leaf. | Bounded by seed rotation (on a removal or a new user); see the [backlog](../backlog.md) for the policy. |
| Author authenticity | MLS signature, verified by OpenMLS. | v1: none (any member could forge). v2: Ed25519 per session plus an endorsement, and the server refuses an unsigned v2 row ([§21](channel-encryption.md#21-graine-v2-an-author-that-is-proven-a-ciphertext-bound-to-its-place---decided-by-the-user-2026-09-28)). |
| A newcomer reads the past | Never from MLS. Today the inviter re-sends it all; decided 2026-10-21 that a new member gets nothing from before their arrival (not built). | Yes, from one bundle of seeds (`shared`, decided 2026-08-17). |
| Tolerance of a device that fell behind | Low: a missed commit is the failure class [mls-desync-prevention](mls-desync-prevention.md) exists for. | High for messages, which stay readable once the seed arrives. The key group is still MLS, so the same class exists there, but it delays seeds rather than losing text. |
| Cost of a membership change | One commit, which every device must apply in order. | One commit on the key group, plus one seed distribution per sender who speaks afterwards. |
| Server storage per message | One queued copy per recipient device, deleted on ACK. | One row. |

## The numbers, re-measured

### Group sizes - the "never above a pair" premise no longer holds

| Group kind | Live groups | Users, max | Active device seats, max / median | Epoch, max / median | Commits in the last 30 d |
| --- | --- | --- | --- | --- | --- |
| Community key group | 16 | 110 (median 8) | **199** / 21 | 261 / 71 | 1 363 |
| Private-salon key group | 2 | - | 10 / 6 | 66 / 15 | 81 |
| 1:1 DM | 236 | 2 | 19 / 6 | 744 / 4 | 903 |
| Group conversation (DM with `isGroup`) | 15 | **42** (median 4) | **109** / 11 | 71 / 5 | 241 |

[channel-encryption §3](channel-encryption.md#3-why-a-channel-is-not-an-mls-group-and-where-mls-still-is)
rejected an MLS group per salon partly because *"the largest MLS group on prod [had] 2 members"*. By
now production runs a 199-seat key group and a 109-seat group conversation. The group conversation
carries its messages over MLS, which is the exact shape §3 warned against. Published key packages name
2.19 devices per user on average (max 15, stale devices included), so the device count, not the
member count, is what an MLS group pays for.

### Rotation - one seed per two messages, not one per sender per week

| Measure | Value |
| --- | --- |
| Channel messages, total (oldest 2026-09-02) | 1 698 |
| Distinct sessions (seeds) | **845** - 2.0 messages per session, median **1** |
| Consecutive messages of one sender in one salon that changed session: gap < 5 min / < 1 h / < 1 d / >= 1 d | 17 % / 69 % / 93 % / 98 % |
| Largest community: messages / sessions / days old | 826 / 458 / 8 |
| Its key-group device joins on its first two days | 69, then 87 |
| Its key-group commits on those days | 99, then 105 |

**The cause, read from the code (before 2026-10-22; the fix is [graine-removal-tracker](graine-removal-tracker.md)).** `shouldRotateGraineSession` rotated when the stored distribution
epoch differs from the current one ([sessionManager.ts](../../../frontend/src/lib/utils/graine/sessionManager.ts)).
Every device that joins the key group commits, and so advances that epoch. Its comment accepts this:
*"An ADD advances the epoch too, and rotates a session it did not have to [...] the cost is one extra
O(1) seed distribution"*. That holds when adds are rare. On production, commits track device joins
almost one for one (the 2026-10-12 audit counted 80 of a new community's 137 commits as first joins:
[audit](../infrastructure/prod-queue-and-epoch-audit-2026-10-12.md#2-the-community-created-yesterday-1b1687d0)).
So in a growing community **almost every message after a pause opens a new session**. The 100-message
and 7-day thresholds are almost never what fires: the busiest session has 21 messages.

### The history bundle - 6x heavier per seed, and sized for the wrong rotation rate

The bundle cap `GRAINE_HISTORY_BUNDLE_MAX_SEEDS = 8000` was sized at *"~50 bytes"* per seed and
*"~1 500 seeds"* a year. A v2 `GraineMsg` on the wire carries the channel id (36 chars), the session id
(24), the seed (32 B), the minter user id (64 chars measured), the minter device id (83 chars
measured), the signing key (32 B), the endorsement (64 B) and the varints. That is **about 330 bytes**.

| | Sized for (2026-08-17) | Measured (2026-10-21) |
| --- | --- | --- |
| Bytes per seed | ~50 | **~330** (v2) |
| Seeds, largest community | ~1 500 / year | **458 in 8 days** (launch), then ~1-12 a day |
| Its bundle today | - | ~150 KB, consistent with the largest key-group frame in the queue (215 280 base64 chars, ~161 KB) |
| Bundle at the cap | 8 000 x 50 B = 400 KB | 8 000 x 330 B = **~2.6 MB in one MLS message** |

At the post-launch rate, the largest community reaches the cap in about two years. Another launch
like the first one, such as a new year group arriving in September, adds hundreds of seeds in a day.
The cap is a refusal (`truncated`), never a silent cut, so reaching it is visible. **Since
2026-10-22 an answer is bounded in bytes and paged** (255 KiB a page, about eleven pages at the cap),
after reading every hop's limit from code and config. The binding hop is the 1 MiB pending-queue page
([channel-encryption §4.4](channel-encryption.md#44-joining-and-what-a-share-link-is-worth)).

### "O(1) per seed" is true of the client, not of the server

| Queue (`queued_message`, 2026-10-21) | Rows | Ciphertext | Copies per distinct payload |
| --- | --- | --- | --- |
| Key-group application frames (seeds, requests, answers) | 204 870 | **883 MB** | 31.4 |
| Key-group commits | 14 159 | 27 MB | 11.9 |
| DM application frames | 54 869 | 23 MB | 7.2 |
| DM commits | 5 260 | 14 MB | 5.5 |
| **Table total** | 279 158 | **1 489 MB** on disk | - |
| For comparison: `channel_messages`, every community message ever | 1 698 | **1.5 MB** | 1 |

A sender posts a seed once. The server then writes one row for each device seat that is not
excluded, and a row stays until that device acknowledges it. Devices with no session left never do
([audit, finding 2](../infrastructure/prod-queue-and-epoch-audit-2026-10-12.md)). On launch day,
2026-10-12, the key groups wrote **637 MB** of queue in 24 hours, with 4 491 distinct payloads fanned
out to 169 437 rows. Answers have been addressed to the requesting device only since that day
([§23](channel-encryption.md#23-a-seed-answer-goes-only-to-the-device-that-asked---fixed-2026-10-12)),
and the daily volume has fallen to between 0.1 and 21 MB (2026-10-14 to 2026-10-21). The table has
kept what was written before, and its oldest row dates from 2026-08-21. **The
community messages cost the server about a thousandth of what their keys cost it.**

## Where each system can improve

Every item is in [backlog](../backlog.md#p2---graine-rotates-on-every-key-group-epoch-so-a-growing-community-mints-a-seed-per-message-measured-2026-10-21),
and this page carries the reasoning.

### Communities

1. **Rotate on a REMOVAL, not on any epoch change (P2).** *The identity-set check below was refused
   on 2026-10-22: a leaf added and removed between two sends is in neither set. Its replacement, a
   clean run fed by a commit summary from `mls-core`, is designed in
   [graine-removal-tracker](graine-removal-tracker.md).* This is the measured cause of the seed
   count. The comment that chose the epoch rejected a durable *"somebody LEFT"* marker, because every
   device would have to write it. A local alternative needs no marker: at mint, a session records the
   leaf identities of the key group (`userId:deviceId`), and at the next send it rotates only if one
   of them is no longer in the tree. `getGroupMemberIdentities` already reads that set for
   [`reconcileDistributionGroupRoster`](../../../frontend/src/lib/utils/graine/rosterReconcile.ts),
   and the check runs only when the epoch HAS moved. Adds would stop rotating, while removals and
   revoked devices still would. Expected effect: seeds return to roughly "senders x weeks", the shape
   the bundle cap was sized for. Cost: up to ~200 identities stored per outbound session, which is
   per device and per salon, not per message.
2. **Bound the bundle in BYTES and page it - DONE 2026-10-22.** Each hop's limit was read and the
   answer is paged under the smallest one, with a third of it as margin. Pages need no reassembly
   ([channel-encryption §4.4](channel-encryption.md#44-joining-and-what-a-share-link-is-worth)).
3. **Store a key-group frame once, not once per seat.** The server writes ~31 copies of each payload,
   and its 883 MB are the largest single cost in the database. A shared per-group log, read with a
   per-device cursor, would bring the DM side's `history:{groupId}` stream shape to the key groups,
   where every recipient receives the same bytes. This is a change to chat-delivery, not to the
   protocol. **Built 2026-10-22 (migration 034), not yet applied to an estate; its readers ship
   first and its writer is switched on in a later release.** It keeps the
   per-device row as the delivery record and stores the ciphertext once, instead of a log with a
   cursor, so ACK, pull and push are unchanged for every client
   ([chat-delivery](../services/chat-delivery.md#a-key-group-frame-is-stored-once-migration-034-2026-10-22)).
4. **`joined` exists and no community uses it** (16 of 16 are `shared`). The weak forward secrecy
   above is the price of `shared`. Nothing needs building, but no admin can choose `joined` today
   unless it is offered.

### DMs and group conversations

1. **Leaves refresh themselves since 2026-10-22, every 7 days of activity per device and group**
   ([mls-protocol](mls-protocol.md#the-periodic-leaf-refresh), with the commit ceiling on these fleet
   numbers), and a revoked device's leaf is removed by the stray-leaf collector. Community key groups
   are excluded: a refresh there is no departure, but it costs every sender a seed redistribution
   and the tighter reused caps (the cost is on that page).
2. **The large group conversation is the shape §3 rejected for salons.** 109 device seats carry
   messages over MLS. Two things are worth doing: measure its unreadable-frame rate against the
   communities' (`LOST frame` against `reportUnreadableChannelMessage`), and decide whether a group
   conversation above some size should be backed by Graine instead.
3. **A DM's past is re-sent message by message by a peer; a community's is re-sent as keys.** Both
   systems depend on a member being online for the past. For a DM, the cost grows with the history.
   For a community it grows with the number of sessions, and only while rotation is fixed (item 1
   above).

### Both

- **Names are in the clear.** `dm_groups.name`, `channel_workspaces.name`, `channels.name` and the
  community `slug` are plaintext columns, and push notifications carry the sender and group names in
  the clear to FCM and APNs ([DSO dossier](../compliance/dso-dossier.md)). Encrypting them was raised
  by the user on 2026-10-21 and is not designed yet. Its constraints are in the backlog entry.
- **What v2 does not close holds for both**: the server can admit a device it controls or publish a
  false key for one (BasicCredential, [§21](channel-encryption.md#21-graine-v2-an-author-that-is-proven-a-ciphertext-bound-to-its-place---decided-by-the-user-2026-09-28)).
  Key transparency or an out-of-band safety number would be the answer for both systems.

## Reproducing the measurement

Run each query with `SET default_transaction_read_only = on` on the production database
([databases](../infrastructure/databases.md#reaching-it-from-a-workstation)):

- Group kind: `dm_groups.distributionWorkspaceId` / `distributionChannelId` set means a key group.
  Otherwise the row is a DM, and `isGroup` separates a group conversation from a 1:1.
- Seats: `dm_device_group_memberships` with `status = 'active'`. Commits: `mls_commit_log`.
- Sessions: `count(DISTINCT "senderSessionId")` on `channel_messages`. Rotation per gap: `lag()` over
  `(channelId, authorId)` ordered by `createdAt`.
- Queue: `queued_message` grouped by the kind of its `groupId`. The ciphertext is in `proto`, and
  `content` is empty on every row.
