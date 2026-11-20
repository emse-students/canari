## P2 - a freshly minted device logs an error-level `REFUSED` for the join push of groups whose join it never solicited

target: 1.7.2

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

Read on dev, `1.7.0-alpha.11`, sitting S4 (2026-11-18, [readings](../device-verification.md#the-web-rig-readings-of-2026-11-18-s4-170-alpha11-the-false-accusers-cost-and-the-web-rows)), during GRP-ADDR-1: the
owner's web seat W3 was minted as a NEW device (`becomeANewDeviceAndConfirm`: enrolled, PIN answered,
a fresh device id, the abandoned one purged) and re-admitted to its groups. Within its first two
minutes it printed five times, at error level, in five different groups,

```
[HISTORY_ADDRESSED] REFUSED an addressed history_bundle in <group>… from <user> - it answers no ask this device has open, or its answerers are all taken (0 message(s) not ingested)
```

and for none of those five groups the line `admitted - the inviter's push is solicited` that opens the
join ask (`takeAddressedAsk`'s `join` kind). Each refused frame was a join push (`claimsJoin`, empty
since #3777: "the push carries the state only"). The groups' history then arrived by the device's own
sealed asks, so nothing was lost on screen - but the state the push carried was dropped, and a line at
error level that fires on every honest re-enrolment is the noise the rules forbid: it reads exactly
like the forged frame the branch exists to catch.

**Why, to be confirmed in the code:** the join ask is opened when the device processes its Welcome as
a solicited admission; a device admitted to many groups at once (a mint re-adds it everywhere) can
receive an inviter's push for a group whose Welcome it processed by another route, or before the ask
was registered. The fix is to carry the discriminator (this device was admitted to that group by that
inviter) to the gate, so a join push from the admitting member is matched by FACT, never refused and
re-learned; `systemMessageHandler.bundleAddressing.test.ts` gains the many-groups admission.

**Not shown a regression:** the branch is #2270's (in `v1.6.12`); only the push's emptiness is new
(#3777). Whether `v1.6.12` printed it on a mint was not measured.

**Seen again 2026-11-18, sitting S7 (`1.7.0-alpha.12`, [readings](../device-verification.md#the-web-and-phone-readings-of-2026-11-18-s7-170-alpha12-the-last-sitting-before-the-stable)), with a second shape.**
`beta`'s web seat W7 minted as a new device logged six error-level `REFUSED` lines in two OTHER groups
within its first fifteen seconds: five for empty join pushes (as above), and one for a NON-empty sealed
answer - `REFUSED an addressed history_bundle in <group>… from <beta> - it answers no ask this device has
open, or its answerers are all taken (43 message(s) not ingested)`, 17 ms after the SAME 43 messages from
another device of `beta` had been ingested for the same ask (`43 added`). Nothing was lost on screen: the
second answer was a duplicate the first had already satisfied. So the gate also accuses the honest
second answerer of an ask that two devices of one member answered; the fix above (match by fact, never
refuse and re-learn) must cover "this ask was answered already" as a counted outcome, not an error.
