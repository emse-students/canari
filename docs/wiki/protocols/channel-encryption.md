# Graine - channel encryption (WP-GRAINE)

> **Status 2026-08-18: PHASES 1-5 ARE IN (up to WP-40).** A salon message is sealed under a
> per-sender seed the server has never held; the push path derives its key the same way on all three
> native surfaces; a missing seed is asked for and answered; a joiner receives the history its
> community allows; and a reaction is an encrypted message rather than a cleartext tally. What is NOT
> done: the deletion of the server's own derivation - so `channels.masterSecret` still EXISTS,
> unused, until WP-50/51 - and the cut itself (WP-60..62). §1 describes what the old regime did while
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
row appears the moment its seed lands. **Do not add a placeholder to one of the two systems
without adding it to both**, and that is a product decision, not a protocol one.

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
   The rule generalises beyond Graine and is in [durable-rules](../durable-rules.md).
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

**An empty hand is answered, never met with silence (WP-63, 2026-08-18).** Determinism is what makes
the election safe and was also what made it a dead end: a member elected by the rule but not holding
the seed was elected again by every device and on every retry, and answering nothing left the session
unreadable for the whole app session. So `GraineBundleMsg.missing_session_ids` carries what the
answerer turned out **not** to hold, and the requester strikes them off and elects the next member -
`resolveAnswerer(..., tried)`. This is the rule against *learning by failing what a fact could have
told you*, applied on the wire: *"I hold none of these"*, *"I never saw your request"* and *"I am
offline"* are three different facts an empty wire cannot separate, and only the first one means ask
somebody else. **The walk terminates on a proof, not on a count or a clock**: each decline removes one
member from a finite roster, so it ends either on the seed arriving or on `resolveAnswerer` returning
`null`, which is logged as *no reachable holder* rather than left as a permanently blank salon. A
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
GATED.** `gatherCommunityHistory` refused the join-time bundle under `joined`, correctly and out
loud - and `gatherNamedSessions`, the WP-33 repair path, consulted nothing at all and handed the same
past back one session id at a time. That is not an exotic path: a newcomer renders a salon, meets
ciphertext it cannot open, and `noteMissingSeed` names those exact sessions. The setting was stored,
broadcast, narrowed fail-closed, enforced on one path and bypassed entirely on the other, so a
community that had chosen *"rien de plus ancien"* got the opposite. **Found on prod by COMM-12 on
2026-08-20, not by the repository**, and it is the twentieth defect of the campaign. The rule now
lives in `historyBoundary.ts` and both callers read it from there, which is what stops the two
readings drifting apart again.

**The boundary is a member's arrival, and it is unambiguous by construction.** `historyFloorFor`
reads `joinedAt` off the community roster - fresh every time, never cached, because a member removed
and invited back starts again LATER and a cached start is the earlier, more permissive one. A seed
minted before that instant is withheld, and that costs the member nothing they could otherwise have
read: every membership change commits to the distribution group and advances its epoch,
`graineRotationReason` rotates on any epoch it does not recognise (an ADD included, deliberately), so
no session ever spans an arrival.

**The one thing this comparison rests on that nothing else here does: a clock.** `joinedAt` is
server-stamped, `StoredGraineSession.createdAt` is stamped by the device that MINTED the session, and
there is no server-anchored mint time anywhere - the server never sees a seed. So the boundary is
sharp to within the minter's clock skew, in both directions: a clock running fast can leak seeds
minted in the skew window before an arrival, one running slow can withhold a seed the member was
entitled to. **Named rather than papered over, and deliberately not widened by a margin** - a fudge
factor would trade the privacy half for the functional half without saying so. The alternative that
would remove the clock is an epoch-anchored boundary, which needs a per-member "entered at epoch N"
record written by every device and silently wrong the once it is missed: exactly the durable marker
`distributionEpoch` exists to avoid. Revisit it only if a real skew is ever measured in the field.

