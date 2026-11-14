## Reading owed - broadcasting the screen in a live from a desktop browser

target: 1.7.0

**What is built:** a live broadcast from a desktop browser shows the screen (owner, 2026-10-31), and
since 2026-11-14 it is COMPOSED: five scenes switched in one click on air (camera, screen, screen with
the camera as an overlay dragged to a corner, side by side, "Je reviens"), the microphone and the
camera switched off without ending, a fixed 1280x720 frame whatever the shared window does, and the
preview showing exactly what is sent. Every gate is fakes, plus a real Chrome run of the compositor
with a fake camera and a canvas standing in for the share; no picker can be driven unattended
([live](../frontend/modules/live.md#scenes-on-a-desktop-live-owner-2026-11-14)).

**The reading that closes it:** the owner's real-browser reading - one live from a desktop Chrome
sharing a window, then a whole screen, watched from a phone: the picker opens from the click, the
viewer sees the shared surface, a hidden page keeps broadcasting, and stopping the share from the
browser's bar ends it as the page describes.

The scenes (#3508) are not in `v1.6.12`, so their reading is not owed yet (owner, 2026-11-14: a reading
of code not shipped is added when it ships).
