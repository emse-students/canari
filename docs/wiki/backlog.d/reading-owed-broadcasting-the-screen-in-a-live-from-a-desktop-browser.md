## Reading owed - broadcasting the screen and switching scenes in a live from a desktop browser

target: 1.7.0

**What is built:** a live broadcast from a desktop browser shows the screen (owner, 2026-10-31), and
since 2026-11-14 it is COMPOSED: five scenes switched in one click on air (camera, screen, screen with
the camera as an overlay dragged to a corner, side by side, "Je reviens"), the microphone and the
camera switched off without ending, a fixed 1280x720 frame whatever the shared window does, and the
preview showing exactly what is sent. Every gate is fakes, plus a real Chrome run of the compositor
with a fake camera and a canvas standing in for the share; no picker can be driven unattended
([live](../frontend/modules/live.md#scenes-on-a-desktop-live-owner-2026-11-14)).

**The reading that closes it:** the owner's real-browser reading - one live from a desktop Chrome (and
Edge if at hand), watched from a phone:

- the picker opens from the click on "Écran" and only then; switching back and forth between the
  five scenes on air never re-opens it, and the viewer follows each switch within a few seconds;
- a shared WINDOW resized mid-live: the viewer's picture stays clean (black bars move, no streaks);
- the preview shows the black bars the viewers get, and the overlay where the viewers see it;
- the overlay dragged to each corner snaps there, in the three sizes and both shapes;
- the tab hidden for 10 minutes: the viewer keeps a moving picture, and the console's
  `[LIVE-STUDIO] drew ... ms each on average` lines (one per 30 s) give the drawing cost - read on a
  modest laptop if one is at hand;
- the share stopped from the browser's bar: the live shows "Je reviens", the sheet says why, and a
  click on a screen scene asks for a screen again;
- the microphone and the camera switched off and back on: silence and the "Caméra coupée" card at
  the viewer, the live never ended; whether Chrome's camera light stays on while the camera is off
  (the lens is not released) is read and noted.
