## P3 - the bubble-action and observation helpers live in one runner (`mut.mjs`)

target: 1.8.0

Waits for a wholesale rig change, because moving helpers into `chat.mjs` invalidates MSG, TYPE, READ and
MUT under rule 33 ([detail](../cross-client-harness-findings.md#the-bubble-action-and-observation-helpers-live-in-one-runner)).

_Context, from the former backlog section "The harness itself":_ Open findings about the instrument; the reasoning is on
[cross-client-harness-findings](../cross-client-harness-findings.md). **DECIDED 2026-10-18: the whole test tooling is reformed NOW, not after a wholesale rig change** (user: "on est a un nombre de test aberrant") - [WP-TEST-TOOLING-REFORM](decided-by-the-user-on-2026-10-18-every-design-question-answered.md); the "waits for a wholesale rig change" lines below are that reform's scope.
