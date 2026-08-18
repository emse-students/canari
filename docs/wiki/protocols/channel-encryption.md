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
- **WP-31** Send path: encrypt under the session, carry `sessionId`.
- **WP-32** Receive path: decrypt by `sessionId`; unknown session renders as explicitly unreadable.
- **WP-33** Request and answer a missing seed over the distribution group.
- **WP-34** The history bundle on join, in one message, gated by `history_visibility`.
- **WP-35** `history_visibility` per community: column, API, settings UI, i18n.

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

### Phase 5 - reactions

- **WP-40** Reactions become silent encrypted channel messages aggregated client-side; the
  `reactions` column and its endpoint are removed.

### Phase 6 - the server forgets how to read

- **WP-50** Delete `deriveEpochKey`, `buildChannelBootstrap`, `getChannelKeyBootstrapForUser`,
  `getChannelHistoryKeysForUser` and their routes. `STALE_CHANNEL_KEY_VERSION` goes with them - the
  server no longer knows which session is current and no longer needs to, which removes a coupling
  instead of moving it.
- **WP-51** Migration `038` (`037` was taken by WP-21's `distributionGroupId`):
  `channel_messages.senderSessionId` replaces `keyVersion`; `channels`
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