**A withheld seed is absent from BOTH lists in the answer.** Reporting it as `missing` would be a lie
with a cost - `missing` means *"elect somebody else"*, and every other member applies the same rule,
so the requester would walk the whole roster to arrive at the answer it was handed first.

**And the requester applies the same rule before it asks.** It knows the community's setting (it was
broadcast) and its own arrival (one roster fetch), and each unreadable row carries a SERVER
timestamp - so the two sides of that comparison come from one clock. Without it a newcomer to a
closed community would spend one frame per pre-arrival session, on the whole group, at every start,
to be told what it already knew. `withheldFromUs` fails OPEN, unlike its counterpart: it is a
bandwidth decision, not the enforcement, and refusing to ask because a roster fetch failed would
strand seeds the member is entitled to.

**Broadcast, not just stored.** `workspace.updated` carries the new value to every member, because a
device still holding `shared` in memory would keep handing the past over after an admin had closed
it - until its next relaunch.

**Narrowed once, and fail-closed.** `narrowHistoryVisibility` is the only place a wire string becomes
one of the two values, so the sidebar and the seed layer cannot disagree about a community. A value
this client does not know, and a community whose rule this session never learned, both read as
`joined`: refusing costs a newcomer some history they were entitled to, guessing `shared` costs a
community the privacy it asked for, and those are not symmetrical. Both cases warn.

**The ask is derived state, twice over.** A joiner asks when it holds NO seed for the community -
read from the store, so it survives a reload a "done" flag would have lied about - and when it has
not already asked in this app session - in memory, so a restart is free to ask again, because the
answerer may simply have been offline. Neither is a clock. The ask sits in
`ensureCommunityDistributionGroup`, on BOTH its branches: entering the group is what makes asking
possible, and a device that joined while its answerer was offline must still ask on the next start.
It is best-effort and never fails the join.

**The answerer is the lowest OTHER member.** `resolveAnswerer` never names this user, and that fixed
a real hole in WP-33 as well: a session's sender can be another device of ours, so a repair could
address a request to the very device that was asking - a round trip that answers nothing.

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
any more - it would admit a device it controls. That is a strictly better position than before (it
buys nothing retroactive, and every commit is visible to the members in the group's log) but it is
not nothing, and no client currently WATCHES that log for an unexpected admission.

**`history_visibility` is a policy guarantee, never a cryptographic one.** Only a device holding a
seed can withhold it, so the rule is applied by the answering member. A modified client answers
anyway. This is inherent - the server holds no key and could not enforce it if it wanted to - and it
is written here so nobody later reads the setting as something it is not.

## 8. Retention: one window, and the seeds derived from it - SHIPPED 2026-08-19

A salon message used to live for ever, and the durable seed store was unbounded with it: the only
thing that ever dropped a seed was leaving the community (`forgetCommunityGraine`, WP-60), so a
device that stayed in an active community held every session ever minted for it.

**Messages expire after `CHANNEL_MESSAGE_RETENTION_DAYS` = 365** (`channel-retention.scheduler.ts`,
daily at 03:45), the user's decision of 2026-08-18. **Pinned messages are exempt**, which is not a
softening of the window: pinning is somebody deliberately saying this one outlives the scroll, and
deleting it silently at a year would destroy the one kind of message a human explicitly marked as
durable. Pinned sets are small and bounded per channel.

**The seeds are swept on the SAME window, and the window is asked for rather than copied.** The
obvious implementation gives the device its own one-year timer, and that is two windows meant to be
one - the shape that drifts. Instead:

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
  (`retentionDays`) so the client still holds no copy of it, and it is sent as DAYS rather than as
  a cutoff instant so both sides of the comparison stay on the device's own clock. A server
  answering `retentionDays <= 0` gets nothing swept: with no window every session looks old enough.
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
| `channel.typing` | who is writing there, live |
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
already has its row, and the write underneath is an upsert), and passes `redeliverMissed: false` for
the same reason the external-join path does: the device holds the group at the CURRENT epoch, so a
replay of what came before is a stream of frames it cannot decrypt.

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
