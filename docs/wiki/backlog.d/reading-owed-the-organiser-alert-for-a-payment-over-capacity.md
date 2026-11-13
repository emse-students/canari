## Reading owed - the organiser alert for a payment over capacity

target: 1.7.0

**What is built:** the organiser alert for a payment over capacity (#2228, D3; owed only once `FORM_ORGANISER_ALERT_ENABLED` is `true` - until then a GUEST who pays over capacity is told to nobody but the responses table)

**The reading that closes it:** first the client floor: `minClientVersion` at or above the version carrying #2228 on both estates, both stores serving it; then on the Mi 9T AND the iPhone 12, one payment landing on a full form on dev: the push arrives with the title only, a tap (app killed AND backgrounded) opens `/forms` with that form's responses accordion open and in view, and the bell row reads the alert sentence ([forms](../frontend/modules/forms.md#the-organiser-is-told-when-a-payment-lands-over-capacity-d3-built-2026-10-22-switched-off))
