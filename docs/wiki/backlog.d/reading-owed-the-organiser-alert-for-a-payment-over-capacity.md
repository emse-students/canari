## P2 - the organiser alert for a payment over capacity: its precondition is met, the flip is owed

target: 1.7.0

**What is built:** the organiser alert for a payment over capacity (#2228, D3; owed only once `FORM_ORGANISER_ALERT_ENABLED` is `true` - until then a GUEST who pays over capacity is told to nobody but the responses table)

**The reading that closes it:** first the client floor: `minClientVersion` at or above the version carrying #2228 on both estates, both stores serving it; then on the Mi 9T AND the iPhone 12, one payment landing on a full form on dev: the push arrives with the title only, a tap (app killed AND backgrounded) opens `/forms` with that form's responses accordion open and in view, and the bell row reads the alert sentence ([forms](../frontend/modules/forms.md#the-organiser-is-told-when-a-payment-lands-over-capacity-d3-built-2026-10-22-switched-off))

**Re-triaged 2026-11-14 (owner: every owed reading is read or deleted, never left waiting).** Not a reading while the switch is off: `FORM_ORGANISER_ALERT_ENABLED` is a compiled constant, so it cannot be flipped on dev alone. Its precondition is MET: `minClientVersion` reads `1.6.6` on both estates (`/api/version`, 2026-11-14), above `v1.4.0`, the first stable carrying #2228, and both stores serve far newer builds. **Owed: the flip pull request** (the constant and the spec pinning it, nothing else), and its phone readings ride the pre-release that carries it.
