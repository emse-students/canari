## P2 - no row on the board can tell a healthy conversation from an epoch-forked one (2026-08-29)

target: 1.8.0

The predicate is built end to end (2026-10-04). Owed: the ROW - a MULTI-shaped row asking `readEpochForks`
of a conversation it is not using, run once on a build carrying `window.__canariMlsEpochs()` ([detail](../cross-client-harness-findings.md#no-row-can-tell-a-healthy-conversation-from-an-epoch-forked-one-2026-08-29)).

_Context, from the former backlog section "The harness itself":_ Open findings about the instrument; the reasoning is on
[cross-client-harness-findings](../cross-client-harness-findings.md). **DECIDED 2026-10-18: the whole test tooling is reformed NOW, not after a wholesale rig change** (user: "on est a un nombre de test aberrant") - [WP-TEST-TOOLING-REFORM](decided-by-the-user-on-2026-10-18-every-design-question-answered.md); the "waits for a wholesale rig change" lines below are that reform's scope.
