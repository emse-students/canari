## P2 - re-registering the PIN verifier strands every other client SILENTLY, and only its next unlock finds out (2026-09-04)

target: 1.8.0

Open: nothing tells an unlocked client its vault material was replaced; every HEAL-NEW row strands W1/W2.
The wipe repair is measured (`newdevice.mjs --device W1`). Owed: do the same digits give an acceptable
verifier, does "ancien PIN" restore or reset MLS state, has production ever had a member in this state
([detail](../cross-client-harness-findings.md#re-registering-the-pin-verifier-strands-every-other-client-silently-2026-09-04)).

_Context, from the former backlog section "The harness itself":_ Open findings about the instrument; the reasoning is on
[cross-client-harness-findings](../cross-client-harness-findings.md). **DECIDED 2026-10-18: the whole test tooling is reformed NOW, not after a wholesale rig change** (user: "on est a un nombre de test aberrant") - [WP-TEST-TOOLING-REFORM](decided-by-the-user-on-2026-10-18-every-design-question-answered.md); the "waits for a wholesale rig change" lines below are that reform's scope.
