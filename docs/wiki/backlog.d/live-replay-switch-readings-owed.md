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
