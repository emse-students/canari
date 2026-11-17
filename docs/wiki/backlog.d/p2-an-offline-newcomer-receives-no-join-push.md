## P2 - a newcomer offline when its Welcome is delivered receives no join push, so no nickname set before it (found by the round-2 review of #3185, 2026-11-09) - built (draft pull request, 2026-11-17)

target: 1.7.0

**Status: BUILT in a draft pull request stacked on option B (#3775), retargeted to `1.7.0` by the
owner's "everything before the stable" (2026-11-17).** The mechanism as built, which tightened the
design below in three places, is in
[history-answer-addressing](../protocols/history-answer-addressing.md#the-newcomer-asks-for-its-register-2026-11-17):

- the register travels SEALED, its flag inside the sealed content and never in the clear routing;
- the join push carries no message any more;
- the fresh-join reconciliation runs at every processed Welcome. It was dead in the ordinary case.

Left: the adversarial review, the merge, and the reading below.

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

**A second way to land here (since the join push reads the Welcome's answer, 2026-11-15).** The inviter
sends no push to a device the server answered `offline` (or `undeclared`) when its Welcome was answered
([history-answer-addressing](../protocols/history-answer-addressing.md#the-rules-as-built), rule 3). A
device that CONNECTS between that answer and its turn in the one-at-a-time push queue is therefore
skipped too, although it would have been addressable at the push; it is counted by the same
`[JOIN_PUSH] ... NOT DELIVERED` warn and recovered by nothing until the step below ships.

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

**It also seals the last unsealed history answer (option B, 2026-11-17).** Since option B every ask
carries a key and its addressed answer is sealed to it; the join push answers no ask and stays unsealed
([history-answer-addressing](../protocols/history-answer-addressing.md#what-is-not-sealed-the-inviters-join-push---so-it-carries-no-message-2026-11-17)).
The register digest above IS a keyed ask, so its answer is sealed with nothing more; with it, the
push carries no message (2026-11-17), which closes the P1's residual
([entry](p1-a-new-member-of-a-group-conversation-receives-its-whole-past-decided-2026-10.md), step 2).

**Why it is not in #3185.** It changes the reconciliation's wire (a field on the digest and its answer),
adds a durable marker on the newcomer and a mixed-version behaviour; the MLS chat path deserves its own
pull request and its own adversarial review for that.

**What proves it, when built:** a newcomer offline at the delivery, then online - the digest carries
`register`, the responder's answer carries the register and no message, the newcomer takes it
"Defini avant votre arrivee" and clears the marker; a reload between the Welcome and the answer still
asks; an older responder leaves the marker set; and a newcomer answered `offline` when its Welcome was
answered, which connects before the inviter's push queue reaches it (so is skipped), still gets the
register from its own digest ask.

**The reading owed on a pre-release, which FAILS until this ships and must then pass:** reading 2 of
the nicknames row of the [readings owed](../plan.md#readings-owed) with the new
member's device NOT connected (the app killed, or the tab closed) when "Ajouter" is pressed, then
opened a minute later. Today the inviter's log reads `[JOIN_PUSH] <group>... NOT DELIVERED to
<account>:<device>` at warn and the new member shows no nickname; once built, the nickname reads
"Defini avant votre arrivee" after the newcomer's digest ask is answered. Mechanism: [chat](../frontend/modules/chat.md#per-conversation-nicknames-modifier-les-pseudos-2026-11-08), "The late joiner".

**Read 2026-11-15 from an iPhone inviter (`1.7.0-alpha.1`, dev).** `gamma` added `alpha` (ten enrolled devices, three addressable at that moment) to a group from the phone: the server answered 13 Welcomes, 3 addressable and 10 offline ("the inviter sends it no addressed answer"), and logged 0 `addressed_unsupported`. The phone's own `[JOIN_PUSH] ... NOT DELIVERED` lines were not read (a page console line, absent from the syslog; the exported in-app log would not open in Quick Look): see [device-verification](../device-verification.md#the-iphone-12-readings-of-2026-11-15-170-alpha1-first-sitting-on-it). The count this entry is measured by is therefore the Mi inviter's, [read the same day](../device-verification.md#the-mi-9t-readings-of-2026-11-15-170-alpha1-first-sitting-on-it).
