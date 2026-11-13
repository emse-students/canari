## P3 - four rig defects read on the 2026-10-22 GRP and GRAINE passes (WP-TEST-TOOLING-REFORM, no verdict)

target: 1.9.0

- **The client logs one group creation twice**: `groupCreation.ts` emits `[OK] Group … created.` and `[GROUP] Group created successfully` for the same event (3 of 3 creations captured on GRP, 2026-10-22). This is upstream noise and not a classifier rule: one of the two lines goes.
- **GRP waits for "no sidebar row" on W2** and errors when the row lingers. That is a wait on rendering, not on the subject of the row.
- **GRP-8 waits on the member-count TEXT**, so a re-worded count reads as an ERROR. It should read the roster.
- **The peer's display name can drift from `PEER_NAME`**: a local account named otherwise turns every GRP row into `the picker offers no <name>`. `identity.mjs` should compare the name shown with `PEER_NAME` before any row runs. The W2 window width belongs here too: a 500 px window hides the Communities rail, and GRAINE-AUTH-1..3 died on a zero-size link, so the preflight should read it.

_Context, from the former backlog section "The harness itself":_ Open findings about the instrument; the reasoning is on
[cross-client-harness-findings](../cross-client-harness-findings.md). **DECIDED 2026-10-18: the whole test tooling is reformed NOW, not after a wholesale rig change** (user: "on est a un nombre de test aberrant") - [WP-TEST-TOOLING-REFORM](decided-by-the-user-on-2026-10-18-every-design-question-answered.md); the "waits for a wholesale rig change" lines below are that reform's scope.
