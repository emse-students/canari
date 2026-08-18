# Graine - channel encryption (WP-GRAINE)

> **Status: DESIGNED AND DECIDED 2026-08-17, NOT ONE LINE WRITTEN.** The shipped behaviour is still
> the one under "What is there today", and it lets the server read every community message. When
> Graine ships, that section becomes history and this page becomes the reference.

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
| Push | `notifyChannelRecipients` inlines the CIPHERTEXT in the FCM payload under 3 KB and the device decrypts natively; over that it degrades to "new message in #channel". It never composes from the text |
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
`CallService` derives the WebRTC media key with label `mls-webrtc-media`, which is exactly DAVE's
shape. But an exported secret is DERIVED FROM group state: using it requires being in the group, at
the right epoch, having processed every commit - and a newcomer could never read the past, because
they were not there at those epochs. It answers a different question.

**MLS keeps a job here, and it is the right one:** carrying the seeds. See §5.

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

A message key is `HKDF(seed, "canari-graine-v1", index)`, ratcheted per message so a key recovered
from one message does not open the next inside the same session.

### 4.2 Rotation does not delete anything

**Rotating a seed means the sender stops using it for NEW messages.** The old seed keeps decrypting
old messages, for ever, for everyone holding it - which is why the history bundle (§4.4) carries
every seed and not just the last. Rotation bounds the blast radius of one recovered seed; it is not
forgetting.

| Trigger | What it buys |
|---|---|
| **A member leaves** | The only structural one. The leaver keeps what they could already read and gets **nothing said after they left**. Without it, leaving a community would change nothing |
| **100 messages** | Slices a talkative sender, so one recovered seed does not yield years |
| **7 days** | The same for a rare sender, whom a message counter would never slice |

The last two cost only their bytes in the bundle. Values are Matrix's, which are field-proven.

### 4.3 The transport: one MLS distribution group per community

Two facts, both checked 2026-08-17, rule out the alternatives: `mls-wasm` exposes **no HPKE**
seal/open, and a 1:1 MLS group **is a visible DM** (`dm_groups` has `isGroup` and no system flag),
so pairwise sealing would put 300 conversations in the sidebar and cost O(N) sends per rotation.

**Each community has exactly ONE MLS group containing every member's devices, carrying key material
only and never a message body.** A seed is distributed as a single MLS application message to that
group: **O(1) traffic per session, not O(N)** - which is the constraint that killed pairwise.

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

`history_visibility` is per community, **`shared` by default** (a newcomer receives the past),
`joined` available for a sensitive salon. Two consequences to carry deliberately:

- With `shared`, a leaked link grants the past again - which makes the invite fixes (one live link,
  expirable, capped) structural rather than hygiene.
- The past is as available as the least careful member. **"Read the past" and "the past's keys
  disappear" cannot both be true**, in any protocol. This is the user's decision of 2026-08-17,
  recorded so it is not rediscovered as a flaw.

### 4.5 A missing seed is requested, and said out loud

A receiver meeting an unknown `sessionId` requests it over the distribution group. While it is
missing the message renders as **explicitly unreadable with a key on the way** - never as absent.
An empty channel and an unreadable channel are different facts, and showing the second as the first
is the silence this repository keeps banning.

A request names WHO must answer, so that N members do not all answer at once and no election is
needed: **the session's own sender always holds its seed**, so the request is addressed to them. If
they have left the community, it is addressed to the current member with the lowest user id. Both
rules are deterministic, need no clock and no coordination, and leave nothing for a race to decide.

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
| `metadata.poll.votesByUser` | who voted for which **opaque** id | Already correct, see §4.7 |

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

### 4.10 Seeds must become durable, which they are not today

`ChannelKeyVault` is **in memory only**, and that is currently sound: the server re-serves every
epoch key on load, so losing the vault costs nothing. **After Graine the server has nothing to
re-serve**, so a lost seed is history a member can only get back by asking a peer.

