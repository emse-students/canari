# Addressing a history answer to the device that asked - step A (2026-10-22)

**Status: BUILT (draft pull request), owed a rig reading.** It is step A of the P1 "a new member of a
group conversation receives its whole past". The decision, step C and its numbers are in
[history-reconciliation](history-reconciliation.md#a-new-member-receives-nothing-from-before-their-arrival-decided-by-the-user-2026-10-21).
The design was reviewed on 2026-10-22 (verdict REVISE, direction kept: address first, seal later).
Building it changed three of its rules, and each change is stated where the rule is, with why.

## Why answers are addressed

A history answer is an MLS application message, so every member of the conversation receives it,
whoever it is meant for. Step C filtered the inviter's PUSH for the invitee. The answers to a request
could not be filtered that way: the diff (`sendHistoryBundleForIds`) and the scrollback
(`sendHistoryRangeBundle`) answer one device, often a new device of a founding member, which is
entitled to everything since that member arrived, while another member of the same conversation
may be entitled to less. **No single filter fits every reader of a broadcast, so the answer is
addressed to the device that asked and filtered for that device alone.**

The push is addressed the same way (rule 1): `handleWelcomeRequest` also pushes to a new device of
a member of any age, and that push is filtered for its own reader like every other answer.

## The rules, as built

1. **Every history answer is addressed** - the diff, the scrollback AND the push.
   `sendBundleChunks` sends with `recipientDevices = [to]` (`addressedHistoryAnswer`), `to` being the
   asking device's `userId:deviceId`. *Changed from the review, which kept the push a broadcast -
   see above, for consistency.* An ask that carries no `requestId` (an older asker) is not answered when the server
   routes addressed answers: the asker could not accept the answer (rule 5), and the generation it
   costs would be skipped by every other member for nothing.
2. **The answer is filtered for its ONE reader** (`readerHistorySelection`). The windows are the
   reader's own `withheld` ones (gaps plus the span before their arrival), no longer the union of
   every member's. That has a second effect: a new device of a continuous member now restores the
   messages sent while ANOTHER member was out, which the union withheld from it (the cost
   [history-reconciliation](history-reconciliation.md#a-remove-holds-against-a-later-re-add---the-answering-peer-withholds-the-window-decided-by-the-user-2026-10-14)
   quantified).
   - **When the server does not name the reader** (`?for=` is answered only for a person with a
     device added since the caller arrived), the filter is the union of every member's gaps plus the
     ANSWERER's own `withheld` windows. That is a superset of the reader's windows, by the server's
     own rule: a reader it does not name has every device row older than the caller's arrival, so
     the reader arrived first and their before-arrival span is inside the caller's; and the reader's
     gaps are in the union. It costs the reader whatever the answerer was handed before its own
     arrival, which an honest answerer does not hold anyway. An answerer the server does not count
     sends nothing.
   - **A server that predates addressed answers** (the exclusions route answers no
     `addressedAnswers: true`) gets today's broadcast: the union, plus the invitee's span on a push.
     The behaviour of step C then stands, and it accuses once per session at error
     ([legacy-compatibility](../legacy-compatibility.md)).
3. **chat-delivery accepts an addressed frame on a conversation group** where it refused one
   outright, under two conditions (`assertConversationAddressable`):
   - the frame is TRANSPORT (`durable: false`). Every history answer is, so it reaches only devices
     online now and never enters the history stream;
   - **every addressed member device declared, on its live socket, that it applies rule 5** (rule 6).
   Otherwise `400 { error: 'addressed_unsupported', devices }`. Key groups are unchanged.
4. **The server marks an addressed row.** `queued_message.addressed` (migration `035`, which sets a
   `lock_timeout` so it fails rather than queue every send behind a long transaction), set when the
   send was addressed ON A CONVERSATION - the flag is what rule 5 and the gateway's edge filter (rule
   6) act on, and a key-group seed answer is held to neither. The live frame carries it
   (`chat:messages`, and the gateway forwards it), and so does the pull. It never enters the shared
   history stream (already the rule).
5. **The receiver accepts an addressed frame only as the answer to its own question**
   (`historyAddressing.ts`). On a conversation, a frame delivered `addressed` is applied only if all
   of these hold; otherwise it is not rendered and not stored, it is logged at **error**
   (`[HISTORY_ADDRESSED] REFUSED`, the group, the verified sender, the content kind, the clause), and
   it is ACKed so the row does not loop:
   - **It is a `history_bundle`.** No other content may be addressed on a conversation
     (`setupMessageHandler`, before any dispatch).
   - **It is SOLICITED.** Every ask (`history_digest`, `history_pull`, `history_range`) carries a fresh
     `requestId`, kept in memory with the bound it states; the answer echoes it. The push is
     solicited by the receiver's own admission: processing a Welcome for the group records a `join`
     ask. **An ask takes at most TWO answering devices** (`MAX_ANSWERERS_PER_ASK`): the rendezvous
     elects one responder, and a re-election over a stored probe can hand the same ask to one more,
     whose answer is held to the same bound and only adds - so it is taken, not refused. Each closes
     the ask for itself with its chunk marked `last`; once both have, the ask is gone, and a third
     device is refused at error, because nothing honest produces one. *Changed twice by the #2270
     reviews: the first build consumed the ask on the FIRST answerer and dropped the second one's
     content at error; the second let any number of answerers in.* **The answerer is the device MLS
     verified**: the decrypt compares the envelope's sending device with the credential and refuses
     a disagreement (`verifiedSender`), which it can do only when the envelope names one - so an
     addressed answer naming none is refused. chat-delivery has no device in its auth context (the
     token names a user), and binds the claim the only way it can: the route requires the caller as
     sender with a device, and refuses a device that is not an active member of the group for that
     authenticated user. When a last chunk was entirely withheld, no frame
     carries `last` and the ask stays open until newer asks push it out. A page
     reloaded between its ask and the answer refuses the answer, and the comparison runs again on
     the next connection. *Changed from the review, which
     dropped open asks "at the next connection": a Welcome processed in the drain of a connection
     races that edge. The open asks are instead a bounded FIFO, 32 per conversation - state, never a
     clock, and a restarted page has asked nothing.*
   - **It is BOUNDED by the ask.** A pull's answer may carry only the ids it named, or ids inside
     the slices it named; a range answer only messages inside `[since, before)`; a digest answer
     only messages from `since` on; and every message no later than the ask plus the one-hour skew
     margin. A message outside is dropped and counted in the error line; the rest is applied.
   - **It may ADD messages and do nothing else.** A message the receiver already holds is not
     touched (no deletion, reaction, edit or tombstone merge), and the conversation's read
     watermarks, history floor and pins are not merged. The one exception is the `join` push: a
     device that was just admitted holds none of that state, and the push is how it gets the floor,
     the watermarks and the pins. A newly added message keeps the state it arrived with.
   On a key group the existing Graine rule is unchanged.
6. **The server refuses to address a device that does not apply rule 5.** *Changed from the review,
   which compared `key_package.deviceAppVersion` against a release and had a leader tab report its
   build.* The evidence is a CAPABILITY declared by the code that decrypts: the client opens its
   socket with `caps=addressed-history-1` (`gatewaySocketUrl`, the one builder both socket openers
   use). Since rule 3 makes an addressed conversation frame transport-only, its addressee is online
   by construction, and the live sessions are exactly the code that will read it.

   **The declaration is a CROSS-PROCESS fact** (`apps/chat-gateway/src/addressing.rs`). *Changed
   from the #2270 review: the first build aggregated the sessions inside one gateway process, so in a
   deploy overlap an old-build tab on one gateway and a new tab on another wrote competing presence
   values, and the device looked addressable.* Every write is one Lua script, validated before its
   first write so a failing one leaves nothing, and tested against the production Redis in CI
   (`redis_it`):
   - **one field per session** in the hash `addressing:sessions:{userId}:{deviceId}` (outside `user:*`,
     which the presence scans match), field `{process}:{connection}`, value the capability or `-`,
     written WITH its expiry in one command (`HSETEX`, the presence TTL), refreshed by its own session
     only. The expiry decides LIVENESS - how long a crashed process's field lingers - never safety:
     a lingering `-` only keeps the device unaddressable, a lingering declared field changes nothing;
   - **a retired session is recorded as LEFT** (`addressing:left:{userId}:{deviceId}`, for one TTL)
     before its field is removed. A field name is never reused, so it is the session's generation
     token: a refresh in flight when its session left writes nothing, and never resurrects it;
   - **the presence value `sessions-1`**, never written over an existing `true`. A gateway that
     predates this writes `true` and records no field, and a current one neither overwrites nor
     deletes that `true`, so it lasts exactly as long as the older gateway's session refreshes it -
     the only trace of a session whose declaration nobody can read;
   - **the presence goes with the LAST field**, asked of the shared hash inside the leave script:
     a session on another process keeps the device online, and a leave in flight cannot delete a
     presence that a later session wrote.

   chat-delivery addresses a device only when its presence value is `sessions-1` AND every field of
   its hash is the capability: ANY undeclared session of the device, on any process, refuses it. So:
   - a tab still open on an older build holds a session without the capability, and the device is
     refused while it does - no release number, no tab-reload protocol;
   - the native background paths never read an addressed frame: they skip every silent frame
     (Android `handleMlsFrame`, the iOS NSE), and nothing native drains the queue.

   **The check and the PUBLISH are one script** (`ADDRESSABLE_PUBLISH_LUA`, `addressing.ts`). The
   sender's check runs before the rows are written; the publish re-asks the same question in the
   same atomic step, so no session registered in between receives the frame. Refused there, the row
   stays queued and the refusal is logged at **error** (`ADDRESSED row NOT published`). *Added from
   the #2270 re-review.*

   **The PULL withholds it too.** The pending fetch carries the same `caps` the socket does, and a
   fetch that does not declare the capability is served no addressed row - filtered in the query,
   so the page and its cursor are untouched and the row waits for a session that can read it
   (`WITHHELD ... addressed row(s)`, info, once per change of that device's count). *Added from the #2270
   re-review: the queue pull is filtered like the realtime path.*

   **The gateway also filters at its EDGE** (`addressed_recipients`): the pub/sub loop hands an
   addressed frame only to the local sessions that declared the capability, and logs every one it
   withholds at **error** (`[PubSub] ADDRESSED frame NOT delivered`).

   The answerer then does not answer that device (`[HISTORY_BUNDLE] ... cannot be addressed`), and
   sends no broadcast in its place. The older device is served by older peers exactly as before.

## Why addressing was limited to key groups, and what rules 3-6 add

On a conversation, chat-delivery fans an application frame out to every device as ONE ciphertext,
so every member sees the same frames; that is why addressing was allowlisted to key groups. Rules 5
and 6 keep that property for everything a conversation shows: an addressed frame that is not a
solicited, bounded `history_bundle` is refused by every receiver that declares the capability, and
rule 6 addresses no receiver that does not.

## The ratchet cost of addressing

A non-recipient never sees an addressed frame, so the sender's generation moves ahead of what that
member last decrypted. OpenMLS derives forward on the next frame it does see, up to
`maximum_forward_distance` (2 000, `sender_ratchet_config` (2000, 2000)). Only CONSECUTIVE addressed
frames from one sender in one epoch count, because any frame the member does receive resets the
distance. A chunk is 200 messages, so 2 000 consecutive frames would be one answer of 400 000
messages. Graine accepted the same bound
([channel-encryption §23](channel-encryption.md#23-a-seed-answer-goes-only-to-the-device-that-asked---fixed-2026-10-12)).
The durable rule that forbade addressing an application message is narrowed accordingly
([durable-rules](../durable-rules.md)).

## Next step

Option B (sealing the answer to the asker) is the next step; see the [backlog](../backlog.md).

## Decided: a quote of an earlier message

**A reply quoting a message from before a member's arrival SHOWS that member the quoted text -
decided by the user, 2026-10-22.** The quote rule stays a broadcast that reads the union of gaps
only. Extending it to every before-arrival span would blank every quote older than the newest
member, for everybody, and that cost was declined. Nothing is built for it.

## What proves it

- chat-delivery: `messaging.durability.spec.ts`, `on a conversation group` - a non-addressed device
  of the group gets no queued row and no publish; a durable or incapable addressee is refused; the
  row and the live frame carry `addressed`.
- chat-delivery: the same block - one undeclared session field, an older gateway's `true`, or no
  field at all refuses the device; the publish re-checks atomically; a key-group answer is never
  marked. `addressing.redis.spec.ts` runs the check-and-publish script against a real Redis (CI:
  `boot-nest-apps`, refused if skipped). `messaging.pending-page.spec.ts` - a fetch that does not
  declare the capability is served no addressed row. `migrations.lock-timeout.spec.ts` - 035 sets
  its `lock_timeout` before it alters the table.
- gateway: `addressing.rs` - the edge filter, the field naming; `redis_it` runs both presence
  scripts against a real Redis (CI: `test-rust`, failing rather than skipping when unset): the
  expiry, an older gateway's `true`, the presence going with the last session on any process, no
  resurrection after a leave, nothing written by a refused call, concurrent sessions.
- client: `frameDelivery.socketUrl.test.ts` - both socket openers declare the capability through
  `gatewaySocketUrl`; `mlsDeliveryApi.pending.test.ts` - so does every page of the pull;
  `historyAddressing.test.ts` - at most two answerers per ask.
- client: `historyAddressing.test.ts` (the open asks, the bounds, every ask carries an id),
  `systemMessageHandler.bundleAddressing.test.ts` (rule 5 on receipt),
  `setupMessageHandler.addressedGate.test.ts` (only a history answer may be addressed),
  `groupActions.historyEntitlement.test.ts` (rules 1-2, the legacy broadcast, an unroutable device),
  `mlsDeliveryApi.addressed.test.ts` (the typed refusal, the server flag).
- **Owed on the rig: GRP-ADDR-1** - three devices: member A's NEW device asks, newcomer C (added after
  messages M1..Mn) is online; C must log no `[HISTORY_BUNDLE] ... received` for A's answer and hold
  nothing before its arrival, while A's new device restores M1..Mn
  ([cross-client-testing](../cross-client-testing.md)).
