## Reading owed - the organiser's "Rediffusion" switch, on both phones and on dev (owner, 2026-11-20)

target: 1.7.2

Built ([the organiser's switch](../live-replays.md#the-organisers-rediffusion-switch-owner-2026-11-20)): the
switch in the pre-live sheet (ON by default), `replay: false` on the start, `DELETE /api/lives/:id/replay`,
the "Désactiver la rediffusion" button on air and on the end screen. The server tests need a PostgreSQL and run
in CI (`lives.integration.spec.ts`, "the organiser's Rediffusion switch"). Owed, on dev, by the lead:

1. A live started with the switch OFF ends with "Rien n'en est gardé" and no replay appears in the feed.
2. A live started ON, switched off ON AIR: the segments fall to the last 20 at once (`[LIVE_TRIM]`, then
   `[LIVE_REPLAY] ... switched OFF by its organiser (on air ...)`), the live goes on, the end keeps nothing.
3. A live started ON and switched off from the END SCREEN, after its replay was published: the replay
   disappears from the feed at once, the worker deletes the post and the next sweep the segments
   (`[LIVE_GC] ... deleted`), and the button cannot be pressed again.
4. A viewer is shown nothing about the replay choice (no badge, no text) on the live.
5. A phone: the switch is operable in the pre-live sheet and a confirm sits before the irreversible off.

**2026-11-20, S16 (`1.7.2-alpha.1`, [readings](../device-verification.md#the-readings-of-2026-11-20-s16-172-alpha1-the-birthday-ring-the-composer-gap-the-pin-gate-the-ios-backup-pass-the-rediffusion-switch-the-web-image-drop-miconnect)): rows 2, 4 and 5 READ, PASS; the replay of a live left ON READ, PASS; rows 1 and 3 NOT TAKEN.** Row 2 on the Mi 9T: `switched OFF by its organiser (on air, replay post not published)`, `trimmed 10 segment(s) behind the window (0..9)`, the trim done, the live on air; the end "Rien n'en est gardé." and `replay=none`. Row 4 on both phones: the viewer's screen names no replay choice, during and after the live. Row 5 on both phones: the switch ON by default and operable, and the confirm "Désactiver la rediffusion ? ... C'est irréversible." before the off. A live of `gamma` left ON (iPhone, 51 s): `published as post ..., 48s`, the Mi's CanaReels viewer opened on it ("Rediffusion · encore 2 j"). **Defect met:** [the switch's label is unreadable on the dark sheet](p2-the-rediffusion-switch-label-is-unreadable-on-the-live-sheet.md). **Left:** row 1 (started OFF) and row 3 (off from the end screen after publication).
