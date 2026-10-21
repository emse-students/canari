# Addressing a history answer to the device that asked - design (step A, 2026-10-22)

**Status: DESIGN ONLY, nothing is built.** Master's verdict of 2026-10-22: this page gets an opus
review BEFORE any code. It is step A of the P1 "a new member of a group conversation receives its
whole past". Step C is described, with the decision and its numbers, in
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

## The proposal

1. **The answer is addressed.** All three answer paths send with
   `recipientDevices = [the asking device]` (`to`, already `userId:deviceId`). The push keeps its
   addressee, the invitee, too.
2. **The answer is filtered for its ONE reader.** The windows are the asking person's own `withheld`
   ones (gaps plus the span before their arrival), and no longer the union of every member's. The
   union stays only for the quote rule, which is a real broadcast (a reply reaches every member).
3. **chat-delivery accepts an addressed frame on a conversation group**, where today it refuses one
   outright (`messaging.service.ts`, `REJECT addressed_not_key_group`). Rules 4 and 5 below are what
   make that safe.
4. **The server marks an addressed row.** `queued_message` gains `addressed boolean NOT NULL DEFAULT
   false`, and the delivery frame carries it. It is set whenever `readAddressedDevices` returned a
   set. An addressed frame never enters the shared history stream, which is already the rule on key
   groups.
5. **The receiver refuses an addressed frame that is not a history control.** On a conversation
   group, a frame delivered with `addressed: true` whose decoded content is anything other than a
   `history_bundle` system frame is NOT rendered, NOT stored and NOT acknowledged as content. It is
   logged at **error**, naming the group, the sender's verified credential and the content kind
   (`[HISTORY_ADDRESSED] REFUSED`). The ACK still happens, so the row does not loop. On a key group
   the existing Graine rule is unchanged.
6. **The server refuses to address a device that predates rule 5.** The device's published
   `key_package.deviceAppVersion` is the evidence. Addressing such a device on a conversation group
   is refused with a typed `400`, and the answerer does not answer that device. It says so in its log
   and sends no broadcast in place of the refused answer. The older device is served by older peers
   exactly as today, and it asks again at its next connection. This holds until `minClientVersion`
   passes the release carrying rule 5.

## The threat it opens, and how far rules 4-6 close it

**Equivocation.** Today, on a conversation group, every application frame reaches every active device
as ONE ciphertext. That is why chat-delivery allowlists addressing to key groups: on a conversation,
`recipientDevices` would let a member (a modified client) show message X to Alice and message Y to
Bob, and keep both out of the shared stream - a split view that the ordinary fan-out makes
impossible.

- **Visible messages: closed by rules 4-6.** An addressed user message is refused by every receiver
  that has rule 5, and rule 6 keeps addressed frames away from every receiver that does not.
- **History contents: NOT closed, and this is the residual to accept or refuse.** A `history_bundle`
  carries messages as JSON (`id`, `senderId`, `content`, timestamps), restated by a peer and checked
  only for duplicate ids. A member can already put a forged message, attributed to anyone, into a
  bundle broadcast to everybody. What addressing adds is TARGETING: such a forgery could reach one
  device and nobody else, so no other member could notice it. History has always trusted the peer
  that answers. Addressing turns "a peer can lie to everyone" into "a peer can lie to one device".
  Closing it means binding each relayed message to its original sender. That would be the original
  MLS ciphertext and its sender signature, which a peer cannot re-encrypt, or a per-message signature
  in the Graine v2 shape. It is out of scope here and named so that the review can weigh it.
- **Server trust is unchanged.** Addressing is a ROUTING control. MLS encrypts for the whole group, so
  a malicious server could hand an addressed answer to any member. The server can already admit a
  device it controls, so this adds no power it lacks.

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

## Why sealing to a key (option B) is deferred, not rejected

Option B keeps the broadcast and makes it unreadable to everyone but the asker. The answerer seals
the bundle payload to a key only the asking device holds. It needs no server trust and no allowlist
change, and it closes the routing residual. Two shapes were considered:

| Shape | What it needs | Why not first |
| --- | --- | --- |
| **B1: an ephemeral X25519 key in the request**, sealed with WebCrypto ECDH + HKDF + AES-GCM | X25519 in `crypto.subtle` on every engine | No code here uses X25519 today. The iOS app targets iOS 14.0 (`IPHONEOS_DEPLOYMENT_TARGET`), and WKWebView's WebCrypto follows the OS: X25519 reached WebKit only in a much later release (to be verified on the bench iPhone before relying on any version number). The inviter's push has no request to carry the key, either. |
| **B2: HPKE in `mls-core`** (Rust, openmls's crypto provider already implements it), sealed to the asker's LEAF encryption key from the ratchet tree, or to the invitee's KeyPackage init key for the push | A new WASM export and its native mirror (Android, iOS), plus a domain-separated HPKE `info` label so the leaf key's use outside MLS cannot collide with MLS's own | The stronger design, and the one that also closes the routing residual. It is a protocol change on three platforms, so it costs a reader-first release pair. It reuses an MLS key outside MLS, which needs its own review. |

**The recommendation is A now and B2 next**, because A closes the user-visible leak in one release
with machinery that already exists (Graine §23). B2 can later replace rules 3-6 entirely, and the
allowlist then returns to key groups only.

## What A does not close

- The split view through history contents (above). It needs bound history, not addressing.
- Older clients keep pushing and broadcasting until `minClientVersion` passes the release carrying A.
  That floor moves only once both stores serve the reader.
- What a newcomer has already received cannot be taken back.

## Questions for the review

1. Is rule 6 (refusing by `deviceAppVersion`) sound evidence, or should the server refuse addressing
   on a conversation until `minClientVersion` alone covers rule 5?
2. Is the split-view residual acceptable for A, given that bundles already allow forgery to everyone?
3. B2's key reuse: is HPKE to the leaf encryption key with a distinct `info` label acceptable, or must
   the asker publish a dedicated key?
