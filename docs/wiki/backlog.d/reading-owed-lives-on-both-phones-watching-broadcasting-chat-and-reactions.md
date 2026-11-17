## Reading owed - lives on both bench phones: watching, broadcasting, the chat panel and the floating reactions (G9, a release blocker)

target: 1.7.0

**A RELEASE BLOCKER (D3): no stable carries lives before it.** The owner decided on 2026-10-19
([live](../frontend/modules/live.md#decisions-of-2026-10-19)) that any member may start a live, so the
moderation and its proofs come before any stable. Of the gates no other entry tracks
([live-production](../frontend/modules/live-production.md#2-the-gates-each-with-its-evidence)), G7 (the
two crypto reviews) and G8 (the chat load on dev) closed on 2026-11-17, with the WP-L6 entry's two
owed items (the chat seal's review and the several-viewer reading); what is left is this reading.

Closing readings on a `1.7.0` pre-release, each `PASS` (never `PASS-DIRTY`) or a new entry:

1. **Check Y (watching) and LIVE-B1 (broadcasting)** of
   [device-verification](../device-verification.md#live-b1-the-broadcaster-on-both-bench-phones---owed-on-both),
   on the Mi 9T and on the iPhone 12, each phone watching the other.
2. **The chat panel, the reaction bar and the floating layer** on both phones, the broadcaster's
   on-air chat included ([live](../frontend/modules/live.md#the-chat-and-the-floating-reactions-client-half-wp-l6-2026-10-19-draft)):
   a line sent opens on the other phone, a reaction floats on both.
3. **The moderation screens and the three broadcaster pushes**: [their own entry](reading-owed-live-moderation-pushes-lift-and-the-lives-switch.md).

Sizes: one sitting per phone. Charter: principle 2 (the essential is never lost).

**First G9 sitting, 2026-11-17 (`1.7.0-alpha.9`, dev, both phones, [readings](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha9-both-phones-and-the-rig)): PARTIAL.** Each phone broadcast and the other watched. Read: the rules screen, on air, the pipe summaries (10+ min on the Mi, nothing dropped), the screen kept awake, Home then back resuming the SAME live, Terminer/Continuer/"Terminer le live", the viewer joining near the live edge and playing with 0 skipped segments, "Le live est terminé" on the viewer within 1-3 s, the chat both ways with the "Hote" badge, a reaction floating on the other phone in both directions. **Left:** the picture itself and glass-to-glass (both scenes were dark), and the LIVE-B1 / Check Y steps not walked: rotation, a network cut, a call interrupting, the share link, the report path. One defect: [a normal end warns on every viewer](p3-a-live-that-ends-normally-warns-on-every-viewer.md) (P3, `1.7.1`).

**Second G9 sitting, 2026-11-17 (`1.7.0-alpha.10`, dev, the Mi 9T broadcasting and the iPhone 12 watching, [readings](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha10-both-phones-and-the-rig)): PARTIAL.** Read: the share link (the iOS share sheet with the dev link), the report path (its dialog and four reasons, opened and closed, nothing sent), rotation (the viewer to landscape and back; the Mi broadcaster turned by the system stayed portrait on air), a 12 s wifi cut on the broadcaster (the live went on, "Connexion rétablie", the viewer still LIVE), a call ringing in-app on air and declined (the live went on), the end seen on the viewer. **Left:** the picture and glass-to-glass with a lit scene (the room was dark again), a call ANSWERED on air, a report SENT, and the same steps with the iPhone broadcasting. Still a release blocker.
