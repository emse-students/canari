## P3 - TWO out-of-tree directories are both called `canari-harness`, and a decoy `names.mjs` sits in the one the harness does not read (2026-09-04)

target: 1.8.0

Owed to the USER, one-off on the workstation: merge the directories or delete the decoy `names.mjs` (both hold credentials and Chrome profiles). The preflight prints `rig state: <STATE_DIR>` first ([table](../cross-client-harness-findings.md#two-out-of-tree-directories-are-both-called-canari-harness-2026-09-04)). **Re-read 2026-10-24 on the workstation:** the identity-provider database dumps are GONE (three 74-byte `.meta` stubs remain); the directory the rig does NOT read still holds the decoy `names.mjs`, two stale test-account files, those stubs, and the Play Console service-account key the play-vitals tooling DOES use (move it, do not delete it).

_Context, from the former backlog section "The harness itself":_ Open findings about the instrument; the reasoning is on
[cross-client-harness-findings](../cross-client-harness-findings.md). **DECIDED 2026-10-18: the whole test tooling is reformed NOW, not after a wholesale rig change** (user: "on est a un nombre de test aberrant") - [WP-TEST-TOOLING-REFORM](decided-by-the-user-on-2026-10-18-every-design-question-answered.md); the "waits for a wholesale rig change" lines below are that reform's scope.
