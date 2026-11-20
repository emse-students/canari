## Reading owed - the organiser alert for a payment over capacity (switched on 2026-11-20)

target: 1.7.2

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped. THE SWITCH IS ON: `FORM_ORGANISER_ALERT_ENABLED = true` (floor `1.7.0`, #2228 in `v1.4.0`); what is owed is the phone reading below, on the next alpha (dev)._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](owner-decisions-of-2026-11-17.md))._

**What is built:** the organiser alert for a payment over capacity (#2228, D3; owed only once `FORM_ORGANISER_ALERT_ENABLED` is `true` - until then a GUEST who pays over capacity is told to nobody but the responses table)

**The reading that closes it:** on the Mi 9T AND the iPhone 12, one payment landing on a full form on dev: the push arrives with the title only, a tap (app killed AND backgrounded) opens `/forms` with that form's responses accordion open and in view, and the bell row reads the alert sentence ([forms](../frontend/modules/forms.md#the-organiser-is-told-when-a-payment-lands-over-capacity-d3-built-2026-10-22-switched-off))

**Re-triaged 2026-11-14 (owner: every owed reading is read or deleted, never left waiting).** Not a reading while the switch is off: `FORM_ORGANISER_ALERT_ENABLED` is a compiled constant, so it cannot be flipped on dev alone. Its precondition is MET: `minClientVersion` reads `1.6.6` on both estates (`/api/version`, 2026-11-14), above `v1.4.0`, the first stable carrying #2228, and both stores serve far newer builds. **Owed: the flip pull request** (the constant and the spec pinning it, nothing else), and its phone readings ride the pre-release that carries it.

**Web rig and server, 2026-11-16: the precondition re-read, the reading NOT TAKEN (it cannot be, and why).** `/api/version` reads `minClientVersion` `1.6.6` on dev (`1.7.0-alpha.2`) and on production (`1.6.12`), above `v1.4.0` (the first stable carrying #2228), unchanged since 2026-11-14. The server half cannot be read on dev: `FORM_ORGANISER_ALERT_ENABLED` is a compiled `false` (`apps/social-service/src/forms/organiser-alert.service.ts`), so no payment over capacity writes an alert row or a push whatever dev's data holds, and the payment itself needs a Lydia confirmation (no real money, no Lydia). Nothing was written on dev for it. **What is owed is unchanged and is the lead's switch:** the pull request flipping the constant and `organiser-alert.service.spec.ts`'s pin of it (`apps/social-service/src/forms/organiser-alert.integration.spec.ts` proves the alert path on real Postgres in CI), then the phone half on the pre-release that carries it.
