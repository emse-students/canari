## P2 - a newcomer offline when its Welcome is delivered receives no join push, so no nickname set before it (found by the round-2 review of #3185, 2026-11-09) - designed, not built

**What is true after #3185.** The inviter's join push (`joinPush.ts`, `sendFullHistoryBundle`) is an
ADDRESSED history answer, and an addressed frame is transport-only: the server publishes it only to a
device whose every live session declared the capability, and refuses it otherwise
(`assertConversationAddressable`, `publishIfAddressable` in
`apps/chat-delivery-service/src/services/addressing.ts`; `addressed_unsupported`). It is never queued.
So a newcomer whose device is NOT connected when the Welcome is delivered - the usual case for a phone
in a pocket - gets no push: no nickname register, no pins, no floor, no read marks from it. The ledger
entry is written before the push starts and nothing retries. Since #3185 that outcome is no longer
swallowed: `sendFullHistoryBundle` returns `unaddressable` and `joinPush.ts` says
`[JOIN_PUSH] <group>... NOT DELIVERED to <user>:<device>` at warn, which is the count this entry is
measured by. The joiner's later reconciliation answers are `addOnly` (messages, nothing else), so they do
not repair it.

**Why the inviter does not retry.** A retry on the inviter's side ("push again when the device becomes
present") depends on two things neither side holds durably: the newcomer's `join` ask lives in memory
(`historyAddressing.ts`, opened by `noteJoinSolicited` when the Welcome is processed), so a reload of the
newcomer between processing and the retried push makes it refuse the push; and the inviter's own device
must come back while the newcomer is online. Neither terminates on a fact.

**The fix, decided by the lead (reversible, so taken under the owner's delegation): the newcomer ASKS.**

1. **Durable on the asker.** Processing a Welcome into a conversation group writes a per-account marker
   "register owed" for that group (`ACCOUNT_KEY`, beside `canari_nicknames:v1`), cleared by an accepted
   join push or by the answer below.
2. **Carried by the reconciliation it already runs.** While the marker is set, the device's probe for
   that group is the DIGEST (never the state key, whose match is answered by silence), with
   `register: true`; the ask is recorded with that flag (`noteHistoryAsk`).
3. **Answered by the elected responder on the existing path.** `answerHistoryDigest`, seeing
   `register: true`, sends one addressed state frame carrying the register (`bundleFrame` with the
   digest's `requestId`, no message), behind the same `historyWithheldAfterSettling` check, before the
   diff - the asker is online by construction (it just asked), so it is addressable.
4. **Taken under the same four limits.** The receiver merges `nicknames` from an addressed answer only
   when the ask it answers carried `register` (`takeAddressedAsk` returns it), with
   `mergeBundleNicknames`' limits unchanged (unverified, current members only, at most as many entries
   as members, dated within the bundle's server time), and clears the marker.

It terminates on facts: the marker is durable, the reconciliation runs on every connection and its
deferral already waits for a member to come back (`onPeersCameOnline`, `retryDeferredReconciliations`),
and the marker clears on the first accepted answer. An older responder ignores `register`; the asker
keeps the marker and asks again on the next connection, at the cost of a digest instead of a state key.

**Why it is not in #3185.** It changes the reconciliation's wire (a field on the digest and its answer),
adds a durable marker on the newcomer and a mixed-version behaviour; the MLS chat path deserves its own
pull request and its own adversarial review for that.

**What proves it, when built:** a newcomer offline at the delivery, then online - the digest carries
`register`, the responder's answer carries the register and no message, the newcomer takes it
"Defini avant votre arrivee" and clears the marker; a reload between the Welcome and the answer still
asks; an older responder leaves the marker set.

**The reading owed on a pre-release, which FAILS until this ships and must then pass:** reading 2 of
the nicknames row of the [verification table](../backlog.md#owed-a-verification-and-nothing-else) with the new
member's device NOT connected (the app killed, or the tab closed) when "Ajouter" is pressed, then
opened a minute later. Today the inviter's log reads `[JOIN_PUSH] <group>... NOT DELIVERED to
<account>:<device>` at warn and the new member shows no nickname; once built, the nickname reads
"Defini avant votre arrivee" after the newcomer's digest ask is answered. Mechanism: [chat](../frontend/modules/chat.md#per-conversation-nicknames-modifier-les-pseudos-2026-11-08), "The late joiner".
