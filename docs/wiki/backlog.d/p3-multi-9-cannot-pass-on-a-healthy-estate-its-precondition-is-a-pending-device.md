## P3 - MULTI-9 cannot pass on a healthy estate: its precondition is a pending device, and none stays pending (2026-10-22)

target: 1.9.0

A new device reached `active` in 107 ms, so there was no window to send into, and the row recorded `VACUOUS`. That matches its only earlier verdict. The row needs a way to hold a device `pending` (a held Welcome or a stopped responder) before it can say anything. Until then it is a precondition the estate cannot create, not a verdict.

_Context, from the former backlog section "The harness itself":_ Open findings about the instrument; the reasoning is on
[cross-client-harness-findings](../cross-client-harness-findings.md). **DECIDED 2026-10-18: the whole test tooling is reformed NOW, not after a wholesale rig change** (user: "on est a un nombre de test aberrant") - [WP-TEST-TOOLING-REFORM](decided-by-the-user-on-2026-10-18-every-design-question-answered.md); the "waits for a wholesale rig change" lines below are that reform's scope.
