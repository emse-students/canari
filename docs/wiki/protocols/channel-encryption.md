# Graine - channel encryption (WP-GRAINE)

> **Status 2026-08-18: PHASES 1-5 ARE IN (up to WP-40).** A salon message is sealed under a
> per-sender seed the server has never held; the push path derives its key the same way on all three
> native surfaces; a missing seed is asked for and answered; a joiner receives the history its
> community allows; and a reaction is an encrypted message rather than a cleartext tally. What is NOT
> done at that date: the deletion of the server's own derivation and the cut itself. Both have
> since landed: migration `041` dropped `channels.masterSecret` and the other server-held key
> columns (see WP-51 below). §1 describes what the old regime did while
> it was live, and stays as the record of why this was worth doing.

**The requirement, from the user:** a community message must not be readable by the server, at the
level MLS already gives DMs. **The constraints:** the interface barely moves; a member must be able
to read what was written before they arrived, without the traffic a message replay would cost;
several hundred members per community; and community push notifications keep working.

**The name.** `Graine` - a session IS a seed: one value from which every message key of that session
grows. Wire and HKDF label: **`canari-graine-v1`**. Deliberately NOT a reuse of
`canari-channel-e2ee-v1`, which names the mechanism being replaced: after the clean cut no message
of the old regime should exist, and a shared label would make the two indistinguishable if one did.

**It is not Olm.** Olm is Matrix's pairwise Double Ratchet, and MLS already fills that role here.
What is borrowed is megolm's SHAPE - a per-sender group session, distributed out of band, rotated on
departure. Adding a second ratchet to a codebase that has MLS would be the opposite of the point.

---

## 1. What is there today, and why it is not a bug

`channels.masterSecret` is a plain Postgres column. Every epoch key is
`HKDF(masterSecret, channelId, keyVersion)`, so anybody holding the database derives every key of
every salon for the whole history without touching a membership row. `buildChannelBootstrap` hands
`newEpochBaseKey` to a member as raw base64 over REST - there is no wrapping step to break, because
there is none.

It reaches further than text. A body is an `AppMessage` protobuf and a media attachment travels as
`MediaMsg.key`, the raw 32-byte CEK, **inside that body**. The server derives the epoch key, opens
the body, reads the CEK, decrypts the blob. The `.proto` comment claiming "Only group members can
decrypt both the key and the blob" is true of MLS and false here.

This was a deliberate design - `server-assisted symmetric encryption (not MLS)` - not an accident.
What changed is not the discovery of a bug but a requirement.

## 2. The measurement that made the decision cheap

**Nothing on the server reads a channel message body.** Measured 2026-08-17:

| Suspected reader | What it actually does |
|---|---|
| Push | `notifyChannelRecipients` inlines the CIPHERTEXT in the FCM payload under 3 KB and the device decrypts natively; over that it degrades to "new message in #channel". It never composes from the text. Since 2026-09-22 it also carries `createdAt`, the row's own instant, so Android's one notification builder recognises a message its two triggers both deliver - the socket frame reads the same column, so nothing is re-derived. It tells FCM nothing it did not already have: a push is timed to the second by its own delivery |
| Search | No server-side search over content exists. The server returns rows; `decodeChannelMessageRow` decodes client-side and is shared by history loading and search for that reason |
| Moderation | `deleteChannelMessage` / `channel.moderate` act on an id. A moderator who reads is a member decrypting client-side |

Server readability funds **no feature**. That is what makes this worth doing rather than a trade to
argue: the cost is writing and migration, nothing else.

Discord is the same design with opposite economics - their server-side plaintext pays for search,
Trust & Safety, spam detection, bots and embeds, so they cannot give it up. Canari sold nothing.

## 3. Why a channel is NOT an MLS group (and where MLS still is)

Measured 2026-08-17:

| Measure | Value |
|---|---|
| Largest MLS group on prod | **2 members**. Not one above |
| Device leaves in a 2-member group | up to 6 |
| Commits accumulated on a 2-member group | up to 40 |
| Largest community | 9 members; the target is hundreds |

1. **The group path has never run above a pair.** A 300-member salon on it would bet the product on
   code no measurement covers.
2. **The cost is the COMMIT RATE, not the group size.** Every device enrolment and revocation is a
   commit, and every device of every member must replay all of them IN ORDER to decrypt.
   [mls-desync-prevention](mls-desync-prevention.md) already documents epoch drift as a live failure
   class at two members.
3. **A missed session key is a lookup; a missed commit is a chain.**

Discord reached the same conclusion from the other side: **DAVE** (2024) is MLS and covers voice and
video only - an ephemeral group of present participants, where a missed commit costs a moment of
media rather than permanently unreadable history.

**The MLS-native analogue exists and does not fit.** RFC 9420 §8.5's exporter secret is the
sanctioned hook, it is exposed in our WASM as `export_secret`, and we already use it -
`CallService` derives the WebRTC media keys with label `mls-webrtc-media-v2` (one per direction), which is exactly DAVE's
shape. But an exported secret is DERIVED FROM group state: using it requires being in the group, at
the right epoch, having processed every commit - and a newcomer could never read the past, because
they were not there at those epochs. It answers a different question.

**MLS keeps a job here, and it is the right one:** carrying the seeds. See §5.

