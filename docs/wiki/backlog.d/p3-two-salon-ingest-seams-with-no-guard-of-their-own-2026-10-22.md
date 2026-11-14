## P3 - two salon ingest seams with no guard of their own (2026-10-22)

target: 1.9.0

- `fcmMemoryMerge.ts` has no `channel_` guard. It is unreachable today, because the native side never caches a salon push; the guard would be defence in depth.
- The live frame and the history page used to key a row by different fields. The live path now reads `messageId` alone (#2248). Should the server ever give one row two ids, the first path to open it claims the key, and the other is refused as a replay.

_Context, from the former backlog section "The harness itself":_ Open findings about the instrument; the reasoning is on
[cross-client-harness-findings](../cross-client-harness-findings.md). **DECIDED 2026-10-18: the whole test tooling is reformed NOW, not after a wholesale rig change** (user: "on est a un nombre de test aberrant") - [WP-TEST-TOOLING-REFORM](decided-by-the-user-on-2026-10-18-every-design-question-answered.md); the "waits for a wholesale rig change" lines below are that reform's scope.
