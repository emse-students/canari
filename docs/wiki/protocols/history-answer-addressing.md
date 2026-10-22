# Addressing a history answer to the device that asked - design (step A, 2026-10-22)

**Status: DESIGN ONLY, nothing is built. Revised after its opus review of 2026-10-22, whose verdict was
REVISE with the direction kept: address first, seal later, and do not skip A.** It is step A of the P1
"a new member of a group conversation receives its whole past". Step C is described, with the
decision and its numbers, in
[history-reconciliation](history-reconciliation.md#a-new-member-receives-nothing-from-before-their-arrival-decided-by-the-user-2026-10-21).

## The problem C leaves

A history answer is an MLS application message, so every member of the conversation receives it,
whoever it is meant for. Step C made the inviter's PUSH safe: its filter adds the invitee's own
withheld span, and every other member is entitled to a superset of that. The ANSWERS to a request
cannot do the same. The diff (`sendHistoryBundleForIds`) and the scrollback (`sendHistoryRangeBundle`)
answer one device, often a new device of a founding member, which is entitled to everything since
that member arrived. Filtered for that device, the broadcast hands a newcomer messages from before
the newcomer arrived. Filtered for the newcomer, it starves the founding member's new device. **No
single filter is right for every reader of a broadcast, so the answer must stop being a broadcast.**
Until it does, the residual of C stands: a newcomer can still read pre-arrival messages from broadcast
answers meant for others' new devices.

## What A protects against, and what it does not

**A protects against an HONEST server and an HONEST answerer, and against nothing else.** It stops
correct software from handing a newcomer what the newcomer was never meant to read. It is not a
confidentiality boundary:

- MLS encrypts an addressed answer for the whole group, so every member can decrypt it. A malicious
  server can deliver an addressed answer to the newcomer as easily as to its addressee.
- A malicious answerer can send the newcomer its plaintext history in any shape it likes. A member
  can always leak what it holds.

Making the answer unreadable to everyone but the asker is option B below, and it is the follow-up.

## The proposal

1. **The answer is addressed.** Both answer paths (the diff and the scrollback) send with
   `recipientDevices = [the asking device]` (`to`, already `userId:deviceId`). **The inviter's push
   stays a broadcast.** Nobody asked for it, so rule 5 could never accept it. It needs no address,
   because step C already filters it for the invitee, and every other member is entitled to a
   superset of what it carries.
2. **The answer is filtered for its ONE reader.** The windows are the asking person's own `withheld`
   ones (gaps plus the span before their arrival), and no longer the union of every member's. The
   union stays only for the quote rule, which is a real broadcast (a reply reaches every member).
3. **chat-delivery accepts an addressed frame on a conversation group**, where today it refuses one
   outright (`messaging.service.ts`, `REJECT addressed_not_key_group`). Rules 4 to 6 below are what
   make that safe.
4. **The server marks an addressed row.** `queued_message` gains `addressed boolean NOT NULL DEFAULT
   false`, and the delivery frame carries it. It is set whenever `readAddressedDevices` returned a
   set. An addressed frame never enters the shared history stream, which is already the rule on key
   groups.
5. **The receiver accepts an addressed frame only as the answer to its own question.** On a
   conversation group, a frame delivered with `addressed: true` is applied only if ALL of these hold.
   Otherwise it is not rendered and not stored, and it is logged at **error**
   (`[HISTORY_ADDRESSED] REFUSED`, naming the group, the sender's verified credential, the content
   kind and which clause failed). The ACK still happens, so the row does not loop.
   - **It is a `history_bundle`.** No other content may be addressed on a conversation.
   - **It is SOLICITED.** The request carries a fresh `requestId`, which the asker keeps in memory as
     outstanding for that conversation. The bundle must echo it. The id is consumed by the answer's
     last chunk, or dropped at the device's next connection, whichever comes first. That is state,
     never a clock: a restarted device has asked nothing, so it accepts nothing addressed.
   - **It is BOUNDED by the request.** A pull's bundle may carry only the ids the asker named, or ids
     inside the prefixes it named. A range bundle may carry only messages inside the window the
     request stated (`since`). Every message's timestamp must be at or before the moment the
     request was sent. A message outside these bounds is dropped and counted in the error line, while
     the rest of the bundle is applied.
   - **It may ADD messages and do NOTHING ELSE.** The broadcast path's metadata merges are barred to
     an addressed bundle, because each one lets a single peer rewrite state the asker already holds,
     invisibly to every other member:
     - deletion (`isDeleted`, applied today with no author check);
     - the conversation's `readWatermarks` and `historyFloor` (both max-merged);
     - pins (`mergePinEntries`);
     - reactions.

     Those converge through the broadcast frames that carry them. A later work package may admit a
     merge whose author is checked against the verified sender, but none is admitted now.

   On a key group the existing Graine rule is unchanged.
6. **The server refuses to address a device that predates rule 5.**
   - **The evidence is the device's published version.** A `key_package.deviceAppVersion` below the
     release carrying rule 5 is refused, and so is a NULL one: a device that never said what it runs
     is treated as the oldest. Addressing such a device on a conversation group is refused with a
     typed `400`. The answerer then does not answer that device: it says so in its log and sends no
     broadcast in place of the refused answer. The older device is served by older peers exactly as
     today, and it asks again at its next connection.
   - **The web multi-tab case.** On the web, one `deviceId` is shared by every tab of a browser
     profile, and only the tab leader (`tabLeader.ts`) holds the socket and decrypts. A tab left open
     on an old build can therefore remain leader while a reloaded tab publishes the new version, and
     the server would then address a device whose decrypting code predates rule 5. So the version
     rule 6 reads is the version of the code that DECRYPTS:
     - the leader reports its own build when its socket authenticates, and again when leadership
       changes hands;
     - the server takes the LOWER of that report and the key package's version;
     - a tab that finds a leader on an older build than its own does not wait for it. It asks the
       leader to reload over `canari-mls-tab`, and leadership passes once the reload completes.
   - **How long it lasts.** Rule 6 holds until `minClientVersion` passes the release carrying rule 5.
     That floor moves only once both stores serve the reader.

## Why the allowlist exists, and how far rules 4-6 keep it

**Equivocation.** On a conversation group, chat-delivery fans an application frame out to every
active device as ONE ciphertext, and that is why it allowlists addressing to key groups. Addressing
lets a sender show one frame to one device and keep it out of the shared stream, which is a split
view.

- **Visible messages: closed by rules 5 and 6.** An addressed frame that is not a solicited, bounded
  `history_bundle` is refused by every receiver that has rule 5. Rule 6 keeps addressed frames away
  from every receiver that lacks it.
- **History contents: narrowed, NOT closed.** A `history_bundle` carries messages as JSON (`id`,
  `senderId`, `content`, timestamps), restated by a peer and checked only for duplicate ids. A member
  can already put a forged message, attributed to anyone, into a bundle broadcast to everybody.
  Addressing adds TARGETING: a forgery could reach one device and nobody else. The solicitation and
  bounds of rule 5 shrink that to "the answerer the server elected, inside the window the asker
  stated, and only as messages the asker did not hold". Closing it requires binding each relayed
  message to its original sender, either through the original MLS ciphertext and its sender
  signature or through a per-message signature in the Graine v2 shape. That is out of scope here.

## The ratchet cost of addressing

A non-recipient never sees an addressed frame, so the sender's generation counter moves ahead of what
that member last decrypted. OpenMLS derives forward on the next frame it does see, up to the
configured `maximum_forward_distance` (2 000, `sender_ratchet_configuration` (2000, 2000)). The
`bundleFrame` docstring rejected addressing for exactly this reason. The numbers do not support that
fear for history: only CONSECUTIVE addressed frames from one sender in one epoch count, because any
broadcast frame in between resets the distance. A full push is one frame per 200 messages, so 2 000
consecutive frames would mean a single answer carrying 400 000 messages. Graine accepted the same
bound for its addressed answers
([channel-encryption §23](channel-encryption.md#23-a-seed-answer-goes-only-to-the-device-that-asked---fixed-2026-10-12)).
That docstring changes with this work package.

## Sealing to the asker (option B) is the follow-up, and its key is decided

Option B keeps the broadcast and makes it unreadable to everyone but the asker. It needs no server
trust and no allowlist change, and it closes what A leaves to an honest server.

**The key, decided by the review on 2026-10-22: a dedicated ephemeral X25519 key generated in
`mls-core`, carried inside the MLS-signed request.**

- **Generated in Rust.** On the web it reaches the page through WASM, and it is mirrored on Android
  and iOS. This removes the WebCrypto question entirely: the iOS app targets iOS 14.0, and WKWebView's
  `crypto.subtle` gained X25519 only much later.
- **Carried inside the MLS-signed request.** The asker's signature covers the key, so the server
  cannot swap it for one of its own.
- **Not the leaf encryption key.** That key rotates on every commit that touches the path, and its
  private half has no public API to open with outside MLS. Reusing an MLS key outside MLS would also
  need a review of its own.

The push is untouched by B, as it is by A: it is a broadcast that step C already made safe.

**B is an opus work package across three platforms, after A.** It covers the WASM export and its
native mirrors, and its rollout is a reader-first release pair. Once it ships, it can replace rules
3 to 6, and the allowlist then returns to key groups only.

## What A does not close

- Anything against a malicious server or a malicious answerer (above).
- The split view through history contents, narrowed by rule 5. It needs bound history, not
  addressing.
- Older clients keep pushing and broadcasting until `minClientVersion` passes the release carrying A.
- What a newcomer has already received cannot be taken back.
