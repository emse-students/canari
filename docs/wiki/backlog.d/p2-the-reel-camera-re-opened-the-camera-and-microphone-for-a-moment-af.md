## P2 - The reel camera re-opened the camera and microphone for a moment after the member left it (Mi 9T, 2026-10-28) - fix MERGED (#2647), read `PASS`, not shipped

On a Mi 9T running `1.5.1` on dev, a member picked a video from the gallery in the CanaReels camera,
reviewed it and published it. The app's logs and the system's own records agree on two short,
unrequested opens. Nothing stayed open: the session released the late stream itself.

| When | App log (`[camera-session]`, `[camera]`, `[reel-capture]`) | System record |
| --- | --- | --- |
| The gallery picker returns, before the pick reaches its review | `back on screen - reopening` / `start user (#3)`, then `ready -> review on picked`, `stop`, `opened user`, `#3 came back after the session moved on - releasing it` | `dumpsys audio`: a CAMCORDER recording for ~0.5 s |
| After Publish, with the feed already on screen | `published`, `the screen is being left: the take is dropped`, `the take was dismissed`, `start user (#5)`, `stop`, `opened user: camera 1, facing front`, `#5 came back ... releasing it`, `released` | `dumpsys media.camera`: CONNECT then DISCONNECT of the front camera; `dumpsys audio`: a CAMCORDER recording for ~0.33 s |
| +33 s, +78 s, and in the reel viewer | nothing | no camera client, no recording |

Causes, the fix and its tests: [reels](../frontend/modules/reels.md#the-camera-does-not-open-again-once-the-member-has-left-it-mi-9t-2026-10-28).
**Read `PASS` on the Mi 9T, rig build `5c362c0e1` on dev (2026-10-28)**, the same path with a
synthetic video: one CONNECT when the camera opened and one DISCONNECT when the gallery picker
opened, the CAMCORDER recording stopping with it; after the pick's return and after Publish, no
CONNECT, no recording, and `appops` still dating the last camera and microphone access to the
picker's open. Logcat's `CameraService` shows the same single pair. Owed: nothing but the release.