**Re-measured 2026-10-21: the table above is the 2026-08-17 premise, and it no longer holds.** A
community key group now has 199 device seats and a group conversation 109, the latter carrying its
messages over MLS. The argument from the commit rate (point 2) still stands, and production measures
it: the 199-seat key group took 204 commits in two days. The numbers and what follows from them are on
[dm-vs-community-encryption](dm-vs-community-encryption.md#group-sizes---the-never-above-a-pair-premise-no-longer-holds).

## 4. The design

### 4.1 A seed per sender, per channel

Each sender owns its own outbound session for a channel; a message names the session it was
encrypted under. A channel-global epoch would need a coordinator, and that raises two problems this
design does not have:

- **Who rotates?** "An admin" makes rotation wait for an admin to be online; "anybody" lets two
  members mint two different `v(N+1)` at once. A race that heals is still a defect - here there is
  no race, because no two senders write the same session namespace.
- **When?** Rotation is lazy: on the next send after the membership it was shared with changed.
  Nothing must happen at the moment somebody leaves, and nothing is owed by a member who never
  speaks again.

  **"Changed" is implemented as "the key group's epoch moved", which a device JOINING also does.**
  On production that makes adds the dominant trigger: 845 sessions for 1 698 messages, and 69-98 %
  of a sender's messages more than an hour apart open a new session (measured 2026-10-21,
  [dm-vs-community-encryption](dm-vs-community-encryption.md#rotation---one-seed-per-two-messages-not-one-per-sender-per-week)).

A message key is `HKDF-SHA256(ikm = seed, salt = sessionId, info = "canari-graine-v1" || be32(index))`.
**It is DERIVED from the seed, not ratcheted** - the difference from megolm is deliberate and argued
in `deriveMessageKey` (`frontend/src/lib/crypto/graine.ts`): history is read by REST in whatever
order the reader scrolls, so an arbitrary index must be cheap, which is the one thing a forward
ratchet is worst at. What that buys and what it does not:

- a key recovered from ONE message opens exactly that message - each index is an independent HKDF
  output;
- whoever holds the SEED opens every index of the session, below a handover floor included. This
  page said "ratcheted per message" until 2026-09-28, which the code has never done.

### 4.2 Rotation does not delete anything

**Rotating a seed means the sender stops using it for NEW messages.** The old seed keeps decrypting
old messages, for ever, for everyone holding it - which is why the history bundle (§4.4) carries
every seed and not just the last. Rotation bounds the blast radius of one recovered seed; it is not
forgetting.

| Trigger | What it buys |
|---|---|
| **A leaf is removed** (any Remove merged since the mint, read from the key group's clean run since 2026-10-22: [graine-removal-tracker](graine-removal-tracker.md)) | The structural one. The leaver keeps what they could already read and gets **nothing said after they left**. Without it, leaving a community would change nothing |
| **A new user joins** (`ROTATE_ON_NEW_USER`, decided by the user 2026-10-22) | A newcomer is never handed a seed minted before it arrived, whose earlier indices it could derive. A new DEVICE of a user already present (by an Add or an external commit; user half of the leaf's credential, lower-cased) does not rotate: the session is re-distributed at the new epoch. The server checks that an external commit's leaf names the caller |
| **100 messages** (50 once re-distributed) | Slices a talkative sender, so one recovered seed does not yield years |
| **7 days** (24 hours once re-distributed) | The same for a rare sender, whom a message counter would never slice |

The last two cost only their bytes in the bundle. Values are Matrix's, which are field-proven.

**This table is where the triggers are distinguished, and the only place.** The client's
`graineOutboundVerdict` answers reuse, re-distribute or rotate, and the MLS layer logs WHY a run
reset (`[GRAINE] run reset reason=departure|new-user|gap|none`); before 2026-10-22,
`shouldRotateGraineSession` answered yes or no. It carried WHICH of the three fired as a typed value
until 2026-09-14 - `'no-session' | 'message-count' | 'age' | 'roster'` - and the sweep that removed it
found the value had no runtime consumer at all: nothing branched on it, the one string interpolating
it went to `console.info`, and nothing in this product captures a browser console into a durable log,
a report or an upload. A distinction nothing can read is a distinction nothing can act on, and it
read as a signal that existed. **If the rate of roster rotations should ever be watched - it is the
one that says a departure took a seed out of circulation - that needs a counter reaching somewhere a
human looks, not a return type**; the value would be the easy half of that work, and re-adding it is
a three-line change.

### 4.3 The transport: one MLS distribution group per community

Two facts, both checked 2026-08-17, rule out the alternatives: `mls-wasm` exposes **no HPKE**
seal/open, and a 1:1 MLS group **is a visible DM** (`dm_groups` has `isGroup` and no system flag),
so pairwise sealing would put 300 conversations in the sidebar and cost O(N) sends per rotation.

**Each community has exactly ONE MLS group containing every member's devices, carrying key material
only and never a message body.** A seed is distributed as a single MLS application message to that
group: **O(1) traffic per session, not O(N)** - which is the constraint that killed pairwise.

That O(1) is the SENDER's. The server still queues one row per recipient device seat, about 31 per
payload on 2026-10-21, and the key-group frames hold 883 MB of the 1.5 GB `queued_message` table,
against 1.5 MB for every channel message ever written
([dm-vs-community-encryption](dm-vs-community-encryption.md#o1-per-seed-is-true-of-the-client-not-of-the-server)).

This is not a return to §3. The distinction is total: the group carries SEEDS, not messages. A
device behind on commits misses a distribution and **requests the seeds it lacks** (§4.5) - a
lookup, bounded, repairable - where a device behind in a message-carrying MLS group loses the
history itself. The failure mode is the whole argument.

### 4.4 Joining, and what a share link is worth

**A share link carries no key material and never did.** It carries an opaque token; accepting it
writes a `channel_members` row. What changes is what that row is worth.

**Nobody has to be online to admit a newcomer.** `join_by_external_commit` is already in the WASM
(`lib.rs:603`) with `export_group_info` beside it, and `mls_group_info` is already a table: the
joiner adds THEMSELVES to the distribution group by external commit, against the group info the
server serves. This was the one real risk in the design and it is answered by machinery that ships.

Then the newcomer asks for history and receives, in **one message**, the bundle of seeds allowed by
the community's `history_visibility`. **The ciphertexts come from the server over REST exactly as
today** - and that is the whole reason channel history is cheap where DM history is not: the server
keeps every channel ciphertext durably, so nothing is replayed peer to peer. Order of magnitude for
a one-year community with 30 active senders rotating weekly: ~1 500 seeds x ~50 bytes ~= **80 KB, in
one message.**

**Both factors of that estimate were wrong by 2026-10-21.** A v2 seed is about 330 bytes on the wire,
not 50. The largest community minted 458 seeds in its first 8 days, because adds rotate (§4.1). Its
bundle is about 150 KB today, and the 8 000-seed cap was about 2.6 MB in one MLS message
([dm-vs-community-encryption](dm-vs-community-encryption.md#the-history-bundle---6x-heavier-per-seed-and-sized-for-the-wrong-rotation-rate)).

**An answer is bounded in BYTES and sent in pages (2026-10-22).** Every hop a bundle crosses was read
from code and config, and the binding one is the pending-queue page an offline device catches up in:

| Hop | Limit |
| --- | --- |
| `POST /api/mls/send`, nginx `client_max_body_size` | 100 MB |
| chat-delivery `bodyParser.json` | 10 MB of JSON |
| `queued_message.proto` (Postgres, no length) | 1 GB |
| Redis `chat:messages`, delivery to gateway | 512 MB |
| gateway to device WebSocket (tungstenite defaults on both ends, no override) | 16 MiB frame, 64 MiB message |
| **pending-queue page, `PENDING_PAGE_MAX_BYTES`** | **1 MiB of base64** (one larger row is still sent, alone) |
| ciphertext inlined in a push | ~3.7 KB: a page never fits, the device fetches it by `queuedMessageId` |

`GRAINE_BUNDLE_PAGE_MAX_BYTES` is **255 KiB** of encoded `AppMessage`, sized so that THREE pages fit
one pending page. The arithmetic, with the MLS framing MEASURED rather than estimated
([application_frame_overhead.rs](../../../frontend/mls-core/tests/application_frame_overhead.rs)):

| Quantity | Bytes |
| --- | --- |
| Pending page, base64 characters | 1 048 576 |
| Largest base64 frame of which three fit (1 048 576 / 3, rounded down) | 349 525 |
| Largest MLS frame giving it (4 x ceil(262 143 / 3) = 349 524) | 262 143 |
| MLS framing, measured (UUID group id, 0 B to 255 KiB plaintext; no padding configured) | 165 - 170 |
| A full page: 261 120 plaintext + 170 framing | 261 290 frame, 348 388 base64 |
| Three full pages | 1 045 164, **3 412 under** the pending page |
| What 256 KiB would have been: three frames of 349 752 | 1 049 256, 680 OVER |

The first version of this page said 256 KiB was "a third" without counting the framing, and three of
them did not fit; the test pins the framing under the 1 023 bytes 255 KiB leaves for it. A page is
about 1/29 of the 10 MB body limit.

An answer over the budget goes as `page_count` complete `GraineBundleMsg`s under one `request_id`,
numbered by `page_index`. When it pages, seeds are grouped by salon, so a salon is re-read by as few
pages as possible; `truncated` rides the last page only. **An answer that fits is one bundle with no
page numbers and its seeds in the order gathered**, so its bytes are exactly the pre-paging ones (the
grouping applies only to an answer that pages). 8 000 seeds is about eleven pages;
`GRAINE_HISTORY_BUNDLE_MAX_SEEDS` now bounds one answer's work, not one message
([bundlePages.ts](../../../frontend/src/lib/utils/graine/bundlePages.ts)).

**The history floor is read once per ANSWER, not once per page.** The floor that decides what an asker
may read (`seedsTheAskerMayRead`, one `graineHistoryFloor` call per salon) belongs to the GATHER step,
which runs before `pageGraineBundle`. Paging cuts what was already filtered, and a page carries no
check of its own. Moving that filter after the paging would cost one floor call per salon per page,
about eleven at the cap, so it must stay before.

**Pages need no reassembly, so nothing waits for them.** A receiver stores each seed on its own in the
durable seed store, keyed on the session id. Pages may arrive in any order. A duplicated page is
`already-held`: nothing is stored and no salon is re-read. A numbering that cannot be true is warned
about and the page is still absorbed. Each page names itself in the absorb line
(`page 2/5 of request r`).

**A lost page corrupts nothing, but it is not free.** It happens when the answerer's send fails
partway, and that failure is logged with how many pages went before it. Its sessions are missing, and
§4.5 hides a row whose seed is missing until the repair lands. That repair is asked for one session at
a time, as each row fails to open. For a HISTORY answer the loss is also recorded durably:
- `pagedHistoryAnswer.ts` keeps the ask's request id from the moment it is sent, so a page absorbed
  after a restart is still recognised;
- it marks each page absorbed only after its seeds are stored;
- it closes on the last page.

**The page numbers are untrusted.** The history ask goes out on the shared key group, so any member
(or a buggy client) can answer it with any `page_index` and `page_count`, a `uint32` each. The
receiver never allocates by them. A `page_count` above `GRAINE_BUNDLE_MAX_PAGES` is refused. That cap
equals `GRAINE_HISTORY_BUNDLE_MAX_SEEDS`, because every page carries at least one entry and an answer
carries at most that many. An index outside its count is refused too: its seeds are absorbed and the
absorb line warns once, but the page is not recorded. The record also belongs to the FIRST answer
recorded, meaning its sender and its count. A page from another sender, or with another count
(a forged "page 1 of 1" or "one message" included), is refused with a warning. Without that, one
forged page could close the record and cancel the re-ask. A stored count above the cap is read back
as no record.

At the next start `requestCommunityHistory`, which otherwise asks only while no seed is held, asks
ONCE more when that record names missing pages. That re-ask is spent only when it is sent, so an ask
that finds nobody online keeps it. A second incomplete answer is left to the per-session repair. The
trigger is the next start and the evidence is which page numbers arrived; no clock is involved. A
re-ask may duplicate pages still sitting in the queue at that start, which costs one more answer and
corrupts nothing.

**A reader that predates pages** decodes a page with a schema lacking fields 7 and 8 (protobufjs and
the native `proto_fields` reader both skip unknown tags), so each page is an ordinary bundle carrying
its own seeds. It absorbs them, writes one debug line per page, re-reads the salons each page adds to,
and warns `TRUNCATED` once, at the last page, when the answer was cut. No old reader asks again for a
history it already holds part of (`requestCommunityHistory` asks only when no seed is held).

`history_visibility` is per community, **`shared` by default** (a newcomer receives the past),
`joined` available for a sensitive salon. Two consequences to carry deliberately:

- With `shared`, a leaked link grants the past again - which makes the invite fixes (one live link,
  expirable, capped) structural rather than hygiene.
- The past is as available as the least careful member. **"Read the past" and "the past's keys
  disappear" cannot both be true**, in any protocol. This is the user's decision of 2026-08-17,
  recorded so it is not rediscovered as a flaw.

### 4.5 A missing seed is requested, and said out loud

A receiver meeting an unknown `sessionId` requests it over the distribution group.

**IT IS NOT RENDERED WHILE IT IS MISSING, AND THAT IS THE DECISION - corrected here 2026-08-19.**
This section used to require the opposite: a bubble reading "unreadable, key on the way", on the
argument that an empty salon and an unreadable salon are different facts. That argument is sound in
general and loses to a stronger one here: **a DM does exactly the same thing.** An MLS frame this
device can never open is logged as `LOST frame`, reconciled by asking the peer for what it holds,
and never shown (`setupMessageHandler.ts`). Two messaging systems in one product, failing two
different ways at the same moment, teach the user that a placeholder means something particular
about communities - which is false, and is a worse lie than the silence.

So the loss is reported where a loss belongs: `reportUnreadableChannelMessage` names the row, the
salon and WHICH of the three causes it was, classified from the error TYPE - a missing seed
(repairable, and the only one that asks a peer), a message sent before this device was given the
seed (the protocol working; asking would loop for ever on the same answer), or a real fault. The
row appears the moment its seed lands. **A page says it once**: history and search hand every row
of a page an `UnreadableRowTally`, which prints one warn per class - count, distinct causes, three
row ids - where a salon older than this device's seeds used to print 200 identical lines per load
(2026-09-28). A live frame is one row and still says so itself. **Do not add a placeholder to one of the two systems
without adding it to both**, and that is a product decision, not a protocol one.

A request names WHO must answer, so that N members do not all answer at once and no election is
needed: **the session's own sender always holds its seed**, so the request is addressed to them. If
they have left the community or have no device online, it is addressed to the ONLINE member with the
lowest user id; with nobody online, the request waits for one to come back. Both rules are
deterministic, need no clock and no coordination, and leave nothing for a race to decide - see
[WP-33](#wp-33-and-the-answerer-nobody-elects) for why presence is part of the rule. Since
2026-10-12 the request also names the devices of that user that can read it, and each answer goes to the
requesting device only, never to the whole group
([section 23](#23-a-seed-answer-goes-only-to-the-device-that-asked---fixed-2026-10-12)).

### 4.6 Ordering rule: remove, THEN distribute

When a sender rotates because a member left, the removal commit on the distribution group must land
**before** the new seed is published to it. Publishing first would hand the new seed to the very
member the rotation exists to exclude. The two are one operation, in that order, or the rotation is
decorative.

Between the departure and the first send by anybody, the leaver is still a leaf of the distribution
group - and that is harmless, because no new seed exists to receive. Nothing has to happen at the
moment of departure, which is what makes the lazy rotation safe.

### 4.7 Reactions become messages

`reactions` is a `Record<emoji, userId[]>` jsonb in the clear. After Graine the server could not
read "j'arrive" but would still see that eight people put 👍 on it. That is content, and an
exception like it hollows out the guarantee.

**A reaction becomes an encrypted channel message**, reusing the convention DMs already have:
`ReactionMsg` exists in the proto with `message_id`, `emoji`, `at` and `removed`, and its
last-write-wins merge on `at` already handles a removal reaching a device that holds a stale
placement. Clients aggregate; the `reactions` column and its REST endpoint go. It must be sent
**silent**, or every 👍 becomes a push.

**Polls stay as they are, and deliberately.** The question and the option labels are already
end-to-end encrypted in `PollMsg`; only opaque, label-free option ids are mirrored server-side so a
tally can be closed without the server ever seeing what an option said. That design is already
correct.

### 4.8 What stays in the clear, stated rather than discovered

| Field | What the server sees | Why it stays |
|---|---|---|
| `authorId`, `channelId`, `createdAt` | who spoke, where, when | It routes and notifies; unavoidable |
| `replyTo`, `pinned`, `attachments` | thread shape, that an attachment exists | Metadata; the blob and its CEK become opaque |
| `mentionedUserIds` | **who** is mentioned | Already deliberate and documented in the DTO - it is what serves the `mentions` notification level without decrypting |
| `senderSessionId` | which Graine SESSION sealed the message | The recipient selects the session with it; without it there is nothing to decrypt with. Marginal over `authorId`: it links a sender's messages to one device/session |
| `messageIndex` | the ratchet position of that message | The recipient needs the step to derive the right key. It reveals how many messages that session has sealed, and makes gaps and reordering visible to the server |
| `metadata.poll.votesByUser` | who voted for which **opaque** id | Already correct, see §4.7 |

**The last two were found by MENTION-6 on 2026-08-22, not written down in advance**, which is the
failure this table exists to prevent - it is titled "stated rather than discovered". The check asserts
the send body carries the documented set AND NOTHING MORE, so it failed on two fields that are
perfectly legitimate and simply undocumented; it also still expected `keyVersion`, which Graine
removed. Both are cleartext routing metadata rather than content, and neither is avoidable: an
encrypted payload nobody can select a key for is not a message. They belong here all the same,
because "the server cannot read the content" and "the server learns nothing" are different claims and
only the first one is true.

### 4.9 Notifications keep working, and the mirror gets a bound

Push already carries the ciphertext inline and decrypts natively from `channel_keys.json` - a map
`channelId -> { keyVersion -> base64(key) }` written by the foreground WebView. Graine changes the
inner key from an epoch NUMBER to a session ID, which the Kotlin side already reads as a string.

Two things it does NOT survive unchanged:

- **The mirror must be bounded.** Epochs were few; seeds accumulate for ever. The native mirror
  exists only to decrypt INCOMING pushes, so it keeps the most recent N seeds per channel while the
  durable set lives in the local store (§4.9). Unbounded growth in an app-private JSON file written
  on every rotation is a defect waiting for a year to pass.
- **A brand-new seed may not be mirrored yet** when its first push arrives. The existing degradation
  - a generic "new message in #channel" - already covers it, and that is the correct outcome rather
  than a new mechanism.

  **THAT PARAGRAPH DESCRIBED A RACE, AND WHAT PRODUCTION DID IS A STATE - corrected 2026-09-20,
  fixed on Android 2026-09-21.** The mirror had ONE writer, the foreground, so a session minted
  while the app was not running was blind for EVERY message it sealed, not for the first. The push
  service now writes it too, deciding on the frame's KIND rather than on `silent`: see
  [§14](#14-the-seed-was-pushed-to-a-shut-phone-and-the-push-service-threw-it-away-unread---fixed-2026-09-21-android).

### 4.10 Seeds must become durable, which they are not today

`ChannelKeyVault` was **in memory only**, and that was sound while it lasted: the server re-served
every epoch key on load, so losing the vault cost nothing. **After Graine the server has nothing to
re-serve**, so a lost seed is history a member can only get back by asking a peer. (The vault itself
was deleted in WP-50 - this section is why the store that replaced it is durable.)

Seeds therefore move into `IStorage` (IndexedDB on web, SQLite on mobile), encrypted with the device
key like messages and outbox entries, and into the backup export/import path beside them. Channel
MESSAGES stay unpersisted - `useMessaging` deliberately skips the DB for a `channel_` conversation
because channels are server-authoritative - so this adds a store, it does not change that decision.

Three consequences of "like a message" that are NOT optional, and are each implemented (WP-13):

- **Every place that re-keys message rows must re-key seeds**, or a PIN change destroys them - see
  the Phase 2 findings in §6.
- **The clear columns must be enough to PURGE without the device key.** `workspaceId` and
  `channelId` stay in the clear precisely so leaving a community can erase its seeds at logout, when
  the key is gone. A purge that needed the key could not run when it most has to.
- **The backup carries seeds still sealed**, and restores them on a second device as well as on the
  same one. The device key is PIN-derived, so it is the same key there; and unlike a conversation -
  forced to `pending` on a second device because that device is not yet an MLS member - a seed
  carries no membership, it is a symmetric key that opens exactly what it always opened.

## 5. Migration: a clean cut

Existing ciphertext is under server-derivable keys, so it cannot be carried over without carrying
the flaw. **Decided by the user 2026-08-17: at cutover every community and all its content are
deleted.** That removes the legacy read path, the dual-version window and any re-encryption pass in
one stroke - and it is the only option consistent with "no message readable by the server", since
leaving the old history in place would contradict the requirement outright.

`channel_messages` has **no retention at all** - no cron in social-service touches it - so nothing
would age this history out on its own. The cut is the only thing that removes it.

**The three remaining questions were answered by the user on 2026-08-18. None is to be re-opened.**

- **The cut deletes EVERYTHING**: communities, channels, members, roles, invitations and messages.
  Not the shells-minus-messages variant. Everyone recreates their community and re-invites.
- **It runs SILENTLY, at deploy**, with no in-app notice before it - the user has already warned
  people out of band. So the migration is a plain step of the release that turns Graine on, and
  there is nothing to build for it beyond the deletion itself.
- **`channel_messages` gains a ONE-YEAR retention window**, which is new: today it has none. One
  year covers a full associative cycle, and it bounds what a history bundle can usefully cover -
  seeds older than the messages they open are dead weight. **Measure the storage cost on
  [storage-forecast](../infrastructure/storage-forecast.md) BEFORE writing the sweep**, and build
  the sweep the way the ninety-day one was rebuilt: trimmed by DATE on write, in the same round
  trip, never a timer pushed back by activity.

**The announcement modal is NOT part of this.** The user asked for one (an admin-published message
shown once per account at the next opening) in the same breath, but explicitly not as a warning
before the cut. It is its own item - see [backlog](../backlog.md).

## 6. The work packages

Every package is one commit with its tests, its logs and its wiki line. Ordered so that each one is
independently reviewable and nothing is half-migrated between two of them.

### Phase 0 - clear the decks

- **WP-00** Finish and commit the storage panel already in the working tree. A protocol change must
  not start on top of an unfinished one.

### Phase 1 - governance (independent of crypto, ships first to keep the crypto diff readable)

- **WP-01** `leaveWorkspace` refuses the last admin, and deletes the community when the last member
  leaves - one transaction, both checks.
- **WP-02** `kickFromWorkspace` consults the TARGET's roles and refuses to remove the last admin.
- **WP-03** `updateWorkspaceMemberRole` refuses to demote the last admin, including oneself.
- **WP-04** `acceptWorkspaceInvite` refuses a community with no members, so no link can resurrect an
  admin-less one.
- **WP-05** `createWorkspaceInvite` returns the live token instead of minting; minting a fresh one
  revokes the previous, so "the link" is one object a human can reason about.
- **WP-06** Invite expiry and use cap in the API and the form, with i18n. Both columns exist and
  `inviteIsValid` already honours them; only the UI is missing.
- **WP-07** Re-run the audit queries on prod and record that no 0-member and no 0-admin community
  remains.

### Phase 2 - Graine foundations (pure additions, nothing switched on) - **SHIPPED 2026-08-18**

- **WP-10** Shared constants: `canari-graine-v1`, rotation thresholds, bundle limits, in one module
  per side so no second copy can drift.
- **WP-11** Proto: `GraineMsg` (`channelId`, `sessionId`, `seed`, `firstIndex`, `createdAt`),
  `GraineRequestMsg`, `GraineBundleMsg`. Regenerate both bindings. Fix the false `MediaMsg` comment
  in the same change.
- **WP-12** `graine.ts`: seed to per-message key, `deriveMessageKey(seed, index)`, with test vectors.
  Pure, no I/O, no storage - the piece that must be provably right in isolation.
- **WP-13** Durable session store in `IStorage`: save/get/prune, device-key encrypted, on BOTH
  backends, plus backup export and import rows. Tests on each backend.
- **WP-14** Native mirror keyed by `sessionId` with a **bound** on retained seeds per channel: Rust
  command, Kotlin reader, Swift reader.

**What Phase 2 turned up, and where it landed.** Two things were found by writing the store rather
than by reading the design:

1. **A PIN change would have silently destroyed every seed.** `performPinChange` re-encrypts messages
   and the MLS state under the new device key; a seed sits under the same key and was in neither
   list. For a message the loss is invisible - the server re-serves it - so the omission had never
   cost anything. For a seed there is nothing to re-serve, so it would have been permanent, and the
   user would have seen it as "my channel history stopped loading" long after the PIN change.
   `reencryptGraineSessions` closes it, next to the message pass and before the new key is adopted.
   The rule generalises beyond Graine and is in [durable-rules](../durable-rules.md). **It closed
   only one of the two paths**: the recovery after a PIN changed on another device never re-sealed
   a seed, until both went through one `resealDeviceKeyStores` (2026-10-15,
   [auth](../frontend/modules/auth.md#what-the-device-key-seals-and-what-a-pin-change-does-with-each)).
2. **The SQLite v7 branch stamped `SCHEMA_VERSION` rather than `7`** - the exact mistake the comment
   in the v6 branch above it warns against. Harmless only while 7 WAS the latest; the bump to 8 is
   what would have fired it, silently skipping the new migration on every database that had ever run
   v7. Fixed in the same change.

**What "tests on each backend" actually means here.** IndexedDB is tested for real
(`graineStore.test.ts`, on `fake-indexeddb`, since happy-dom ships no IndexedDB): real cursors, real
indexes, real version migration. SQLite cannot be opened without a live Tauri SQL plugin, so what
holds the two implementations together is the shared codec both go through (`graineCodec.ts`), tested
on its own - the same split `sqliteBatch` and `sqliteMigrations` already use. **Say this rather than
letting "tested on both backends" be read as more than it is.**

### Phase 3 - the distribution group

- **WP-20** `dm_groups` gains a community-distribution kind, hidden from every conversation surface.
  The risk is the ENUMERATION, not the flag: every path that lists, counts, badges, notifies or
  syncs a group must be found and audited, not just the sidebar. **DONE 2026-08-18** - the audit
  and its result are below.
- **WP-21** Server: the group is created with the community, published through `mls_group_info` for
  external join, and its membership tracks `channel_members`. **DONE 2026-08-18** - the design and
  what it turned out to cost are below.
- **WP-22** Client: external-join on first use, ignore the group in the conversation pipeline, route
  its messages to the Graine handler. **DONE 2026-08-18** - below.

#### The WP-20 audit, and why it came out short

The marker is `dm_groups.distributionWorkspaceId` - **the community's id, not a boolean**. It answers
"which community", which every later decision needs anyway, and a partial unique index on it makes
"exactly one distribution group per community" a fact the DATABASE enforces: a second creation fails
loudly instead of producing two groups each holding half the members.

**Two invariants make the enumeration tractable, and both must survive WP-21:**

1. **A distribution group holds NO `dm_group_members` rows** - it is joined by external commit, and
   authorisation comes from community membership. Every path that starts from a user's memberships
   therefore never reaches it, which is most of them. **WP-21 must build the delivery recipient set
   from `channel_members` without writing membership rows**, or this audit is void.
2. **`GET /mls/users/:userId/groups` is the ONE place a client learns which groups exist.**
   Discovery, lifecycle classification, sync eligibility, the sidebar, badges and
   `initializeConnection` are all fed from that single answer, so the exclusion lives there and
   nowhere else. Excluding it at each consumer would be a rule every future consumer has to
   remember, which is the shape of rule the next call site does not.

Invariant 1 is an assumption, so it is **detected rather than trusted**: `getUserGroups` partitions
instead of filtering in SQL, and `logger.warn`s if a membership row on a distribution group is ever
seen. A `WHERE ... IS NULL` would have made the count a subtraction, and a subtraction cannot tell a
distribution group from a membership pointing at a row that is simply gone - two situations needing
opposite responses. **The exclusion working is not the same as nothing being wrong.**

Every other reader of `dm_groups`, and why it needs no change:

| Site | What it does | Verdict |
| --- | --- | --- |
| `members.controller` `getUserGroups` | the conversation list | **excluded here**, with the warning above |
| `devices.controller` `registerDevice` | pending `DeviceGroupMembership` per membership row | unreachable by invariant 1 - and correct if it ever were, since a Welcome nobody sends is exactly what external join avoids |
| `internal.controller` account deletion | partitions the user's groups on `isGroup` | unreachable by invariant 1 |
| `app.controller` `cleanupSoftDeletedGroups` | purges tombstones past 90 days | correct unchanged - a distribution group is an MLS group and its tombstone ages the same way |
| `app.controller` `cleanupOrphanedRedisGroups` | id-scoped existence check | correct unchanged |
| `messaging.service` `purgeOrphanGroups` | id-scoped existence check | correct unchanged |
| `groups.controller` rename / avatar / delete | acts on an explicit `groupId` | never named - no surface offers one |
| `invitations.controller`, `utils/group-invite` | acts on `invite.groupId` | never named - no invite targets one |
| `calls.service` | reads `name`/`isGroup` for a call notification by id | never named - one cannot be called |

**What this audit does NOT cover: the client.** Nothing client-side changed in WP-20, because
nothing client-side can see the group - it is absent from the only list the client is given. That
holds only while WP-22 keeps the Graine layer's access deliberate and separate; the moment the
distribution group enters `getUserGroups`, every row above is back in question.

#### WP-21, and the gate it had nowhere to live

**Invariant 1 has a consequence nobody had priced: chat-delivery cannot authorize anything about a
distribution group.** All three of its MLS gates - `getCommitsSince`, `getGroupInfo`,
`storeGroupInfo` - answer one question, "is there a `dm_group_members` row", and by construction
there is not. Left alone, the group would have been unusable by everyone including its own members.

The roster that governs it is COMMUNITY membership, which lives in social-service. So the decision
is made there, and the call goes the direction it already goes:

| | |
| --- | --- |
| Who authorizes | social-service, against `channel_workspace_members`, in `assertWorkspaceMember` |
| Who holds the group | chat-delivery, `dm_groups."distributionWorkspaceId"` |
| How they talk | `POST/GET/DELETE /api/internal/mls/distribution-groups[/:workspaceId]`, `X-Internal-Secret`, never through Nginx |
| What the client calls | `GET|POST /api/channels/workspaces/:id/distribution-group[/group-info]` |

**Three alternatives were rejected, each for one reason:**

- **Write `dm_group_members` rows anyway** - the gates would all work untouched. Rejected because it
  voids the WP-20 audit: `registerDevice` would mint a pending `DeviceGroupMembership` per row and
  the `getUserGroups` warning would fire on every request, having been written to mean the opposite.
- **Mirror community membership into chat-delivery** - a local table, fed by social-service on join
  and leave. Rejected on drift: a mirror that misses one removal leaves a former member reading
  seeds, and it heals only when somebody notices. *A race that heals cleanly is still a defect;* one
  that does not heal at all is worse.
- **Let chat-delivery ask social-service per call** - no drift, but it puts a network hop inside an
  authorization path, needs a fourth `deliveryUrl`-shaped helper pointing the other way, and adds a
  fail-closed branch to a service that has none. The proxy costs the same and keeps the decision in
  one service.

**THE GROUPINFO IS THE CAPABILITY.** Anyone holding it can external-join, so handing it out IS the
authorization decision - which is why it is the thing social-service gates, and why chat-delivery's
public `GET /mls/group-info/:groupId` is left refusing distribution groups rather than taught about
them. A member removed from the community must still be removed from the MLS group (WP-30's
rotation-on-departure); no server-side check substitutes for that.

**AND THE COMMIT IS ASKED THE SAME QUESTION (WP-KEYGROUP-JOIN-GATE, 2026-10-22) - the third
alternative above, taken after all, for the commit alone.** Gating the GroupInfo decides who may
READ the base; it does not decide who may COMMIT, and an accepted external commit also promotes its
committing device to `active`. So chat-delivery's commit gate now asks social-service, per key-group
external commit, `POST /internal/distribution-groups/entitlement` (`kind`, `scopeId`, `userId`).
Social-service answers with the SAME predicates as the routes that serve the GroupInfo
(`isDistributionGroupEntitled`: a community's members; a private salon's readers). A conversation's
external commit keeps its own roster check, and a member commit never reaches social-service.

**Before either check, an external commit must join AS the caller's device** (2026-10-22): its path
leaf, read in the clear by `readCommitFrame`, must name `<authenticated caller>:<deviceId>`, the same
binding every KeyPackage upload is held to; otherwise `403 commit_identity_mismatch`. Graine's rotation
reads the user from that leaf's own credential ([graine-removal-tracker](graine-removal-tracker.md)).

| Outcome | What the commit gate does |
| --- | --- |
| `{ entitled: true }` | accepts; the epoch moves and the committer is activated |
| `{ entitled: false }` | `403` (`code: NOT_A_MEMBER`, `error: committer_not_member`), before the epoch moves |
| anything else (secret unset, unreachable, non-2xx, no boolean) | `503 entitlement_unavailable`, before the epoch moves - never an acceptance |

The objection recorded above - a fail-closed network hop inside an authorization path - is paid
deliberately: the hop happens only on a key-group EXTERNAL commit (~77/day measured 2026-10-22), and
the client already reads any failed submission as `unreachable`, claims nothing about membership, and
joins again on its next recovery pass. A key group's Welcome TARGET is asked the same question in
`sendWelcome`, since a grant is written in social-service before the granting device Welcomes anyone
(a conversation's Welcome target must be on its roster instead). Code:
`apps/chat-delivery-service/src/internal/distribution-entitlement.ts`,
`apps/social-service/src/internal/internal-distribution-entitlement.controller.ts`.

**A seat is written against a CLAIM, under one per-group lock, and no HTTP call runs under it
(2026-10-22).** The gate's answer is read before the epoch moves, but the seat is written later, so a
departure could run in between. `apps/chat-delivery-service/src/utils/seat-eviction.ts` closes that
window with a durable row and a lock:

- **The generation is the group's.** `dm_groups."seatGeneration"` (migration `036_seat_evictions.sql`)
  is moved by every eviction of ANYONE from the group, first thing under the lock
  (`bumpSeatGeneration`). Nothing naming an account has to survive for an earlier claim to be
  refused, so an account erasure deletes the account's rows below. **The cost, accepted:** a claim
  in a group where someone else was evicted meanwhile is refused once (`evicted_since_claim`) and its
  writer retries with a fresh claim - evictions are rare, and an overtaken claim already meant one
  refusal and a retry.
- **The row.** `dm_seat_evictions`, one per (group, person): a `generation` of that person's
  evictions and `owedDeparture`, the NAME of a key group's departure in progress (the person's
  generation of the eviction that began it), or null. It refuses a claim only through
  `owedDeparture`; naming a departure is all it is still for.
- **The lock.** A transaction-scoped Postgres advisory lock on `seat:<groupId>`, released by the
  commit or the rollback and never by a clock. Every writer that evicts or creates a seat holds it:
  `evictFromDistributionGroup` (`evictSeats`), `removeGroupMember` (the conversation removal, its
  roster write and its eviction record in one transaction), the commit's advance (its admits), an
  account erasure (`eraseSeats`, per group), the commit's advance for its own committer (written in
  that transaction, so an accepted commit never leaves a leaf without its seat),
  `activateDeviceMembership` for a key group's publisher, and the two writers of a `pending` seat - a device
  registration and an invite acceptance (`writePendingSeats`, shared, against the group row and the
  roster re-read under it).
- **One order.** Every writer takes the seat lock, then the `dm_groups` row, then
  `dm_group_members` and its interval, then `queued_message`, then `dm_device_group_memberships`, and
  writes `dm_seat_evictions` last; an eviction's `dm_groups` write is its generation, so it comes
  first. A group's end (`GROUP_OWNED_TABLES`) deletes in the same order: the tombstone writes the
  group row first, and the 90-day reaper locks it `FOR UPDATE` before deleting what it owns. It is
  written once, in `utils/seat-eviction.ts`.
- **The epoch moves from the base the gate read, or not at all.** The gate reads the epoch outside
  the advance's transaction, and the advance may wait on the seat lock. The advance is
  `UPDATE ... WHERE "activeEpoch" = base`: of two commits at one base, the second matches nothing and
  is refused `epoch_mismatch`, whatever the Redis commit lock's 5 s did. A commit-log row already
  holding that base refuses the advance too, so the log and the epoch never disagree.
- **The claim.** Before the check that decides a seat (the roster, or
  `isEntitledToDistributionGroup` over HTTP, always outside the lock) `claimSeat` reads the group's
  generation and the person's `owedDeparture`. Under the lock `seatClaimHolds` re-reads both - a
  database read only - and the seat is written only if the generation has not moved and no departure
  is owed. An eviction therefore ran before the claim
  (the check sees it), between claim and write (nothing is written), or after the write (it deletes
  the seat). An activation without a claim is refused and logged at error. The commit gate reads the
  claim too: a key-group external commit whose author has a departure in progress is refused there
  (`NOT_A_MEMBER`, logged `reason=departure_in_progress`) before the epoch moves, without asking.
- **A report promotes under the same lock, and every Redis route follows the commit.** The report's
  one conditional UPDATE (`promoteReportedSeat`) runs under the seat lock. The route
  (`group:members:<g>`) is then written by `routeActiveSeat`, after the seat's own transaction
  committed, under the lock again and only if the seat is still `active`. The gateway reads that set
  alone - its live broadcast and its election of a peer to answer a request re-check nothing in the
  database (chat-delivery's queued fan-out reads the active rows) - so a route written for a seat an
  eviction already deleted would keep a device reached. The two other route writers - a send's
  reconciliation of the set (`MEMBERS_CACHE_REPAIRED`) and an election door's reload of an empty one
  (`MEMBERS_CACHE_RELOADED`) - find the missing entries first (`SMISMEMBER`) and add only those still
  `active` when re-read under the seat lock (`restoreRoutes`).
- **A send's queued rows cannot outlive a seat.** A send reads its recipients with no lock; its queue
  write (`enqueueForLiveGroup`) takes the seat lock SHARED before the group row, re-reads who still
  holds a seat and queues and delivers only to them (a commit's removed devices excepted, logged
  `SEAT_GONE_NOT_QUEUED`). An eviction waits for the write and its delete then takes those rows; sends
  into one group never wait for each other.
- **A commit re-reads its claims in the advance's transaction, and an overtaken one refuses it
  whole.** Under the seat lock, before the epoch moves, the committer's claim (an external joiner, or
  a member whose seat is not yet `active`) and each admit's are re-read. A claim an unrelated
  eviction overtook (`evicted_since_claim`: the group's generation moved) refuses the WHOLE commit
  with a 409 `SEAT_CLAIM_OVERTAKEN` (`seat: committer|admit`): nothing advances, and the client
  rebuilds and resubmits at once on a fresh claim. That holds for EVERY commit, an ordinary
  conversation's included - a pending member's own add or remove carries a committer claim too - so
  the rebuild lives in `runCommitTransaction` itself (up to `SEAT_CLAIM_OVERTAKEN_MAX_ATTEMPTS`
  submissions), with the external join's attempt loop and `admitNewcomer`'s tree re-read above it.
  Each such refusal proves an eviction landed in between, which is what bounds the retries. A departure in progress still refuses an external join
  (`NOT_A_MEMBER`, `reason=departure_in_progress`): no leaf enters the tree for a person with no seat.
- **A device row that ADMITS a device is inserted only beside its key package, read under the
  lock.** Every such writer reads the device's `KeyPackage` row `FOR SHARE` under the seat lock first
  (`heldKeyPackages`): `writeClaimedSeat` (the committer's seat, an activation, the group's creator -
  which also checks the revocation denylist), a commit's admits (`ADMIT_REFUSED reason=no_key_package`;
  the admit is dropped and the commit accepted, since the leaf belongs to an account that is going or
  a device revoked while the Add was in flight, and the accept names it in `refusedAdmits` so the
  committer owes and sends it no Welcome - [mls-protocol](mls-protocol.md#a-device-the-gate-did-not-admit-is-owed-no-welcome---the-commits-answer-says-so-2026-10-25)),
  both Welcome stores (`lockWelcomeSeat`) and `writePendingSeats`. **Two known exceptions.** The
  demotion (`deactivateDeviceMembership`, the stale-device cron among its callers), deliberately:
  it upserts a `pending` row without that read - the cron demotes precisely a device with no recent
  key package - and removes the route itself. And the creation bootstrap of `addGroupMember` (a
  caller enrolling ITSELF into an empty roster), which writes the roster row and `pending` seats
  with no seat lock. Since ADM-3 (2026-10-25) the route enrols nobody else: another person's device
  rows go through `writePendingSeats` under the seat lock, or the route refuses
  ([backlog](../backlog.md), P2 "addGroupMember can enrol an erased account after the final erasure
  pass", narrowed). An account erasure deletes the account's key packages FIRST, in a
  transaction of its own, so a writer either holds one and the delete waits for it - its row is
  then there for the erasure's discovery - or finds none and writes nothing. The erasure cuts every
  group it found, under each group's seat lock (`eraseSeats`: rows, queue and routes together), so
  a run interrupted anywhere leaves what it had not cut still named by a row for the retry.
  **The ordering does not stop the account itself**: every (re)connection republishes its key
  package (`register-device`), and a token issued before the deletion is honoured for up to an
  hour. So the roster rows go once every group was cut (`writePendingSeats` seats a registering
  device only where its owner is on the roster), and the run ends with a SWEEP - the key packages
  deleted again, then every group a device row names NOW cut through the same `eraseSeats`. **No
  device row is deleted outside `eraseSeats`**, because the row is what names the route: a seat
  admitted after the sweep's read stays whole, row and route, for the FINAL PASS, which core starts
  once every token expired, so no republish can follow it - termination is that pass's, never the
  ordering's ([account-erasure](../account-erasure.md)). After it, only a demotion's route-less
  `pending` row can appear, naming a device with no key package, which `cleanupStaleDevices`
  collects. Proven on PostgreSQL in `seat-lock.integration.spec.ts` ("a key package republished
  after the first delete", "a seat admitted after the sweep's read"). `recordSeatEviction` creates no row for an account it is not beginning a
  departure for, so an eviction after the erasure leaves nothing naming it.
- **A key group's admits are asked like a join.** An admit writes a `pending` seat its device later
  promotes by reporting itself, so in a key group each admitted person is asked of social-service
  (`claimKeyGroupAdmits`, before the commit lock) against a claim re-read under the seat lock: not
  entitled or departing is `ADMIT_REFUSED`, evicted since is the whole-commit 409 above. The group's epoch is read first, so a
  commit on another epoch is answered `epoch_mismatch` without asking anyone; the distinct people are
  then asked in parallel. Unanswered is a 503 for the whole commit, before the epoch moves.
- **The Welcome store and the key-group eviction take the same seat lock.** A key group has no roster
  row in chat-delivery, so a Welcome's target is asked of social-service (`resolveWelcomeTarget`)
  against a claim read before the question. Both stores re-read that claim under the seat lock - a
  sent Welcome in `enqueueForLiveGroup` (shared), a commit-carried one in the advance's transaction -
  and refuse `welcome_target_not_member` (`reason=evicted_since_claim` or `departure_in_progress`)
  when an eviction overtook it - unless the target is also the commit's admit, whose overtaken claim
  has already refused the whole commit with the 409. The target's `pending` row is written in that same transaction
  (`ensurePendingSeat`), so an eviction either runs wholly before the store or deletes what it wrote.
  Evictions and removals end the device rows and the queue through `endDeviceMemberships`, under the
  lock.
- **One departure function, two evictions, a named outcome.** Every departure in social-service -
  `leaveWorkspace`, `kickFromWorkspace` and the account erasure (`removeFromWorkspace`, the community's
  group and every private salon naming the person), `leaveChannel`, `removeMemberFromChannel`,
  `updateChannelAccess` - goes through `ChannelService.departDistributionGroups`. It evicts BEFORE the
  roster write (so a failed eviction aborts a departure that is still retryable), and chat-delivery
  answers the departure's name; the roster write and a `departed` row in `distribution_departures`
  (social migration `108`) commit in ONE transaction; then it evicts again with
  `?phase=after_roster_write&departure=<name>`, which settles that departure and no later one.
  `updateChannelAccess` computes who it cuts from the list the CLIENT edited, so it names the access
  revision that list was read at and is refused `409 CHANNEL_ACCESS_CHANGED` when the salon moved
  since - otherwise a stale settings panel cut whoever was granted after it loaded
  ([social-service](../services/social-service.md#an-access-rewrite-names-the-revision-it-edited-2026-10-25)).
- **The drain asks for an OUTCOME, never the entitlement.** A failed second eviction is logged
  `[KEY_DISTRIBUTION] second eviction FAILED` and the departure stays owed. The hourly sweep
  (`drainOwedSeatEvictions`, `[SEAT_DRAIN]`) asks social-service how THAT departure ended
  (`internal/distribution-groups/departure-outcome`). The entitlement could not answer: it says `true`
  both before the roster write commits and after a rejoin, and settling on the first lets a seat be
  written for a person whose departure then commits. The question decides: with no `departed` row
  yet, social-service writes `cancelled` under the same primary key, so the roster write can no
  longer commit under that name (it is refused with `DEPARTURE_SUPERSEDED` and rolls back; the person
  stays a member). The drain applies the outcome under the seat lock only if that departure is still
  the one owed: `departed` cuts again and settles, `cancelled` settles. It re-reads the row right
  before asking and skips one that is gone (an account erasure deletes it). A person no longer
  entitled with nothing recorded is answered `departed` and NOTHING is written - no roster write can
  restore them under that name, and an erased account's id is not written back after its erasure.
- **A rejoin after a lost second eviction waits for the drain - deliberately.** While a departure is
  owed, every claim of that person is refused (`departure_in_progress`), so a person who left, whose
  second eviction was lost, and who is then re-admitted cannot join the key group until the next
  hourly pass settles that departure. It is NOT settled at the claim: settling means asking the
  departure's outcome, and the question DECIDES an undecided departure `cancelled` - so a join
  attempted by the departing person's own client, while an admin's removal of them is still in flight,
  would cancel that removal. The drain asks only of a departure its second eviction left behind, at
  most an hour late; the client's recovery pass retries the join, and nothing is lost but the wait.
- **An abandoned departure is settled at once.** When a later first eviction or the roster
  transaction fails, `departDistributionGroups` decides each departure it had begun (`cancelled`, the
  person still on the roster) and calls
  `POST mls/distribution-groups/:scope/:scopeId/members/:userId/departures/:departure/cancel`, which
  settles it under the seat lock and evicts nothing (`settleCancelledDeparture`). Each step logs; one
  that fails is left to the drain, and the original error is rethrown. The leaving user sees
  `DEPARTURE_SUPERSEDED` as a retry sentence (`chat_community_departure_retry_error`).
- **The roster write holds the community's removal lock.** Its transaction opens with
  `pg_advisory_xact_lock(hashtextextended('community_removal:' || <workspaceId>, 0))`
  (`COMMUNITY_REMOVAL_LOCK_SQL`); every caller passes the community the departure belongs to. A
  caller may re-check a permission inside `rosterWrite` against writes serialised on that lock; a
  refusal thrown there rolls the transaction back (no `departed` record, no roster change) and ends
  as an abandoned departure, settled `cancelled` above. The first evictions run before the
  transaction, so no HTTP call is made under the lock. Proven on PostgreSQL
  (`distribution-departure.integration.spec.ts`, "a refusal re-checked under the community removal
  lock").
- **Records end with their group.** A community's deletion deletes the `distribution_departures` rows
  of its group and its salons' groups in its transaction; a salon group retired deletes its own; an
  account erasure deletes the account's (`account-erasure.ts`). chat-delivery's `dm_seat_evictions`
  rows go with their group's purge and with the account's erasure, whose chat-delivery part runs only
  once social's part - the removals that write those rows - has completed
  ([account-erasure](../account-erasure.md#ordering-failure-classes-and-operating-it)).
- **A rolling deploy.** Both migrations (036, 108) are applied before any service is replaced
  (`deploy-environment.sh` runs `apply_migrations` first). A first eviction answered by an older
  chat-delivery names no departure: social-service logs `first eviction named NO departure` and evicts
  plainly after the roster write. An older social-service never names one either, so a newer
  chat-delivery's departure begun by it stays owed until the drain asks, and is answered from the
  roster as above.

The interleavings are asserted without a clock in `messaging.commit-log.spec.ts` ("against a
departure that races it": an eviction while the activation holds the lock, a stale HTTP answer after
the whole departure, an activation between the two evictions, a late settlement against a newer
departure, the drain, the admits), in `messaging.one-active-writer.spec.ts` (a report under the lock,
no route for a seat evicted after its commit), in `members.controller.exclusions.spec.ts` (the
removal's order under the lock), and in social-service's `distribution-group.spec.ts`: the order
`evict -> roster -> evict&departure`, the erasure taking the same path, the abandoned departure's
settlement and the rolling-deploy path. The first-writer-wins race is run against PostgreSQL in
`distribution-departure.integration.spec.ts` (a transaction held open, the other side waited on
through `pg_blocking_pids`, then committed or rolled back): the question asked while the roster write
is in flight reads `departed`, or `cancelled` when it rolls back; a roster write arriving while the
question is in flight is refused with `DEPARTURE_SUPERSEDED` and the member stays. chat-delivery's
seat lock is run against PostgreSQL (migration 036 applied) in `seat-lock.integration.spec.ts`, CI job
`test-chat-delivery-integration`: a claim overtaken while it waits on the lock, a departure refusing claims
until settled, a send's queue write waiting for an eviction and queueing nothing for that seat, an
eviction waiting for a send and deleting what it queued, two sends not waiting for each other, a
route restore waiting for an eviction and writing nothing, a claim refused after a whole account
erasure with no eviction row of the account left, and a claim overtaken by SOMEONE ELSE's eviction
refused once and holding on its retry.

**`POST /mls/commit` is rate-limited per user (2026-10-22):** `MLS_COMMIT_LIMIT_PER_MINUTE` (600)
through `UserThrottlerGuard`, after `HeaderAuthGuard`. A refusal is the throttler's `429` before the
gate, so the epoch has not moved. Its body is `{ code: 'RATE_LIMITED', retryAfterMs }`, read by
`refusalFromResponse` into `ApiRefusalError.retryAfterMs`. The client records that wait once for the
process (`frontend/src/lib/mls-client/commitRateLimit.ts`) because the quota is per ACCOUNT: the
staged-commit path rolls its commit back and throws `CommitRefusedError('rate_limited')` carrying the
wait, an external join returns `{ reason: 'rate_limited', retryAfterMs }`, and while the wait holds
neither stages nor builds anything. The sync watchdog's recovery sweep and its stuck-gap escalations
stop for the rest of the tick instead of collecting one `429` per group. The number sits above what a
client's serial commit path produces during a restore and is owed a check against the production
maximum per user and minute (`mls_commit_log`). The background Welcome's commit
(`POST /mls/push/send-welcome-and-commit`) and the push-triggered key-group join of #2266
(`POST /mls/push/key-group-join`), both PushSecret routes, are not throttled, so they do not count
against this quota.

**What creation writes, and what it deliberately does not.** The `dm_groups` row, and nothing else:
no `dm_group_members`, no `DeviceGroupMembership`. Both absences are asserted directly in
`internal.distribution-group.spec.ts`, because nothing in the system would ever complain about their
presence and the whole audit above rests on them. The MLS group is not created server-side and
cannot be - the first member in finds `groupInfo: null`, initialises it, and publishes back. That
null is a state the client acts on, never an error.

**Failures are failures.** Every function in `distribution-group.client.ts` throws: an unset
`INTERNAL_SECRET`, an unreachable delivery, a non-2xx. The service already carries one guard that
fails OPEN (`userHasMlsDevices`), and the day its URL was wrong that turned it into a constant
`true` - a check nobody had. So a community whose group cannot be created is UNWOUND (`createWorkspace`
deletes the row it just wrote and rethrows) rather than left holding a slug it cannot use, and a
community whose group cannot be deleted is NOT deleted - retryable beats an orphan group named by
nobody, which is exactly the shape of row the 2026-08-17 purge had to find by hand.

**One duplication was closed on the way through.** The four `deliveryUrl` callers carried 4 s, 4 s,
5 s and 5 s of timeout with nothing recording why; they are one `DELIVERY_TIMEOUT_MS` now, in
`internal/service-urls.ts`, the same one-constant-per-repo discipline WP-AVATAR-1 settled on.

**Not in scope, and stated rather than assumed:** `getCommitsSince` still gates on
`dm_group_members`, so a distribution-group member who falls behind cannot replay commits and
re-joins by external commit instead. That is the intended rung for this group - it holds seeds, not
a conversation - but it is a difference from ordinary groups, not an oversight.

#### WP-22, and the race that had no election

**The client joins where the community is loaded** (`useChannelWorkspaces`), through one function,
`ensureCommunityDistributionGroup`. It is idempotent and its early return is derived from state that
already exists - the registered group id, and the local MLS group list - rather than from a "done"
flag, which a state reload would have made a lie.

**It is AWAITED there, and that is load-bearing.** Joining is also what REGISTERS the group id
locally, and until it is registered a seed frame arriving on that group is treated as an unknown
conversation and answered with a `welcome_request` nobody will ever send. Awaiting closes that
window instead of paying one spurious recovery per community per start.

**One decision point for where a base lives.** `BaseMlsService.groupInfoChannel(groupId)` answers it
once, from the registry, and both `refreshGroupInfo` and `externalJoin` go through it - a rule each
call site had to remember is the shape of rule the next call site does not. A group registered as a
distribution group with no transport wired **throws**: sending it to chat-delivery instead would
produce a 403 that reads like a permission problem and send the next reader to the wrong place.
**So does a group only NOTED** (`noteDistributionGroup`: the server named it a key group before this
session loaded its community, so no scope addresses it): it used to fall through to chat-delivery,
whose 403 is the one refusal `externalJoin` reads as final. No caller was found to reach it - every
gap, join and publish on a key group starts from a scope, and `routeDistributionFrame` returns before
arming a gap for an unscoped one - so it throws rather than being trusted to stay unreachable
(2026-10-04).

**The transport is injected, not imported** (`setDistributionGroupInfoTransport`, wired in
`sessionAuth` from `ChannelService`). The MLS layer never learns to speak to the communities API.

**THE FIRST-PUBLISH RACE, AND WHY IT NEEDED A SERVER CHANGE.** Two devices can both find a community
uninitialised and both create an MLS group under the same id at epoch 0. The monotonic rule cannot
separate them - epoch 0 is no newer than epoch 0 - so without a discriminator the second publish
overwrites the first and the community's seeds split in half, silently, for ever. Who won the INSERT
separates them, and `putGroupInfo` used to answer `stored: true` from the insert branch regardless:
`orIgnore` makes a lost race silent. It now reports `ON CONFLICT DO NOTHING`'s empty `raw` truthfully,
and the loser discards its group and joins the winner's base. **No election, no coordination, no
peer online.** The cost of being wrong here is the reason this is not left to heal: nothing
reconciles two MLS groups sharing an id.

**AND FOR A YEAR THAT ELECTION DECIDED ONLY THE COLLIDING HALF OF THE RACE.** `orIgnore` separates
two publishes only when their INSERTs actually overlap. Serialized - the first committed before the
second device even read the row - the second found a row and fell through to the UPDATE, whose guard
was `baseEpoch <= :baseEpoch`: epoch 0 replaced epoch 0, and the writer was told `stored: true`. So
the case the paragraph above describes as settled was settled only when it happened fast, and the
commoner ordering produced exactly the outcome the election exists to prevent - two creators both
believing they own the group.

**And it is not an exotic ordering.** Creating a private salon publishes `channel.member.joined` to
the channel audience, which makes every one of that user's devices load the workspace and walk its
private channels; each of them reaches an uninitialised scope within the same second. Measured on
production 2026-08-27 (COMM-8): three `epoch=0 stored=true` publishes for group `ef60eb1e` inside one
second, from three devices of one account, and in the run before it two for `19d12785`. The survivor
is whichever tree the next commit happens to be built on - A1's in the first case, an undriven web
device's in the second - and the creator that minted the salon's Graine session is orphaned at epoch
0, refusing the group's own first commit as `ValidationError(InvalidSignature)` and watching it run
away (`epoch gap [msg_epoch=4, group_epoch=0]`). The seed for the salon's first message then exists
only inside a tree no member holds: the joining member asks, every roster device answers
`absorbed 0/0`, and it concludes `has no reachable holder`. **`unsettledDistributionGroups` cannot
help here** - it closes the window for a device that KNOWS it is unsettled, and this device was told
it had won.

**The rule is now strict on both halves of the function.** An epoch already published is OWNED: a
base for it is refused and reported `stored: false`, whether the collision is caught by the read or
by the UPDATE's own `baseEpoch < :baseEpoch` guard, and the UPDATE reports what it actually matched
instead of assuming it landed. **An equal epoch was never a legitimate refresh** - every republisher
carries a strictly newer one by construction, since `validateCommit` writes the base for
`baseEpoch + 1` inside the transaction that advances to it, and `republishStaleBase` fires only when
the stored base is BEHIND the group and publishes from a tree at or past `activeEpoch`. The client
needed no change at all: it had always known what to do with a lost race, and had simply never been
told it lost.

**AND DISCARDING THE LOSER IS ONLY FREE IF NOTHING WAS BUILT ON IT.** The code asserted that in a
comment - "this runs before any seed is sent" - which is true of `ensureDistributionGroup`'s own
call and of nothing else. Between `createGroup` and the server's verdict the doomed group is a
member of `getLocalGroups()`, and `distributionEpochFor` asks exactly that question while meaning a
different one: *held* was read as *usable*, so the group answered epoch 0 like any settled one. A
salon message sent in that window minted an outbound Graine session against it and distributed the
seed into it; `forgetGroup` then took the session with the group (`session ... has no reachable
holder`) and the message stayed sealed under a session nobody could open, its author included.

**So the window is named rather than asserted away.** `unsettledDistributionGroups` holds the group
from before `createGroup` until the verdict, cleared in a `finally` so no branch can leave it
behind, and `isDistributionBaseSettled` is what `distributionEpochFor` consults before answering an
epoch. While it is unsettled the answer is **null** - the same answer, and the same
`GraineDistributionUnavailableError`, that a caller already gets for a group this device does not
hold, because the two mean the same thing to a sender: not yet. Held, settled and absent are three
states, and the middle one had been spelled as one of the outer two.

**Nothing waits on this in ordinary use.** `ensureDistributionGroupFor` is awaited at community load
and at salon join, both before a composer exists, so only a genuinely concurrent send reaches the
window - which is what the COMM rung does: on 2026-08-27 one race made two rows vacuous, and the
orphaned frame, classifying as `unknown` and therefore never acknowledged, was redelivered onto
fifteen more. That amplification is a separate defect and is in [backlog](../backlog.md).

**Routing.** `setupMessageHandler` branches on `isDistributionGroup` BEFORE the known/unknown split,
because both would misbehave: `handleKnownGroup` looks up a conversation that does not exist and
returns without acknowledging, so every seed would be redelivered for ever while being read by
nobody; `handleUnknownGroup` asks for a Welcome that external join exists to avoid.
`routeDistributionFrame` decrypts and hands the plaintext to a registered handler - **a seam, and
deliberately empty**: what a seed offer, a seed request or a history bundle MEANS is WP-30..33. A
frame arriving with no handler wired is logged at ERROR and NOT acknowledged, because the only other
symptom would be a community whose history quietly never loads, weeks later, with nothing to point
at.

**Acknowledgement rules, since they decide what is lost:** a commit is applied and acknowledged (no
payload, and a replay would only be refused); a frame that cannot be decrypted yet is NOT
acknowledged, so the server redelivers it once the join lands; a dispatched frame is acknowledged.

### Phase 4 - send, receive, repair

- **WP-30** Outbound session manager: create per (channel, sender), rotate on departure / 100
  messages / 7 days, persist through WP-13. **DONE 2026-08-18** - below.
- **WP-31** Send path: encrypt under the session, carry `sessionId`. **DONE 2026-08-18** - below.
- **WP-32** Receive path: decrypt by `sessionId`; unknown session renders as explicitly unreadable.
  **DONE 2026-08-18** - below.
- **WP-33** Request and answer a missing seed over the distribution group. **DONE 2026-08-18** -
  below.
- **WP-34** The history bundle on join, in one message, gated by `history_visibility`.
  **DONE 2026-08-18** - below.
- **WP-35** `history_visibility` per community: column, API, settings UI, i18n.
  **DONE 2026-08-18** - below.

#### WP-30, and the departure nobody records

**"Rotate when somebody leaves" is decided from the distribution group's EPOCH, not from an event.**
Every membership change commits to that group, so its epoch is a number every device already holds,
reads identically and cannot forget. A session records the epoch it was minted at
(`graine.distribution_epoch`, SQLite v9; IndexedDB rows are objects and needed no version); a
mismatch means the set of people holding that seed is no longer the set entitled to it, and the next
send mints a new one.

The alternative was a durable "somebody left" marker. It has to be written by every device, kept
until every session has cycled past it, and cleared by something - three chances to be silently
wrong, against a number that is simply read. *Durable state answers only the question it was written
for*, and the group's epoch was written to answer exactly this one.

**An ADD advances the epoch too, and rotates a session it did not have to.** Deliberate: the cost is
one extra seed distribution, which is O(1), against a discriminator that would have to distinguish
add from remove and be trusted to. The comparison is `!==`, not `<`, for the same reason - any
disagreement is a disagreement.

**A session with no epoch is rotated, never trusted.** `undefined` is not epoch 0. A row written
before the column existed was minted under a roster nobody recorded, which is the case rotation
exists for; the codec keeps absent absent rather than letting `Number(null)` turn it into a real
epoch.

**Three orderings in `reserveOutboundSlot`, each the answer to a failure that leaves no trace:**

| Rule | What the other order costs |
| --- | --- |
| Serialised per (channel, sender) | Two racing sends read one `sentCount`, seal two messages under one AES-GCM key. No symptom at either end. |
| Distribute the seed, THEN persist the session | Persisting first leaves a session in hand that nobody can read; it is reused, so every message under it is lost, permanently. Distributing first means a failure leaves the seed nowhere and the next attempt mints again. |
| Burn the index before the send, and leave it burned on failure | A gap costs nothing - every message carries its index and the key is derived directly. Re-handing one out after a send that the server did receive costs the session. |

**The sender id is lower-cased at the one place a session is written and the one place it is looked
up.** A row stored as `Alice` and searched for as `alice` is never found, so every send mints - a
community that works perfectly while rotating on every single message, and distributing a seed for
each.

The rotation is the only line logged (at `info`): it is rare by construction - once per 100
messages, per week, or per membership change - and it is the only record that a departure took a
seed out of circulation.

#### WP-31/32, and the two fields a message cannot be read without

**A row names a SESSION and an INDEX**, `channel_messages."senderSessionId"` and `"messageIndex"`
(migration `038`). Two columns and not one, because the key is `HKDF(seed, sessionId, index)`: a row
carrying only the session is a row nobody can open, including its own author. They replace
`keyVersion`, which named an epoch the server derived and could therefore read.

**`STALE_CHANNEL_KEY_VERSION` is gone, and so is the retry it drove.** That refusal existed because
the server held the key and could rotate its epoch out from under a connected tab, so one send could
fail for a reason one refresh repaired. Nothing rotates under a sender now: the session is the
device's own, and the one thing that invalidates it - the roster moving - is checked BEFORE the seal.
*Never learn by failing what a fact could have told you.* Two refusals replace it, both
`BadRequest` and both about the message rather than about the server's state:
`CHANNEL_SESSION_REQUIRED` and `CHANNEL_MESSAGE_INDEX_REQUIRED`.

**Index 0 is the first message of every session**, so every guard on the wire and in the three
native readers is written against *absent*, never against *falsy*. A `if (!messageIndex)` would hide
the one message every reader is guaranteed to want.

**What the client needed that a channel id does not carry.** Sealing needs the community (whose
distribution group carries the seed), the device key, the local store and the user id. The community
comes from `registerChannelWorkspace`, called wherever salons are loaded - including the real-time
`channel.member.joined` path, without which the first message typed into a freshly-joined salon
would be refused until a relaunch. The other three are injected once at login (`setGraineRuntime`)
and cleared at logout, with the decrypted-seed cache and the channel map, because they belong to the
account that left.

**Only an ANSWER is cached.** A seed found in the store is kept in memory so a page of history does
not decrypt the same row fifty times; a seed NOT found is re-asked for every time, because "missing"
is exactly the state a repair is expected to change underneath.

**Three unreadabilities, three types, because they need three different responses:**

| Type | What it means | What to do |
| --- | --- | --- |
| `GraineSessionUnavailableError` | this device holds no seed for the session named | repairable - WP-33 asks for it |
| `GraineBelowFirstIndexError` | sent before this member was given the seed | nothing; a request would return the same floor for ever |
| `GraineDistributionUnavailableError` | the community's group is not in hand | refuse the SEAL, before a row nobody can read exists |

**The push had to move with it, natively, or a salon notification would have stopped saying
anything.** All three readers already delegated AES-GCM to Rust, so the derivation lives in ONE
place (`mobile::graine::derive_message_key`, pinned to the TS side by shared vectors) and the change
is uniform: `channel_keys.json` becomes `graine_seeds.json`, `keyVersion` becomes
`senderSessionId` + `messageIndex`, and `canari_native_decrypt_channel_message` becomes
`canari_native_decrypt_graine_message`. The mirror is BOUNDED to the newest sessions per channel, so
a miss on an old session degrades the banner to "new message in #salon" - which is the outcome an
oversized ciphertext already produces, and the correct one. `channelPushFields.test.ts` is what
holds the writer and the three readers together; it caught this migration rather than being updated
after it.

**The epoch-key machinery came out whole in WP-50/51** - client and server in one commit, so no
build ever ran with a client calling routes that had gone. See "the server forgets how to read"
below for what that removed and what replaced each guarantee.

#### WP-33, and the answerer nobody elects

**A repair asks ONE named member, and every other member ignores the frame.** The request travels on
the community's distribution group because that is the only channel every holder is already on, so
three hundred devices receive it; `answererUserId` is what stops three hundred bundles going back for
one missing seed. The answerer is the session's own SENDER whenever they are still in the community -
they always hold it - and the lowest user id in the roster when they are not. That is a total order
every device already has, computed identically everywhere with no clock, no election and nothing for
a race to decide.

**Only a member with a device ONLINE is elected (2026-09-26).** A request is `DELIVERY.transport`,
and chat-delivery drops a transport frame for a recipient with no device online. So an election that
ignored presence addressed requests nobody would ever receive, and nothing replaces a SILENT answerer
- only one that declines (below). Measured on production 2026-09-24 (`v0.18.22`): a member left an
8-member community and came back through its link one minute later, and saw 2 of the 21 messages of
`general` on the phone and 0 on the browser. The history request went to the lowest id, offline for
two days; the per-session requests went to the sessions' authors, two of them offline for weeks; and
several online members held every seed and were never asked. The fix carries presence TO the
decision, rather than learning it by failing:

- the roster the election reads comes back with each member's `online` flag -
  `GET /api/channels/:id/members?presence=1` and `GET /api/channels/workspaces/:id/members?presence=1`.
  social-service answers it with ONE `SCAN` over the gateway's `user:online:{userId}:{deviceId}` keys
  (`RedisService.onlineUserIds`), opt-in so the member lists the UI draws do not pay for it;
- `resolveAnswerer` takes the sender when online, else the lowest ONLINE member not yet tried, else
  our own other device (unchanged), and answers `{ kind: 'wait', offline }` when the only members who
  could answer are offline - distinct from `exhausted`, where everyone has declined;
- a `wait` PARKS the want, one waiter per channel (`parkUntilOnline`; the history request has its
  own, `parkHistoryUntilOnline`), on `presenceStore.whenAnyComesOnline`. The first of those members
  seen online re-runs an ordinary election over a FRESH roster. No clock: the event is presence.
  The waiter compares against the presence map AS IT STOOD AT REGISTRATION, not against the previous
  poll: a member this client has never polled has no previous value, so `onPeersCameOnline` would
  never fire for them, and a stale `true` must be seen `false` first or a retry would find them
  offline and park again, in a loop;
- a row the server returned WITHOUT the flag is elected as if online and accused at warn level: that
  is a social service predating the field, and a bandwidth decision must not strand a want on it.

**What presence does not see.** A backgrounded Android can hold its socket open, so `user:online` can
be true for a device that will not process the frame (the DM history election randomises for that
reason). Here the elected member is then silent, the ask stays in the in-memory asked-set, and the
next start asks again - the pre-existing residue, now limited to a frozen member instead of every
offline one.

**Holding some seeds is still a reason not to request the whole HISTORY.** The returner's phone held
the 2 seeds sent since the return, so `requestCommunityHistory` did not ask - and that was not the
defect. The past such a device lacks is derived from the messages it cannot open: each names its
session and is asked for by the per-session repair, which failed only because it addressed offline
members. Re-requesting the full bundle at every start, of one member, for seeds the device mostly
holds, buys nothing that path does not deliver.

**An empty hand is answered, never met with silence (WP-63, 2026-08-18).** Determinism is what makes
the election safe and was also what made it a dead end: a member elected by the rule but not holding
the seed was elected again by every device and on every retry, and answering nothing left the session
unreadable for the whole app session. So `GraineBundleMsg.missing_session_ids` carries what the
answerer turned out **not** to hold, and the requester strikes them off and elects the next member -
`resolveAnswerer(..., tried)`. This is the rule against *learning by failing what a fact could have
told you*, applied on the wire: *"I hold none of these"*, *"I never saw your request"* and *"I am
offline"* are three different facts an empty wire cannot separate, and only the first one means ask
somebody else. **The walk terminates on a proof, not on a count or a clock**: each decline removes one
member from a finite roster - **one decline per MEMBER, however many devices they have**: a request
is addressed to a user and each of their devices may say no, so a second "no" from a member already
struck off is ignored rather than logged and walked again (2026-09-28) - so it ends either on the seed arriving or on `resolveAnswerer` answering
`exhausted`, which is logged as *no reachable holder* rather than left as a permanently blank salon. A
history refusal stays silent on purpose - it is the one case the requester can already derive, since
the visibility rule is broadcast by the server.

**A member hands over the floor they hold, never a lower one.** `firstIndex` travels as stored, so a
repair cannot widen access: somebody given the seed from index 40 answers with 40, and the requester
ends up exactly as entitled as their answerer was.

**Asked once per SESSION, not once per unreadable row.** A page of fifty rows names a handful of
sessions between them. The set of asked sessions is in MEMORY on purpose: a request is
`DELIVERY.transport`, so an answerer who was offline never saw it and the next start must be free to
ask again. A durable "already asked" marker would be *state answering a question it was not written
for* - it would silence the retry exactly where the retry is the point. A request that could not even
be SENT never enters the set, so it is re-asked the moment the next row names it.

**The batching window is a network hop, not a timer.** The flush resolves the community's roster
first and reads the accumulator afterwards, so everything that finishes decoding during that hop
joins the same request. A timer here would have been *a clock deciding correctness*: the worst case
of the hop is one extra request, never a silence.

**EVERY path a seed lands by tells the UI, not just a repair bundle (WP-63, 2026-08-18).** The rows a
seed makes readable were rendered unreadable and dropped minutes earlier, and nothing else goes back
for them before the user next leaves and re-enters the salon. A seed reaches a device by **two**
paths - its sender distributing it, and the distribution group's **durable log replaying it on
reconnect** - and only the second races the salon's own history load. While only the bundle path
announced, a device that reconnected into an open salon sat in front of a blank history whose seed it
was already holding. `setGraineRepairListener` is registered by `ChatBackgroundService` - the layer
holding both the seed layer and the conversations - and a repair landing with nobody listening warns
rather than passing silently. `truncated` is on the wire for the same reason: *"this is all there
is"* and *"this is all I could send"* are different facts, and only one of them means ask again.

**Inside a drain, ONE re-read per salon, at the drain's end (2026-10-12).** Announcing on arrival
re-read the salon once PER SEED: a device coming back drains every seed its members minted while it
was away, and a production web console (`v1.2.5`) showed 26 new seeds for 3 salons in 1.8 s become 26
history reloads - 52 requests (`messages?limit=200` + `read-marks`), 14 of them for one salon, each
re-decrypting the page. The announcement is now HELD while a bulk-ingest window is open
(`holdGraineRepairs` / `releaseGraineRepairs` in `graine/runtime.ts`, registered as a
`BulkIngestObserver` in `sessionAuth`) and released as one set of distinct salons when the outermost
window closes. **The window is the drain itself, not a timer**: `beginBulkIngest`/`endBulkIngest`
pair exactly, and their close is the one moment after which a re-read sees every seed the drain
brought. Outside a drain (a live seed on an idle socket) the announcement is immediate, as before.
**What the hold costs, read on the same console**: the drain ran 4.2 s (`Drain start` +0.91 s ->
`Drain complete` +5.09 s) and the first re-read went out at +3.27 s, so a salon whose seed comes
early in a long drain is redrawn up to the drain's length later than before - ~1.8 s on that log
(the startup timeline of the 2026-10-12 startup-load audit, #1790). A drain shortened by #1768
shortens this with it.
**Only the QUEUE DRAIN's window holds** (`graineRepairHoldObserver`, phase `bufferUi: true`): a
history restore opens a bulk-ingest window too, and the startup one spans every conversation's
replay, so holding on it would keep a salon opened at startup blank until all of them were replayed.
Pinned by a count: 26 seeds for 3 salons inside one window -> one announcement naming 3 salons, and a
restore window announces at once (`frameHandler.test.ts`).

**A seed arriving disarms its ask.** `forgetAskedSession` is called on every path that ends with the
device holding the session, so the asked-set holds only requests still outstanding. It existed with
**no caller at all** until WP-63 - the same shape as `deleteGraineSessionsForWorkspace` before WP-60,
and the second time in this protocol that a correct mechanism shipped unwired.

#### WP-34/35, and the rule the server cannot enforce

**`channel_workspaces."historyVisibility"` (migration `039`) is stored server-side and applied
client-side, and that split is the whole design.** The server holds no seed, so it could not enforce
the rule if it wanted to; what it can do is give every device the same answer and tell them when it
changes. `NOT NULL DEFAULT 'shared'`, unlike 037's nullable pointer: there is no such thing as a
community with no answer to this question, and a null would be a third state every reader would have
to interpret.

**THE ENFORCEMENT POINT IS EVERY PLACE A SEED LEAVES A DEVICE, AND FOR A YEAR ONLY ONE OF THE TWO WAS
GATED.** `gatherCommunityHistory` refused the join-time bundle under `joined`, out loud (whole,
whoever asked - floored at the member's arrival since 2026-10-22, below) - and `gatherNamedSessions`, the WP-33 repair path, consulted nothing at all and handed the same
past back one session id at a time. That is not an exotic path: a newcomer renders a salon, meets
ciphertext it cannot open, and `noteMissingSeed` names those exact sessions. The setting was stored,
broadcast, narrowed fail-closed, enforced on one path and bypassed entirely on the other, so a
community that had chosen *"rien de plus ancien"* got the opposite. **Found on prod by COMM-12 on
2026-08-20, not by the repository**, and it is the twentieth defect of the campaign. The rule now
lives in `historyBoundary.ts` and both callers read it from there, which is what stops the two
readings drifting apart again.

**A SESSION CAN SPAN AN ARRIVAL, so the answer is a FLOOR and not a yes or a no.** The first fix
withheld any seed minted before the member arrived, on the reasoning that a join advances the
distribution group's epoch and `graineRotationReason` rotates on any epoch it does not recognise -
an ADD included. **That reasoning is wrong, and COMM-12's own log says so:** four markers sealed
under TWO sessions, `PAST`+`IN1` together and `OUT`+`IN2` together. Rotation is decided by the
SENDER at the moment it seals its next message, from the epoch it has PROCESSED - and a join is an
EXTERNAL commit, so the sender learns of it late and seals a few more messages under the session it
already had. A removal is committed by a remaining member, which is why that direction rotates
immediately; the asymmetry is exactly visible in the pairing above. So withholding such a session
costs the newcomer messages sent AFTER they arrived, and handing it over gives them messages sent
before. Only `firstIndex` expresses the difference, and it is the field that exists for it: *"non-zero
when the seed was handed over mid-session, so a member who joined late cannot open messages sent
before they were allowed to"*. It is RAISED and never lowered - a member cannot hand over more than
they were given.

**The floor is computed by the SERVER, and that is what makes it deterministic.**
`GET /api/channels/:channelId/graine/history-floor?forUser=&sessions=` answers, per session, the
lowest `messageIndex` whose row is dated at or after that member's `channel_members.createdAt`; a
session absent from the answer has nothing that member may read and is withheld whole - absence
rather than a zero, because *"give it from index 0"* and *"there is nothing here for you"* are
different instructions. Both halves are the server's own columns, written by one clock, so **no
device clock enters the decision at any point** and every device that asks gets the same number for
the same state. Neither the member answering nor the member asking supplies anything the result
depends on: the answerer names who the seed is for, and the server looks their arrival up itself.
The caller must be able to READ the channel, and the person named must be a member of its
community - otherwise the route refuses and the answerer, which fails closed, hands over nothing.

**A withheld seed is absent from BOTH lists in the answer.** Reporting it as `missing` would be a lie
with a cost - `missing` means *"elect somebody else"*, and every other member applies the same rule,
so the requester would walk the whole roster to arrive at the answer it was handed first.

**And the requester declines to ask for what it can see it may not have.** It knows the community's
setting (broadcast) and its own arrival (one roster fetch), and it keeps the NEWEST server timestamp
it has seen for each wanted session - so a session whose every known row predates the arrival is
dropped before the request is built, and both sides of that comparison are server values too.
Without it a newcomer to a closed community would spend one frame per pre-arrival session, on the
whole group, at every start, to be told what it already knew. `withheldFromUs` fails OPEN, unlike
its counterpart: it is a bandwidth decision, not the enforcement, and refusing to ask because a
roster fetch failed would strand seeds the member is entitled to.

**Broadcast, not just stored.** `workspace.updated` carries the new value to every member, because a
device still holding `shared` in memory would keep handing the past over after an admin had closed
it - until its next relaunch.

#### The floor is the MEMBER's, on every path, and a widening reaches the members already in (2026-10-22)

An audit of the rule on 2026-10-22 found it enforced, with four gaps. All four are closed in the
same change; the rig arms that read them on a live estate are owed (COMM-12, two arms below).

- **A member's NEW DEVICE got no history bundle under `joined`.** `gatherCommunityHistory` refused
  every HISTORY ask whole, whoever asked - a reading of the rule by DEVICE, when the floor is per
  MEMBER (`channel_members.createdAt`). It now answers like the repair path, through ONE function
  (`seedsTheAskerMayRead` in `frameHandler.ts`): each held seed raised to the server's floor at the
  asking member's arrival, a session wholly before it withheld, fail-closed when the floors cannot
  be read. A newcomer's first device gets the sessions spanning its arrival; a long-standing
  member's new device gets everything since the member arrived. The floor query is sliced at 100
  session ids (`HISTORY_FLOOR_QUERY_MAX_SESSIONS`), because a bundle can name thousands and the ids
  travel in the query string; the slices run four at a time (`HISTORY_FLOOR_QUERY_CONCURRENCY`), so
  a capped bundle's 80 queries are not 80 round trips in a row. The bundle's cap applies before the
  floors, to the NEWEST sessions first: the store's read has no order, and capping it as it came
  could keep only sessions that predate a recent arrival - an empty, truncated answer at every ask.
- **The `joined` newcomer's ask was answered by silence at every launch.** It is now ANSWERED: with
  floored seeds, or, when every row opened and every one predates the arrival, with the "I hold
  nothing" flag of [section 24](#24-a-history-ask-answered-i-hold-nothing-is-final-for-its-roster-wp-hold-nothing-decided-2026-10-18),
  meaning "nothing here for you" - recorded per roster exactly like "nothing". So the requester asks
  under both rules, and the ask stops repeating. Rows that do not open with the device key still
  answer silence, as under `shared`. **What recovers a past after "nothing for you", said:** only
  the REPAIR path. The history ask is not asked again for that roster version, and a voucher written
  onto an existing row (a re-admission, section 25) does not move the epoch. Each row the member
  renders names its session and asks for it, and that repair goes through the same gate - which,
  once the admission is proven, hands the seed whole (`frameHandler.test.ts`, RE-ADMISSION).
  Forgetting the record when this device's own voucher appears was weighed and not built: it needs
  the requester to watch its own roster row, and the repair path already reaches every row read.
- **A switch `joined` -> `shared` never restored the past to members already in.** The history ask
  returns once any seed is held, and a row below a raised floor is classed "sent before this device
  was given the seed", which asks nobody (asking would loop on the same floor). Re-classing those
  rows was REJECTED for that reason. Instead the ask is re-opened: `historyClosedSeen.ts` records,
  durably per account, the communities whose past this device was told is CLOSED (only from a rule
  the server stated, `knownHistoryVisibility` - never the fail-closed default). When the rule then
  reads `shared`, `requestCommunityHistory` asks even though seeds are held (reason
  `visibility-widened`), forgets ONCE the "nothing" answers given under the floor, and keeps asking
  at each start until an answer STORES a seed (`noteHistoryAnswered`), the ask goes final,
  or there is nobody to ask. Durable because most members are offline when an admin flips the
  setting; the live `workspace.updated` also triggers it at once - and forgets, with the "nothing"
  answers, the in-memory "nobody could answer at this epoch" (`historyUnanswerableAt`), which the
  floor reached and a live widening does not move. An answer with a lower floor on a
  held session lowers it (`storeIncomingSeed`) and re-reads the salon. **Residue, said:** an
  answerer who itself arrived late, or who still holds `joined` in memory, answers with what it may
  give, and that answer settles the widening.
- **`shared` -> `joined` cannot take back a seed already handed out**, by design. The admin panel's
  `joined` note says so (`chat_community_history_joined_note`), and no longer says "permanently".

**The receiver re-floors under `joined` (`seedsWeMayKeep` in `frameHandler.ts`).** A bundle is
floored for the member who asked, and answerers before 1.2.6 addressed it to the whole key group
([section 23](#23-a-seed-answer-goes-only-to-the-device-that-asked---fixed-2026-10-12)), while
`absorbSeedBundle` stored every seed it carried. The receiver now applies its OWN floor too: a
bundle's seeds are re-floored at this member's arrival (same server route, same raise-never-lower
`applyHistoryFloors`) before anything is stored; fail-closed, the seeds stay reachable one session
at a time by the repair path. The frame carries nothing that says whom it was addressed to, and the
request id would refuse a legitimate late answer, so the floor is the check. The broadcasting
answerer is retired by `minClientVersion` at or above `1.2.6` on both estates; the receiver check
holds against any answerer, modified ones included. The native push mirror (`graine_seeds.json`) also
absorbs a bundle with the app killed and is not re-floored: it only opens PUSHED messages, which are
minted after the arrival, and nothing reads it back into the store.

**One chokepoint, composed with the admission gate of [section 25](#25-a-member-hands-the-past-only-to-an-admission-it-can-verify-decided-by-the-user-2026-10-22)
(reconciled 2026-10-23).** `seedsTheAskerMayRead` is the one function both answers go through, and
applies, in this order:

1. the salon's roster - the scope of the key group the request arrived on (`withinFrameScope`). A
   floor is asked of the server per salon, and a salon the asker may not read never reaches that
   question, nor the gate. Nothing left in scope answers at once, ungated: "I hold none of these"
   (a repair's `missing`, a history ask's "nothing" when the store has no row) depends neither on
   the rule nor on the asker;
2. the cap (history only);
3. the rule as this session LEARNED it (`knownHistoryVisibility`): not learned yet PARKS the ask
   until the listing states it (`parkAskUntilRuleKnown`, woken by `whenHistoryRuleKnown`);
4. the gate (`pastPolicyFor`): `unobserved` PARKS the ask (section 25); `unverifiable` (the roster
   or the tree did not read) is answered by SILENCE; `shared` hands everything;
5. under `joined` - the community's setting or an unproven admission - the floor at the asking
   MEMBER's arrival.

| Case | Answer | Why |
| --- | --- | --- |
| Nothing held in scope | at once, ungated: `missing`, or "nothing" when no row exists | a fact about this store, not about the asker |
| Rule not learned by this session | parked, gate never asked, then decided again (gate included) when the rule arrives | a floor drawn under a guessed `joined` loses a `shared` past for good; the same queue and bound as `unobserved` (64 asks, the oldest dropped at warn) |
| Rule `shared`, admission proven | everything in scope | section 25 |
| Rule `shared`, voucher not observed yet | parked until the key group drains, then decided again | section 25; nothing is floored before the gate decides |
| Rule `shared`, admission not proven | floored at the member's arrival, "nothing for you" when every row predates it | section 25's "never refused whole"; the same floor as a `joined` community |
| Rule `shared`, admission not checkable (roster or tree unreadable) | SILENCE on both paths: no floored seed, no "nothing", no decline (decided 2026-10-23) | a floored seed is lasting at the requester - the rows below its floor are asked of nobody - so a passing read failure would cost a member part of a session for good; silence records nothing, and the requester asks again at its next start |
| Rule `joined`, proven or not | floored at the member's arrival | the rule outranks the proof: a proven admission lifts the `shared` gate, never a closed past |
| Floors cannot be read | silence | fail-closed |
| A row withheld for its roster, or the cap cut the list | never "nothing for you" | an unlisted salon may be the asker's; past the cap the floors judged nothing |

**The receiver reads the COMMUNITY's rule, never the gate.** The gate is about whom an answerer may
hand the past to, and a device is proven to itself. Under `shared` every seed goes to
`storeIncomingSeed` as it came (a seed of a salon the answered listing did not name waits for its
registration, `awaitSalonListing`). Under `joined` the bundle is scoped first (`seedsWeMayFloor`, the
same `seedOutsideScope` as the answerer): another roster's seed is refused, and a seed of a salon not
listed here - not yet, or not named by the answered listing - is SET ASIDE, not held for its
registration, because a seed admitted that way would be stored unfloored. The repair path reaches it
once the salon is rendered, floored at the answerer. Only then is the rest re-floored at our own
arrival (`seedsWeMayKeep`).

**A settled widening needs a STORED seed.** `noteHistoryAnswered` runs only when the bundle stored
something new: an answerer handing back the floored past this device already holds settles nothing.

**Narrowed once - and an UNKNOWN rule is neither rule.** `narrowHistoryVisibility` is the only place
a wire string becomes one of the two values, so the sidebar and the seed layer cannot disagree
about a community; a value this client does not know reads as `joined`, and warns. A community
whose rule this SESSION has not learned yet is different (`knownHistoryVisibility` is `null`): the
answerer PARKS the ask, on both answer paths, and the receiver HOLDS a bundle carrying seeds, until
the rule arrives (`whenHistoryRuleKnown`, event-driven, at most 256 waiting steps, a step past it
dropped at warn; dropped and said with the session or the community). A floor drawn under a guessed `joined` is a loss rather than a precaution: a `shared`
community's newcomer handed the floored past records the ask answered and never asks again.

**The ask is derived state, twice over.** A joiner asks when it holds NO seed for the community -
read from the store, so it survives a reload a "done" flag would have lied about - and when it has
not already asked in this app session - in memory, so a restart is free to ask again, because the
answerer may simply have been offline. Neither is a clock. The ask sits in
`ensureCommunityDistributionGroup`, on BOTH its branches: entering the group is what makes asking
possible, and a device that joined while its answerer was offline must still ask on the next start.
It is best-effort and never fails the join. An explicit "I hold nothing" answer is the one thing
recorded durably, per roster ([section 24](#24-a-history-ask-answered-i-hold-nothing-is-final-for-its-roster-wp-hold-nothing-decided-2026-10-18)).

**The answerer is the lowest OTHER member with a device online** (presence since 2026-09-26, see
[WP-33](#wp-33-and-the-answerer-nobody-elects)). This user is named only when another device of
ours sits on the group (`ownDevicesOnTheGroup`, COMM-18, 2026-08-25): a request names a USER and MLS
never hands a sender its own message back, so it then reaches our other devices and nobody else -
first when one of them minted the session, last otherwise.

**A community roster now has its own route.** `GET /workspaces/:id/members` exists because the
caller that needs it - a device that has just joined and opened no salon yet - holds no channel id,
and reaching for an arbitrary channel to learn a community's roster breaks the first time the list
is empty.

### Phase 5 - reactions

- **WP-40** Reactions become silent encrypted channel messages aggregated client-side; the
  `reactions` column and its endpoint are removed. **DONE 2026-08-18** - below.

#### WP-40, and the one bit the server still needs

**A reaction is a channel message now**, sealed under its sender's Graine session like any other
(`ReactionMsg`, the same frame a DM uses, with the same `at` on both legs). `channel_messages.reactions`
- a cleartext `emoji -> userIds` jsonb the server counted - is DROPPED in migration `040`, with its
endpoint and its `channel.reaction` broadcast. It was the last place the server could read content:
it could not read "j'arrive" but could see that eight people put a heart on it.

**`silent` is what replaces it, and it is one boolean.** Not which emoji, not on what, not by whom -
only whether a row may ring a phone. The server cannot read the body, so it is TOLD rather than left
to guess: *never learn by failing what a fact could have told you*. Two things depend on it:

| Consequence | Why it is not optional |
| --- | --- |
| No push fan-out for a silent row | A heart that rang every phone in the community is a community people mute. The AUTHOR is still told, by the client, through the same targeted push a DM reaction uses. |
| The page is filled with BODIES, silent rows added | A plain `take: 200` would let a burst of reactions push real messages out of the page - a channel that shows less history the more people react to it, with nothing anywhere saying so. The limit counts non-silent rows; every silent row newer than the oldest of them comes along. |

**The merge is the DM one, unchanged** (`applyReaction`, last-write-wins per `(user, emoji)` pair on
`at`), so reading a history page newest-first gives the same result as reading it oldest-first, and
a frame seen twice changes nothing. That is what makes a reaction arriving before the message it
lands on a non-event.

**The distinct-emoji cap moved to where the user ACTS.** The server enforced it; nothing server-side
can now. It is checked before sending and never in the merge, because a frame that arrived is
something the community did, and a device that refused it would drift from one that accepted it.

**A reaction row carries its OWN message id**, never the reacted-to message's: every server-side
operation on a channel message - delete, pin, poll vote - addresses it by row id, and two rows
answering to one address would make each of those ambiguous.

### Phase 6 - the server forgets how to read - SHIPPED

**WP-50 deleted the derivation and every route that served it**, in the same commit as the client
halves: `deriveEpochKey`, `buildChannelBootstrap`, `getChannelKeyBootstrapForUser`,
`getChannelHistoryKeysForUser`, `rotateChannelKey`, `pushKeyToUser`, the four-state
`channel_key_distributions` ledger with its three status routes, and on the client
`ChannelKeyVault`, `channelKeyMirror`, the `channel.key.rotated` handler, the
`channel_key_distribution` system-message branch and the Rust `store_channel_key` mirror. One
commit and not two, because a client left calling a route that had gone is a broken deploy with a
green gate on both sides of it.

**Three guarantees the old machinery carried had to be re-answered, not dropped:**

| What the epoch machinery did | What answers it now |
| --- | --- |
| Invite hands the newcomer every past epoch key | Nothing is handed at invite time. `historyVisibility` decides, and another member answers over the distribution group (WP-34). |
| Leaving or being removed rotates the key | The senders mint a fresh session on the next send, because a departure is what rotates a Graine. The server rotates nothing, and now cannot. |
| `STALE_CHANNEL_KEY_VERSION` refuses a sender behind the epoch | Gone with the epoch. The server knows a session's NAME and nothing else, so a sender can never be behind it - a coupling removed rather than moved. |

**`channel_members.keys` went with them, and it is the one nobody would have missed.** A jsonb map
of per-channel keys, written by a path deleted long before this one and read by nothing since - the
exact shape of a column that survives because no query fails when it is wrong.

**WP-51 is migration `041`** (`037` was WP-21's `distributionGroupId`, `038` added
`channel_messages."senderSessionId"` and `"messageIndex"` in WP-31, `039` added
`channel_workspaces."historyVisibility"` in WP-35, `040` traded `channel_messages.reactions` for
`silent` in WP-40): it drops `channel_messages.keyVersion`, `channels.masterSecret`,
`channels.keyVersion`, `channel_members.keys` and the `channel_key_distributions` table. Dropped
rather than left nullable, deliberately: while `masterSecret` exists a future read path can derive
from it, and the point of the work is that the ABILITY is gone. The cut (WP-60) empties these tables
at the same deploy, so no row loses data it could still have been read with.

- **WP-52** ~~Push payload carries `sessionId`~~ **DONE inside WP-31/32**, server and all three
  native readers, because `channelPushFields.test.ts` refuses a payload whose keys no client reads -
  which is exactly the drift it was written to catch. Everything else about the notification path is
  unchanged, and that is asserted rather than assumed.

  **AND ON 2026-09-22 IT REFUSED A FIELD THAT WAS RIGHT, WHICH IS WHERE ITS RULE GOT NARROWER.**
  `createdAt` came back for the Android de-duplication (`backlog.md`, G1) and no iOS handler reads
  it, so the gate failed - correctly, since `createdAt` is one of the three fields it measured
  drifting on 2026-08-15. But the reason it has one reader is architectural and checkable: the
  second trigger is `notifier_message_natif` -> `notifyMessageFromWebSocket`, and that body is
  `#[cfg(target_os = "android")]`, so iOS posts nothing from the socket and has no two
  announcements of one salon message to reconcile. So the gate keeps **a key read by NOBODY fails**
  for every key, and a `PLATFORM_SPECIFIC` table narrows only WHICH readers are owed. Each entry
  cites the code that makes it true and a test re-reads that code, so the exemption dies with the
  `cfg` rather than outliving it.

### Phase 7 - the cut and the record

- **WP-60 SHIPPED.** Two migrations, one deploy, no in-app notice: social-service's `042` deletes
  every community, channel, member, role, invitation and message; chat-delivery's `015` deletes the
  distribution groups those communities owned, with their commit log, their GroupInfo, their queued
  messages and both membership tables.
  **Why a delete and not a data migration:** every message ever written was sealed with an epoch key
  derived from `channels.masterSecret`, which `041` has just dropped, and no device holds a
  replacement - a Graine seed is minted by a SENDER, and no sender ever minted one for a pre-Graine
  message. The rows would read as history right up until somebody scrolled to them.
  **The delivery half is an ALLOWLIST**: every statement is scoped through
  `dm_groups."distributionWorkspaceId" IS NOT NULL`, because "delete the groups that are not
  conversations" is one wrong predicate away from deleting every DM on the platform. It hard-deletes
  where `deleteDistributionGroup` tombstones, and says why in the file: a tombstone is right when
  ONE community goes and the system keeps running, wrong here, where the row would spend ninety days
  naming a workspace that no longer exists and the reaper that eventually collects it touches
  neither `mls_commit_log` nor `mls_group_info`.
  **The device half is `forgetCommunityGraine`**, called from `purgeWorkspaceLocally` - the one seam
  all four ways a community leaves local state already went through (left, removed, deleted, or the
  `workspace.deleted` broadcast). It erases the durable seeds, the decrypted in-memory cache, the
  channel-to-community map, the history rule, what was asked for, and the native `graine_seeds.json`
  mirror through a new `forget_graine_channel` command. All three stores, because none stands in for
  the others: the durable rows are what the app READS, the mirror is what a background push reads,
  and the maps are what an open tab answers from. `deleteGraineSessionsForWorkspace` had existed
  since WP-13 with **no caller at all** - a purge implemented and never wired, which is why a member
  who left a community kept every seed they had held.
- **WP-61** Rewrite what described the old model: the channel section of
  [social-service](../services/social-service.md), the transport table in
  [cross-client-campaign](../cross-client-campaign.md), the schema row in
  [architecture](../architecture.md), the channel routes in [api-surface](api-surface.md).
- **WP-62** Campaign rows for what this creates: a joiner reads the past under `shared` and nothing
  under `joined`; an unknown session is requested and repaired; a departure forces a new session on
  the next send; a notification still decrypts on the phone; a reaction produces no push.

### Phase 8 - availability of the key material - SHIPPED 2026-08-18

**Asked for after the rest was written, and the right question:** the DM path gives an unreadable
frame a whole recovery apparatus - left unacknowledged in `queued_message`, tallied in
`unackedFrames`, re-fetched by `refetchFramesLeftBehind` when the EVENT that unblocks it happens -
and the audit was whether a Graine seed gets the same. **Half of it already did**: a seed is
`DELIVERY.keyMaterial`, so it is appended to the distribution group's shared log and an offline
member picks it up on reconnect exactly like a queued frame, with no ask and no round trip. The
recovery half had three holes, all found by reading the two paths side by side.

- **WP-63 SHIPPED.** Three defects, one theme - *a want that nothing ever came back for*.
  1. **A declining answerer answered with silence.** Fixed on the wire, with
     `GraineBundleMsg.missing_session_ids` and a walk down the roster - above.
  2. **Only the repair-bundle path announced a repair.** A seed replayed from the durable log on
     reconnect could lose the race against the salon's own history load, and nothing went back for
     the rows it had just made readable - above.
  3. **`forgetAskedSession` had no caller**, so a satisfied ask stayed armed for the app session -
     above.

  What is deliberately NOT here: nothing re-asks on a schedule, and nothing re-asks on reopening a
  salon. Every retry in this protocol is driven by an arriving frame, so *no answer, no ask* - there
  is no cycle to bound and no clock that could be wrong.

## 7. What the server can still do, stated rather than implied

Graine removes the server's ability to READ. It does not make the server irrelevant, and the two
residual powers below are worth naming, because a reader who has just been told "the server holds no
key" will otherwise assume more than is true.

**The server still decides WHO is a member, so it still decides who may enter the distribution
group.** Entry is by external commit against a published `mls_group_info`, and eligibility is read
from a roster the server owns. A server that wanted future seeds would not read them out of a column
any more - it would admit a device it controls. That is a strictly better position than before (every
commit is visible to the members in the group's log) but it is not nothing, and no client currently
WATCHES that log for an unexpected admission. **The PAST is handed over on a member's signature, not
on the roster** since 2026-10-22: a member gives a community's history only to a newcomer whose
admission it can verify
([section 25](#25-a-member-hands-the-past-only-to-an-admission-it-can-verify-decided-by-the-user-2026-10-22)).

**`history_visibility` is a policy guarantee, never a cryptographic one.** Only a device holding a
seed can withhold it, so the rule is applied by the answering member. A modified client answers
anyway. This is inherent - the server holds no key and could not enforce it if it wanted to - and it
is written here so nobody later reads the setting as something it is not.

**`firstIndex` is the same kind of guarantee.** A handover floor says which messages of a session a
member is ENTITLED to, and `GraineBelowFirstIndexError` is the client declining to open below it.
Nothing cryptographic stops it: every index is derived from the seed (§4.1), so a member handed the
seed at floor 40 can derive index 3 with a modified client. The native push path does not even
decline - its mirror does not carry the floor.

**What v1 does NOT authenticate - found by the audit of 2026-09-27, closed by v2 (§21).** "The server
cannot read" was true and "the author shown wrote it" was not:

| What | Who can do it in v1 | Why |
| --- | --- | --- |
| Re-attribute a message to another author | the server | The author shown is the row's `senderId`, a clear column; `openChannelMessage` finds the session by id and never compares its sender with the row's |
| Move a message to another salon of the community | the server | AES-GCM is used with no additional data, so a ciphertext is bound to nothing but its key |
| Replay a message as a new one | the server | Same; and nothing refuses two rows naming one `(senderSessionId, messageIndex)` |
| Forge a message in another member's name | any member of the community | A seed is symmetric and every member holds it; nothing is signed |
| Record a session under the wrong minter | the server, or whoever answers a repair | The MLS layer verifies a frame's sender and then DISCARDS it (`mls-core/src/messaging.rs`), so `frame.sender` is the delivery envelope's claim; a repair bundle is stored under its ANSWERER, and `GraineMsg` carries no minter |
| Replace a held seed | any member answering a repair | Closed 2026-09-28: `storeIncomingSeed` and the native `merge_graine_seed` refuse a held session re-sent with other bytes or for another salon, out loud (`[GRAINE] REFUSED seed replacement`) |

The last row is the only one v1 could close without a format change. The others need what a v1 seed
does not carry: a minter, a key that signs, and bytes the ciphertext is bound to.

## 8. Retention: one window, and the seeds derived from it - SHIPPED 2026-08-19

A salon message used to live for ever, and the durable seed store was unbounded with it: the only
thing that ever dropped a seed was leaving the community (`forgetCommunityGraine`, WP-60), so a
device that stayed in an active community held every session ever minted for it.

**Messages expire after `CHANNEL_MESSAGE_RETENTION_DAYS` = 365** (`channel-retention.scheduler.ts`,
daily at 03:45), the user's decision of 2026-08-18. **Pinned messages are exempt**, which is not a
softening of the window: pinning is somebody deliberately saying this one outlives the scroll, and
deleting it silently at a year would destroy the one kind of message a human explicitly marked as
durable. Pinned sets are small and bounded per channel.

**The seeds are swept on the SAME window, and the window is asked for; the client holds only a
FLOOR equal to it.** The obvious implementation gives the device its own one-year timer, and that is
two windows meant to be one - the shape that drifts. Instead the server answers liveness and the
window, and the device bounds that window from below (`GRAINE_RETENTION_FLOOR_DAYS`, pinned equal to
`CHANNEL_MESSAGE_RETENTION_DAYS` by `retentionFloorPin.test.ts`):

1. `sweepExpiredGraineSeeds` (post-boot, tab-leader only) reads the session ids it holds out of the
   ENCRYPTED rows - id and date, never the seed, so an undecryptable row is swept like any other.
2. It posts them, 500 at a time, to `POST /api/channels/graine/live-sessions`, which answers which
   ids are still named by a stored message, scoped to the caller's communities.
3. Anything unnamed is dropped from all three stores: the durable rows, the native mirror
   (`forget_graine_sessions`, per session - the mirror's own per-channel bound only ever trims a
   channel something is still being WRITTEN to, so a quiet salon kept twenty plaintext seeds for
   ever), and the in-memory seed cache.

Two refusals carry the design:

- **A session younger than the window is never dropped, whatever the answer says.** "No message
  names this session" has two causes the answer cannot separate - its messages expired, or it has
  none yet - and only the first is a reason to delete. The window travels back with the answer
  (`retentionDays`); the client holds a floor equal to it, never a second clock, and it is sent as DAYS rather than as
  a cutoff instant so both sides of the comparison stay on the device's own clock.
  **Client-side bounds on server-provided retention (2026-10-22):** the answer is bounded from below
  by `GRAINE_RETENTION_FLOOR_DAYS` = 365 (`retention.ts`), the product window above. An honest
  server answers exactly that, so the bound changes nothing; an answer below it (zero and negative
  included) is logged at `error` and the sweep runs with the floor, so no seed younger than a year is
  ever dropped on a remote number. A non-numeric answer is refused outright. There is no ceiling: it
  could only delete SOONER than the server says, and the server already decides which sessions are
  live. **Changing `CHANNEL_MESSAGE_RETENTION_DAYS` means changing the floor in the same change.**
- **A chunk that went unanswered abandons the whole run.** A failed ask reads exactly like "the
  server names nothing", and acting on it would delete every seed on the device the first time the
  API is down. The server refuses a list over `MAX_LIVE_SESSION_QUERY` = 500 rather than truncating
  it, for the same reason: a truncated answer reads as "the rest are dead".

**This is also what makes the pinned exemption safe.** A pinned message keeps naming its session, so
the session stays live, so its seed is kept. A matching client-side timer would have deleted that
seed and turned a deliberately preserved message into ciphertext nobody holds the key to.

**The figure at ship time was zero.** `channel_messages` held no rows at all - THE CUT deleted every
community on 2026-08-18 and none had been recreated - so the window was armed on deploy with no data
to forecast its cost from. That is stated rather than a figure being invented; the user's decision of
2026-08-19 was to build and arm directly.

## 9. The distribution group is not a conversation, and two sweeps assumed it was - FIXED 2026-08-19

**The community rework shipped non-functional, and one prod run found it.** MSG-5, the first send
ever attempted against production, failed on the creator AND on a member who had joined by invite
link, nine minutes apart:

```
[SEND] Failed: [GRAINE] community b9d52032 has no distribution group on this device
       - nothing can be sealed for it until the join lands
```

Nothing about the join was broken. The client fetched the base, external-joined, republished the
GroupInfo, and social-service logged all of it. Two seconds later:

```
[MLS] externalJoin succeeded for d70e8952... (base epoch 19)
[SYNC] WASM removed (absent from server): d70e8952...
```

### What the sweep believed

`GET /api/mls/users/:id/groups` is **the one place a client learns which groups exist**, and it
excludes a community's distribution group on purpose - that group carries seeds, never a message,
and holds no `dm_group_members` row *by construction*. The exclusion is right, and it is documented
on the route itself.

Two reconcilers then read that answer as *every group this device may legitimately hold*:

- `syncConnectionAfterWsOpen` step 3 - "purge WASM state for groups no longer known to the server";
- `discoverMissingGroups` phase 1 - the same comparison, written separately.

A premise scoped to conversations, used to authorise destruction of anything. The distribution group
is in `getLocalGroups()` and can never be in that list, so it was forgotten on **every connection**,
and `persistMlsStateAfterMutation` made the loss durable.

### What the user saw

Everything after that follows mechanically:

- each boot re-joined by external commit, so the group's epoch climbed one per connection - **2 to
  21 in a single afternoon**, one stale leaf per join;
- every seed ever distributed fell behind the live epoch, so no member could read any of them;
- whether a user could send at all depended on **which of the join and the sweep finished last**.
  The whole feature is verified by compiling and by unit tests, and no unit test holds two async
  paths against each other.

### The fix

**Absence from that list is a reason to ASK, never a reason to destroy.** The `dm_groups` row is the
only thing that knows which kind of group it is, and it already carries the answer, so
`GroupMeta` now carries `distributionWorkspaceId` and `groupLifecycle.ts` gains the decision both
sweeps call:

- `decideAbsentLocalGroupFate` - a pure reducer: a registered or row-confirmed distribution group is
  KEPT; a network doubt is KEPT; only a `dm_groups` row confirmed absent, or a conversation row this
  device holds no membership in, is forgotten. The second case is exactly the behaviour the sweeps
  always had, now taken on a row that was read rather than on a list that never named it.
- `reconcileAbsentLocalGroup` - the shared I/O around it. It short-circuits on
  `isDistributionGroup`, and when it does have to ask, it **registers what it learnt**. So the sweep
  that used to destroy the group is now how a cold boot discovers it, before any community has
  loaded. One request per community per SESSION, and the ordering between the Graine layer and the
  reconcilers stops mattering at all - which is what removes the race, rather than an ordering
  imposed by hand between two async paths.

Both sweeps go through it, for the reason `decideAbsentGroupFate` exists: two copies of this
decision diverging IS the defect.

### The redelivery loop underneath it

The same probe showed **60 console lines per boot** - the same six frames, re-read on every
connection for ever. `routeDistributionFrame` refused to acknowledge ANY frame it could not decrypt,
which is right while a redelivery can still help and is an infinite loop when it cannot. Among those
frames were this device's own seeds, which OpenMLS refuses by construction
(`CannotDecryptOwnMessage`), and frames from a past epoch that `mls-core` had already classified in
its own log as *"unreadable for good"*.

`classifyIncomingDecryptError` describes itself as the single source of that classification, with
each consumer keeping its own policy; this consumer had never adopted it. It now does:
`own-message`, `secret-reuse`, `past-epoch-application` and `generation-gap` are **acknowledged**
with one line, because what recovers a lost seed is a peer answering `requestCommunityHistory`,
never the server handing the same undecryptable bytes back. Everything else is still redelivered.

### What this leaves

The population that was live while the defect was: session seeds distributed between epochs 8 and
21 on `d70e8952` are unreadable for good on every device, and are now acknowledged rather than
looping. New sessions are minted at the live epoch and readable by every member. The stale leaves
one per external join left in the group are inert - a member that no device will ever speak as.

### Two more the same run found

**The live route dropped an unreadable message anonymously and asked for nothing.** A salon message
and the seed that opens it travel on two different transports, so a receiver can get the message
first - the ordinary case for the first message of a new session. The HISTORY path had always
handled it correctly: it names which of the three unreadabilities it was, and calls `noteMissingSeed`
for the one a peer can fix. The LIVE path (`channelEventHandler`) caught everything into one
`console.error('Failed to parse channel message')` and asked for nothing, so recovery happened only
if a history reload later ran the other path. Measured on A1 during the MSG-5 re-run: six seconds,
one ERROR line, and the repair triggered by the wrong code path. Both now call
`reportUnreadableChannelMessage`, one function, because the two had drifted and only one was right.

**Leaving a community did not leave its distribution group.** `forgetCommunityGraine` erased the
seeds, the in-memory maps and the native mirror - everything this device HELD - and never the MLS
group, which is what keeps FEEDING it. The gap was invisible while the reconciliation sweep above
destroyed that group on every connection: an accident was doing the work. With the sweep correctly
keeping it, a community left in the morning would still be receiving seeds at midnight.
`forgetDistributionGroup` is the counterpart of `ensureDistributionGroup` - the tree and the
registration together, then a checkpoint, because a forget nothing persists comes back on the next
load.

**A departing member's LEAF stayed in the tree** - the last of the three, and the largest. It has
its own section below.

## 10. A departure moved nothing, and rotation waited on it - FIXED 2026-08-19

`graineRotationReason` returns `roster` when a session's `distributionEpoch` no longer matches the
distribution group's, and its own doc gives the premise: *"every membership change commits to the
community's distribution group and advances its epoch"*. **Nothing implemented that.** The whole
forward-secrecy story of a community rested on a sentence.

### What was measured, on production

`d70e8952`, the campaign community's distribution group, at epoch 25. W2 left through the real UI
(community settings -> *Quitter la communaute* -> confirm), the sidebar dropped it and
`POST /api/channels/workspaces/.../leave` was sent; `channel_members` went from two rows to one.
Then:

- `mls_group_info.baseEpoch` was **still 25**, `updatedAt` unchanged. No commit had happened.
- W1's next send produced the four `[SEND]` lines and **no** `[GRAINE] new outbound session` - the
  session minted before the departure was reused, so the seed W2 already held opened it.
- `dm_device_group_memberships` still carried W2's device as `active` on that group, so the delivery
  service went on fanning every seed frame out to it.

The two facts are independent, and each is sufficient on its own: one lets a departed member READ
what follows, the other keeps DELIVERING it to them.

### The two halves of a departure, and why they are not symmetric

**Routing is revoked by the server, immediately, and needs nobody online.**
`DELETE internal/mls/distribution-groups/:workspaceId/members/:userId` drops the leaver's
`dm_device_group_memberships` rows, their queued frames for that group, and their entries in the
Redis fanout set - three stores, none standing in for the others: the rows are what a reconnect
reads, the set is what a live fanout reads, and the queue holds frames already sealed for a device
that was offline. It is called from `leaveWorkspace` and `kickFromWorkspace` **before** the
membership row is deleted, and a failure aborts the departure: the MLS half self-heals whenever a
member next loads the community, but nothing ever comes back for a routing row left behind. Failing
closed leaves them a member and the whole departure retryable, the same rule `hardDeleteWorkspace`
already follows.

**The leaf is removed by a member, lazily, because only a member can commit.**
`reconcileDistributionGroupRoster` diffs the group's ratchet tree against the community roster and
commits one Remove covering every stray - all their devices, all of them - so a departure costs one
epoch whatever the fleet behind it. It runs from `ensureCommunityDistributionGroup`, on **both** its
branches: a device that has just joined can carry a departure as well as one that has been in the
group a week, and a pass on only one branch would leave a community whose members all reconnect
fresh with a tree nobody prunes. It is idempotent by construction - a tree that already agrees
produces no commit and no epoch change - so it is safe to repeat and does not rotate a session for
nothing.

**A diff, not an event.** A departure notice reaches only the devices online when it fires, and only
one of them may commit; electing that one is a race, and a durable "somebody left" marker is state
every device must write and keep. A diff between two lists needs neither: same answer whoever runs
it, whenever, converging to nothing to do.

**A roster it could not read removes nobody.** A fetch that threw is not an empty community, and
reading it as one would empty the tree of everybody but this device. Same rule as every other
destructive sweep here.

### The actor of a removal commits it - 2026-10-27

"Lazily" turned out to mean "at the next app load": the pass ran only from the community LISTING,
and selecting a salon or a community calls nothing that reaches it. So the device that had just
revoked somebody from a private salon - holding the salon's group, online by construction - committed
nothing while it stayed loaded, and every session minted meanwhile stayed at the epoch the removed
devices hold, protected by server routing alone. The rig hid it for a while: the leave-and-re-enter
gesture of its salon row was a full page load until it became a click, after which the row measured
the real behaviour.

**Whoever removes somebody commits the Remove**, the mirror of section 20's admission:
`commitSalonRevoke` (`frontend/src/lib/utils/graine/commitRemoval.ts`) runs from the settings panel
right after the server accepts the revoke, not awaited and never throwing. It is the SAME roster
pass, not a second implementation - a diff read after the server write, so it removes exactly whom
the server no longer lists - and the pass is now serialised per scope
(`reconcileDistributionGroupRoster`): a pass waits for the one running on its scope, and callers
arriving while a pass still waits share it, so the actor's pass and a load's cannot both commit the
same Remove. One writer: the actor's own device, on its leader tab. A shared pass logs through every
caller that shares it. **The lane is bounded by its transports, not by a timer**: each pass awaits a
local tree read, the roster and base reads (`apiFetch`'s response-head deadline, a typed
`RequestDeadlineError`), at most one commit (the MLS lock-hold budget) and a local persist, so every
pass settles, and a failed one is swallowed by the lane's tail rather than holding the scope - a
hung actor pass cannot stall a community's opening. A removal the gate refuses re-reads the tree:
"already gone" when another device removed them first, "still hold a leaf" only when they do.

**A community kick, the same way** (`commitCommunityKick`, from the community admin panel): the
kick cuts and strips the person from the community AND from every private salon in one server call,
so the actor commits in the community's key group and then in each private salon's group of that
community it holds, one at a time. A `channel.member.kicked` broadcast about somebody else stays
`ignore` on every receiver (`memberRemoval.ts`): the commit is the actor's, never the fan-out's.

**A departure nobody acting can commit is committed by ONE ELECTED device**
(`frontend/src/lib/utils/graine/departureCommitter.ts`). A member's own LEAVE has no committer: MLS
does not let a member commit its own removal, and the leaver's devices are unrouted first. A kick or
a revoke whose actor holds no leaf in a scope is the same case. So every receiver of the removal
broadcast about somebody else - and a salon leave now broadcasts `channel.member.removed` with the
leaver as its own actor, to the salon's audience and the leaver - reads the scope's tree and its
roster with per-device presence and elects the same device: the first, in canonical
`userId:deviceId` order, of the tree's leaves whose user is on the roster, is not the departed user,
and whose device the roster reports online. That device runs the scope's roster pass (the same
serialised pass, so a load's pass cannot double it); every other receiver commits nothing and logs
whom it left it to. When the actor's user holds a leaf, the receivers leave it to the actor. No
clock: two receivers reading presence a moment apart may elect two devices - the epoch gate keeps
one commit and the other pass finds nothing to remove - or none, and then the Remove waits for a
holder's next roster pass. Neither is retried.

What it does not cover, said in its log line and left to a holder's next pass (the convergent diff
above, unchanged): an actor or an elected device on a follower tab, a session with no Graine
runtime, a roster read without per-device presence, no remaining device online - and **an
access-list rewrite** (`updateChannelAccess`: a salon's list edited wholesale, or a public salon made
private with a shorter list), which runs no actor pass and broadcasts no removal at all.

### Two primitives were missing, and one was inert

`member_identities` / `get_member_identities` / `lister_identites_membres` (mls-core, wasm, Tauri):
**the tree is the only authority on who can READ a group.** `GET mls/groups/:id/members` answers who
the delivery service will ROUTE to - a different question, empty for a group whose tree is full after
a device fresh-start, and a distribution group has no user-level rows at all by construction. A
removal decision reads the tree.

`remove_members_for_users` compared a bare user id with the full credential identity, which is
`userId:deviceId`. **It matched nothing and could only ever answer "No member found"** - the entire
user-level removal path was inert, in communities and in group conversations alike. It now matches
the `userId:` prefix, colon included so one user id cannot swallow another's
(`tests/roster_removal.rs`).

### What this leaves

A member who left before the fix keeps a seed that opens what was sent up to the first send after a
remaining member reloads the community; from that send on, the session is minted at an epoch their
leaf is no longer in. Their routing is already cut. The stale leaves from the WP-GRAINE-1 rejoin
storm are removed by the same pass whenever their user is off the roster; the ones belonging to
current members are inert and stay.

### The asymmetry has a third half: COMING BACK - FIXED 2026-08-21 (WP-REGRANT-1)

The two halves above are what a departure costs. What neither of them says is what the LEAVER ends
up believing, and that turned out to be the defect.

The routing revoke is immediate; the Remove is committed later, by a remaining member, **and it is
published to the group the leaver is already unrouted from**. So the leaver never receives the
commit that removes them. Their local MLS group stays alive, at its old epoch, for ever. Nothing
ever corrects it, because the only thing that could was routed away one step earlier.

`ensureDistributionGroupFor` then read that local group as membership:

```ts
const known = mlsService.distributionGroupFor(scope);
if (known && mlsService.getLocalGroups().includes(known)) { reconcile; askForHistory; return true; }
```

Re-granted, the member's client took that early return on every load - reconciled, asked for
history, and never re-joined. **The join is the ONLY writer of `dm_device_group_memberships`**, so
nothing put their delivery rows back and they read nothing in that salon again. A reinstall was the
only recovery.

**Measured on production 2026-08-21**, one private salon, W1 owner and W2 peer:

| gesture | epoch | delivery rows for W2 | W2 reads |
| --- | --- | --- | --- |
| granted, peer opens the salon | 1 -> 2 (1863 ms) | 3 | yes |
| revoked, owner opens it | 2 -> 3 | 2 | no |
| **re-granted, peer opens it again** | **3, unchanged after 180 s** | **2** | **NO** |

**The fix carries the fact to the decision, rather than inferring it.** Holding the group locally is
this device's MEMORY of having joined; the delivery rows are the fact, and only the server holds
them. `GET internal/mls/distribution-groups/:scope/:scopeId?userId=` now answers `memberDevices` -
this user's device ids in that group, `pending` rows included, because the question is "was the join
RECORDED", not "is it in sync". social-service names the reader on both distribution-group reads and
passes the array through; the client compares it against its own device id and, when the group holds
no row for it, calls `forgetDistributionGroup(scope)` before re-joining. **In that order, and the
order is the fix:** `ensureDistributionGroup` returns early on a group it already holds
(`BaseMlsService.ts`), so re-joining without forgetting first is a no-op.

Three properties, each deliberate:

- **`undefined` is "nobody asked", never "no devices".** A caller that did not name a reader, or an
  older delivery service, leaves behavior exactly as it was.
- **A failed read is not an eviction.** The fetch used to happen only when the group was NOT held,
  so transport could never break a healthy load; now that it always happens, a throw keeps the held
  group and takes the old path. Same rule as the roster reconciliation.
- **The repair ACCUSES.** Reaching it means the two sides had drifted and a member was sitting in a
  salon receiving nothing. The line is the only record that it was ever broken, and its RATE is what
  says whether the drift is rare or routine. `[DISTRIBUTION_GROUP] served ... devices=N` and
  `[CHANNEL_GRAINE] served ... devices=N` are the server's half of the same evidence.

A diff, not an event - the same reason the roster reconciliation is one. Nothing has to be online at
the right moment, nothing has to be remembered, and repeating it converges to nothing to do.

**THE FIRST ATTEMPT AT THIS FIX WAS A NO-OP ON PRODUCTION, and only the accusing line caught it.**
It gated the comparison on `distributionGroupFor(scope)` - the scope->group registration - and
forgot through the same door. But that registration is a SECOND copy of a fact the MLS layer already
holds, `ensureDistributionGroup` early-returns on the GROUP ID, and the two can disagree. A device
whose registration did not name the group therefore failed the gate (so no check), then reached a
join that early-returned on the tree it was still holding (so no join): the bug wearing the fix's
clothes, and the server log was identical to a healthy load. Re-measured on `19a58034` at 01:56:04
UTC - `served ... user=b78568a3 devices=0`, one read, no publish, no repair line.

Both sides of the comparison are now named by `ref.groupId`, the one name the server and the MLS
layer agree on, and the forget is `forgetDistributionGroupById` for the same reason. And the third
state - `memberDevices` absent, the question never put - logs, because "the roster agreed" and
"nobody asked" reaching a run log looking identical is precisely what let the first attempt pass.

**VERIFIED ON PRODUCTION, against the salon the first attempt had left stranded** - `19a58034`,
group `b0192801`, unrouted for 53 minutes - the moment the second deployed and the peer reloaded:

| UTC | Server line |
| --- | --- |
| 02:49:04 | `served channel=19a58034 user=b78568a3 … devices=0` |
| 02:49:05 | the same read again, from the join's own transport |
| 02:49:05 | `published channel=19a58034 user=b78568a3 epoch=2 stored=true` |
| 02:49:25 | `served … devices=1` |

Three rows on the group afterwards, the peer's among them. **The negative control is the first
attempt**, on the same salon, one deploy earlier: one read, no publish, `devices=0` for three
minutes.

## 11. A private salon's ciphertext was addressed to the whole community - FIXED 2026-08-19

Found while answering a question about §4.3, and it is the second half of it. §4.3 settles how a
SEED reaches a community. Nothing had ever asked how the CIPHERTEXT does.

### The two halves, and why only together they are a defect

A private salon is `channels.isPrivate` with an `allowedUsers` list, and every REST route that
touches it is guarded by `canAccessChannel`. That guard runs on the ACTOR - the person making the
request. It had never run on the AUDIENCE.

Every channel event was published with `getWorkspaceMemberIds(channel.workspaceId)`: a question
about the CONTAINER. The gateway does exactly as it is told and delivers to those user ids, so a
member excluded from a private salon received, on their own authenticated socket:

| Event | What it carries |
|---|---|
| `channel.message.created` | `ciphertext`, `nonce`, `senderSessionId`, `messageIndex` - inline |
| `channel.typing` | who is writing there, live (never sent back to the typist) |
| `channel.pin`, `channel.message.deleted` | what is pinned, what was removed |
| `channel.poll.vote` | the tally |
| `channel.updated`, `channel.member.joined` | the salon's NAME, and who was added to it |

On its own that is a metadata leak. What makes it a confidentiality defect is §4.3: the Graine seed
that opens those ciphertexts is distributed on the COMMUNITY's distribution group, so every member
already holds the key. **Both halves were on the excluded member's device.** The only thing
between them was `channelEventHandler` declining to render a channel it does not have in
`conversations` - client-side restraint, in a client the reader controls.

The push path was the one that filtered, because `notifyChannelRecipients` was written per
recipient and reached for `canAccessChannel` naturally. That is what kept the gap invisible: the
mechanism that looked like the risky one was correct, and the one nobody looked at was not.

### The fix

`channelIsReadableBy(channel, userId, holdsManageWorkspace)` is now the ONE rule, pure and
database-free, and everything that needs it supplies the admin bit from whatever it already has
(the third argument went away with the admin bypass on 2026-08-20 - see §13):

- `canAccessChannel` - one actor, one permission lookup;
- `channelAudience(channel)` - every member, two bulk `find`s, and a public channel skips the role
  load entirely so the send path costs nothing extra;
- `listChannelMembers`, which had a third hand-rolled copy of the same rule.

Every content and channel-lifecycle event is now addressed to `channelAudience`, and
`notifyChannelRecipients` reads the same list - a push that reached somebody the socket frame did
not would be this leak arriving by another door. Community-scoped events (`workspace.updated`,
`workspace.deleted`, the community-level `channel.member.kicked`) still go to the community, which
is what they are about.

**Two ordering rules fell out of it, and both are load-bearing.** An audience derived from access
inverts what "notify" means at the two moments access CHANGES:

- `inviteToChannel` now writes `allowedUsers` BEFORE publishing. It published first and granted
  after, which under the old community-wide audience was invisible and under this one would address
  the invitation to everyone except the person invited.
- `removeMemberFromChannel` strips `allowedUsers` first, so the audience no longer holds the
  target - who is added back by name. Losing access is the one event its subject must receive.

Covered by `channel-audience.spec.ts`, whose six behavioural cases were each run against the old
audience and each failed.

### The same question, one method away

`getChannelAccess` returns a private salon's `allowedUsers` - which IS its roster - and checked only
that the caller belonged to the COMMUNITY. `listChannelMembers`, a few hundred lines up, asks
`canAccessChannel` for the same fact. Found while writing this section down rather than by a
failure, and fixed with the guard it should always have had.

Worth stating because it is the third form of one mistake: **the actor check and the data's owner
were different scopes.** Wherever a route returns something ABOUT a channel, ask whether its guard
names the channel or merely the community around it.

### What this did NOT fix - closed by §13

The guarantee for a private salon was still **server-enforced, not cryptographic**: every member of
the community held the seed, because §4.3 gives the community exactly one distribution group. This
change meant the server no longer handed them the ciphertext; it did not mean they could not read it
if they obtained it another way.

The structural answer - a distribution group PER PRIVATE SALON - **shipped 2026-08-20 and is §13**. The product question it turned on (admins reaching every private salon without being in it)
was answered by the user on 2026-08-19: the admin joins explicitly.

## 12. Open, and not blocking

Nothing here blocks anything above.

## 13. One distribution group per private salon - SHIPPED 2026-08-20

The structural answer §11 named and did not write. A private salon's guarantee stops being "the
server declines to serve you the ciphertext" and becomes "the seed was never sealed to you".

### What changed, in one sentence

A private salon has its OWN key-distribution group, whose roster is `allowedUsers`; a public salon
has none and rides the community's, because its audience IS the community.

### The scope, and why it is one object

`dm_groups` gains `distributionChannelId` beside `distributionWorkspaceId`, with a database CHECK
that **at most one of the two is set** (migration 018). A row reachable from two scopes would be
served to two rosters, which is the defect the scope exists to remove.

Everything else is the same machinery, deliberately: seeds only, never a conversation, entered by
external commit, no `dm_group_members` row and no `DeviceGroupMembership`. Those absences are what
the WP-20 audit in §7 is built on, and duplicating the family per scope would have doubled a surface
audited once. The five internal routes take `:scope/:scopeId` and refuse an unknown scope rather
than defaulting to `workspace` - a default would serve a salon's caller the community's group, i.e.
exactly the sharing being removed.

On the client the same rule holds: `DistributionScope` is one type, `scopeKey` is the one place a
map key is spelled, and the prefix (`w:` / `c:`) is what keeps a salon's entry from colliding with a
community's - both ids are uuids drawn from the same space.

### The admin problem, and the decision that settles it

§11 ended on the product question: an admin reached every private salon without being in it, so the
roster was `allowedUsers` **plus whoever happened to hold an admin role at that moment**. That set
changes without anyone touching the salon, and a set like that cannot be an MLS group - every seed
would have to be sealed to a membership nobody committed.

The user's decision of 2026-08-19, and it is what makes the design possible:

- **An admin JOINS explicitly.** `POST /channels/:id/join-as-admin` requires `MANAGE_WORKSPACE`,
  adds them to `allowedUsers`, and from then on they are an ordinary member of that roster.
- **The join shows in the MEMBER LIST only - no system message.** A line in the transcript would be
  a permanent record of a moderation act inside the conversation being moderated, which is a
  different decision from the one being made here.
- **An unjoined private salon is still VISIBLE to an admin** - its name, `viewerHasAccess: false`,
  and nothing else. Without that the capability is unusable: making the bypass explicit would have
  made private salons invisible to the only people who can moderate them. What leaks is a salon's
  existence, to someone who can add themselves to it in one click anyway.
- **Forward secrecy is decided AGAINST.** An admin who joins reads the salon's past, exactly like
  any invited member; the Graine history rules of §8 already govern that and are not re-litigated
  per scope.

So `channelIsReadableBy(channel, userId)` lost its `holdsManageWorkspace` parameter and is now
`allowedUsers` and nothing else. That is the whole of the access rule, in one pure function.

### The lifecycle, and where each half may fail

| Moment | What happens | May it abort the operation? |
|---|---|---|
| A salon is created private | group minted, id stored on `channels.distributionGroupId` | **Yes** - the salon row is deleted if it fails |
| Public -> private | group minted before the row changes | **Yes** |
| Private -> public | group tombstoned after the row changes | No - best-effort, logged at ERROR |
| Archived | group tombstoned | No - there is no route back, so this is its end |
| One member loses access | evicted before `allowedUsers` is written | **Yes** |
| A member leaves/is kicked from the COMMUNITY | evicted from every private salon they held, AND removed from each `allowedUsers` | **Yes** |
| An account is deleted | same sweep, driven by the repair route, which is the only thing left that knows who it was | No - per workspace, isolated and logged |
| The community is hard-deleted | every private group tombstoned before the transaction | **Yes** |

The asymmetry is the same one §10 states: what may abort is what would otherwise leave a routing row
nothing will ever come back for; what may not is what would otherwise leave a salon nobody can
archive. A leftover group distributes to a roster nothing consults and is inert - but it is logged
at a level that ACCUSES, because inert is not the same as intended.

**The roster removal is not tidiness.** `reconcileDistributionGroupRoster` diffs the MLS tree against
`allowedUsers`, so a leaver still named there would have their leaf re-authorised at every
reconciliation pass, for ever - a departure the tree undoes.

### What the client had to learn

- `registerChannelWorkspace(channelId, workspaceId, isPrivate)` - the third argument is REQUIRED
  rather than defaulted, because a default is a guess about which roster a seed is sealed to, and
  the wrong guess in the safe-looking direction (public) is the one that hands a private salon's
  seed to the whole community.
- `sealChannelMessage` asks `scopeForChannel`, never `workspaceForChannel`.
- Reconciliation reads the SALON's roster (`listMembers(channelId, 'channel')`) for a salon scope,
  and the repair asks a salon member for a missing seed - asking a community member would name an
  answerer who cannot even see the request, since it travels on the salon's group.
- `forgetCommunityGraine` leaves EVERY scope of the community, enumerated from
  `mlsService.distributionScopes()` rather than from the channel list, which the purge is about to
  empty.
- The join path is `ensureDistributionGroupFor(scope)`, one function for both scopes - a second copy
  would be a second place for the join, the reconciliation and the history request to drift apart.

### The history request stays community-scoped, deliberately

`requestCommunityHistory` means "this device holds nothing at all for this community". A member
joining a private salon already holds the community's seeds, so the ask would short-circuit and they
would still be missing the salon's past. What recovers that is the per-message repair of §4, which
asks a NAMED holder for the exact sessions a message needs - and that path is salon-aware.

**AND "NOBODY TO ASK" IS VERSIONED ON THE ROSTER, not filed as an ask (FIXED 2026-09-14).** The ask
runs on every ordinary trigger, including the already-in-the-group branch of
`ensureDistributionGroupFor`, whose own comment says why: *"a device that joined while its answerer
was offline would never ask again if the ask lived only on the joining branch"*. `historyAsked`
defeated exactly that. It is the set of communities this session HAS asked, and the branch that
found nobody to ask added to it - recording a request that never went out, and making the skip last
the session. The only things clearing it were the community leaving the device and a restart, the
second being the user getting themselves out of an impasse.

It is keyed on the distribution epoch instead. Both halves of "nobody to ask" - a second member, a
second device of ours on the group - are membership, every membership change commits to the
distribution group and advances its epoch, so the epoch IS the version of that answer. A pass that
finds the same epoch returns before the roster read and writes no line; a pass after the epoch moved
asks again. The measured case: a phone joining while the laptop holding the seeds is offline, then
the laptop coming online and joining - which is itself the commit that moves the epoch.

### An answer carries only the seeds of the salons its key group may read (2026-10-22)

**Seeds are STORED per community, whichever key group brought them** (`IMlsService.DistributionFrame`),
so a device's store does not say on its own which roster a seed was sealed to. Both answer paths -
the HISTORY bundle (`gatherCommunityHistory`) and a SESSIONS repair (`gatherNamedSessions`) - read
that store, and an answer goes back on the key group the request ARRIVED on. So both keep only
the sessions whose salon rides that group (`seedOutsideScope` in `frameHandler.ts`):

- on the community's group, the seeds of PUBLIC salons only;
- on a private salon's own group, the seeds of that salon only.

Which group a salon rides is `scopeForChannel`, learned from the community listing
(`registerChannelWorkspace`) - the same fact the seal uses. A salon the answerer has NOT listed is
withheld: its roster is not known, and guessing public is the expensive half of the asymmetry. A
withheld seed is absent from both lists of the answer, for the reason a `joined` refusal is (every
honest member filters the same way, so `missing` would walk the roster), and a HISTORY answer left
with nothing to send stays silent rather than claiming "I hold nothing" (section 24).

**The receiver checks the same fact, for a NEW seed** (a held session is judged as before):

- another salon's seed on a private salon's own group is refused, at error level - no honest path
  sends it;
- a seed of a salon registered PRIVATE, on the community's group, is not stored, at warn level and
  accusing nobody: a salon made private after it was public leaves, in the community group's log,
  the seeds minted while it was public;
- a seed of a salon the community's listing did NOT name, once that listing has answered
  (`markCommunityListed`), is held in memory, unstored (`awaitSalonListing`). The listing names
  every public salon to every member and a private one only to its members and administrators, so
  such a salon is private and closed to this viewer - or public and created since the listing, its
  seed having beaten the channel-created event. Its registration decides: public, the seed is
  admitted and the salon re-read; private, or never, it is dropped;
- before the community's listing has answered, a seed of an unknown salon is kept: a public
  salon's seeds arrive with the key group, ahead of the listing.

Pinned by `frameHandler.test.ts`, "the salon scope of an answer".

**The native mirror cannot make that check** - it knows neither which salons are private nor which
key group a frame came on. So a bundle's seeds are marked `relayed` by `proto_fields::graine_seeds`,
and `store_graine_seeds_json` mirrors a relayed seed only for a salon the mirror already holds a
session of; any other is left to the app, which reads the same answer from its durable queue. That
check opens the SEALED mirror with the cache key, through the one reader `read_graine_mirror`: a
plain-text read of it failed on every sealed file, so no relayed seed was mirrored at all
(`a_relayed_seed_is_mirrored_only_for_a_salon_the_device_already_reads`). A sender's own distributed
seed is mirrored as before. Bundles reach the native path only on Android
(`handleMlsFrame`, a key-group push with its ciphertext inline); the iOS extension opens only the
`seedFrame` a salon push carries, which is a single seed.

### Found while writing this: a discriminator dropped in transit

`GroupMeta.distributionWorkspaceId` has been documented since WP-22 as "the discriminator a
destructive sweep needs", and `decideAbsentLocalGroupFate` reads it. `mlsDeliveryApi` never mapped
it out of the response body. So the only thing that ever kept a distribution group alive through the
orphan sweep was having been registered earlier in the same session - a sweep that ran first forgot
it, and the seeds stopped arriving until the next boot re-registered it. Both fields are carried
now, and the sweep keeps a group named by either.

### Found on production, and only there: the three routes were registered one segment too deep

`@Controller('channels')` already contributes the first segment, so `@Get('channels/:channelId/distribution-group')`
registers **`/channels/channels/:channelId/distribution-group`**. All three of the routes added for
this design carried the doubled prefix, so the client's `GET /api/channels/:id/distribution-group`
met Nest's own 404 - `Cannot GET` - and `ensureDistributionGroupFor` reported the salon as having
no group while the group sat on the server, correctly minted, addressed by nothing.

**Nothing in the repository could have caught it.** The path is composed at bootstrap from two
decorators written in different places; it is not a type error, not a lint error, and every unit
test of `getChannelDistributionGroupForMember` passed because the method was right. It took
creating a private salon on production and watching a real client ask - which is the campaign's own
rule, stated in CLAUDE.md: a green gate is not a working system, and everything verified by
COMPILING proves nothing about running.

`channels.controller.spec.ts` now reads Nest's `PATH_METADATA`/`METHOD_METADATA` off every
handler, composes the full path, and asserts three things: that no handler repeats the controller's
own prefix (**the defect class**, not this instance of it), that the five Graine routes exist at the
exact strings the frontend's `distributionGroupUrl` builds, and that the salon route is declared
before the catch-all `:channelId` routes that could shadow it. Re-introducing the doubled prefix
fails two of them.

### Three more, from driving a real salon through its whole lifecycle

Creating one private salon on production found the routes above. Flipping that salon public and back
found the rest, and none of the three was reachable by any test in the repository - each is a fact
about a SEQUENCE of operations, and every unit test arranges the state it asserts on.

**1. A public salon could never be made private.** `ensureChannelDistributionGroup` guarded on
`channel.isPrivate`, and on this path the row is still public: the mint happens BEFORE the save, on
purpose, because that is what lets a salon whose group cannot be created stay public rather than
become a private salon with nowhere to put its seeds. The guard therefore refused the exact path its
own doc comment describes ("BEFORE THE ROW IS CALLED PRIVATE"), and `updateChannelAccess` answered
500. The intent is known at the call site, so it is passed - `ensureChannelDistributionGroup(channel,
willBePrivate)` - rather than re-derived from a row that answers a different question.

**2. Turning a salon public and private again handed it back the group it had just retired.**
`deletedAt` on `dm_groups` is a plain column, not a TypeORM `@DeleteDateColumn`, so an ordinary
`findOne` still returns a tombstone; the scope's partial unique index does not exclude one either.
So the reuse read in `createDistributionGroup` found the dead row and returned it - a group
`cleanupSoftDeletedGroups` is counting down to reap, whose MLS tree still held the previous roster.
Retirement now **releases the scope in the same write** as the tombstone, which makes the row an
ordinary dead group and leaves the scope genuinely unoccupied. Migration 019 frees the scopes of
rows tombstoned before that change (one row on production).

**3. `getUserGroups` hid a community's distribution group and not a salon's.** The partition that
keeps a distribution group out of every conversation surface tested `distributionWorkspaceId` alone
and was never extended to `distributionChannelId` - so invariant 2 of the WP-20 audit, which says
this list is the ONE place the exclusion lives, held for one scope out of two. Both are tested now,
and both are reported by the same warning: a membership row on a group joined by external commit
means something wrote one, and hiding it would be all the notice anybody ever got.

**And two user-visible strings that the design falsified.** `chat_channel_admins_access_all_hint`
told every reader of the access panel that "administrators always have access to every channel, even
private ones", which is precisely what this work removed; it is now
`chat_channel_admins_join_hint` and says what is true. The panel's own "Access" tab was a raw
French literal in the markup - the last one in this component - and is `chat_channel_access_tab`.

### The fourth, and the worst: the device that CREATED a group was on no roster

Found on production 2026-08-20, by putting a real second member into a private salon and watching
both consoles. **A private salon with two people in it did not work at all**, and no test in the
repository could have said so: every unit test arranges a roster, and this is a fact about who
writes one.

`dm_device_group_memberships` is the delivery recipient set - what the server consults to decide
which devices a frame on a group goes to. It is written in exactly one place, the commit fan-out,
where the device activated is the commit **sender**. A device that CREATES an MLS group sends no
commit. So the creator held no row on the group it had just made, and the server sent it nothing on
that group:

- not the next member's external-join commit, so the creator's copy of the group stayed at epoch 0
  while the group was at 1, and every seed it sealed after that was a past-epoch frame the new
  member could never decrypt (`Past-epoch application frame, unreadable for good: msg_epoch=0
  group_epoch=1`);
- and not that member's request for the missing seed either, so the repair path had nobody to answer
  it - the request was sent, logged, and delivered to an empty set.

The fix threads the publishing device through the four layers between the client and the delivery
service - `ChannelService` -> the social-service route -> `publishDistributionGroupInfo` -> the
internal route - so that **publishing the base is what puts the publisher on the roster**. That is
the only moment the server learns which device created the group; before it, the group has a
creator nobody can name. The call is unconditional and idempotent (a device that external-joined
already has its row, and the write underneath is an upsert). Nothing is replayed to it: the device
holds the group at the CURRENT epoch, so what came before is a stream of frames it cannot decrypt.

`deviceId` is **required**, not optional, at both routes. A publish that does not name its device is
a group whose creator is on no roster - this defect, silently - and storing it would leave the group
looking healthy while nothing can be delivered on it.

### Two more, from reading one warning nobody had classified

The run that proved the roster fix printed a line the harness could not classify, on a pair of
clients running the same bundle:

```
[GRAINE] distribution frame of kind 'system' from b78568a3... is not handled by this client
```

That warning exists to announce **version skew** - a peer speaking a protocol this bundle does not
answer. There was no skew. It is the visible end of two separate faults, and the second is what made
the first impossible to fix with a filter.

**1. The history reconciliation probed distribution groups as though they were conversations.** The
connection audit takes its targets from `getLocalGroups()`, which names every group a device holds:
the community's seed carrier and, since the salon scopes shipped, **one per private salon**. Each
got a `history_state` probe, broadcast to every member as an MLS application frame, asking them to
compare a transcript that does not exist. The peers answered nothing and logged the warning above.

**The cost is not the reason, and saying it was would be wrong.** Both sides compute "empty", agree
and fall silent, so the exchange is a no-op; and a broadcast advances every member's sender ratchet
by one uniformly, which is not the generation GAP the `recipients` rule warns about. What it really
costs is traffic - one stored, fanned-out frame per group per connection, queued for whoever is
offline, and now N+1 of them for someone who can open N private salons.

**The reason it is closed is the invariant.** A distribution group must never reach the conversation
pipeline, and the reconciliation IS that pipeline's repair arm - `recovery.ts` calls it straight
after a re-add. Today it compares and says nothing. The next branch it grows - a purge, a drop, a
"this group is damaged" - would act on a group it fundamentally misunderstands, and two defects have
already shipped from breaking this same invariant: the sweep that deleted the group, and
`getUserGroups` leaking it into the conversation list. This is the third place it was broken.

The guard goes in `reconcileGroup`, which is the ONE door every trigger comes through (a connection
edge, an unreadable frame, a peer coming back, a replay that gave up); the five call sites are
covered by writing it once. It is silent: not asking is the permanent, correct behaviour for this
kind of group, not a degradation of anything.

**2. `isDistributionGroup` answered FALSE about groups the server had just identified as
distribution groups.** One `Map<groupId, scope>` was answering two questions - *is this a
distribution group* and *whose roster is it* - and only the second needs the community. A salon's
`dm_groups` row carries the salon and cannot carry the community (chat-delivery does not own
`channels`), so for a salon whose community this session had not loaded, `distributionScopeFromMeta`
returned null and **the caller registered nothing at all** - although the sweep had, one line
earlier, spared the group on the server's word. The cheap answer was waiting on the expensive one,
and every consumer of the predicate inherited the ignorance for the rest of the session.

A separate `knownDistributionGroups` set now answers `isDistributionGroup`; the map keeps answering
`distributionGroupFor`. `noteDistributionGroup(groupId)` records what a group IS when its scope
cannot yet be named, and both are dropped together when the group is left - a predicate that
outlived its group would make the sweep spare state the device no longer holds, for ever.

**The other four consumers were enumerated, not assumed.** `getLocalGroups()` has five callers that
could have made the same mistake, and the seam is only closed if all of them are read:
`sessionAuth`'s lifecycle promotion and `sessionWatchdogs` both iterate CONVERSATIONS and use the
local list only as a membership lookup, so a distribution group - which is never in
`cb.conversations` - cannot reach them; `actions.ts` already routes through
`reconcileAbsentLocalGroup`, the shared decision, and gains the fix above for free; the frame
pipeline asks `isDistributionGroup` before `handleKnownGroup`. One of five was wrong. Enumerating
them is the only way that sentence can be written at all.

**The rule this leaves behind:** a log line nobody has classified is not noise to be filtered, and a
warning that names a cause is a CLAIM about that cause. This one said "version skew" on two clients
running the same bundle, which was enough to refute it on the spot.

### Migration: there was nothing to migrate

Measured on production 2026-08-19 before writing any of it: **zero private salons existed.** So no
backfill is written, no history is re-encrypted, and every private salon that will ever exist is born
after the switch with its own group. The user's decision, taken before that measurement, was that
private history could be erased if a migration were needed; the measurement made the question moot.

### The repair that worked said nothing - FIXED 2026-08-20

A seed reaches a device two ways, and only one of them was audible. The distribution frame announces
what it stored (`[GRAINE] seed <session> from <sender> for channel <id8>`); the REPAIR - a device
that met a message it could not read, asked, and was answered - absorbed the whole bundle in
silence. So the exchange logged its two halves and not its result: `asked <peer> for N seed(s)` on
one side, `answered <peer> with N seed(s)` on the other, and nothing at all about whether those
seeds landed. **A repair that worked and a repair whose seeds were every one refused produced
identical logs**, and the only symptom of the second is a salon that stays unreadable.

`absorbSeedBundle` now ends with `[GRAINE] absorbed <n>/<total> seed(s) from <sender> in community
<id8> - salon(s) <ids>`. Read it against the `answered` line: the counts agreeing is the repair, and
`absorbed 0/N` under `answered N` is an answer that repaired nothing. Since 2026-10-12 the line
reads `absorbed <new>/<total> seed(s) (<k> already held)`: `storeIncomingSeed` returns a
`SeedStoreOutcome` (`stored`, `already-held`, `refused`) instead of a boolean that folded the first
two together, and **only `stored` - a new session or a lower floor - announces a salon as
repaired**. A bundle travels on the community's distribution group, so every member receives the
answer to ANY member's request, and announcing held seeds re-read the salon's history on every online
member per answer: 18 refetches of one salon in three minutes on a client that had asked for nothing
(production web console, 2026-10-12, `v1.2.4`). A shortfall that is not
`already held` is a refusal, which warns or errors on its own line.

**Found by COMM-8**, which asserts that a member granted access to a salon is SEEN to receive its
seed. That assertion could not hold on any wording, because the only line it could match belongs to
the path a mid-salon grant never takes.

### The creator prepared nothing, so the first message in a new community was refused - FIXED 2026-08-20

Creating a community selects its default salon and leaves the composer ready. A public salon seals
its seeds to the **community's** distribution group, and only two paths ever ensured that group
existed on the device asking for it:

- `executeWorkspaceLoadAttempt` - the workspace LOAD, i.e. a start or a refetch;
- `createNewChannel`, and only for a **private** salon, which has its own group.

`ensureWorkspaceByName` created the community, listed its channels, selected one, and prepared
nothing. So the very first message its creator sent was refused outright, by
`seedDistribution.ts`:

```
[SEND] Failed: [GRAINE] community 9c973114 has no distribution group on this device -
       nothing can be sealed for it until the join lands
```

**It healed, which is why it survived.** A reload runs the load path. A second member joining finds
no base published, creates the group, and the creator joins it afterwards - which is exactly what the
run that caught this recorded: W2, the *joiner*, printed `no base published for community 9c973114 -
creating group 899da5c1...` while W1, the *creator*, was refusing the send one second later. The
defect lives only in the window where the creator is alone and has not reloaded, which is the minute
after they press the button.

That window is also why no check had ever seen it: every other COMM runner navigates - and
`enterCommunities` does a real `goto('/communities')`, which runs the load path and prepares the
group on the way past. COMM-1 posts without an intervening navigation, and COMM-1 had never once
completed a run.

The group is now ensured as part of creating the community, awaited, and placed **before** the
channels are listed - the reason the load path gives at its own call site: a seed frame arriving on a
group this device has not registered is answered as an unknown conversation, with a welcome request
nobody will ever send. It is never fatal: a community whose preparation fails still reaches the
sidebar, and its salons then refuse to send with a named cause rather than the community vanishing.

Three tests hold it: that the group is ensured, that it is ensured *before* the listing, and that a
failure to prepare still leaves the community on screen.
### A community deleted left its seed carrier held for ever - FIXED 2026-08-21

**Measured on production during the COMM campaign.** Group `b0192801` belonged to a community deleted
through the product at 05:50:52 UTC. Three hours later W1 still held it, and every single load wrote:

```
[PIPELINE] Out-of-sync for b0192801... - requestReAdd
[PIPELINE] Recovery attempt finished for b0192801...
```

Its `dm_groups` row was exactly what a deletion leaves: `deletedAt` set, `activeEpoch 2`, and both
distribution columns cleared. Before the debris was swept by hand, the same group also produced
repeated `[GRAINE] undecryptable frame on b0192801... - not acknowledged` - the server had frames
queued for it, a frame nobody can read is deliberately left unacknowledged so it will be retried, and
the seeds needed to read it had been correctly deleted with the community. A loop with no end on
either side, for a community nobody could name any more.

**Two independent causes, either one sufficient.**

`reconcileAbsentLocalGroup` short-circuited on `isDistributionGroup(groupId)` and returned `keep`
with `serverStatus: { kind: 'unknown' }` - it never read the row at all. That predicate exists so a
sweep will not destroy a LIVE seed carrier, which is WP-GRAINE-1 and is genuinely needed; it answers
*what the group is*, and it was being read as *whether the group still exists*. The two differ only
in lifetime - the predicate stays true for the rest of the session, the group can stop existing at
any point inside it.

Nothing else could ever collect what the shortcut spared, either. WP-60 gave the job of forgetting a
community's carriers to `forgetCommunityGraine`, and that is the right owner - a tombstone is not a
purge cue, and `groupLifecycle.test.ts` says so on purpose. But it enumerates
`mlsService.distributionScopes()`, which is `distributionScopeByGroup.values()`, and a group the
server identified while this session could not yet name its community is recorded by
`noteDistributionGroup` - which writes `knownDistributionGroups` **only**. In the predicate, in no
scope: unreachable from the purge side by construction. The only caller that can end such a group is
one holding the server's answer, which is why `forgetDistributionGroupById` was written and why the
sweep is where this had to be fixed.

**Asking is safe, and the answer is authoritative.** `GET /api/mls/groups/:id` reads `dm_groups` with
NO membership check, so the exclusion that hides distribution groups from `getUserGroups` does not
apply here. And a distribution group cannot be held locally before the server named it:
`ensureDistributionGroupFor` takes the id from `getDistributionGroup(scope)` and joins only
afterwards. There is no window in which a live carrier reads `absent`.

So `isKnownDistributionGroup` stopped being an unconditional first branch and became what it is - the
fallback for `unknown`, where nothing better exists. Every keep that mattered is unchanged: `active`
with distribution columns, `tombstone` with distribution columns (the deliberate decision), and any
row that cannot be read. What is now collected is the one state that used to be permanent: a row
confirmed gone, or one that has stopped naming any scope.

**The second cause was the drop itself.** `forgetMlsGroupIfPresent` called `forgetGroup`, which
erases the tree and leaves the `knownDistributionGroups` entry standing - so the predicate outlives
the group it described, and the sweep, which spares whatever that predicate names, would spare the
leftover entry for ever. It now goes through `forgetDistributionGroupById`, which drops the pair;
`initializeConnection`'s sweep, which had its own inline `forgetGroup`, uses the same helper.

Six tests hold it, and two that asserted the old behaviour were rewritten rather than deleted, each
carrying why: a registered carrier whose row is confirmed gone is forgotten, one whose row has
stopped naming a scope is forgotten, one whose row cannot be read is spared, and the reconciler reads
the row even for a group it has already registered.

### One gesture called the join twice, and the second call repaired the first one's half-finished work - FIXED 2026-08-21

Found in COMM-22's dirt, which is the whole reason a `PASS` carrying an unexplained line is recorded
as `PASS-DIRTY` rather than as a pass.

Both clients logged, on first opening the salon, `[GRAINE] salon 0a00f651 of 85d5164f: this device
holds the distribution group but the group holds NO row for it (0 device(s) for this user) - the local
group is stale, rejoining`. **W2's line was the mechanism working**: the check had revoked it fourteen
seconds earlier, so it held a group the server routed nothing to - the exact asymmetry WP-REGRANT-1
exists to repair, and it repaired it. W1's was not, and the server's own log settles which:

```
11:41:58  created                 published=false devices=0
11:41:59  read                    published=false devices=0
11:41:59  group-info epoch=0 stored=true
11:41:59  group-info epoch=0 stored=true      <- the same base, published twice
11:42:01  read                    published=true  devices=1
```

**Two concurrent calls, from one click.** Three call sites reach `ensureDistributionGroupFor` for a
private salon - creating it (the creator initialises its MLS state), loading the workspace that now
lists it (the walk enters every private channel's group), and joining it in-session - and the first
two fire on the same gesture, because creating a salon refetches the workspace to put it in the
sidebar. Both read a group with no roster row for this user, both created and published epoch 0, and
the second then found a group held locally that the server named no row for. That is indistinguishable
from an eviction, so it took the repair branch: it forgot the tree the other call had just built and
external-joined again, costing an extra epoch and leaving its first leaf in the tree.

The repair was right about what it saw. What it saw was another call's half-finished work - which is
the shape the standing rule names: **a race that heals cleanly is still a defect, so name what makes
the two paths overlap and delete the overlap.** A ledger reconciling them afterwards is a witness,
never a fix, and here the "ledger" was a destructive repair.

`ensureDistributionGroupFor` now shares one in-flight promise per scope. Every caller wants the same
postcondition - "this device is in this scope's group" - so the second caller wants the first one's
ANSWER, not a second attempt at it. Keyed on the scope, which is the durable identity of the thing
being joined, never on a done-flag: a flag is a second bookkeeping layer able to lag the tree, and
this file already carries what believing one of those cost. The entry is deleted in `finally`, so a
later join - the one a revoke makes necessary - runs for real.

Four tests hold it: two concurrent callers produce one read, one join and one reconciliation; the
caller that waited SAYS it waited, so it is not indistinguishable from the one that worked; nothing
survives the call; and a rejection is shared without poisoning the next attempt.

**A new private salon, driven end to end (2026-10-05).** `useChannelWorkspaces.salonCreation.test.ts`
overlaps the three moments that reach a fresh salon's group on the creating device - the creation,
its own `channel.member.joined` (published before the POST answers) and a workspace load - and pins
ONE read and ONE `ensureDistributionGroup`. So the "same salon read twice in one second for one user"
seen on the COMM rung (2026-08-27) is the user's OTHER device answering the same
`channel.member.joined`: a first-publish race between two devices, settled by `stored: false` by
design, not a duplicate caller.

#### The sequel: the call was already one, the PRECONDITION was three (G-D1, 2026-09-13)

The audit row read *"`ensureDistributionGroupFor`, 5 call sites, deduplicated only by an in-flight
map"* - and read that way it is refuted by the section above. One implementation, one coalescer,
five inlets: **a count of call sites is not a count of implementations**, and naming what fusing them
would DELETE answers "a call", which is nothing.

**What WAS written three times is the precondition around it.** A private salon is entered in three
moments - the workspace walk, a salon joined in-session, a salon just created - and each carried its
own copy of *is it private, does this viewer have access, is there an MLS client, and what do I say
if not*. Copies drift, and these two had:

- **one entry logging through `console.info`.** The in-session join is the one of the three with no
  `ChannelWorkspaceContext` to hand, so it reached for the console - and a salon joined in-session
  left nothing in the log every other GRAINE line lands in.
- **only ONE of the three saying anything when it DECLINED.** That line is what a stale-tree
  diagnosis reads: WP-REGRANT-2's peer held a stale tree for a salon it was entitled to, was
  reloaded, and put no question to the server for 97 seconds, and nothing said whether the walk had
  SKIPPED that salon or never reached it. The two readings are opposite - a wrong `viewerHasAccess`
  is a server bug, a walk that did not run is a load-order one - and the absence of the line means
  "the walk did not run" only if every declining moment emits it.

`enterPrivateSalonGroup` is now the one entrance, in `distributionGroup.ts` beside the generic join.
`viewerHasAccess` is the single thing that genuinely differs between the three moments, so it is the
single parameter that carries it: the walk passes `channel.viewerHasAccess !== false`, because it is
the only one that meets a salon the viewer may merely SEE; joining and creating both ARE the access,
and pass `true`. A public salon returns false in silence - its seeds ride the community's group, and
narrating every public salon of every community on every hydration is the noise rule's own example.
`registerJoinedChannel` took a `log` parameter to lose the console, and `ChatBackgroundService`
hands it `appendLog`.

The spec pins the count: exactly three `enterPrivateSalonGroup(` in the composable and no
`ensureDistributionGroupFor` at all, because **a fourth moment reaching the generic join directly is
a fourth copy of the precondition, which is the defect itself.**

### Nobody owned the base every joiner depends on - FIXED 2026-08-26

Found by COMM-8, on production 2026-08-25: a web client submitted the same external commit to the
same private salon for twenty minutes, refused `epoch_mismatch` every time, and would have gone on
for ever.

**The gate is correct and the publisher was not.** `submitCommit` accepts a commit whose base epoch
equals `dm_groups.activeEpoch` and nothing else - anything looser accepts a commit built on a tree
that has moved. But the base it compares against is minted in exactly one place:
`runCommitTransaction` advances `activeEpoch`, then fires

```ts
void this.refreshGroupInfo(groupId);
```

from the single device whose commit was just accepted. Only two call sites invoke `refreshGroupInfo`
at all - that one and `externalJoin`'s success path - so if that follow-up is lost (a closed tab, an
offline moment, a refused refresh), `mls_group_info.baseEpoch` stays behind `activeEpoch` **for
ever**, and nothing in the system republishes.

For an ordinary conversation that would be recoverable: `requestReAdd` asks a peer for a Welcome. A
distribution group is entered ONLY by external commit, by construction - it holds seeds, not a
conversation, and `getCommitsSince` gates on `dm_group_members`, which it has none of. So a member
entitled to a private salon, holding no local MLS state, is refused on every attempt, permanently.

**Five causes arrived at every caller as one `false`.** `externalJoin` returned a boolean, so "no
base published yet" (retry), "the base is behind the group" (retrying is futile), "the commit could
not be built locally", "the gate was never reached" (nothing is known about membership) and "the gate
refused us" were one value - and the bounded retry loop written for the ONE cause that can change ran
for the four that cannot, building and discarding a fresh tree per attempt. It now returns
`ExternalJoinOutcome`, a discriminated union, and each arm is acted on differently. The bound
(`EXTERNAL_JOIN_MAX_ATTEMPTS`) exists for `concurrent_commit` alone; every other exit is a fact.

**Both epochs are served from where they are already known together.** `MessagingService.readGroupInfo`
reads `mls_group_info` and `dm_groups` - it is the one place holding both numbers - and returns
`activeEpoch` beside `baseEpoch`, warning when the base is behind. `activeEpoch` then travels
unchanged through `internal/mls/distribution-groups/...`, `DistributionGroupRef`, `ChannelService`,
`mlsDeliveryApi.fetchGroupInfo` and `groupInfoChannel` to `externalJoin`, which now declines before
building anything when `baseEpoch < activeEpoch`. `published=true` answered "is there a base" and
never "is that base usable"; the client used to learn the difference by being refused, which is the
standing rule against learning by failing what a fact could have told you. An answer with no
`activeEpoch` - an older delivery build - reads as the base, never as 0: 0 would mark every base ahead
of its group and refuse every joiner.

**The repair is a holder's ordinary read.** `republishStaleBase` runs on the branch of
`ensureDistributionGroupFor` that joins nothing - the early return every member takes on every load
of a scope it is already in - and republishes from the tree it holds when the published base is
behind. Not a timer and not a sweep:

- the **trigger** is a read that already happens, for its own reasons;
- the **termination condition** is a proof the server hands over, `baseEpoch >= activeEpoch`;
- it is **idempotent** because `putGroupInfo` is monotonic;
- it is **free** in the common case, where the two numbers agree and nothing is sent.

**A device behind the group declines to publish**, and says so. Its own export would be refused by the
same gate, so publishing it would replace one unusable base with another and report success. Some
other member will be current - it is the receiving half of the fan-out that leaves them so.

Both new lines accuse rather than inform: reaching either means somebody is right now unable to enter
a scope they belong to, and the RATE of them is what says whether a lost republish is rare.
`[GROUP_INFO] STALE base` on the server, `[GRAINE] ... republishing from the tree this one holds` on
the client.

Eight tests hold it. On the joiner: a stale base is not attempted at all (no build, no submit, no
forget, one read), a base that goes stale between the read and the submit ends the loop on that fact
rather than on the attempt count, and an unreachable gate claims nothing about membership. On the
holder: it republishes, it accuses when it does, it publishes nothing from a tree behind the group,
and it sends nothing when the epochs agree or when no base exists at all. On the wire: the two epochs
survive each hop, and a missing `activeEpoch` reads as the base.

#### There are TWO repairs, and only one of them read the server's answer (R-D3, fixed 2026-09-13)

`republishBaseIfStale` heals the steady state on any holder's ordinary read of a scope it is already
in. `answerBaseRefreshRequest` answers a `base_refresh_request` from a device that is locked out
RIGHT NOW. **They cannot be one function, and the audit row that called them "2 mechanisms" was
asking for the wrong collapse**: the second is handed a group id and nothing else, where
`classifyBase` needs the group's `activeEpoch` to decide whether a publish is worth a round trip at
all. It cannot classify, and it should not - the ask is urgent and the publish is monotonic, so
offering a base costs nothing but the trip.

**What they share is not the decision, it is the ANSWER, and the answer was already on the wire.**
`putGroupInfo` is strictly monotonic and reports `stored: false` for a base that was not newer - the
one authoritative statement of *your tree did not help*. The #571 work made `publishCurrentBase` the
single publisher and threaded that answer out through `refreshGroupInfo`, and then two callers were
entitled to describe it: the responder read it, and `republishBaseIfStale` discarded it outright. It
logged *republishing from the tree this device holds* and never said whether the tree was TAKEN - so
a holder that published into a refusal, which is exactly the state where the group is still shut,
left a line that reads as a repair.

`publishAndReport` is now the one reading, and the three answers are three sentences: the server took
it and the base describes epoch N; the server KEPT the base it had, because this device's epoch was
not newer; the republish did not land, and the base is exactly as stale as it was. **The third is not
the second** - a publish that never arrived proves nothing about the base, and reading one as the
other turns a dropped packet into *no holder that has connected can repair this group*. The TAG is
the only difference between the callers: `[BASE]` is a holder healing the steady state, and
`[BASE_REFRESH]` is a holder answering a device that cannot get in.

The responder also **moved out of `sessionAuth` into `staleBase.ts`**, beside its sibling. It was the
half of the pair with no coverage of any kind, because nothing could call it - a responder inside a
1500-line composable is a responder no test can drive. A table now runs both repairs over the same
three server answers and asserts that neither claims something the server refused, and that both say
it in the same words; the two cases only the responder has - it holds no active MLS state, and it
must never throw into the WebSocket handler that called it - are pinned beside them.

#### The locked-out device's half: one `no_peer_online`, two records, one edge (R-D10, 2026-09-13)

The sections above are the HOLDER's half. This is the other end: a device that cannot external-join
because the published base is behind, and that asks a member to republish it.

`base-refresh-request` answers `no_peer_online` when the server read the roster and found nobody
online to forward to. **That verdict has to be remembered, and remembering it is what stopped a
storm**: measured on production 2026-09-12, group `4f87267a` was asked once a minute for at least
twenty-seven consecutive minutes - four HTTP calls a pass - and the server answered
`NO_PEER_ONLINE members=1` to every one. Its only other member had not connected since 2026-08-03.
Three groups on that estate had been in the state since 2026-08-29, 08-30 and 08-31: thirteen days,
not a transient.

So `recovery.ts` records it in `noRepairerAt`, keyed by the pair of epochs it was proved against -
`${baseEpoch}/${activeEpoch}` - and the dead end ends when either number moves. **The value is the
proof, which is why it is not a boolean**: a flag would need a clock to expire it, and termination
here comes from a proof.

**The premise under that was false about the one event the verdict is made of.** The record's doc
said nothing about the answer could change while both epochs stood still. But the set the server
looked at is the set of members who are ONLINE, and a member connecting changes it with neither
number moving. What actually rescued the group was a fact on the OTHER device: `initializeConnection`
republishes a stale base for every group that device holds, so a returning holder moves `baseEpoch`
itself, and the next pass here sees a different pair. That repair shipped 2026-09-04,
`minClientVersion` does not require it, and a republish that fails is logged and nothing more. **An
exit that rests on what the far side is running is not an exit.**

`no_peer_online` is ONE answer and this client writes it down TWICE - here as a proof about a pair of
epochs, and in `historyReconcile` as a deferred reconciliation. They are not one map and should not
be: one is a termination proof, the other a note that an ask never went out. What they share is the
EDGE that negates the answer, and `onPeersCameOnline` reached only the second. It now discharges both
(`forgetProvenDeadEnds`), in the same callback, for the same reason: the server said nobody was
online, and somebody just came online.

Two details the spec pins. The THROTTLE is not discharged with the record - `lastReAddAt` answers
*how often may this device ask*, which no peer's arrival changes, and clearing it would let a
presence flap turn every locked-out group into a pass per edge. And the discharge says how many
groups it un-stuck, or says nothing at all: the edge fires every ten seconds, and a line its reader
learns to skip is the one that hides the next defect.

### The joiner's own commit was what stranded the next one - FIXED 2026-08-26

The section above fixed the READER. COMM-22 found the same lockout one turn deeper, and the reason it
survived is that the WRITER was never touched.

**An external join advances the group, so the base it built on is stale the instant it is accepted.**
The joiner is not a bystander to the staleness - it CAUSES it. And it was the joiner's own
`void this.refreshGroupInfo(joined.groupId)` that was supposed to mint the replacement, from a device
that reloads by construction: the check reloads the peer moments after the join, onto a clean state
that no longer holds the tree, so the follow-up never lands and nothing can mint a base afterwards.
Measured on production 2026-08-26, on two builds, from one run log:

    19:36:12  W1  no base published for salon 58afab93 - creating group 9e46429d
    19:36:12  W1  POST .../distribution-group/group-info        <- base published at epoch 0
    19:36:21  W1  Processing Commit group=9e46429d sender=<peer>  <- the peer's external join, epoch -> 1
                  ... and NO group-info POST from the peer, ever
    19:36:26  W2  externalJoin STALE base for 9e46429d (published 0, group at 1) - not attempting
    19:36:40  W1  the published base is at epoch 0 while the group is at 1 - republishing   <- 14 s late

`republishStaleBase` did fire, three times across that run, and every time after the refused device
had already given up: its trigger is a HOLDER's ordinary read, not the epoch change, which is exactly
the property that makes it a good repair and a bad mechanism.

**THE BASE NOW TRAVELS INSIDE THE SUBMISSION.** An external commit is applied to the returned
instance at once - unlike a staged add or remove, which is why this works here and not there - so the
joiner holds the tree for `base + 1` before it has submitted anything, and can export the base for the
epoch its own commit is about to create. `POST /api/mls/commit` carries it as `groupInfo`, and
`validateCommit` writes it with the epoch advance in ONE transaction
(`groupRepo.manager.transaction`, `putGroupInfo(groupId, base, baseEpoch + 1)`). Its authority is the
commit the gate just accepted, which is a stronger claim on the group than any roster row, so no
separate check is owed. Nothing follows an accepted external join any more - the fire-and-forget
refresh is deleted, not kept beside the new path, because keeping it would be the overlap the standing
rule tells us to remove.

**A wrong epoch abandons the join instead of publishing.** The client checks that its instance is at
exactly `gi.baseEpoch + 1` and treats any other value as a build failure, which the `welcome_request`
fallback already handles. `putGroupInfo` is monotonic: a base stored under an epoch nobody described
could never be walked back, so a lockout with no repair at all is the one outcome worse than the
staleness this replaces.

**Ordinary staged commits still mint their base by follow-up**, and the window is still there - one
round-trip wide, on a device that stays a holder and rarely reloads mid-flight. Closing it needs the
GroupInfo openmls already builds and every call site discards (`_group_info`), carried out through
`mls-wasm` into the `submitCommit` slot that now exists; see [backlog](../backlog.md). The server side
is finished and takes it unchanged.

Six tests hold this half. In `mls-core`, a joiner exports before merging and a fourth device holding
NOTHING joins on that base and converges - which is the only thing that proves the blob was genuinely
usable. On the server: the base lands under `baseEpoch + 1` in the same transaction as the advance, a
commit with no base advances the epoch alone, and a REJECTED commit stores nothing. On the client: the
export happens before the merge and travels as the fifth argument, and a mismatched epoch abandons the
join without submitting.

## 14. The seed was pushed to a shut phone and the push service threw it away unread - FIXED 2026-09-21 (Android)

The defect §4.9 corrected itself about, and its fix. Reported by the USER on Android, measured on
production 2026-09-20: three messages in one salon in 50 seconds, the first carrying its plaintext
in the shade and the next two reading `Nouveau message dans #general`. The sender rotated between
the first and the second; the new session's seed was minted 21 seconds before the message it
sealed, and never reached the reader's mirror at all.

**NOTHING WAS LOST AND NOTHING WAS RACING.** The frame is durable, the rows render on the next
foreground load, and the seed IS delivered - `DELIVERY.keyMaterial` is `{silent: true, durable:
true}`, so `deliverQueuedFrame` arms an FCM push carrying the frame inline. The phone was sent the
seed and dropped it. That is a STATE, not a window: it lasts until the reader next opens the app,
so every message of that session is blind, not merely the first.

### The one boolean that stood in for a classification

`CanariFirebaseMessagingService` returned before any decrypt, at `if (silent && !CALLS_ENABLED)`,
under a comment that was TRUE when it was written - *"nothing a silent frame's plaintext is read
for is enabled"* - and that Graine falsified: the consumer of a silent frame's plaintext is
`graine_seeds.json`. Past that return there was nothing to read it with either. `proto_fields.rs`
recognised `AppMessage` fields 10-12 and answered a bare `{"ok": false}`, which is correct about
the notification and silent about the contents.

Both halves are the same mistake: **a classification carried as one boolean**. `silent` says "raise
no banner". It cannot say "and there is nothing in here", and the next useful silent frame would
have inherited the same silence by accident.

### Deciding on the kind, from where the kind is already known

Decrypting every silent frame instead would put an MLS load and the state lock behind every read
receipt and every self-read dismissal - roughly 3-5 s each, serialised on the one push lane - to
discover that the frame had nothing in it. *Never learn by failing what a fact could have told you.*

The fact was already in the database. A distribution group's log carries seeds and NOTHING else
(`DELIVERY.keyMaterial`'s own reasoning, §4.3), and `dm_groups` says which groups those are in
`distributionWorkspaceId` / `distributionChannelId`. The push already reads that row for the
conversation's name, so the discriminator costs one more `select` entry and travels in cleartext as
`isKeyDistribution` - the same three-state shape as `isGroup`, absent meaning *the server does not
know*, which is a different sentence from *no*.

### The path, end to end

| where | what it does |
| --- | --- |
| `messaging.service.ts` | reads the two `distribution*` columns it was already fetching the row for |
| `push-payload.ts` | sends `isKeyDistribution`, or OMITS the key when the row could not be read |
| Kotlin `onMessageReceived` | `silent && isKeyDistribution != true` still returns; a key-material frame goes on (the guard read the calls switch too until 2026-10-18 - [calls](../frontend/modules/calls.md#the-switches-agree-and-a-silent-frame-stays-unread)) |
| `background.rs` | passes a non-renderable answer through with a `reason` TOKEN instead of collapsing it to one refusal |
| `proto_fields.rs` | reads fields 10 (one seed) and 12 (a BUNDLE, as a list) and attaches `{channelId, sessionId, seedB64, createdAt}` |
| Kotlin `decryptProto` | switches on the same token, into `PushDecrypt.KeyMaterial` |
| `lib.rs` JNI | `nativeStoreGraineSeeds` merges each seed through `merge_graine_seed` - the mirror writer the Tauri command already owned, factored out of it |

**`ok` STAYS FALSE THROUGHOUT.** That is what the notification path reads, and a seed must still
ring nobody. The seeds ride ON the refusal.

**AND THE PUSH PATH STAYS READ-ONLY.** `decrypt_push_message_with_key` takes an immutable slice and
no path: it cannot advance `mls.bin`, which the foreground owns. The one file this whole path
writes is `graine_seeds.json` - a bounded cache of key material the device is already entitled to,
rebuilt from the group's log whenever the app next runs.

### What holds it

Nothing between these files type-checks: three languages, and every seam is a string.

- `background.rs`: a seed encrypted by one MLS client and opened by its peer through the push path
  comes back as `reason=graine-key-material` with the seed intact - a real ratchet, not a
  hand-built buffer. The read-only invariant is asserted by the SIGNATURE, not by a test of it.
- `proto_fields.rs`: a rotation frame, a catch-up bundle of three (a first-match reader loses its
  tail in silence), a seed missing what `derive_message_key` needs, a request named rather than
  lumped with the unrecognised, and an ordinary message acquiring no kind.
- `grainePushSeeds.test.ts`: the cross-language guardrail - the cleartext key, the two reason
  tokens, the four seed field names, the mirror's `seed`/`createdAt` shape against the Kotlin
  reader's own lookup, and the JNI symbol.

### The seed then arrived 324 ms too late - FIXED 2026-09-21

`NOTIF-18` measured the fix above on hardware the same day and found it correct and insufficient.
A phone dead for twenty seconds woke, recognised the silent frame
(`decryptProto: graine key material, 1 seed(s)`) and stored it
(`absorbGraineSeeds: stored 1 seed(s)`) - **after the message it unlocks**:

    11:03:24.421  type=channel -> groupId=<8>          the salon message
    11:03:24.487  no seed/ciphertext -> generic        the banner is built blind
    11:03:24.747  absorbGraineSeeds: stored 1 seed(s)  260 ms too late

**THE ORDER CANNOT BE BOUGHT AT THE SENDER.** Both pushes left in the same second, from two
services nothing sequences - `social-service` sends the salon message, `chat-delivery-service` the
seed - and FCM promises no order across two sends. The overlap is on the DEVICE:
`handleChannelMessage` runs under `runWithWakeLock("fcm_channel")` while key material is absorbed
under `runSerializedWithWakeLock`, and neither waits for the other. Serialising the two sends would
buy a delivery order FCM does not promise to preserve, which is a fallback dressed as a fix.

**SO THE HANDLER IS ORDER-INDEPENDENT INSTEAD.** A frame whose ciphertext is present and whose seed
the mirror cannot answer for is HELD in a bounded registry keyed `channelId:sessionId:messageIndex`
- one entry per message, because two messages of one session can both outrun it and each owns a
different line to correct. `absorbGraineSeeds` drains it after a successful store: for every held
frame the mirror can now answer for, it rebuilds the notification with the plaintext and re-posts
under the same stable id, in `messageIndex` order.

**THE OVERLAP IS DELETED, NOT HEALED.** The registry lock is held across BOTH the seed lookup and
the registration, so the absorber cannot store a seed in the window between a miss and its entry
appearing. The reverse window - the absorber running while the generic banner is still being built
- is closed by the entry's `genericStamp`: it is 0 until the post returns, the drain skips a
0-stamped entry, and the posting path re-reads the mirror afterwards and claims its own frame.
Exactly one of the two paths redraws, in every interleaving.

**AND THE CORRECTED LINE REPLACES THE BLIND ONE RATHER THAN JOINING IT.** `showMessageNotification`
now returns the `MessagingStyle` instant it stamped its line with, and takes a `supersedes` instant
that is dropped from the re-injected history - an identity, not a guess about the text, which is
the lesson `alreadyPosted` already carries. The filter runs BEFORE the `MAX_NOTIF_MESSAGES` bound,
so a redraw never costs the history a real line, and the re-post is `setOnlyAlertOnce`: the reader
was alerted when the blind banner went up, and buzzing again to correct its wording would be the
second notification this whole path exists to prevent.

**TERMINATION IS A CAPACITY, NOT A CLOCK.** Nothing expires. A held frame leaves when its seed
arrives, or when the eighth message after it pushes it out - well past `MAX_NOTIF_MESSAGES`, which
is 6. A frame the server could not inline is never held at all: no seed can ever open it, so
waiting for one would never end. `PendingChannelFrameTest` holds the eight cases.

### What is left

iOS. The NSE runs on an alert push and a silent `keyMaterial` frame does not wake it at all, so
nothing above reaches an iPhone; `isKeyDistribution` already travels there through
`buildApnsRequest`, so what is owed is the wake, not the discriminator. See [backlog](../backlog.md).

**THE DEGRADATION IS COUNTED SINCE 2026-10-05, ON BOTH PLATFORMS.** A blind salon banner that
reaches the shade is reported to `POST /api/mls/push/blind-banner` (PushSecret, nothing stored),
which prints one WARN line per banner: `[PUSH_BLIND] user= device= platform= channel=
missing=<terms> held=<bool>`. `held=true` is Android's frame waiting for a late seed (it may still be
redrawn); `missing=ciphertext` is the FCM budget, generic for ever; an iPhone is never `held`, since
nothing redraws its banner. So the rate per platform and per cause is one `GROUP BY` over the
chat-delivery log. The terms are the same four, from one helper (`blindBannerMissing`) on Android.

**AND THE SECOND OF THOSE NAMES ITS OWN CAUSE SINCE 2026-09-24.** `no seed/ciphertext` is one `if`
with four terms - `seedB64`, `ciphertext`, `nonce`, `messageIndex` - and the line named none of
them, so two opposite problems printed one sentence: a seed that was never mirrored, which is a
mirroring bound (the sender opened a Graine session while this device was away), and a ciphertext
the server declined to inline, which is the 4 KB FCM budget. They want opposite fixes, so a report
that cannot separate them is a report that sends the next reader back to the phone. The line now
ends `missing=<terms>`, comma-joined in declaration order.

**It is a SUFFIX, and that is the whole of the design.** Three things read this line - `watch.mjs`'s
`fcm-channel-generic` rule, anchored at both ends; `notif18.mjs`, which locates the frame by the
prefix; and `NOTIF-18` on the [board](../cross-client-testing.md), which asserts its ABSENCE - so
anything woven into the middle would have unclassified it in the two runners and left the third
reading a line nothing matched. The classifier rule was widened in the same commit, as its own
comment requires (*every pattern is copied from its `Log.` call site*), and `missing=` is REQUIRED
there rather than optional: a build that quietly lost the discriminator must stop matching, not go
on passing. Widening it also closed a blind spot the rule had always had - `senderSessionId`
defaults to the empty string, and `session=\S+` could not match the line that produced, which is
precisely a frame whose session this device never knew. Both shapes are fixtures in
`logcatclassify-selftest.mjs`, and reverting the rule drops both to `unexplained`.

## 15. A member added to a community entered no key group at all until they restarted - FIXED 2026-09-21

Four moments register a channel against its community, and each owes the community's
key-distribution group before the first seed travels: the startup walk, creating a community,
creating a salon inside one already loaded, and **being added to one in-session**. The fourth did
not.

`registerJoinedChannel` - the `channel.member.joined` handler's half in `useChannelWorkspaces` -
did two of the three things the startup walk does per community. It wrote the channel-to-community
map, and it called `enterPrivateSalonGroup`, which returns immediately for a public salon. Nothing
entered the COMMUNITY's group, which is the only group a public salon's seeds travel on (§4.3).

### What it looked like

Measured on the local estate, 2026-09-21, with the peer's client left running throughout:

    invite lands            the community appears in the peer's sidebar, #general opens
    owner distributes       [SEND] No message queued after validation - recipients=0 - the
                            group named no other device
    roster                  1 device, epoch 0 - the owner's, and nobody else's
    peer's app RELOADED     [DISTRIBUTION_GROUP] served ... user=<peer> devices=0
    ~1 s later              roster: 2 devices

So the new member was entitled, visible in `channel_members`, able to open the salon - and on no
delivery roster. Every seed minted between the invite and their next app start was fanned out to
everyone except them, and their salon read `nouveau message dans #general` for all of it. **It is a
STATE, not a window**: nothing else fetches the group, so it lasts until the app is relaunched.

This is the same screen as §14 and a different cause. §14 is a seed that was pushed and dropped;
this is a seed that was never addressed to the device at all, because the server's roster did not
name it. **The two are separated by the SERVER's log, not the phone's** - `recipients=0` on the
distribution send is the discriminator, and it is already written.

### Why the premise held for three callers and not the fourth

`enterPrivateSalonGroup`'s early return carried the reasoning: *"a public salon's seeds travel on
the community's group, which a different call already entered"*. True of the startup walk, which
enters the community's group before listing its channels; true of community creation, which enters
it before listing the channels the backend made; true of salon creation, which cannot happen in a
community this device has not loaded. **False of the one caller reached from a real-time event**,
which has no walk around it at all.

The fix is one guarded call in `registerJoinedChannel`, before the private-salon entrance, and the
comment now NAMES the precondition instead of assuming it. The join is idempotent and coalesced per
scope by `ensureDistributionGroupFor`, so a second channel joined in the same session shares one
promise and mints no second external commit. A private salon takes both: its own seeds travel on
its own group, and the community's still carries every public salon beside it.

### What holds it

Four cases in `useChannelWorkspaces.svelte.test.ts`, two of them red before the change: the
community's group is entered for a public salon with the community as the scope; it is entered for
a private salon too; nothing is reached for when the load has no MLS client; and the
channel-to-community map is written BEFORE the join, so a refused GroupInfo cannot also cost the
mapping. The rejection is deliberately not caught - `onChannelMemberJoined` already logs it as
`[GRAINE] could not prepare joined channel`, and a `try` here would make that line unreachable.

## 16. A shut phone one commit behind could never catch up, in any community - FIXED 2026-09-27

**Measured on a store Pixel 6a, production, 2026-09-27.** Every Gala salon push arrived as
"Nouveau message dans #general" and stayed that way. The seed frame DID reach the phone; the
logcat said why it was not opened:

```
groupLocality: epoch=4 group=17d0281e     <- the community's distribution group
tryDecrypt refused                         <- the frame is ahead of the persisted state
fetchCommitsFromBackend: HTTP 403          <- the catch-up (POST mls/push/commits) is REFUSED
Silent push group=17d0281e shows nothing - it could not be decrypted
```

**The gate asked the wrong table.** `MessagingService.getCommitsSince` served the commit log only
to a user with a `dm_group_members` row. A distribution group is entered by each DEVICE's external
commit and is recorded in `dm_device_group_memberships` alone - on production all eight held ZERO
user rows - so the catch-up refused every one of them: `POST mls/push/commits` answered 403 **173
times in eight hours**, against one success. Any newcomer to a community advances its epoch, so
every shut phone fell one commit behind at the first join and every seed after it was unreadable
until the app was next opened. `putGroupInfo` had already recorded the same absence for the WRITE
of a group info; the replay had never been told.

**The fix asks the table that records membership for the group's KIND**: a key-distribution group
(`distributionWorkspaceId` or `distributionChannelId` set) answers from an ACTIVE device row, any
other group from `dm_group_members` as before. A device holding an active leaf already reads these
commits, and `evictFromDistributionGroup` deletes a leaver's rows at once, so this admits nobody
the group does not. A refusal now logs `[COMMITS_SINCE] refused ... keyDistribution=<bool>`.

**Still open, and a different defect**: the seed of a NEW session reaches the phone about a second
AFTER the message it opens (FCM does not order the two pushes; the server sends the seed first). The
banner goes up generic and is redrawn by `drainPendingChannelFrames` - measured on the same phone,
Rootz `#general`, 20:13:56 -> 20:13:57. See the [backlog](../backlog.md).

## 17. Anybody holding a key group's id could add themselves to it - FIXED 2026-09-27

**Found by the audit that followed section 16**: every `dm_group_members` gate in
chat-delivery-service was read against the question "does a key-distribution device reach it".
None still refuses one wrongly. One ADMITTED somebody it should not.

`POST mls/groups/:groupId/members` (`MembersController.addGroupMember`) lets a creator register
itself into an EMPTY group - the bootstrap in `assertCallerMayMutateMembership` passes when the
caller adds itself and `dm_group_members` holds no row for the group. A key-distribution group holds
no such row BY CONSTRUCTION (section 16), so to that gate it is permanently "an empty group". A user
who knew the id - a member removed from the community keeps it - could add themselves, which also
wrote them pending device rows, then pass `getGroupInfo` on the row just written, external-commit
into the group that carries every salon seed, and read seeds past social-service's scope gate.

**The fix refuses the route for the whole kind**: a group with `distributionWorkspaceId` or
`distributionChannelId` set answers `403 KEY_DISTRIBUTION_GROUP` and logs
`[ADD_MEMBER] REFUSED key-distribution group=...`. Nothing legitimate ever came through it: these
groups are entered by external commit, authorised by social-service. With no `dm_group_members` row
possible on them, the `getGroupInfo` / `storeGroupInfo` gates that read that table become sound
again. **Production held no such row on any of its eight key groups**, so the hole was never used.

## 18. The catch-up opened the seed and then threw it away - FIXED 2026-09-27

**Found by `NOTIF-19` the moment §16 stopped answering 403.** With the commits served
(`fetchCommitsFromBackend: 2 commit(s) since epoch=8`), the phone still logged
`decryptProtoWithCommits: ok=false -> catch-up insufficient` for every seed frame, and the salon
banner stayed generic. `decrypt_push_message_with_commits_with_key` (`mobile/background.rs`) kept
only a result with `ok: true`, i.e. a chat message with a text; Graine key material is `ok: false`
with `reason: graine-key-material` by design (it must ring nobody), so a seed that needed the
catch-up was decrypted and dropped. The Kotlin side had the same narrowing: its catch-up returned a
`DecryptedMessage` or null, never `PushDecrypt.KeyMaterial`.

**One classifier and one reader now serve both paths.** `classify_plaintext` in `background.rs` is
the only place deciding what a decrypted frame is, and both push decrypts return its shape;
`parseNativeDecrypt` in `CanariFirebaseMessagingService.kt` is the only reader of that shape, so
the recovery ladder's `catchUp` passes a `KeyMaterial` through to `absorbGraineSeeds` like any
other. Pinned by `a_graine_seed_sealed_one_commit_ahead_survives_the_catch_up`.

**What this left unseen, and why nothing said so.** Not one `[PushBG]` line reaches logcat when the
app is dead: the Rust logger is installed by `tauri_plugin_log` when TAURI starts, and a push
handled in a killed app calls Rust through JNI without Tauri. See the [backlog](../backlog.md).

## 19. Design: the seed travels with the message - DECIDED BY THE USER 2026-09-27

*"La clé voyage avec le message."* The alternative - post the generic banner silent and let only the
redraw alert - keeps two pushes and a race; this removes the race.

**The rule.** A session this device minted keeps its own seed frame `{groupId, protoB64}` - the MLS
ciphertext `sendMessage` already returns and nothing kept - and EVERY message sealed under it carries
that frame. A session without one is rotated (one rotation per channel and sender at upgrade). On
the phone: the mirror first, then the attached frame (through the catch-up of §18 when behind), and
the hold of §14 only for a push with no frame - a sender on an older version.

**Why every message, not the first.** A push can be suppressed (notification level, mentions only),
so the first message a phone RECEIVES under a session is not always the first one sent.

**The budget.** A seed frame is ~280 bytes (~430 in the push with its group id), estimated from RFC
9420 framing with the suite in `mls-core/src/group.rs`. The fixed `ciphertext <= 3000` in
`notifyChannelRecipients` becomes a computed budget, and `{ciphertext, seedFrame, seedGroupId}` are
inlined all or nothing. That needs `sendPushToUser` to stop sending the data AND the APNs block to
every token, the duplication `sendFcmForQueued` already stopped for its own pushes.

**What social-service may do with it.** Pass it through, never store it, never put it in the
WebSocket event, and refuse a `seedGroupId` that is not the salon's key group (the private salon's
own, or the community's) with a typed code. It is an MLS private message: social-service learns
nothing it could open, and Google and Apple already carry the same bytes on the seed push.

**What stays.** The seed push on the key group remains the durable copy for the foreground, other
devices and history. It also fixes iOS: the frame rides the ALERT push that wakes the notification
extension, so nothing depends on a silent wake (§14, what is left).

**Proved by `NOTIF-20`**: a rotation forced by a join while A1 is dead, `seed source=frame` in
logcat, NO `frame HELD` and no redraw, the plaintext on the first and only post.

### How it is built (2026-09-27)

| Where | What it does |
| --- | --- |
| `sessionManager.ts`, `seedDistribution.ts` | `distributeGraineSeed` returns the sealed frame `{groupId, protoB64}`; the session keeps it in the SEALED half of its row (`graineCodec`); `graineOutboundVerdict` rotates a session without one |
| `channelSeal.ts`, `channelCrypto.ts` | every non-silent send carries `seedFrame` + `seedGroupId`; a silent one (a reaction) carries neither, since it pushes nobody |
| social-service `assertSeedFrame` | both or neither, base64, at most `MAX_SEED_FRAME_CHARS` (2048); `seedGroupId` must be the private salon's own group, the community's otherwise - `CHANNEL_SEED_FRAME_INVALID` / `CHANNEL_SEED_FRAME_GROUP_MISMATCH`. Never stored, never in `channel.message.created`. The controller used to REBUILD every refusal from its status and message, dropping `code`; a typed refusal now leaves as thrown |
| social-service `notifyChannelRecipients` | hands `{ciphertext, seedFrame, seedGroupId}` to `internal/push/notify` as `inline`, apart from the fields every push carries; the fixed `ciphertext <= 3000` is gone |
| chat-delivery `sendPushToUser` | ONE half per token - the data map for Android, the APNs request for iOS - as `sendFcmForQueued` already did; `withInlineGroup` adds the inline group when ALL of it fits that platform's 4 096 B and none of it otherwise, and says so in `[PUSH_SIZE]` |
| Kotlin `openSeedFrame`, `SeedFrameLadder` | on a mirror miss, the frame is decrypted like the seed push would be; `LOCAL` -> commit catch-up, `ABSENT` / `UNKNOWN` said and NOT waited on (not a join in flight); the seed is absorbed by the one writer and read back from the mirror. `seed source=mirror|frame` names which |
| Kotlin dispatch | the salon push runs on the MLS lane (`runSerializedWithWakeLock("fcm_channel")`), beside the seed push. On two lanes they overlapped: the frame decrypt waited 5 s on a state lock the seed push held for ~10 s of Argon2, gave up, and fell back to the hold. Serialised, FCM's order decides the source and never the outcome |
| Rust `with_graine_mirror` | every edit of `graine_seeds.json` holds an OS file lock (`graine_seeds.lock`, threads and processes alike - the iOS extension is another process) and writes by rename. Two writers used to read-modify-write it unordered, so one could erase the other's seed |
| iOS NSE `openSeedFrame` + `canari_native_store_graine_seeds` | the same path; the frame rides the ALERT push, so it is the one way an iPhone gets a new session's seed while shut |
| `canari_push.mm` (app alive) | does NOT open the frame: it decrypts no MLS frame at all, and the live engine already holds the seed. `channelPushFields.test.ts` asserts that fact, so the exemption fails the day it stops being true |

What stays for an older sender - the hold and redraw of §14 - is in
[legacy-compatibility](../legacy-compatibility.md), with its removal condition.

## 20. Whoever admits a newcomer Welcomes them - DECIDED BY THE USER 2026-09-27

**§4.4 made the newcomer add THEMSELVES, and that answered only half of the ways in.** A share link
has nobody else in the room, so the joiner's own external commit is the only possible door - and it
stays. But `inviteToChannel` is an ADMIN adding someone from the panel, the admin's client online and
holding the key group, and nothing admitted the newcomer: their seat waited for their own app to
load the community. Two Gala members added at 14:35 on 2026-09-27 had still not joined six hours
later, their phones taking every salon push offline and reading none
([backlog](../backlog.md)).

The user, asked whether the phone should join by itself from the push or be Welcomed: *"L'ajouteur
envoie un welcome"* - the DM's own shape. A DM newcomer is Welcomed by whoever added them and their
phone processes it in the background with the app shut; a community newcomer now is too.

- **Who**: the client that performed the add, which is online by construction and holds the key
  group (an admin of the community is always a member of it).
- **What**: an MLS add of every device the newcomer has published a KeyPackage for, and a Welcome
  to each - the same `addMember -> sendWelcome -> sendCommit` the DM uses.
- **Why the first message after it is readable**: the add is a commit, a commit rotates every
  sender's session, and §19 puts the new session's seed on the message itself.
- **Not a second path**: the self-join stays the door for the cases where the newcomer is the one
  acting (share link, public salon join). Each way in has exactly one admitter.

### How it is built

| Piece | Where | What it does |
| --- | --- | --- |
| The admit | `admitNewcomerToDistributionGroup` in `frontend/src/lib/utils/graine/admitNewcomer.ts` | Holder only; `fetchUserDevices` -> add-lock -> tree read -> ONE `addMembersBulk` of the devices with no leaf -> checkpoint -> one `sendWelcome` per device. Never throws; returns a typed `NewcomerAdmission` |
| The decision | `devicesToAdmit` (pure) | A device whose `userId:deviceId` leaf stands is not re-added: every device already in the tree means NO commit |
| Community invitation | `inviteMemberToChannel` (`useChannelWorkspaces`) -> `admitInvitedMember` | Only when the server answers `alreadyMember !== true`; the community's group, then the private salon's when the invitation was to one (the server grants both in that one call) |
| Private-salon grant | `addAllowedUser` (`ChannelSettingsPanel`) -> `admitSalonGrantee` | The salon's own group. The same gap existed there: a grantee entered it only by their own external commit. An admin granting a salon they are not in holds no group and admits nobody, which is logged |
| Welcome authorization | `sendWelcome` in `apps/chat-delivery-service/src/services/messaging.service.ts`, through `memberOfGroupKind` | It asked `dm_group_members`, which names nobody for a key group (section 16), so every such Welcome would have been a 403. Now an ACTIVE device row - the one helper the replay (`getCommitsSince`) also uses |
| The newcomer, foreground | `handleDistributionWelcome` in `setupMessageHandler.ts` | `getGroupMeta` names the kind (it now carries `distributionWorkspaceId` / `distributionChannelId`); registers the seed carrier BEFORE installing, installs, promotes the row. No conversation row. A failed install is ACKed and nothing else: the queued Welcome is gone, so the device's own load joins |
| The newcomer, app killed | `processReceivedWelcomeBackground` (Android, unchanged) | Installs the Welcome and calls `membership-active` |
| One door at a time | `ensureDistributionGroupFor` + `readWelcomeOwedFromRow` (`utils/chat/welcomeOwed.ts`, shared with `requestReAdd`) | A device holding nothing whose seat is `pending` with a queued Welcome or an add in flight WAITS instead of external-joining; an unreadable seat opens neither door this pass |

**Why two admitters, or an admitter and the newcomer's own join, cannot both land.** Two admitters
are serialised by the add-lock, taken before the tree is read. The external commit takes no lock and
needs none: both commits are built on epoch N and `validateCommit` advances the epoch for exactly one
of them, refusing the other `epoch_mismatch` and rolling it back unmerged. **And no window is
left between the add and the seat**: the commit names the devices it adds (`admits`) and the server
writes their `pending` seats in the same transaction as the epoch advance, before the successor
base can be minted - so a newcomer that reads that base also reads a seat, with `addInFlight` while
the admitter holds the lock through its Welcomes, and waits. The same record makes the newcomer a
recipient of every frame sealed from that epoch on (below).

**When the admitter's Add is the one refused, it is rebuilt - on a proof (NOTIF-21, 2026-09-28).**
The first run measured the losing side: the newcomer's two live web clients joined by their own
external commits in the second the Add was built, the Add was refused, and the admitter gave up - so
the dead phone, the one device that cannot act for itself, was never added. The refusal is now typed
(`CommitRefusedError` in `frontend/src/lib/mls-client/CommitRefusedError.ts`, carrying the reason and
both epochs), and the admitter loops only when the refusal is one AND its local epoch moved past the
one the Add was built on - the catch-up applied the winning commit, so re-reading the tree is
reading a newer group, and a device that already joined is dropped by `devicesToAdmit`. An epoch
that did not move is a `console.warn` naming the devices NOT admitted. `actions.ts` reads the same
type rather than the message.

**The phone's push lane, which put a Welcome behind its own group's frames.** Frames sealed at the
admitting epoch can reach the phone BEFORE the Welcome (the Welcome is sent after the commit's
fan-out). On Android both run on the one `MLS_PUSH_LANE` thread, and the recovery ladder's
Welcome-race retry slept 3 x 1.8 s in front of a join queued behind it: measured, the Welcome joined
24 s after it arrived. `WELCOMES_ON_LANE` counts the Welcomes received per group and released when
their task ends; a refused frame whose group has one is queued again behind it, once, with no clock. The
sleep itself is DELETED on both platforms (user, same day): an absent group with no Welcome queued
waits for nothing ([mobile](../frontend/mobile.md#background-mls-decrypt-ladder)).

**Not covered**: making a PUBLIC salon private grants its whole list at once through "Enregistrer";
that group is brand new (unpublished) when the grant lands, so no admitter holds it yet and every
grantee enters it by their own load, as before.

**What a rig row asserts.** Admitter: `[GRAINE] ADMIT <newcomer> into <scope>: start`,
`ADMIT Welcome -> <newcomer>:<device>`, `admitted N/N device(s), group now at epoch E`; server
`[WELCOME][...] DONE group=<key group>` and NO `AUTHZ FAIL ... keyDistribution=true`. Newcomer phone
with the app killed: `processReceivedWelcomeBackground: ... group joined group=<key group>`, the
server's `MEMBERSHIP_ACTIVE_PUSH` activation, then the first salon message opened with
`seed source=frame` (section 19). Newcomer in the foreground: `[WELCOME] ... is a KEY-DISTRIBUTION
group`, `key group ... installed at epoch E`, and no new sidebar conversation.

### A newcomer is a recipient from its admitting epoch - DF2 deleted (user, 2026-09-28)

A device added while its phone was dead is `pending` until its own join reports it, and the send path
queued for `active` rows only. What covered the gap was DF2: at activation, a replay of what a
five-minute window over the Redis history stream still held, capped at fifty. The user chose to
replace that clock with a queue, and the design rests on one fact: **the epoch a newcomer can open is
known exactly at the ADD COMMIT, and nowhere later.**

| Piece | Where | What it does |
| --- | --- | --- |
| The declaration | `commitAdmits` (`frontend/src/lib/mls-client/commitAdmits.ts`), sent by `runCommitTransaction` as `admits` | The devices the staged Add put in the tree: the fan-out exclusions every add caller already passes, minus the committer and minus any device the staging skipped for an invalid KeyPackage |
| The record | `validateCommit` -> `resolveAdmittedDevices` (`messaging.service.ts`) | Each declared device with a KeyPackage row is written `pending` with `admittedAtEpoch = baseEpoch + 1` IN THE ADVANCE'S TRANSACTION, before the commit's fan-out; an `active` row is never touched. The background re-add (`send-welcome-and-commit`) declares its one target the same way |
| The routing | `sendMessage` | A `pending` row whose `admittedAtEpoch` is at or below the frame's epoch is a recipient, queued and pushed like any member. The epoch is read from the frame's CLEAR MLS header (`mlsFrameEpoch`): a member lagging a commit behind seals at the older epoch, which the newcomer can never open. Never announced on the routing set - that stays `activateDeviceMembership`'s |
| The end | `activateDeviceMembership` / `deactivateDeviceMembership` | Both clear the column: an active device is routed by its status, a demoted one needs a new Welcome |

**Why not at the Welcome.** `sendWelcome` runs after the commit is accepted and fanned out, so a
member could seal at the new epoch in between (the newcomer skipped), and a second commit landing
first would have made the group's counter name an epoch past the Welcome's (the newcomer then never
queued the commit it must apply). No clock and no replay: whatever was sent before the record was
sealed at an epoch the newcomer cannot open.

**What a rig row asserts.** Server: `[COMMIT][commit-...] ADMITS group=... atEpoch=E devices=...`
on the add, then `[SEND][send-...] PENDING_ADMITTED group=... frameEpoch=E devices=<device>@E` on the
first message, and no `ACTIVATION_REDELIVER` line at all. `NOTIF-17b` is the regression witness.
A client predating `admits` records nothing; its newcomers are routed once they activate.

### A key group's Welcome wrote a conversation row, and discovery asked its roster - FIXED 2026-10-25

Measured at boot on `1.4.1-alpha.3`: `GET /api/mls/groups/<id>/user-members -> 403`, then
`[DISCOVERY] ... is a Graine distribution group - removing conversation row`, for a community's key
group. The admitter's Welcome above is the one door that reaches the conversation machinery, and
three places treated it as a conversation:

- **The drain announced it.** `handleDistributionWelcome` installs the group without a row, but
  `BaseMlsService.processQueue` then fired `onWelcomeProcessed` for every Welcome, and that listener
  (`sessionAuth.ts`) builds an `active` row for any group it holds none for, saves it and restores.
  The drain now reads `isDistributionGroup` and does not announce a key group's Welcome.
- **An unreadable server row made it a conversation.** `handleWelcome` classified the group from
  `getGroupMeta` alone, which answers `null` for a network failure or any non-2xx. A restart
  re-delivering the Welcome after the startup walk had registered the group therefore took the
  conversation path (`writeRowForHeldGroup`, `onGroupReady`). The row decides when it was read - the
  server outranks the session's memory - and `isDistributionGroup` decides when it was not.
- **Discovery asked the roster before the kind.** `discoverMissingGroups` asked `getGroupUserMembers`
  of any active absent group, then tested `isDistributionGroupMeta` on the row it already held. The
  server refuses that roster on a key group, so the 403 was provoked for a question already
  answered. The kind is now tested first.

Left open - a Welcome whose row is unreadable for a group this session does not know either - is
in [backlog](../backlog.md).

## 21. Graine v2: an author that is proven, a ciphertext bound to its place - DECIDED BY THE USER 2026-09-28

**Why.** §7's table: v1 hides the content from the server and authenticates nothing about who wrote
it or where. The user chose the whole of it on 2026-09-28 - bound context, a checked author and a
signature per session - and the DMs in the same stroke, since the MLS sender is discarded for them
too.

**A v2 SESSION carries**, besides its seed:

- `version = 2`, carried by MLS with the seed. The version belongs to the SESSION, never to the
  row, so the server cannot downgrade a message: a row under a v2 session with no signature is
  refused;
- an Ed25519 pair minted with it. The secret key stays on the minting device (sealed, in the
  backup); the public key `signingPk` travels with the seed;
- an ENDORSEMENT: the minter's device signs, with its MLS credential key,
  `encode("canari-graine-v2-endorse", channelId, sessionId, minterUserId, minterDeviceId, signingPk, SHA-256(seed), createdAt)`. The seed commitment was added when the primitives were written (§21.2): without it the endorsement proves the key and not the seed.
  A relayed seed (repair, history bundle) carries it untouched, so whoever answers cannot substitute
  a key. It is checked against the minter device's key in the distribution group's tree, or - once
  that device has left it - against the key the server publishes from its KeyPackages. That is the
  trust MLS BasicCredential already gives the server, no more (decided by the user).

**A v2 MESSAGE carries** `H = encode("canari-graine-v2", channelId, sessionId, minterUserId, be32(index))`,
length-prefixed fields, never a joined string. `H` is the AES-GCM additional data, and
`signature = Ed25519(sessionSk, H || nonce || ciphertext)` is a new column. `workspaceId` is not in
`H`: the push does not carry it and a `channelId` is already a global UUID.

**Opening one** refuses, each with its own typed error and a line that accuses: a row whose
`senderId` is not the session's minter, a row in another salon than the session's, a bad signature,
and a second row naming one `(senderSessionId, messageIndex)` - a replay, shown once.

**What v2 does NOT close**: the server can still admit a device it controls, or publish a false key
for one (§7). That is BasicCredential's limit and v2 does not pretend otherwise.

**The order, reader before writer** - the CORRUPT pattern: a release that READS v2 everywhere, web,
Android and iOS, then, once both stores serve it and `minClientVersion` is that reader, the release
that WRITES it (one rotation per salon and sender). **v1's end, decided by the user 2026-09-28**:
once the writer is the floor, a v1 seed that ARRIVES is refused, since a modified client could
otherwise keep minting v1 sessions to forge an author; the v1 seeds already held keep opening their
rows until those age out of the 365-day window, and the v1 reader goes with the last of them
([legacy-compatibility](../legacy-compatibility.md)). **The verified MLS sender is MEASURED before it
refuses**: one release logs every envelope that contradicts it and refuses nothing, because a
legitimate mismatch nobody foresaw would otherwise lose messages. The work packages, WP-G2-0 to WP-G2-6, are in
the [backlog](../backlog.md#p1---graine-v2---an-author-that-is-proven-and-a-ciphertext-bound-to-its-place-decided-2026-09-28).

### 21.1 The verified sender, measured then refused (WP-G2-1, G2-1b)

**Where it comes from.** OpenMLS verifies an application message's signature against the sender's
leaf before it decrypts, and `ProcessedMessage::credential()` is that leaf's credential - read in
`mls-core/src/messaging.rs` BEFORE `into_content()` consumes the message, and returned beside the
plaintext as `IncomingApplication.sender_identity` (`userId:deviceId`, the BasicCredential identity
`state.rs` mints). WASM returns `{data, sender}`, both from the single decrypt and from the history
batch; Tauri's `recevoir_message_bytes` and batch rows carry the same field. A credential the engine
cannot read is `sender: null`, never an absent field: `null` is "unverifiable", an absent field is
a path that was never given a sender and compares nothing.

**What it is compared with.** `mls-client/verifiedSender.ts` `checkVerifiedSender` is the ONE
comparison, on four paths - `live` (the WebSocket and pull queue), `distribution` (a key-group
frame), `welcome-replay` and `history`. The envelope's user is compared with the credential's user,
and its `senderDeviceId`, where the envelope carries one AND the path hands it over, with the
credential's device. **`live`, `history` and, since #2090, `distribution` hand it over**:
`openDistributionFrame` passes the frame's `senderDeviceId` beside the user, so a key-group frame
whose device disagrees is refused like a user mismatch (see
[section 24](#24-a-history-ask-answered-i-hold-nothing-is-final-for-its-roster-wp-hold-nothing-decided-2026-10-18)).
An alpha deploys dev alone, so production cannot run it before a stable: the pre-stable production
evidence is the INDIRECT reading - zero `[SENDER_MISMATCH]` of any kind on chat-delivery from
2026-10-10 to 2026-10-24, the `live` path comparing the same envelope field throughout. The order is
alpha, `path=distribution` read on dev (weak: a fictional seed plus testers), the stable, then the
same line read on production AFTER it, a nonzero count triaged as the
[backlog](../backlog.md#p3---the-distribution-paths-device-check-read-dev-on-the-alpha-production-after-the-stable) says. Three kinds:
`user`, `device`, `unverifiable`. The envelope's device is itself what the SENDING client's request
body claimed, so a `device` mismatch is either the server relabelling a frame or a client lying
about which device sent it - both worth knowing, and the measurement does not need to tell them
apart before the refusal exists.

**What a mismatch does: it is REFUSED (WP-G2-1b).** `[MLS] SENDER MISMATCH (...) - REFUSED,
consumed and not shown` at ERROR, and ONE report per `(group, path, kind, envelope, verified)` per
session to `POST /api/mls/sender-mismatch`, which logs `[SENDER_MISMATCH]` on chat-delivery with the
reporter and stores nothing - so production keeps its grep after the refusal exists. The measurement
came first (user, 2026-09-28) and read ZERO lines on production before the refusal was written.

`processIncomingMessage` (web and Tauri) throws a `SenderMismatchError` - a TYPE, which
`classifyIncomingDecryptError` reads first as `sender-mismatch`, never a sentence. The frame DID
decrypt, so its generation is spent, and each path does the same three things - mark it consumed,
acknowledge it, show nothing - and asks for no repair, because the group is fine and the envelope
lied:

| Path | Where | What it does |
| --- | --- | --- |
| `live` | `setupMessageHandler.ts` catch | `noteConsumed()`, ACK, nothing reaches the chat |
| `welcome-replay` | the buffered-frame replay after a Welcome | `noteFrameConsumed`, nothing dispatched (its other failures now log instead of vanishing) |
| `distribution` | `BaseMlsService.openDistributionFrame` + `dispositionOfUnreadableFrame` | consumed, ACKed, never handed to the seed handler, and no second "lost seed" line |
| `history` | `history.ts`, after the page is marked consumed | the row is skipped, nothing stored |

A `null` verified sender (a credential the engine cannot read) is `unverifiable`, and is refused
like the other two kinds: a frame whose sender nobody checked is not one to attribute.

**What it does not cover yet.** The native push decrypts - `mobile/background.rs`, the Android
service and the iOS NSE - still name the envelope's sender on a notification. They take the same
comparison IN RUST (the envelope's `senderId` handed to the decrypt, one implementation for both
platforms) with G2-4b, the package that already moves those files; a refused push shows the generic
banner. Until then a relabelled DM push can mislabel ONE notification, never a stored message: the
foreground decrypt of the same frame refuses it.

### 21.2 The v2 primitives (WP-G2-2) - written, tested, wired to nothing

**The bytes.** `lp(x)` is a 4-byte big-endian length followed by `x`; strings are UTF-8.

| Structure | Bytes |
| --- | --- |
| `H`, the message header and AES-GCM additional data | `lp("canari-graine-v2") lp(channelId) lp(sessionId) lp(minterUserId) be32(index)` |
| What the session key signs | `H nonce(12) ciphertext` - `H` delimits itself and the nonce is fixed-width |
| `D`, the endorsement descriptor the device key signs | `lp("canari-graine-v2-endorse") lp(channelId) lp(sessionId) lp(minterUserId) lp(minterDeviceId) lp(signingPk) lp(SHA-256(seed)) be64(createdAt ms)` |

**The seed commitment in `D` is a change to the design above, made when it was written.** G2-0
refuses a seed that differs from one already held, so the FIRST relayed copy of a session wins. An
endorsement that proved only the key would let the first member to relay a session to a newcomer
hand over other bytes, and the right seed would be refused when it came. With `SHA-256(seed)`
endorsed, the wrong seed is refused on arrival and the right one still lands. The hash reveals
nothing, since the seed is 32 random bytes.

**Why the device's MLS key may sign `D`.** OpenMLS signs `SignContent`, whose first byte is the
varint size of a label that is always `"MLS 1.0 " + label`, so never empty. Every Graine structure
begins with a 4-byte length whose first byte is `0x00`, which is a ZERO-length label read as an MLS
varint. No Graine bytes can be an MLS `SignContent`, so an endorsement can never be replayed into MLS.

**Where each half lives.**

- **Ed25519**: `mls-core/src/graine_signature.rs` is the only implementation, on every platform. It
  holds the session pair, session signing, one verifier for both keys (`verify_strict`), and
  `MlsManager::sign_with_device_credential`. Its errors are typed, with a stable `code()`. It is not
  WebCrypto, because Ed25519 reached the browsers late (Chrome 137, iOS 17) and the WebViews phones
  ship are older than that.
  - Exposed to WASM as `graine_session_keypair`, `graine_sign_with_session_key`,
    `graine_verify_signature` and `WasmMlsClient.sign_with_device_credential`.
  - Exposed to Tauri as the commands of the same names.
  - A verification answers `valid` or a code, never an exception: a signature that does not verify is
    an answer, not a failed call.
  - **A page is verified in ONE call** (`graine_verify_signatures`, WASM export and Tauri command,
    2026-10-22). The checks cross as one packed buffer (`packGraineSignatureChecks` in
    `graineV2.ts`, decoded by `unpack_graine_signature_checks`; a shared vector pins the two, and
    `graineSignatureBatch.wasm.test.ts` runs the BUILT WASM on the TS packer), as one
    base64 string over Tauri. Each check is still `verify_graine_signature`, one verdict per check in
    order: it is NOT an Ed25519 batch verification, which answers one bit for the set and is not
    strict, so one forged row would refuse its honest neighbours. A packing that does not parse
    rejects the call whole; it is a contract break, never a verdict. So does an answer that is not
    one known verdict per check (`requireGraineVerdicts`, a typed `GraineSignatureBatchError`). The history load and the
    whole-history search open their rows through `openChannelMessagePage` (`channelSeal.ts`), which
    runs the single open's two halves around that call: every check before the signature row by
    row, one engine call, then the decrypt and the replay claim in page order. Every row gets what
    `openChannelMessage` gives it; `channelSeal.test.ts` asserts that on a page holding every
    refusal. The live path opens one row and keeps the single call.
- **The encodings, the AES-GCM with AAD, and the endorsement check**:
  - `frontend/src/lib/crypto/graineV2.ts`, which is pure and takes the Ed25519 half as a
    `GraineSignatureEngine`;
  - its native mirror, `src-tauri/src/mobile/graine.rs`, whose `open_graine_message_v2` is what a push
    will call.
  - Both check the signature BEFORE deriving a key, so a relabelled row is a `GraineSignatureError`
    (a FAULT), and a wrong seed past a valid signature is an AES failure (a different fault).

**What holds the two sides together.**

- **Shared vectors**, computed with WebCrypto alone and asserted in `graineV2.test.ts` (WebCrypto
  engine) and `mobile/graine.rs` (aes-gcm, sha2, ed25519-dalek, independently). They cover the
  header, `D`, the seed commitment, a sealed message that opens, its signature re-derived byte for
  byte, and an endorsement that verifies.
- **A frozen fixture**, `src-tauri/tests/fixtures/v0.18.28-graine-v2-push.bin`
  (`nonce || signature || ciphertext`), beside the v1 generation. `cross_version_push.rs` asserts that
  it opens, that today's seal and signature reproduce it exactly, and that a relabelled author does
  not open it.

**Nothing calls any of it yet**: the store and the wire carry the fields in G2-3 (§21.3), and the
reader uses them in G2-4.

### 21.3 The data model carries the minter and its key (WP-G2-3)

Everything a v2 reader needs is now carried, stored and relayed. No v2 session exists yet, and
nothing verifies anything. That is G2-4.

- **On the wire.** `GraineMsg` gains `version = 6`, `minter_user_id = 7`, `minter_device_id = 8`,
  `signing_public_key = 9` and `endorsement = 10`.
  - `utils/graine/wireSeed.ts` is the one translation between that message and the store.
    `seedFromWire` keeps a `version = 2` seed v2 even when its fields are missing, so the reader
    refuses it rather than taking it for v1. `toWireSeed` relays the four public fields untouched
    and NEVER the session secret.
- **In the store.** `StoredGraineSession.v2` (`minterDeviceId`, `signingPublicKeyB64`,
  `endorsementB64`, and `signingSecretKeyB64` on the minting device only) lives inside the payload
  that is already sealed with the seed.
  - So neither SQLite nor IndexedDB needed a migration, and the backup carries it as it is.
  - A partial block reads as absent.
  - On a v2 session `senderId` IS the minter, stored exactly as signed. A relayed seed is no longer
    recorded under whoever relayed it.
  - `storeIncomingSeed` extends G2-0's refusal: a copy whose endorsement, key, device or minter
    differs from the one held is `[GRAINE] REFUSED` (`'endorsement'`), as a different seed already
    was. So a relayed copy cannot downgrade a v2 session, nor re-attribute it.
- **The restored secret cannot reuse a key.** A backup import carries no `distributionEpoch`, so a
  restored session always rotates before it seals again, and the same index is never signed twice
  from two installs.
- **In the native mirror.** A `graine_seeds.json` entry becomes
  `{seed, createdAt, firstIndex[, version: 2, minterUserId, signingPk]}`.
  - Both writers go through `MirrorSeed` in `commands/push.rs`: `store_graine_seed` from the
    webview, and `store_graine_seeds_json` from the push's attached frame, whose `proto_fields.rs`
    now reads `first_index` too.
  - `merge_graine_seed` refuses a replacement whose channel, seed or v2 block differs, and may only
    LOWER `firstIndex`.
  - A v2 entry missing its minter or key is refused rather than written as v1.
- **On social-service.** Migration 065 adds `channel_messages.signature` (88 base64 characters,
  checked for SHAPE only, since the server holds no key and cannot tell a v2 session from a v1 one;
  REQUIRED on every row since §21.8, which the floor made possible).
  It is relayed with the row in `listMessages` and the `channel.message.created` event.
  - It joins the push's inline group in G2-4, WITH the three native readers:
    `channelPushFields.test.ts` refuses a key the server sends that no handler reads, and it
    refused this one.
  - The same migration adds the UNIQUE partial index `(senderSessionId, messageIndex)`, measured
    first: 0 duplicate pairs in production (123 rows) and dev (67).
  - A second row under one key is refused with a 409, `CHANNEL_MESSAGE_KEY_REUSED`, and
    `[CHANNEL_KEY_REUSED]` at ERROR. By the restore argument above it can only name a bug, so no
    client retries it.
- **On chat-delivery.** `device_signature_key` (migration 027) keeps every MLS signature key a
  device ever published, and `GET /api/mls/devices/:userId/:deviceId/signature-keys` serves it.
  That is the key an endorsement is checked against once the minter's device has left the tree.
  - An upload whose package names another device is refused, measured at zero on both estates
    ([chat-delivery](../services/chat-delivery.md#routes)).

### 21.4 The web reader (WP-G2-4a)

The web app reads v2 now. Nothing writes it until G2-5, so on today's rows none of this runs.

**Opening a row** (`openChannelMessage`). A session with no `v2` block opens as v1, unchanged. A v2
session's row is refused, in this order:

1. served in another salon than the session's (`GraineChannelMismatchError`);
2. naming an author who is not the session's minter (`GraineAuthorMismatchError`). Both ids are
   compared lowercased, as the rest of the client reads them. The SIGNED header uses the minter
   exactly as endorsed, so a served id's case proves nothing either way;
3. carrying no signature (`GraineSignatureError`). The version belongs to the session, which came
   over MLS, so dropping the signature is not a downgrade to v1;
4. a signature that does not verify under the session key, over `H || nonce || ciphertext`
   (`GraineSignatureError`). This covers a row moved to another index, and a member signing a
   header that names another minter.

**A replay is shown once.** `claimOpenedKey` (in `runtime.ts`) remembers which row id first opened
each `sessionId#index`. A second row id under the same key is a `GraineReplayError`, and the same row
opened twice (history, then the live event) is not. The key is claimed only AFTER the row
authenticated, so a forged row cannot take a key first and get the real one refused as its replay.

**All four refusals are FAULTS.** `reportUnreadableChannelMessage` says each class ONCE per page at
ERROR (`REFUSED`, `author mismatch`, `channel mismatch`, `bad signature`, `replay`) and never asks a
peer for a seed, since the seed is right. A missing seed stays a warn that asks.

**A new v2 seed is stored only once its endorsement verifies** (`utils/graine/endorsement.ts`,
called from `storeIncomingSeed`, which both the single seed and the repair bundle go through).

- The minter device's key comes from the key group's TREE, via `memberSignatureKey`
  (`mls-core` `member_signature_key`, exposed to WASM and Tauri), when the device is still a leaf.
  A failure there is a refusal: the server is not asked as a second try.
- It comes from the server's published history (`fetchDeviceSignatureKeys`, §21.3) only when the
  device has left the tree.
- `refused` (a forged minter, a substituted key or seed, missing fields) stores nothing and says
  `[GRAINE] REFUSED v2 seed` at ERROR.
- `unanswered` (the device has left the tree and the server cannot be reached) stores nothing and
  refuses nothing. A later row under the session is then a missing seed, which asks again.
- A copy of a HELD session is not re-checked, since `seedConflict` already proved it byte-identical.

**The Ed25519 engine** is `IMlsService.graineSignatureEngine()`: the WASM free functions on the web
(`wasmGraineSignatureEngine`) and the Tauri commands on native. Both are `mls-core`. Tests use
`crypto/graineV2.testEngine.ts`, a WebCrypto copy that production never imports.

**The native push readers** are §21.5, and the signature joins the push's inline group with them.

### 21.5 The native readers (WP-G2-4b)

**One implementation for both platforms, in Rust.** A push handler on Android (Kotlin) or iOS (the
NSE, and `canari_push.mm` in the app process) used to read the seed out of `graine_seeds.json` and
hand it to a key-derivation call. That split put half of the rules in three languages. Now it hands
over the push's own fields and the data directory, and
`mobile/background.rs` `open_graine_push` does the rest:
- `nativeOpenGrainePush` on Android;
- `canari_native_open_graine_push` on iOS.

| Check | How | Refusal (`reason`) |
| --- | --- | --- |
| The salon | the session is read under the push's OWN `channelId`, so a row moved to another salon finds nothing | `seed-not-mirrored` |
| The floor | `index < firstIndex` of the mirrored session | `below-floor` |
| A v2 session held whole | a v2 entry without its minter or key is unreadable, never opened as v1 | `mirror-unreadable` |
| The author (v2) | the push's `senderId` must be the session's minter (case-insensitive, as the web) | `author-mismatch` |
| The signature (v2) | present, then verified over `H \|\| nonce \|\| ciphertext` BEFORE AES-GCM runs with `H` as AAD | `signature-missing`, `signature-refused` |

The three accusing refusals are logged at ERROR by Kotlin, because a Rust log line goes nowhere in a
killed app. **A replay is not refused here**: a notification path keeps no record of the rows it
opened, so a replayed push shows its banner again. The app, which does keep that record, shows the row
once.

**A blind banner names no author (2026-10-22).** The push's `senderId` and `mentioned` are the
server's words, and only the open above proves the author. So the face, the "<name> mentioned you"
line and the mention route (`canari_mentions` on Android, the time-sensitive level on iOS) are drawn
only on a banner that shows the decrypted text. A banner on the generic line - no seed, no inlined
ciphertext, a refused open - draws the salon's initials and nothing about an author. One pure rule
on each platform: Android `push/ChannelBannerAttribution` (tested in `android-tests`) and the NSE's
`channelBannerAttribution`; `canari_push.mm` applies the same rule inline. A held v1 session still
opens with no author check, as the app's v1 reader does
([legacy-compatibility](../legacy-compatibility.md)).

**The verified sender of an MLS push (the native half of WP-G2-1b).** Both push decrypts
(`decrypt_push_message_with_key` and the commit catch-up) now take the push's `senderId` in a
`PushFrame`. They decrypt with `process_incoming_message_with_sender`, and a frame whose verified
leaf names another user, or no readable one, is `sender-mismatch`. That covers a DM's banner and an
attached seed frame alike. Kotlin reads it as `NothingToRender`: no catch-up, no worker, and the
generic banner on a visible push.

**An arriving v2 seed is checked against the tree before it is mirrored.** `classify_verified` keeps
a key-material frame's v2 seed only when its endorsement verifies against the minting device's leaf
in that key group (`member_signature_key`). A push handler has no user session to reach the
server's published keys, so a minter that has left the tree is UNANSWERED, as on the web: nothing is
mirrored and nothing is refused, and the app checks and mirrors the seed when it next runs. A v1 seed
is kept as before.

**Pinned by** `cross_version_push.rs` `through_the_mirror`, which opens the frozen v2 fixture through a
temporary mirror, with each refusal falsified. `background.rs` covers the sender refusal and the
three endorsement cases (endorsed, forged by another member, minted by a device the tree does not
hold). `channelPushFields.test.ts` now expects `signature` in the inline group on all three readers.

### 21.5b What a salon EDIT trusts (2026-10-05)

A salon edit is a silent row whose authorship every reader checks against the row's sender
(`applyChannelEdit`, [chat](../frontend/modules/chat.md#editing-your-own-message-in-a-salon-2026-10-05)).
**That sender is PROVEN only for a row under a v2 session** (signature and minter checked by
`openChannelMessage`). A row still opened under a v1 session carries a server-supplied, unsigned
`senderId`, so a malicious server, or a v1 row from before G2-5, could forge an edit "from" the
author. This is the same trust level as DELETE today (the server alone decides whose delete it
honours), so it is not a regression, and edits are deliberately NOT restricted to v2. It closes when
the last v1 session ages out with the v1 reader ([legacy-compatibility](../legacy-compatibility.md)).

### 21.6 The writer (WP-G2-5)

Every send is v2 from this release on (#1221, first in the stable `v1.0.3`, 2026-10-05). It ships only once `minClientVersion` is R1 (the G2-4
reader) AND both stores serve R1: a v1 reader shown a v2 row fails to open it (the floor is raised by the user only; it reached `1.0.3` on 2026-10-11, which let G2-5b refuse an ARRIVING v1 seed, §21.7). This is the
reader-then-writer order of CORRUPT ([durable-rules](../durable-rules.md)).

**Minting endorses first** (`reserveOutboundSlot` in `utils/graine/sessionManager.ts`). A new
session is drafted, then `endorse` (`utils/graine/endorseSession.ts`) runs, then it is distributed,
then persisted:

- `endorse` mints the session pair through the engine (`newSessionKeyPair`: `mls-core`, over WASM
  or Tauri);
- it signs `D` with this device's MLS credential key (`IMlsService.signWithDeviceCredential`), and
  the seed commitment inside `D` binds the pair to these seed bytes;
- the distributed session already carries its `v2` half. A v2 seed without its endorsement is
  refused by every reader, so the order is load-bearing;
- a failed endorsement distributes and persists NOTHING, exactly like a failed distribution.

**Rotation** (`graineOutboundVerdict`, `shouldRotateGraineSession` until 2026-10-22) adds one cause: a session with no signing secret. That
covers every v1 session (one rotation per salon and sender, at the first send after the upgrade) and
a v2 session restored somewhere its secret is not.

**Sealing** is `sealWithGraineV2` under `H = (salon, session, minter, index)`, signed by the
session secret. The `signature` travels in the send body. The server stores it and relays it in
`listMessages`, the live event and the push inline group (§21.3, §21.5).

**The v1 writer is deleted.** `sealWithGraine` survives only as a test fixture
(`crypto/graine.testSeal.ts`), because the v1 reader's tests still need v1 rows. What remains of v1
is the reader, and its removal condition is in [legacy-compatibility](../legacy-compatibility.md).

### 21.7 An arriving v1 seed is refused (WP-G2-5b) - the floor reached the writer, 2026-10-11

**The precondition.** The user raised production's `minClientVersion` to `1.0.3` (the G2-5 writer) on
2026-10-11, read back from `GET /api/version`. The gate is hard: a client below it cannot unlock MLS,
so no honest client can put a v1 seed on the wire. A v1 seed names no minter and its rows carry no
signature, so a modified client minting one could post under any member's name. That is the case the
user's 2026-09-28 decision closes.

**What is refused: a NEW v1 seed, on every path a seed arrives by.**

| Path | Where | What happens |
| --- | --- | --- |
| A single seed frame on a key group (a fresh distribution, or the durable log replaying one) | `frameHandler.ts` `storeIncomingSeed` -> `'v1-refused'` | nothing stored, nothing mirrored, no salon announced; `[GRAINE] REFUSED v1 seed <id> from <sender> ... (claimed createdAt N)` at WARN |
| A repair or history bundle | the same call, from `absorbSeedBundle` | the bundle's v2 seeds are stored; its v1 seeds are refused in ONE line per bundle, `[GRAINE] REFUSED N v1 seed(s) relayed by <sender>` |
| A seed frame attached to a push (native, Android and iOS) | `background.rs` `endorsed_by_tree` | the seed is dropped before Kotlin or the NSE can mirror it. The answer names the refused sessions in `v1Refused`, because the Rust line reaches no logger in a killed app or in the extension: Kotlin logs `REFUSED N v1 seed(s)` at WARN, the NSE `[CanariNSE] openSeedFrame: REFUSED v1 seed(s) ...` through `NSLog` |

"New" means this device does not hold the session. **A v1 session already held is untouched**: its
own sessions coming back, a copy lowering its floor, and every row under it still open with the v1
reader. A backup import and a PIN change write held sessions straight to the store and never go
through `storeIncomingSeed`. The webview mirroring a held session (`store_graine_seed`) does not go
through the push filter either.

**WARN, not ERROR, on purpose.** The key group's durable log still replays v1 frames that honest
clients distributed before the floor moved, and an honest answerer relays every v1 session it holds.
So one refusal accuses nobody. The `createdAt` it prints is the sender's own claim and decides
nothing. It is there so a reader can tell an old replay from a fresh mint.

**A row that only a v1 seed could open no longer asks for one.** `openChannelMessage` throws
`GraineV1SessionNotHeldError`, not `GraineSessionUnavailableError`, for an UNSIGNED row under a session
it does not hold. A v2 session refuses an unsigned row anyway, so only a v1 seed could open it, and
this device would refuse that seed. `reportUnreadableChannelMessage` calls no `noteMissingSeed` for it.
In a history page it is counted as `v1 session not held`, a warn once per page, because a page
replays honest rows written before the floor. **On the LIVE path (`channelEventHandler`, no tally) it
is an ERROR, `REFUSED`**: every client admitted since the floor signs what it sends now, so a fresh
unsigned row is a modified client minting v1, or a server stripping a signature. *Never learn by failing
what a fact could have told you.* If a server strips the signature from a v2 row whose seed this
device lacks, the row lands here and is not asked for. That makes the row unreadable, which
withholding it would do just as well.

**What a member sees.**

- **A device already holding a v1 session**: no change. Its v1-era rows stay readable.
- **A NEW member, a NEW device without a backup, or a returner missing a v1 seed**: salon messages
  written under a v1 session (sent before the sender's first send on `1.0.3` or later, at most 365
  days old) are not shown on that device, and nothing asks a peer for them. **The salon says so ONCE (user,
  2026-10-12)**: when a history load dropped any `v1 session not held` row, `olderMessagesNotice`
  adds one system notice, `chat_older_messages_unavailable` (Paraglide, fr and en). It is derived from
  the load's own dropped rows (`UnreadableRowTally.rowsOf`), never a timer, and a SILENT row (a
  reaction or an edit, `silent` on the server row) does not count, since it drew no bubble. Its id is
  fixed per salon (`graine-v1-unavailable:<salon>`), so reloads merge into the same notice, and
  `keepNoticeOnTop` restamps it before the oldest message held after every merge, so a forced reload
  or a whole-history search never leaves it mid-history. v2-era messages are
  unaffected. This is the cost of the decision, accepted when the user decided it on 2026-09-28:
  refusing only "new" v1 sessions by date is impossible, because the date is the sender's claim.
- **A client at `1.0.3` up to the release before this one** still accepts v1 seeds. It writes v2 and
  is not the threat: the threat is a modified client, and these refusals sit on the RECEIVING side.
- **A client below `1.0.3`**: blocked at unlock by the floor (`auth_update_required`), as it already
  was.

**What it does NOT close.** A member who already HOLDS a v1 seed can still forge an unsigned row
under that session, naming its minter. The v1 reader opens it until it goes, at the count in
[legacy-compatibility](../legacy-compatibility.md). **The server now refuses to STORE such a row
(§21.8)**, so the forgery needs a server that cooperates; the reader is what still guards against
that one. The salon-edit trust level of §21.5b is unchanged.
The dev estate's floor was raised to `1.0.3` as well (2026-10-12), so a pre-release there meets no
admitted client minting v1.

**Pinned by** `frameHandler.test.ts` (a new v1 seed refused, with nothing mirrored or announced; a mixed
bundle stores its v2 seeds and refuses its v1 seeds in one line; a held v1 session still lowers its
floor), `channelSeal.test.ts` (an unsigned row under an unknown session is v1, a signed one is a
missing seed), `channelCrypto.test.ts` (only the signed one asks), `channelEventHandler.v1Live.test.ts`
(the live unsigned row is refused at ERROR and asks nobody; the signed control asks), `olderMessagesNotice.test.ts`
(the notice: absent at a zero count or for silent rows only, sorted to the top, one per salon, kept
first after a merge), `useConversations.olderNotice.svelte.test.ts` (a real history load: present
when a v1 message row is dropped, absent otherwise, first after a forced reload), and `background.rs`
`a_v1_seed_is_refused_by_the_push_path`, which also checks `v1Refused` (the two push seed tests now carry
an endorsed v2 seed). The Swift and Kotlin log lines are not compiled on a workstation: their
reading is owed on a device. **On a real estate** the rig rows GRAINE-AUTH-5 (the live unsigned row,
refused at ERROR, nothing asked) and GRAINE-AUTH-6 (the same row from history, warn, the notice once)
are `PASS` since 2026-10-13 ([board](../cross-client-testing-archive-1-4-0.md#20---graine---an-author-that-is-proven)).
Since §21.8 the server refuses that POST, so GRAINE-AUTH-5 has no arm any more and GRAINE-AUTH-6
inserts its row in the database.
**First shipped in the stable `v1.2.6` (2026-10-13)**: a store build older than that still accepts a v1
seed, which is the receiving-side gap the floor (`1.0.3`) does not close.

### 21.8 The server refuses an unsigned salon row (2026-10-13)

**The precondition is §21.7's**: `minClientVersion` is `1.0.3` (the G2-5 writer) on both estates, so
every admitted client signs every row it posts. §21.3 checked the signature for SHAPE only because the
server cannot tell a v2 session from a v1 one. It still cannot. It no longer needs to: no honest
client writes v1 at all.

**What is accepted is an ALLOWLIST of one shape**: `POST /api/channels/:channelId/messages` with a
`signature` of 88 base64 characters (64 bytes). Everything else is refused before anything is
stored, published or pushed (`ChannelService.assertSigned`, social-service):

| The row | Answer |
| --- | --- |
| `signature` absent or `null` - text, poll, silent (reaction, edit) alike | 400 `CHANNEL_SIGNATURE_REQUIRED`, `[CHANNEL_SIGNATURE] REFUSED unsigned row ...` at ERROR |
| `signature` of another length, not base64, not a string | 400 `CHANNEL_SIGNATURE_INVALID` at WARN, as before |

The order is unchanged: membership, read access and write policy are checked first (a non-member
still gets its 403), then the session and index, then the seed frame, then the signature.

**Why nothing legitimate is refused.** This route has exactly ONE caller in the repository,
`ChannelService.sendMessage` (frontend), reached only from `sendEncryptedChannelMessage`, which seals
through `sealChannelMessage`. That function throws before the POST when the session holds no signing
secret, and `graineOutboundVerdict` mints a new session for any that lacks one. Text, polls,
mentions, reactions, edits and a community's system notice all go through it, and the `v1.0.3` tag
already posted `signature: sealed.signature` on every one (read from the tag, 2026-10-13). What does
NOT use this route, and is therefore untouched:

- DMs and MLS groups, commits, Welcomes, seed distributions, seed requests and repair bundles: MLS
  frames on chat-delivery, signed by MLS;
- the Android notification reply and the iOS one: MLS only, never offered on a `channel_`
  conversation (`CanariFirebaseMessagingService`, `canari_push.mm`), and their outbox drain posts to
  chat-delivery;
- the push handlers, the NSE and every Tauri background path: they READ salon rows, none posts one
  (no `/api/channels` in `src-tauri/`);
- the server itself: `sendMessage` is the only code that inserts a `channel_messages` row; no bot,
  service or internal route writes one;
- the cross-client harness: only archived probes post here. `graineauth.mjs`'s replay arm posts a
  SIGNED row, so it still gets its 409. Its v1 arm posted an UNSIGNED row on purpose, and this change
  broke it: the arm now reads the 400 itself (GRAINE-AUTH-7), and the history arm writes its row in
  the database (GRAINE-AUTH-6). GRAINE-AUTH-5, the live arm, has no runner any more: a database
  insert publishes no event.

A client below the floor cannot unlock MLS, so it holds no seed and cannot seal a salon row in the
first place. The one population that could still send unsigned is a process UNLOCKED before the floor
rose and still running pre-`1.0.3` code; `PlatformGateOverlay` covers it on the next focus. Such a send
gets a 400, and `v1.0.2`'s salon send (`messaging.ts`) turns any 400 into the generic send-failed
line and returns: nothing retries it on its own, and a salon send never enters the outbox
(`outbox.ts` drops a `channel_` entry), in `v1.0.2` as now. On current code the same 400 marks the
bubble `error` (`deliverSalonSend`); its manual retry re-seals, so it signs. No client branches on the
code: no current client can reach it, which is why no client change ships with it. `ChannelApiError`
already carries the code, so a later consumer reads it at the throw.

**No flag, no staged rollout.** The refusal depends on a fact both estates already hold (the floor),
not on a switch. It ships through a pre-release to `dev.canari-emse.fr` first, like everything. **The
floor must never be LOWERED below `1.0.3`** - that was already true of §21.7 (an older client would
mint v1 seeds every current client refuses), and this makes it true of the server too.

**What it closes, and what it does not.** A modified client can no longer STORE an unsigned row under
a v1 session another member holds - the hole §21.7 left open. A malicious server can still insert
one directly, and the v1 reader would open it: that is the v1 reader's own limit, and it goes with the
reader ([legacy-compatibility](../legacy-compatibility.md)). It also makes the reader's removal
measurement monotonic: from this deploy on, `count(*) WHERE "signature" IS NULL` can only fall.

**Measured 2026-10-13 on both estates: 0 unsigned rows since 2026-10-10**, the last one written on
2026-10-09 - before the floor rose on 2026-10-11, so not one admitted client has written v1. The
count per day, to re-run after the deploy:

```sql
SELECT date_trunc('day', "createdAt") AS day, count(*) FILTER (WHERE "signature" IS NULL) AS unsigned
FROM channel_messages WHERE "createdAt" > '2026-10-05' GROUP BY 1 ORDER BY 1;
```

**Pinned by** `channel.service.spec.ts`: an absent, a `null`, a silent and a poll row are each refused
with `CHANNEL_SIGNATURE_REQUIRED` at ERROR, nothing saved or published; a non-member still gets its
403; and the floor boundary, as the two tags put a row on the wire - the five shapes `v1.0.3` posts
(text with its seed frame, silent reaction or edit, poll, system notice, mention) are accepted signed,
and the same five as `v1.0.2` posted them, unsigned, are refused. **On a real estate**: the rig row
GRAINE-AUTH-7 (the 400, the ERROR line, nothing stored), not yet run
([board](../cross-client-testing-archive-1-4-0.md#20---graine---an-author-that-is-proven)).

**Where it stands (2026-10-14).** Merged as #1802, on dev since `v1.2.7-alpha.1`; production gets it
with the next stable. Production still held **373 unsigned rows in 15 salons** (none pinned), the
oldest from 2026-09-02 and the newest from 2026-10-09, and none written in the four days before. The
v1 reader goes when that count is 0 ([legacy-compatibility](../legacy-compatibility.md)).

## 22. A key group's backlog was refused on every load - the classification is device state - FIXED 2026-09-28

**Measured on the user's PC, production `v0.18.28`, 2026-09-28.** Mineurchestre -> `#general` was
blank on the web client and full on the phone. The device was frozen at epoch 5 of the
community's key group `2de1b91f`, which the server had at 13. `queued_message` held **51** rows on
that one group - eight commits (5 -> 12) and 43 seed frames, the oldest a day old - and every load
drained all 51 and acknowledged none:

```
Message for absent conversation 2de1b91f - retry after restore      (x51)
[PENDING] 51 frame(s) left unacknowledged ... absent-conversation: 51
[SYNC] WASM kept 2de1b91f... - key-distribution group               (+2.6 s)
```

**A boot race, and a reason nothing discharged.** The key-group registry
(`knownDistributionGroups`, `distributionScopeByGroup`) lived in memory only, filled by the
community loop that `setIsLoggedIn` starts WITHOUT awaiting. The gateway drains the whole queue a
few hundred milliseconds later; Mineurchestre is this user's fourth community and was registered
after the drain. So `isDistributionGroup()` was false when its frames arrived, the pipeline skipped
the key-group branch (`setupMessageHandler.ts`) and `handleKnownGroup` refused each one as
`absent-conversation` - a reason discharged only by a conversation appearing, which a key group never
has. The registration that came 2.6 s later discharged nothing, and a live socket means no later
pull: the salon stayed blank until a reload lost the same race again.

**The fix is two halves, one mechanism and one net.**

- **The classification is durable device state** - `IStorage.saveDistributionGroup` /
  `getDistributionGroups` / `deleteDistributionGroup` (IndexedDB store `distributionGroups`, v9;
  SQLite table `distribution_groups`, schema 11), plaintext like conversation metadata, modelled on
  the pending exits. `registerDistributionGroup` writes a row when the scope is NEW or CHANGED;
  `forgetDistributionGroupById` deletes it (not `dropGroupState`: the gap escalation drops a tree and
  rejoins while keeping its registration). `hydrateDistributionGroups` runs in `sessionAuth` right
  after the local database opens - before `setIsLoggedIn`, the handler and the drain - and restores
  every row **allowlisted by the local MLS state** (`holdsGroupState`); a row outliving its tree is
  deleted, never believed.
- **Registering a key group collects what was refused for it.** `registerDistributionGroup` and
  `noteDistributionGroup` call `refetchFramesLeftBehind` for THAT group, for `absent-conversation`
  and - once the scope is named - `unscoped-distribution-group`, in ONE pull. That second reason is
  new: `routeDistributionFrame`'s scope-less branch (a group the server named before its community
  loaded) used to refuse bare, with nothing left to re-fetch it. **A fallback is a signal**: the net
  firing for a group HELD AT START-UP means the durable half missed it, and says so at `warn`
  (`[GRAINE] key group ... was held at start-up and the stored registry did not name it`); for a
  group joined in this session it is the ordinary order of events.

**Why it heals losslessly.** The seed handler is wired (`onDistributionFrame`) before the drain, so
once the classification is known the eight queued commits apply in order and the 43 seeds decrypt -
no rejoin, no history request. The claim is checked on the device that reported it: zero
`past-epoch-application` after the release (`max_past_epochs` is 2, so a commit applied out of
order would show there).

### 22.1 A key group behind its server catches itself up, and nothing is sealed while it is behind

**The same device, an hour later (console of 19:25, 2026-09-28)**: epoch **4**, and every one of the
1984 frames refused was `epoch-gap` at epochs 6 to 15 - the commit 4->5 was not in the queue at all,
so the classification alone could not have healed it. Four things were missing, each now a mechanism:

- **Held is not current.** `joinDistributionGroup` read `ref.activeEpoch` on every load and compared
  it with nothing. The held branch now schedules `verifyDistributionEpoch(groupId, activeEpoch)`, never
  awaited: it waits for `whenInitialDrainSettled()` (a one-shot resolved by the first pull that EMPTIED
  the mailbox, never by a failed one) and the group's own queue, because before the drain "behind" may
  mean "its commits are still queued" - and replaying from the log first would jump past the epochs
  the queued seeds were sealed at. Still behind after it is a proof: rung 1 replays the missing commits.
- **A frame from a future epoch is caught up to, one commit at a time.** `routeDistributionFrame` used
  to refuse `epoch-gap` bare - no gap armed, nothing to catch the group up. It now replays ONE commit
  (`attemptCommitReplay(..., untilEpoch = local + 1)`) and re-tries the frame, repeating while each
  step applies a commit. One step is exactly the hole when the rest is queued, and it keeps the queued
  seeds readable (`max_past_epochs` is 2). `wrong-epoch` is NOT armed: `mls-core` fast-fails every
  `msg_epoch > group_epoch` as `epoch gap` before openmls sees the frame, so it cannot be one.
- **Nothing is sealed at a stale epoch.** The gap is armed for the whole catch-up and lifted only at the
  SERVER's epoch (`distributionGapTarget`) - the commit branch used to lift it on the first commit with
  seven still to come. `distributionEpochFor` answers null while it is armed, so no seed is minted; seed
  requests and the history request wait for `whenDistributionEpochSettled` and are HELD while the gap
  stands (`repair.ts`). When the gap closes, the held ones go out and every request sealed at an epoch
  the group has since left is asked again (`askedOn`).
- **Rung 2 has one door.** A replay the log cannot finish (below its floor, or holed) is a proof, so the
  verdict listener re-joins at once through `rejoinBehindDistributionGroup`: forget, then
  `ensureDistributionGroupFor` - the loader's own join, in-flight share included - and the community's
  history is asked even though seeds are held. The sync watchdog's stuck-gap net takes the same door
  whenever a scope names the group, instead of its own drop + external commit (two doors to one leaf is
  the GRP-4 duplicate).

What the verdicts are and who acts on them: `DistributionGapVerdict` (`IMlsService.ts`),
`distributionGapListener` (`utils/graine/distributionGroup.ts`), wired in `sessionAuth` with the frame
handler, before any drain.

**Also measured that day, and not a defect of this device**: Rootz 2026-2027 -> `#general`, the
rows of 2026-09-02 (two sessions, one the user's own) are unreadable on EVERY current device - all
joined the key group 2026-09-12..28, the phone included. The repair walk behaved: own devices
declined, the seven other members were really offline, the waiter re-asks on presence. It is a
measured limit of section 4.5: "the sender always holds its seed" is false once the author's device
is gone.

### 22.2 A key group held with its own leaf removed is not held - FIXED 2026-09-29

**The same PC, after `v0.18.29`: the salon was still blank.** Its local key group sat at epoch 5,
**inactive**. OpenMLS 0.9 (`external_commits.rs`) adds a Remove to an external commit for every leaf
whose signature key equals the joiner's (a resync). The credential `user:device` and its key pair
live in the MLS state, so a device that joins twice with one key pair removes its own first leaf.
The server's commit log shows exactly that: the PC joined Mineurchestre's key group twice on
2026-09-25, and the second join's commit 4->5 was 864 bytes, one inline Remove. The state that
survived on disk was the FIRST join's. Replaying commit 4->5 into it applied the Remove, and from
then on every frame answered `Evicted` and was acknowledged as "no repair is owed". The loader
took the group as held on every load, because held meant "a tree exists", never "this device
is in it".

**Reproduced on the local estate, W2, 2026-09-29**: snapshot the MLS blob, delete W2's roster row so
its next load re-joins (commit 24->25, sent by W2 itself), then restore the snapshot. On `main` the
replay reported `replayed 1 commit(s), epoch 24->25, healed=true` on the very commit that evicted
it. Four seed frames were ACKed and dropped. Only the sync watchdog rescued the group, 45 s later,
and only because the server was further ahead (on the PC it was not, for three days).

**Held is now three questions, and the second one is asked everywhere it matters**:

- **The loader** (`joinDistributionGroup`) reads `isGroupActive` on a held group. Held but inactive is
  stale: it forgets the tree and joins, **unless a Welcome may be owed to this device**
  (`readWelcomeOwedForThisDevice`), which is the only other way back in and which a second join
  would race.
- **The frame path and both replays** tell a new verdict, `evicted`, ONCE per group until it is
  forgotten (`tellEvictedOnce`), since a queued burst is one eviction. The frame is still
  acknowledged: its epoch belongs to a leaf this device no longer holds, and the seeds come back
  through the history request the re-join sends. **Eviction is asked BEFORE "reached the target"**,
  because the Remove applies like any commit, and the epoch alone would say caught up.
- **The listener** re-joins on `evicted` through the one door `replay-exhausted` already used
  (`rejoinBehindDistributionGroup`).

**Why the PC joined twice is NOT proven.** The candidate is the known warning "externalJoin FAILED
to checkpoint - a reload before the next write would rejoin", or two tabs before the leader lock
settled. Either way the join leaves a state on disk that a later commit evicts, and that state is
what this section now repairs on sight.

### 22.3 The native app read every held key group as epoch 0, and re-joined them all - FIXED 2026-10-09

**Measured on production, 2026-10-09.** Community key groups were kept alive almost only by
external joins: 54 to 85 a day for six days, 378 of 449 from native apps. In one salon's key group,
every commit from epoch 44 to 57 was an external join by a member's own native device, and the
commit before each re-join was the SAME device's previous join, one to seven minutes earlier. The
device was current and re-joined anyway. In between, members sending to the salon got "Échec de
l'envoi" with no request reaching the server, so the seal had refused.

**The edge log named the path.** Every burst was `GET .../distribution-group` for each scope, then
`GET /api/mls/device-memberships`, then one `POST /api/mls/commit` per key group, all within one
second. About 47 s before each burst the same device had asked `GET /api/mls/commits/<group>?sinceEpoch=0`
for all its key groups, which it had joined minutes earlier.

**The cause: `TauriMlsService.getEpoch` is a cache, and it answered 0.** The cache
(`_epochByGroupId`) was filled after a queued message's callback and by a few native calls. It was
never filled at start-up, and it answered `0` for a group with no entry. After a cold start, every
held key group whose drain carried no frame therefore read as epoch 0. Then:

1. The loader's held branch ran `verifyDistributionEpoch(group, activeEpoch)` and saw it 56 epochs
   behind.
2. `catchUpDistributionGroup` armed the gap and asked the log from 0.
3. The replay broke on the epoch-0 commit against a tree at 56, and the verdict was `replay-failed`.
4. The gap stayed armed, so `distributionEpochFor` refused every seal for the scope. That is the
   refused send.
5. 45 s later the sync watchdog (`STUCK_EPOCH_GAP_MS`) took `rejoinBehindDistributionGroup`. It
   forgot the tree, re-read the distribution group, read the device memberships (`active`, so no
   Welcome is owed) and external-joined. That is the burst, across every key group the device
   holds.

Each re-join also moved every other member one epoch. The web never did any of this, because
`WebMlsService.getEpoch` reads WASM live. The cache also lagged every commit the replay applied
itself (`attemptCommitReplay` compares `getEpoch` with its target after each commit), and
the key-group frame route reads it to decide whether a gap is closed.

**The fix is the cache, at its source** (`TauriMlsService`):

- `syncGroupCachesFromNative` rebuilds the held groups AND their epochs from the native manager, at
  start-up and when the resume installs `mls.bin`. The file may be AHEAD of the live manager, and a
  stale-low epoch reads as "behind". It writes into the LIVE caches, never swaps them, because
  commits, joins and forgets keep landing while it awaits. Every reading and every forget takes a
  per-group stamp BEFORE its native call and is written only if nothing started later has been.
  So a sync reading never lowers a newer refresh, a group created or joined mid-sync keeps its
  entry (no false 0, no false gap), and a group forgotten mid-sync is not re-listed.
- Every native call that can move an epoch refreshes it before returning: a commit applied
  (`processIncomingMessage` answering null), a batch, a merge (now awaited), a create, a join, a
  Welcome.
- The queue's post-callback hook (`onMessageProcessed`) is deleted: it was the only refresher, and
  it ran too late.

A held group whose epoch cannot be read accuses at `error`, because `getEpoch` then answers 0 for
it. Pinned by `TauriMlsService.epochCache.test.ts`. On the old code its cold-start case answers
`replay-failed`, the exact verdict that armed the gap.

**The refused seal now says which fact was missing.** `distributionEpochFor` folded four
facts into one null and one sentence ("has no distribution group on this device"), which was false
for the case that fired. `readDistributionEpoch` keeps the reason
(`key-group-unregistered | not-held | unsettled | catching-up`), and `GraineSealUnavailableError`
carries it with `no-session` and `unknown-channel`. The seal logs it at `error`. Both send surfaces
(`sendChatMessage`, `toUiActionError`) show `sealUnavailableMessage(reason)`: one Paraglide sentence
per fact, in place of "Échec de l'envoi" or "pas encore prêt".

**Since 2026-10-13 a salon TEXT no longer reaches `unknown-channel`.** It waits for its salon to be
entered (`salonSendGate.ts`) and is sealed and signed only when released. It is never queued
unsealed. See [chat](../frontend/modules/chat.md#a-salon-not-yet-loaded-holds-the-send-it-does-not-refuse-it-2026-10-13).

**Old clients (1.0.3 to 1.1.2) carry the same cache and keep re-joining until they update.** No
server change can stop the loop without making it worse. The re-join FORGETS the tree before it
asks to join, so refusing a "redundant" external join would leave a device holding nothing for the
scope, which is worse than one extra epoch. Making the replay from 0 "succeed" would mean the server
answering a question the client did not ask. The churn ends as the store floor
(`minClientVersion`) reaches the release that carries this.

## 23. A seed answer goes only to the device that asked - FIXED 2026-10-12

Measured in the [production queue audit](../infrastructure/prod-queue-and-epoch-audit-2026-10-12.md)
(findings F1-F3): in the community created that morning, about 184 seed answers made up roughly 28 k
of the 35 k rows the key group queued and about 180 of its 194 MB. Every answer (`graineBundle`) was
sent with `DELIVERY.keyMaterial`, so it was queued for EVERY seat of the key group (about 100), and
every online device of the elected user answered it (finding G of the web console audit).

**What the broadcast was for.** Nothing in the protocol depends on a third party reading an answer.
The requester is the only device that named the sessions. The others got two side effects: a
member missing the same seed absorbed it for free, and a shut phone absorbed it through the push
mirror. The audit's finding B shows these absorptions are mostly seeds already held. Each one cost
a salon refetch until #1761.

### What changed on the wire

| Field | Where | Meaning |
|---|---|---|
| `recipientDevices: string[]` | `POST /api/mls/send` body | 1 to 16 `userId:deviceId` keys. The frame is queued only for those devices among the group's LIVE members (the same membership query as every send), and it is NEVER appended to the history stream. Refused (400) on a commit or a Welcome, on any group that is not a key-distribution group (a member could otherwise equivocate in a conversation), as an empty list, as more than 16 keys or as a malformed key. If the field is absent, the frame goes to the whole group, as before. |
| `answerer_device_ids` (field 6, repeated) | `GraineRequestMsg` | The devices of the elected answerer that answer: every one that is online and a leaf of the requester's tree, at most 16. If it is empty, every device answers (pre-1.2.5 requesters). |
| `onlineDevices: string[]` | social-service roster `?presence=1` | Each member's online device ids, sorted, from the same single SCAN as `online`. |

The answer is still a `graineBundle` sealed by the key group, still durable and silent. Only its
fan-out changed: `addressedKeyMaterial(requester)` in `frameHandler.ts`, where `requester` is the
request envelope's `sender:senderDeviceId`. The envelope device is self-asserted, but the server
delivers only to a live member's device, so naming a device can only narrow delivery, never widen
it. If the envelope carries no device, the answerer refuses at `error` and sends nothing. It does
not fall back to a broadcast.

### Who answers: every device that can, each to the requester alone

The election (`resolveAnswerer`, section 4.5 and WP-33) still picks a USER. `answeringDevicesOn`
then takes that user's online devices from the roster and intersects them with the LEAVES of this
device's copy of the key group's tree (`getGroupMemberIdentities`). The request names EVERY such
device, sorted, at most 16 (`answerer_device_ids`). A device that is online but not a leaf cannot
open the request, so it is never named. A member whose online devices are all non-leaves no longer
counts as reachable. On the answering user's devices, `answerSeedRequest` answers if the list is
empty or contains this device. Otherwise it says so at `debug` and stays silent.

**Why every device and not one (review of #1768).** The first version of this PR named only the
lowest device id. That was wrong twice:

- **D1.** `tauri-` sorts before `web-`, so the device it named was usually a backgrounded phone. Its
  socket stays open while its script does not run. A silent named device is a walk that never moves.
- **D2.** The other devices of that member stayed silent, though one of them could hold the session.
  A phone that joined last week does not hold what the laptop minted.

Naming every device keeps the cost bounded. Each answer still goes to the requesting device alone,
so one ask costs one addressed frame per named device (1-3 in practice), never one per seat.

**The FIRST decline from a named device strikes the member.** `askedRequest` records, per session,
the request id, the member asked and the devices named (`named`). A decline is checked against them:

- one that quotes another request, or comes from another member, is ignored (a replay, or an ask
  since superseded);
- one from a device that was not named is ignored at `debug`;
- a second decline from the same member changes nothing;
- the first accepted decline strikes the member and moves the walk to the next one.

A second iteration waited for EVERY named device to decline. The re-review refuted it (D-A): it
re-created the stall, because a named phone that stays silent held the walk and nothing woke it.

Striking early loses nothing. A device of the struck member that does hold the seed and answers
later still lands it: a bundle's seeds are stored whoever asked, and storing one ends the walk
(`forgetAskedSession`). The cost of a decline from a device that does not hold the seed, while
another device of the same member does, is ONE extra ask to the next member.

**Termination, without a clock.** Each accepted decline strikes one member off a finite roster, so
the walk ends on the seed arriving or on `exhausted`, which is logged. The walk stops only if every
named device of the elected member stays silent. That is the same residue as a silent elected
member before this change, and it takes ALL of that member's online leaves being frozen.

### The reason on every ask (F3)

`[GRAINE] asked <user> (<device,device... | every device>) for N seed(s) in community X at epoch E - reasons
unreadable-row=a,declined=b,holder-online=c,epoch-left=d, newest row A..B old, key group lost
<cause:n | none> this session`. `epoch` is this device's key-group epoch. The reasons say why each
seed was asked for: a row it could not read, a decline from the previous answerer, a holder that
came online, or a request held while the device left an epoch. The losses are key-group frames this
device could not open, counted by `noteKeyGroupFrameLost` (`keyGroupFrameLosses.ts`) per
classification (for example `past-epoch-application`). The history request line carries
`reason key-group-rejoined|no-seed-held` and the same loss count.

### Old clients (floor 1.0.3), side by side

| Case | What happens |
|---|---|
| New requester, old answerer | The old answerer ignores field 6 and answers to the whole group from every device, as it does today. |
| Old requester, new answerer | No device is named, so every device of the answerer answers, but each answer is addressed to the requester only. |
| Old client that is not the requester | It no longer receives other devices' answers. It skips that sender's generations, which OpenMLS derives forward (see the risks). |
| Old social-service (no `onlineDevices`) | No device is named and the ask warns once. Every device answers, each answer addressed. |
| Old chat-delivery (ignores `recipientDevices`) | The answer reaches the whole group and the history stream, as today. |

### How a returning member still gets its seeds

The durable key-group log replays the ORIGINAL distributions to it. Its own requests are answered
with a durable frame queued for its device even if it went offline in between. The history request
is unchanged. What it loses is only the chance of finding someone else's answer in its
queue.

### Expected effect, and how to read it

On a community in its first hours, about -80 % rows and -90 % bytes: each answer reaches 1 seat
instead of about 100. Bundles of 16 KB or more drop from about 42 copies per payload to 1 per
answering device. A member with 2-3 devices online still answers 2-3 times. Each of those answers is
one row, not one per seat, and that is the price of D1 and D2 above. To read it on prod: the
per-group copies-per-payload query of the audit, and the `[SEND][trace] ADDRESSED` lines in
chat-delivery (`ADDRESSED_NOBODY` warns when the device that asked is no longer a member).

### Risks, stated

- **Forward distance.** A non-recipient skips the addressed frame's generation. OpenMLS allows 2 000
  generations forward per sender per epoch. Transport frames (requests) already skip offline
  devices the same way. An answerer would need 2 000 consecutive addressed frames within ONE epoch
  for this to bite.
- **Frozen-online devices.** A backgrounded Android can keep its socket open without running. The
  walk waits only if EVERY named device of the member stays silent. One seed ends the walk, and one
  decline moves it on. It waits until a frozen device resumes and answers, or until the next start.
- **Early strike.** A device without the seed may decline while another device of the same member
  holds it. That costs one extra ask down the roster, and the holder's late answer still lands.
- **Refined reachability.** A member online only on a device that is not a leaf of this tree is not
  asked. Before, they were asked and could not have opened the request anyway.

### Not the cause: the drain order

The 2026-10-12 console export showed past-epoch frames (epochs 135-138 while the group was at 141).
`mlsPerGroupScheduler` was suspected of applying commits before queued application frames. It does
not: commits and application frames share one per-group FIFO, and its `control` tier holds only
the native `group_reset`. The frames were LIVE requests (339-469 B) sealed by other members' devices
3-6 epochs behind, so every up-to-date member found them unreadable, and each loss drives a re-ask.
The sender side is open in the [backlog](../backlog.md).

**The server names the lagging sender (2026-10-18).** chat-delivery reads every application frame's
clear epoch (`mlsFrameEpoch`) and, under the same locked group read as the write
(`enqueueForLiveGroup`), compares it with `activeEpoch`. A frame below `activeEpoch - 2`
(`isBeyondPastEpochWindow`, the client's `max_past_epochs`) logs `STALE_EPOCH_FRAME group=...
keyGroup=... frameEpoch=E activeEpoch=A behind=N sender=user:device app=<build> rows=R` at `warn`.
The build is the sender's KeyPackage `deviceAppVersion`, read by the query the fan-out already
makes. It is REPORTED, never refused: a `stale_epoch` refusal changes what every shipped client sees
on a send, and it waits for this line to say which builds lag. Commits and Welcomes are not checked.

## 24. A history ask answered "I hold nothing" is final for its roster (WP-HOLD-NOTHING, decided 2026-10-18)

**The defect.** A device holding no seed of a community asks ONE member for its past
(`requestCommunityHistory`, [WP-34](#wp-3435-and-the-rule-the-server-cannot-enforce)). An answerer
holding nothing answered by SILENCE (`answerSeedRequest` returned on an empty gathering), so the
requester had no answer to record and asked again at every launch. The Mi 9T did it for eight bench
communities per launch ([offline-and-weak-network section 15](../frontend/offline-and-weak-network.md#15-an-offline-cold-start-sends-nothing-it-knows-will-fail-2026-10-15)).
A durable "asked at epoch E" was rejected there and still is: it would strand a community whose
answerer missed the live request. What can be recorded is an ANSWER.

### What changed on the wire

`GraineBundleMsg.holds_nothing = 6` (bool). An answerer that may hand the past over (the community
is `shared`) and holds NO seed ROW of the community answers a HISTORY request with an empty bundle that
says so, echoing the `request_id`, addressed to the device that asked as key material like every
answer ([section 23](#23-a-seed-answer-goes-only-to-the-device-that-asked---fixed-2026-10-12)). The
`joined` refusal stayed silent (the requester knows the rule) until 2026-10-22; under `joined` the
ask is now answered, floored, and an empty hand whose rows all opened says "nothing" too
([WP-34/35](#the-floor-is-the-members-on-every-path-and-a-widening-reaches-the-members-already-in-2026-10-22)).
A SESSIONS request is unchanged.

**"Nothing" is a count of ROWS, never of what decrypted** (adversarial review of #2027). The seed read
skips a row the device key cannot open - a PIN change re-sealing the store, backup rows sealed under
another key - so an empty read is not an empty store, and claiming "nothing" from it would put a
durable record at the requester while the past sits on the answerer. The claim is made only when
`countGraineSessionsForWorkspace` (one `COUNT` on the clear `workspace_id` column, no key, both
stores) is 0, read after the seeds; rows present and none opened answer as before this section:
silence, with a warn naming the count.

### What the requester does with it

`noteHistoryHeldNothing` binds the answer to the ask in flight exactly as a session decline is bound
(`noteSeedUnavailable`): the same request id, the member it was addressed to, a device it named (or,
when it named none, a device of that member on the key group's tree). Anything else is ignored at
debug.

**The record is keyed on the answering DEVICE, never on its member or the roster** (re-review of
#2027, 2026-10-18). A request names only the member's devices ONLINE, so a member whose online phone
said "nothing" while a laptop of theirs sat on the key group offline has NOT answered: the laptop may
hold the past. A member counts as answered (`exhausted`) only once EVERY device of theirs on the key
group's MLS TREE (`getGroupMemberIdentities`, never presence) is recorded; the same rule holds for
our own other devices. Recorded durably (`utils/graine/historyAnswered.ts`, `localStorage` per
account, `canari_graine_history_held_nothing:v1:<userId>`) as `{groupId, epoch, devices[], final?}`
(`user:device`) against the key group and the distribution epoch the request was sealed at:

- **One launch walks the roster one member at a time**: one roster read and one sealed send per
  member, once per epoch. Once every device the request named has answered (or, when it named none,
  every tree device of the member), the next member is asked at once, from the answer itself. A
  device recorded already never moves the walk again, so a repeated answer cannot loop it.
- The election skips a member whose devices are all recorded (`exhausted`), and for now a member
  whose ONLINE devices are all recorded (`spent`) - only the unrecorded online devices are named.
- A member offline and never asked keeps the ask open (parked on presence, as before). A member
  `spent` but not `exhausted` (its other tree devices offline), or our own other devices offline,
  is filed against the epoch for the session and asked at the next start that sees such a device
  online - not parked, because the presence waiter watches USERS and that user is online (backlog,
  "Four things the offline cold start fix left open").
- **A roster member with NO leaf on a known tree** (never signed in, or no device on the key group)
  holds nothing sealed to it: skipped, never parked on, and counted as answered for FINAL. A leaf
  naming no device keeps its member on the tree (never `exhausted`, never leafless). An unreadable
  tree proves nothing about anyone, as below.
- **FINAL** = every other member `exhausted` or leafless, and our own other devices on the tree all
  recorded (or none exist). Read from the tree, so a device offline throughout is never final by omission. A
  tree that cannot be read proves nothing exhausted and never goes final. Marked durably, and a final
  record skips even the roster read on the next start - the tree cannot change without moving the
  epoch.
- **The epoch is the tree's version** - every membership change commits to the key group - so a
  moved tree replaces the record and asks again from the lowest member, with no clock anywhere.
  A re-join (`evenIfSeedsHeld`) and the community leaving the device forget the record. A request
  sealed with no ridable epoch is not recorded (said at info). Holding a seed already ends the ask.

**The device an answer names is VERIFIED whenever the envelope carries one** (since #2090).
`senderDeviceId` is what the sending client wrote in its request body, and on the distribution path
it is compared with the sealing credential's device like the user
([section 21.1](#211-the-verified-sender-measured-then-refused-wp-g2-1-g2-1b)): a frame naming another
device is refused before the seed handler sees it. The remaining bound is for the LEGACY row with
no device, where only the user is compared: a claim then counts only for a device the request named
(or on the tree when it named none), once - and the user IS verified, so it can only be a sibling of
the same account.

What it does NOT cover, said rather than guessed: a device that answered "nothing" and LATER gains
the past without the epoch moving. Two routes: another member of the roster, who is either still
unrecorded (and asked) or answered "nothing" too; and a **backup import** (`importBackup` ->
`importEncryptedGraineRow`), which restores seed rows onto a device already on the tree. The record
of that "nothing" lives at the REQUESTER, so forgetting anything on the importing device would not
reach it, and no frame tells the requester. Accepted, because the cost is bounded: the requester's
unreadable rows each still ask their session's sender (`noteMissingSeed`, the SESSIONS path,
which reads no "nothing" record), the next membership change moves the epoch and asks again, and a
new seed minted later reaches the requester directly and ends the ask.

**The account wipe owes the key, and takes it from the ONE list.** The key is built by
`ACCOUNT_KEY.historyHeldNothing` in `utils/accountLocalKeys.ts` (#2023, WP-DEL-LOCAL), and the
deletion's allowlist removes it whole: one key per account, written only by that account's device,
so the other members' ids it holds are that account's records and nothing of anyone else's. Nothing
in `historyAnswered.ts` is called by the wipe; its own clear and key export are deleted.

### Old clients, side by side (checked before writing, 2026-10-18)

| Case | What happens |
|---|---|
| Old requester, new answerer | The old reader (`absorbSeedBundle`, the same shape since `1.0.3` and in the floor `1.2.7`) decodes the bundle, skips the unknown field 6 (protobufjs skips unknown tags), loops over zero seeds and zero declines, announces no salon, and writes one `debug` line. No warn, no error. It keeps asking per launch, as today. |
| New requester, old answerer | Silence, as today; the ask stays open and the next start asks again. |
| Native push path (Rust `proto_fields`) | The bundle is classified `graine_key_material` with zero seeds, `ok: false` - silent, as a decline-only bundle already is. |

Tests: `frameHandler.test.ts` (the answer is sent and addressed; `joined` stays silent, an empty hand
included; rows the key cannot open stay silent; the new bytes
decoded by a schema WITHOUT field 6 are an empty bundle that changes nothing and logs nothing above
debug; a claim carrying seeds is ignored out loud), `repair.test.ts` (final across a restart; asked
again when the epoch moves, after a re-join, after a leave; a foreign id, member or device is
ignored; one member's "nothing" asks the next; final only once every device on the tree answered,
and then no roster read; a member whose online phone said "nothing" while a laptop of theirs on the
tree is offline is not answered, and the laptop is asked when online; not final while our own other
device is on the group and offline; a leafless roster member neither blocks final nor parks the ask,
a device-less leaf does; one device counted once), `graineStore.test.ts` and
`sqliteCountMessages.test.ts` (the row count includes rows the key cannot open), `historyAnswered.test.ts`
(per-device keying, a repeated answer is not new, version replacement, malformed records), `proto_fields.rs`
(`a_bundle_saying_it_holds_nothing_is_silent_key_material_with_no_seed`). **Owed:** one bench
reading - a cold start with every other member online, then a second start: the first shows one
`holds nothing ... at distribution epoch N - recorded, asking the next member` per member and then
`is final at distribution epoch N`; the second shows no `asked ... no-seed-held` for that community.

## 25. A member hands the past only to an admission it can verify (decided by the user 2026-10-22)

**The decision** (user, 2026-10-22, *"Garder Partagé par défaut"*): a community stays `shared` by
default - a newcomer reads what was written before they arrived - but a member's device hands that
past over only to a newcomer whose ADMISSION it can verify itself, from what it saw by itself,
never on the roster's word. Seeds keep rotating when a new user arrives (D5, the rotation work of
#2263, not this section).

**It holds once every client that answers runs it.** An answering device of an older version
hands the past to whoever the roster names, so the protection is complete only when
`minClientVersion` reaches the version that carries this section - an owed floor, in
[backlog](../backlog.md).

### Three ways to prove an admission were weighed

| Option | Verdict |
| --- | --- |
| A member-committed add (the admitter's device commits the newcomer into the key group) | Rejected: a link newcomer is admitted while no member is online, and the key group is entered by external commit for every device after the first (section 20). It would change the join path, not prove it. |
| An admin-signed roster | Rejected: one more signed object to keep current on every change, and a link admission happens with no admin present. |
| **A signed invitation - a voucher stored with the membership** | **Chosen.** Each real way in already passes through a member's device (the panel add, the link shown): that device signs, the voucher rides the membership row, and any member verifies it against what it recorded itself. |

### The join paths, and what each carries

| Path (`social-service`) | Who signs | Voucher |
| --- | --- | --- |
| Creating the community | nobody - the creator is a root | none needed |
| A member adds someone from the panel (`inviteToChannel`) | that member's device, at the add | `direct`, sent with the add |
| A newcomer follows an invite link (`acceptWorkspaceInvite`) | the device that SHOWED the link, at display; the newcomer redeems it | `link`, sent with the accept |
| A link shown by an old client, or copied without its `#` part | nobody | none: the newcomer joins, and reads from their arrival on (accepted by the user, 2026-10-23) |
| Any other way onto the roster | nobody | none: answered as `joined` |

**An old invite link keeps working for joining and gives no past until it is re-issued** - the cost
the user accepted (2026-10-23): old links are taken as they are. A link shown by this version carries its proof after the `#`; one shown before it
does not, and its newcomer reads from their arrival on until a member adds them again or they follow
a fresh link (a member already on the roster who follows a fresh link has the voucher written onto
their row). The `#` part reaches the join page on every surface: a browser keeps it, and the app
receives an App Link or Universal Link whole and navigates to it with its fragment
(`appLinkNavigation.test.ts`).

**Who may sign**: any admitted member's device. The product lets only members with the invite
permission add someone or show a link, but that permission is roster data: reading it would make a
voucher depend on the server's CURRENT word about its signer, and would add nothing against a member,
who - holding the past - could hand it over directly (section 7).

### The trust rule (`frontend/src/lib/utils/graine/admissionGate.ts`)

An answering device reads only what it holds itself - its ADMISSION LEDGER (roots and verified
admissions, per account) and its MLS layer (pins and departures):

- **Roots**, fixed at the first community sync after the proof existed (the roster reconciliation
  calls `observeAdmissionState`): the members who arrived before `ADMISSION_PROOF_SINCE` or created
  the community, AND have a leaf in the community's key group at that sync. A roster row with no
  leaf is never a root, and a root counts now only while the roster still shows the arrival it was
  rooted with. **The cut date is the day the production stable carrying the proof ships** (decided
  by the user, 2026-10-23): planned for 2026-10-27 UTC. If that stable moves, the constant moves
  with it, in one line, before the stable's final pre-release.
- **Verified admissions**: each voucher that held, at the place it was signed.
- **Observations**: for each voucher on the roster, where (the community key group's epoch) and
  when (this device's clock) this device first saw it. An observation is made only while the key
  group is DRAINED on this device (`isGroupDrained`): the last pull listed the whole mailbox, no pull
  is running, the socket is open, and nothing of the group is queued, parked or being applied.
  A commit still held in the mailbox, a removal included, is therefore never observed as not yet
  happened. A voucher that claims a place after the one this device first saw it at is refused.
- **The drain drives the observation** (`whenGroupDrained`, an event and not a poll: it is
  re-checked when the scheduler finishes a frame of the group and when a pull ends). A sync that
  found the group not drained - the start-up sync runs before the first full pull - observes again
  the moment it drains. An ask arrives ON the key group, so it is that group's current work and can
  never see it drained. An ask whose answer depends on a voucher not observed yet
  (`pastPolicyFor` -> `unobserved`) is therefore PARKED in memory (`parkedAsks.ts`): one per asking
  device, community and kind, at most 64 (shared with the asks that wait for an unknown history
  rule), the oldest dropped at warn. The drain that follows decides it again and answers then; a decision that has become a refusal is answered as one, with its log.
  **Consequence: the answer waits for the key group to catch up on the answering device.** A parked
  ask lost with the app is acceptable: the asking device asks again at its next start. A SESSIONS
  repair naming only seeds this device does not hold is answered at once (`missing` does not depend
  on the admission). A failed pull wakes nothing - only a pull that ends whole does - and says how
  many drain waiters it holds up. Sign-out forgets the parked asks (`clearParkedAsks`), and the MLS
  service's `destroy` rejects its pending drain waiters (`GroupDrainAbandonedError`).
- **Removals**: the epochs at which a commit this device merged - live or on catch-up - removed the
  user's last leaf from the key group (`removalEpochs`, [mls-protocol](mls-protocol.md)); a device
  repair is one commit (`replaceMember`) and records none. No removal seen means UNKNOWN, never
  proof that none happened.

**A signer's key has ONE trust source**: the key the community's key-group tree holds for that
device now, else the keys the MLS layer PINNED for it (`pinnedSignatureKeys`, the device-binding
pins, shared with every other caller that needs a device key it can stand behind); a signature that
verifies under any of them counts. Never a key the server publishes on its own: a signer device
that is neither in the tree nor pinned is unproven, and one that has since left the tree keeps
verifying under its pin. A pin re-learned after a prune (`anchored: false`) is weaker evidence, and a
signer verified only under one is unproven: the newcomer reads from arrival on. Every user id the
gate and the voucher compare - roster rows, leaves, subject, signer - is in the one canonical form of
`leafIdentity.ts` (`canonicalUserId`, Rust's `to_ascii_lowercase`), never a plain `toLowerCase`.

A voucher carries a PLACE its signer wrote: a key group and that group's epoch. The newcomer's
admission starts there, so a removal of the newcomer after it ends it. The SIGNER is judged
elsewhere: at the place where THIS device first observed the voucher (decided by the user,
2026-10-23). The device records, durably and per voucher, the community key group's epoch when it
first saw the voucher on the roster (`observed` in its ledger, written at every community sync and
every check). The voucher admits when its signer was admitted at that observed place - a root, or
admitted by an earlier voucher - with no removal of the signer in between. A member is admitted now
when some admission of theirs has no removal after it.

So:
- A voucher from a member of a former bureau still admits after they leave, provided this device saw
  it before they left.
- A voucher first observed after its signer's removal does not admit, whatever place it claims - a
  removed signer cannot backdate one.
- A removed member who comes back with the voucher they had is a newcomer without one.
- Places in two key groups cannot be ordered, and the reading that hands nothing over is taken.

**The cost, accepted by the user: a device that saw a voucher late grants less past, never more.**
A device that joined the community after the signer left, or whose ledger was lost, observes every
voucher anew, now. It then refuses the vouchers whose signer has since been removed: those newcomers
read from their arrival on when this device answers. Another device that saw the voucher in time
still hands them the past. The record holds only the vouchers on the current roster; one that leaves
the roster and comes back is observed again, later.

`pastPolicyFor(frame)` is THE gate, and both answer paths call it through ONE chokepoint,
`seedsTheAskerMayRead` - the HISTORY bundle (`gatherCommunityHistory`) and the SESSIONS repair
(`gatherNamedSessions`) - so the two cannot disagree about a member. It returns `joined` when the
community is set to it, or when the admission is not proven (`info`: a decision, not a loss), and
`unverifiable` when the roster or the tree cannot be read (`warn`: fail closed, answered by
SILENCE on both paths - a floored seed would be lasting at the requester, a passing failure must
not be). **Not proven is never refused whole**: the answer is the one a
`joined` community gives - nothing from before the asker's arrival, everything from it on, under the
same server-computed floor, on the history path too since the reconciliation with #2264
([the decision table](#the-floor-is-the-members-on-every-path-and-a-widening-reaches-the-members-already-in-2026-10-22)).
It returns `unobserved` when the admission is not proven only because a
voucher waits for the key group to drain; the answer path then parks the ask (above). It judges on
the COMMUNITY's key group (`communityKeyGroupOf`), whichever
group the ask arrived on: a private salon's own group holds that salon's members and its own
removals, and neither says who the community admitted.

### The wire

Every signed structure begins with its own length-prefixed label, as Graine v2's do: the label keeps
one signature from verifying as another, and its leading `0x00` keeps a device-key signature from
ever being an MLS `SignContent` (`mls-core/src/graine_signature.rs`). `lp` is a u32 big-endian length
then the bytes; `be64` a u64 big-endian integer.

```text
A = lp("canari-graine-admit-direct-v1") || lp(workspaceId) || lp(subject) || lp(signerUser) || lp(signerDevice) || lp(keyGroupId) || be64(epoch) || be64(issuedAt)
L = lp("canari-graine-admit-link-v1")   || lp(workspaceId) || lp(signerUser) || lp(signerDevice) || lp(keyGroupId) || be64(epoch) || lp(linkPublicKey) || be64(issuedAt) || be64(expiresAt)
R = lp("canari-graine-admit-redeem-v1") || lp(workspaceId) || lp(subject) || lp(linkPublicKey)
```

- **direct**: the adding member's device signs `A` with its MLS credential key
  (`signWithDeviceCredential`), placed at its key group's current epoch.
- **link**: the device showing the link mints a fresh Ed25519 pair, signs `L` with its credential
  key, and puts `L`'s fields, that signature and the link's SECRET in the fragment
  (`canari-graine-invite-v1`, base64url) - a browser never sends a fragment to a server. The join page
  takes it, drops it from the address at once, keeps it in the tab's session storage across a
  sign-in (never in `returnTo`), and the newcomer signs `R` with the secret. The voucher carries `L`'s
  fields and both signatures, and verifies with no secret. An admission through a link is placed
  where the link was signed, however late it is used.
- **A link's grant expires** (decided by the user, 2026-10-23). `expiresAt` is the invite link's own
  expiry, or 30 days after signing (`LINK_GRANT_DEFAULT_LIFETIME_MS`) when the link has none. It is
  signed into `L`, so no holder of the fragment can extend it. A member counts a link voucher only
  if it first observed that voucher no later than `expiresAt`. The only reference for an instant is
  this device's own clock: the key group's epochs order commits, not time. The clock is read once,
  at the first observation, and recorded with it. It bounds the link from above and decides nothing
  else. A device whose clock runs fast refuses a link early; one whose clock runs slow accepts it
  late.
- **The voucher** (`canari-graine-admission-v1`, base64url, at most 4096 characters) is stored in
  `channel_members."admissionVoucher"` (migration `107`) and served on the roster with `isCreator`.
  The server checks its alphabet and length and nothing else: it cannot verify it, and need not.

### What it does not do, stated

- A device key is pinned on first sight, and a tree admits devices the way MLS
  BasicCredential does (section 21): the proof is as strong as the tree. Device cross-signing is
  that work.
- A removal counts on the devices that merged its commit; a member that arrived later holds no
  record of it.
- A device that first syncs a community after the cut records its roots from the members present
  then.
- A member whose every device left the tree needs a fresh admission for the past.
- An invite link is a bearer proof until its grant expires: whoever holds the full link, `#` part
  included, can be admitted with the past. Share it as you would the community itself.
- A newcomer admitted by an older client, or through a link without its `#` part, reads from their
  arrival on until re-admitted.

### Order with the other drafts

This section merged after #2262 (salon scope); #2264 (visibility floors) was then rebuilt on top of
it (2026-10-23): `seedsTheAskerMayRead` calls `pastPolicyFor` after the rule check, so the gate
stays the ONE function both paths call, and the history path floors an unproven asker instead of
refusing them whole. The composed cases are the table in
[the floor is the member's](#the-floor-is-the-members-on-every-path-and-a-widening-reaches-the-members-already-in-2026-10-22).
#2263 (rotation on a new user) and #2255 (paging) touch neither the gate nor the voucher.

Tests: `graineAdmission.test.ts` (the leading `0x00`, round trips, every tampering: subject,
community, place, signer, forged link key, an extended expiry, malformed bytes),
`admissionGate.test.ts` (a removed signer's backdated voucher observed after the removal does not
admit; nothing is observed while a commit is held; a start-up sync observes once the first pull
drains the group; after a ledger loss the observation restarts and grants less; a link observed
after its expiry does not admit, one observed before does; a device the server publishes for a
rooted member is refused; a lost signer device keeps verifying under its pin; a roster row with no
leaf is never a root; the roots are fixed at the first sync; a removed member's old voucher no
longer admits, a fresh one does, a repaired device keeps its admission; a former bureau's voucher
observed before they left still admits, one signed after its signer's removal does not; any pinned
key verifies, but a pin re-learned after a prune does not prove a signer), `frameHandler.test.ts`
(both answer paths floor an unproven newcomer; direct, link and chained admissions hand the past;
copied, foreign or forged vouchers do not; a newcomer who asks at once is answered after the drain,
with no restart; a voucher whose signer was removed before the observation stays refused after it;
one parked ask per device, bounded; the creator is a root; an unreadable roster fails closed),
`BaseMlsService.groupDrained.test.ts` (the drained fact and its event), `rosterReconcile.test.ts`
(the sync feeds the ledger), `inviteFragment.test.ts`, `historyOverlayStack.test.ts` and
`appLinkNavigation.test.ts` (the fragment), `useChannelWorkspaces.svelte.test.ts`,
`channel.service.spec.ts` and `mls-device-guard.spec.ts`. **Owed on the rig** (proposed
COMM-26..31): a fresh link with its fragment gives the past, on the web and through the app's link
handler; an old link joins and reads from arrival; a member's add gives the past; a new device of a
rooted member gets the past; a kicked member re-added with their old voucher reads from arrival; the
`admission is not proven` line on the answerer for an unproven newcomer.

## 26. A shut phone joins a salon's key group from the push - DECIDED BY THE USER 2026-10-22

**The gap.** A member's seat in a key group is committed by an admitter's Welcome
([section 20](#20-whoever-admits-a-newcomer-welcomes-them---decided-by-the-user-2026-09-27)) or by
the member's own external commit when the app loads the community. A member nobody admitted (added
before section 20, or by a path with no online admitter) whose phone does not open the app got every
salon push as a blind banner: the push service said "not in the salon's key group" and stopped.
Asked whether the phone should join from the push, as it joins a DM from a Welcome, the user chose:
*"Oui, rejoindre au push"*. Section 20's admitter stays the first door; this is the one for a seat
nobody committed.

### What happens on Android

A salon push whose seed frame is refused and whose key group is ABSENT from this device
(`SeedFrameLadder`'s `onAbsent`) posts its generic banner as before, then queues
`joinKeyGroupFromPush` on the push service's single MLS lane:

| Step | Where | What it decides |
| --- | --- | --- |
| Claim | `mobile/key_group_join.rs` `claim` (`key_group_push_joins.json`, file-locked) | ONE attempt per group until the app starts. Written `attempting` before anything is fetched, so a crash mid-join is never retried from a push; capped at 64 entries. A `deferred` entry is claimed again with the base epoch its prepare failed on |
| Base | `POST /api/mls/push/key-group-base` (PushSecret) -> `readKeyGroupBaseForPush` | Key group only (403 otherwise); the same entitlement ask as `assertCommitterMayCommit` (403 not entitled, 503 unanswered); `welcomeOwed` when a Welcome is queued or the add lock is held (one door at a time); the scope; the base |
| Before the prepare | `KeyGroupPushJoin.beforePrepare` | A base at the epoch a previous prepare failed on is not prepared again (`deferred`, unchanged); a salon-scoped base must name the push's own salon (`scope-mismatch`) |
| Prepare | `prepare_key_group_join` under `MlsStateLock` | Refused in a WARM process (below); the client checks below; builds the external commit and STAGES `digest(mls.bin) + sealed post-join state` - nothing is installed. A refusal reached after the load or the build is `deferred` on that base, so a stuck base does not cost every salon push seconds of work |
| Commit | `POST /api/mls/push/key-group-join` (PushSecret) -> `submitKeyGroupJoinForPush` | Rate-limited per user like every other commit path, after the PushSecret is proven (`KEY_GROUP_PUSH_LIMIT_PER_MINUTE`, a 429 the phone settles `deferred` on that base, never `lost`); external commits into key groups only (400/403 otherwise), then `validateCommit` unchanged: entitlement, strict epoch, base republished |
| Install | `finish_key_group_join` -> `background_write_mls_bin_if_unchanged_and_cold` | Under the write lock: refused while the app is in the foreground or warm, refused if `mls.bin` changed since the prepare read it (a compare-and-swap, never a lost update). A state lock not taken is not an answer: the attempt stays `attempting` and the app discards the stage |
| Settle | `settle`; `KeyGroupPushJoin.kt` maps every answer | `joined` (with the server's scope), `refused` (the server ANSWERED, or the push was inconsistent), `lost` (accepted, not installed), `deferred` (failed on this base), `retryable` (no answer, an unreadable answer, 503, stale or missing base, Welcome owed) |

**No install lands under a foreground manager - cold or warm.** The login reads `mls.bin` through
`foreground_load_mls_bin`: it marks the foreground active and the process WARM, then reads under the
write lock, so an install either landed before the read (and the manager holds it) or sees a mark
and is refused. A warm process - an app backgrounded with its manager still in memory - refuses the
join outright, before the build: at its resume a manager holding a ratchet advance is persisted over
the file (`LiveAhead`), which would erase the install. The app's own load joins the group there.

Only the server answering is a refusal; a transport failure, a 503 or an unexpected status claims
nothing about membership. The app takes and clears the ledger at its next start
(`take_key_group_push_joins` -> `adoptKeyGroupPushJoins`, right after `hydrateDistributionGroups`,
and again after each resume reload): a `joined` group the loaded MLS state really holds is registered
(workspace scope, or a salon whose community this start already knows; otherwise noted as a key
group until its community loads) - never over a mapping the registry already holds; every other
entry is left to the community load, which joins the ordinary way.

The ledger is sealed at rest under the install's native cache key, and the staged state under the
device key; both leave with `mls.bin` at sign-out
([mobile](../frontend/mobile.md#the-native-caches-are-sealed-at-rest-and-kept-out-of-backups-2026-10-22)).

### What the client checks before committing

- the seed frame's clear MLS header names the group the push names (`frame-group-mismatch`);
- the base names that group too (`base-group-mismatch`) and sits at the epoch the server states
  (`epoch-mismatch`);
- the push's author holds a leaf in the base's tree (`sender-not-in-tree`);
- this device holds no leaf of the group already (`already-held`);
- a salon-scoped base names the salon the push is for (`scope-mismatch`). A community-scoped base
  cannot be compared here - the push carries no community id - and is left to the server's gate.

Entitlement itself is the server's gate, asked on both round trips: a phone that never loaded the
community has no roster of its own to compare with.

### What the triggering push shows

The generic banner already posted. Its frame was sealed before this device's join epoch, which a
joiner cannot open by construction. The join is a commit, a commit rotates every sender's session,
and [section 19](#19-design-the-seed-travels-with-the-message---decided-by-the-user-2026-09-27) puts
the new seed on the next message - so the NEXT salon push is readable. No new string.

### iOS

The notification service extension reads an App Group MIRROR of `mls.bin` and never writes the
app's state, so it cannot join. It logs that the app joins at its next foreground and shows the
generic localized banner; the app's community load joins the group.

### Owed

Compiled only by CI: the Kotlin service and the JNI entry points (Android), the Swift line (iOS).
Device readings: on the Mi 9T, a member whose phone never opened community X receives a salon push
for X - a generic banner, `joinKeyGroupFromPush: settled joined`, the next push readable, and the
app's next start logging `[KEY_GROUP_PUSH_JOIN] ... registered`; on the iPhone, the generic banner
and the join at the next foreground.
