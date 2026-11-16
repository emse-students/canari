## Reading owed - screen share in a desktop live: the scenes, read with the owner in a real browser

target: 1.7.0

Built: the scenes of a desktop live (#3508, 2026-11-14), in every `1.7.0` pre-release - camera, screen,
screen with the camera as an overlay, side by side, "Je reviens" - switched ON AIR on ONE recorded
stream, so the live never restarts and the viewer path is unchanged. Design, what was measured on the
workstation and what was not: [live](../frontend/modules/live.md#screen-share-in-a-desktop-live-what-170-carries-2026-11-16).
This is the owner's 2026-11-14 item #93 ("read together, live",
[decisions](owner-decisions-of-2026-11-14.md)): the bench cannot drive a real `getDisplayMedia`
picker, so nobody else can take it. **The `1.7.0` stable waits for it.**

Closing reading, on `dev.canari-emse.fr` at the latest `1.7.0` pre-release, a desktop Chrome or Edge
(126 or later) with a webcam broadcasting, one bench phone watching:

1. Start on `camera`; switch to `screen` (the picker opens from that click; a dismissed picker changes
   nothing), then `screen-camera`, `side-by-side`, `pause` and back - the phone sees each, with no gap
   and no restart (one live in the bell, one push).
2. The overlay dragged to each corner (snaps on release), the three sizes, round and rectangle; the
   arrow keys and Enter move it.
3. The microphone muted then back, the camera off ("Caméra coupée" card) then back; the camera light's
   behaviour while off noted (Chrome may keep it lit).
4. The shared window RESIZED twice on air: the phone's picture stays clean (the 2026-11-14 streaks).
5. The tab hidden more than five minutes while the screen is shared: the phone keeps moving pictures;
   the member's console shows the `[LIVE-STUDIO] drew N frames, X ms each on average` lines (the
   drawing cost on the owner's machine, the figure the bench lacks).
6. "Arrêter le partage" from the browser's bar: the live turns to "Je reviens", does not end and
   does not fall back to the camera; the next screen scene asks again.

A step that fails becomes its own defect entry. Charter: principle 2 (the essential is never lost:
a click on the browser's bar no longer throws the live away) and 7 (simple: ready-made scenes, not
layers).