Seeds therefore move into `IStorage` (IndexedDB on web, SQLite on mobile), encrypted with the device
key like messages and outbox entries, and into the backup export/import path beside them. Channel
MESSAGES stay unpersisted - `useMessaging` deliberately skips the DB for a `channel_` conversation
because channels are server-authoritative - so this adds a store, it does not change that decision.

## 5. Migration: a clean cut

Existing ciphertext is under server-derivable keys, so it cannot be carried over without carrying
the flaw. **Decided by the user 2026-08-17: at cutover every community and all its content are
deleted.** That removes the legacy read path, the dual-version window and any re-encryption pass in
one stroke - and it is the only option consistent with "no message readable by the server", since
leaving the old history in place would contradict the requirement outright.

`channel_messages` has **no retention at all** - no cron in social-service touches it - so nothing
would age this history out on its own. The cut is the only thing that removes it.

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

### Phase 2 - Graine foundations (pure additions, nothing switched on)

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

### Phase 3 - the distribution group

- **WP-20** `dm_groups` gains a community-distribution kind, hidden from every conversation surface.
  The risk is the ENUMERATION, not the flag: every path that lists, counts, badges, notifies or
  syncs a group must be found and audited, not just the sidebar.
- **WP-21** Server: the group is created with the community, published through `mls_group_info` for
  external join, and its membership tracks `channel_members`.
- **WP-22** Client: external-join on first use, ignore the group in the conversation pipeline, route
  its messages to the Graine handler.

### Phase 4 - send, receive, repair

- **WP-30** Outbound session manager: create per (channel, sender), rotate on departure / 100
  messages / 7 days, persist through WP-13.
- **WP-31** Send path: encrypt under the session, carry `sessionId`.
- **WP-32** Receive path: decrypt by `sessionId`; unknown session renders as explicitly unreadable.
- **WP-33** Request and answer a missing seed over the distribution group.
- **WP-34** The history bundle on join, in one message, gated by `history_visibility`.
- **WP-35** `history_visibility` per community: column, API, settings UI, i18n.

### Phase 5 - reactions

- **WP-40** Reactions become silent encrypted channel messages aggregated client-side; the
  `reactions` column and its endpoint are removed.

### Phase 6 - the server forgets how to read

- **WP-50** Delete `deriveEpochKey`, `buildChannelBootstrap`, `getChannelKeyBootstrapForUser`,
  `getChannelHistoryKeysForUser` and their routes. `STALE_CHANNEL_KEY_VERSION` goes with them - the
  server no longer knows which session is current and no longer needs to, which removes a coupling
  instead of moving it.
- **WP-51** Migration `037`: `channel_messages.senderSessionId` replaces `keyVersion`; `channels`
  drops `masterSecret` and `keyVersion`; `channel_members` drops the legacy `keys` jsonb.
- **WP-52** Push payload carries `sessionId`; everything else about the notification path is
  unchanged, and that is asserted rather than assumed.

### Phase 7 - the cut and the record

- **WP-60** Announce, then delete every community and all its content.
- **WP-61** Rewrite what described the old model: the channel section of
  [social-service](../services/social-service.md), the transport table in
  [cross-client-campaign](../cross-client-campaign.md), the schema row in
  [architecture](../architecture.md), the channel routes in [api-surface](api-surface.md).
- **WP-62** Campaign rows for what this creates: a joiner reads the past under `shared` and nothing
  under `joined`; an unknown session is requested and repaired; a departure forces a new session on
  the next send; a notification still decrypts on the phone; a reaction produces no push.

## 7. Open, and not blocking

**Retention on `channel_messages`** - there is none, and a salon message lives for ever. Either
channels get a window (ninety days, matching conversations, is the obvious candidate) or they are
declared permanent and the growth is measured. The current state - no policy, no measurement, no
statement - is the only unacceptable one. Nothing above is blocked by the answer.
