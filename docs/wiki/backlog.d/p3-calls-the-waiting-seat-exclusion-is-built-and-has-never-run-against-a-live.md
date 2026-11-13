## Reading owed - one ring on dev with a pending joiner, the waiting seat not rung

target: 1.7.0

Every call route refuses a seat awaiting a member's admission (409) and the ring's callees are
admitted seats only (`ADMITTED_SEAT`), proven against PostgreSQL by `admission.integration.spec.ts`.
`calls_mode` is `off` on production, so no ring has gone through it. Owed: one ring on dev with a
pending link joiner in the conversation, read in the `[ring]` lines (`not rung: ... hold no
admitted seat`) - [calls](../frontend/modules/calls.md).
