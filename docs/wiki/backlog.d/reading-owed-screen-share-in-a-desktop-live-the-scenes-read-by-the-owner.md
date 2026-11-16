## Reading owed - screen share in a desktop live: the scenes, what the bench read and what is left to the owner's hand

target: 1.7.0

Built: the scenes of a desktop live (#3508, 2026-11-14), in every `1.7.0` pre-release - camera, screen,
screen with the camera as an overlay, side by side, "Je reviens" - switched ON AIR on ONE recorded
stream, so the live never restarts and the viewer path is unchanged. Design, what was measured on the
workstation and what was not: [live](../frontend/modules/live.md#screen-share-in-a-desktop-live-what-170-carries-2026-11-16).
This is the owner's 2026-11-14 item #93 ([decisions](owner-decisions-of-2026-11-14.md)). **Since the
owner's 2026-11-16 decision the bench reads it first**: on `1.7.0-alpha.5` the bench read steps 1 to 6
in a desktop Chrome 157 with a web viewer
([sitting](../device-verification.md#the-desktop-screen-share-reading-of-2026-11-16-170-alpha5)).
It could not drive a real picker or a real window, so what is left is only what needs a human hand.
**The `1.7.0` stable waits for these rows**, in a desktop Chrome or Edge (126 or later) on
`dev.canari-emse.fr` at the latest `1.7.0` pre-release, a web or phone viewer:

1. **The picker itself.** Click "Ecran": the browser's own picker opens from that click, with a WINDOW
   chosen (the bench only took a tab, through a flag that skips the picker). A dismissed picker changes
   nothing (the scene stays as it was). Note whether the picker offers the sound option and that the
   sound is heard.
2. **A real window resized twice on air.** The bench resized a shared TAB's window twice (clean, no
   streaks, the frame stays 1280x720); a shared WINDOW (the 2026-11-14 streaks were seen on one) was not
   taken, because Chrome would not auto-select a window by title and sharing the entire screen was
   refused (the desktop holds private material).
3. **"Arreter le partage" from the browser's bar.** The bench ended the track from outside the app
   (closed the shared tab), which fires the same `ended` event, and read it: "Je reviens", live not
   ended, no fallback to the camera, the next screen scene asks again. The bar's own button is the hand
   row.
4. **The camera light while the camera is cut** (the bench used a synthetic camera: Chrome may keep the
   real light on), and **how an overlay drag FEELS** (the bench's mouse drags worked and snapped, but
   each took about 70 s of rig time, a rig fact never explained, not a measurement of the app).
5. **One live in the bell, one push** when a phone watches (the bench had no phone to give).

A step that fails becomes its own defect entry. Charter: principle 2 (the essential is never lost:
a click on the browser's bar no longer throws the live away) and 7 (simple: ready-made scenes, not
layers).
