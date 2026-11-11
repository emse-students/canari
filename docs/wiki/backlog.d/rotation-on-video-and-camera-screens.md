## P2 - rotation on the video and camera screens only (owner, 2026-11-09): the mechanism, the camera and the broadcaster built, two viewers owed after the video-player stack

The owner's decisions and the mechanism are in [screen-orientation](../frontend/screen-orientation.md):
portrait everywhere; the full-screen video viewer, the live viewer, the live broadcaster and the
camera (chat, posts AND CanaReels) turn with the phone under its rotation lock, and a rotate button
forces landscape with the lock on; a live keeps the broadcaster's orientation; a landscape CanaReel
is letterboxed in the vertical pager.

### The steps, each its own draft pull request, smallest risk first

1. **Design** - [screen-orientation](../frontend/screen-orientation.md) and this entry. Rides with step 2
   (no docs-only pull request).
2. **The native mechanism** - `window.canariOrientation` / `webkit.messageHandlers.canariOrientation`,
   the Android `requestedOrientation` mapping (`OrientationMode.kt`, `OrientationModeTest`), the iOS
   hook on tao's root view controller and the geometry request, the Info.plist, the side safe areas
   on iOS, and the page's one store (`screenOrientation.svelte.ts`). Nothing requests anything yet, so
   the app stays portrait: the only change a member can see is none.
3. **The surfaces not being rewritten by the video-player stack**: the camera (`CameraScreen`: the
   frame follows the screen, a take freezes it, the rotate button) and the live broadcaster (chosen in
   the preview, frozen on air, the rotate button; and the owner's double tap on the preview to switch
   the lens, 2026-11-09). The button is `ui/player/RotateButton.svelte`, the sides' padding
   `utils/sideSafeArea.ts` - both for step 4 to reuse.
4. **Owed after the stack lands** (#3201 rewrites `MediaLightbox.svelte` and the player kit, #3202
   `LiveViewer.svelte`; neither may be edited under them):
   - **`LiveViewer.svelte`**: `const orientation = useScreenOrientation('live-viewer')` for its whole
     mount; a `RotateButton` (step 3's kit button) in the top bar, beside the close, drawn when
     `orientation.canRotate`; the top bar and the bottom row padded on the sides with
     `var(--safe-area-inset-left, env(safe-area-inset-left, 0px))` (and right). The `<video>` is
     already `object-contain`, so a landscape live is already whole with bars in portrait - check it
     stays so, and that the chat panel and the reaction bar take `landscape:` widths (a column at the
     right, not the bottom third of a 390 pt tall screen).
   - **`MediaLightbox.svelte`**: request `auto` ONLY while the item on show is a VIDEO (an
     `$effect` on the current item: `requestOrientation('auto', 'lightbox-video')` when it is a video,
     released when the item changes to an image or the lightbox closes) - photos stay portrait, as the
     owner scoped it. The `RotateButton` in the glass bar, `glass={false}` there (the bar is already
     glass - design-reference section 3); the bar and the caption padded on the sides as above.
   - **`ReelViewer` / the pager**: stays PORTRAIT (no request). A landscape reel is letterboxed by
     `ReelFrame` with the media's own ratio - already the case for a gallery import; read it on the
     phones with a reel filmed in landscape (below).

### The landscape reel viewer (owner, 2026-11-11, ships after `1.6.11`) - built, draft PR

A CanaReels video whose own file is wider than tall gets a "Plein ecran" chip; it opens that video in
`MediaLightbox` forced to landscape (`forceLandscape`), from the blob or stream fork the slide already
holds, and closing returns to the portrait pager on the same reel at the same position. Per media, from
its recorded width and height; missing dimensions -> no chip, logged. **The owner also decided NOT to
crop black bars baked into a video file (no detection, not now).** Mechanism and files:
[reels](../frontend/modules/reels.md#a-landscape-file-gets-a-plein-ecran-chip-owner-2026-11-11),
[screen-orientation](../frontend/screen-orientation.md#the-landscape-reel-viewer-owner-2026-11-11).
Readings owed, Mi 9T and iPhone 12, lock off then on: the chip shows on a landscape reel only (not on the
next vertical one); a press turns the screen to landscape with the lock ON; the picture resumes at the
pager's time; closing returns to portrait on the same reel, at the viewer's time; the header clears the
notch on both sides; desktop web opens the viewer without turning.

### Readings owed on a pre-release

Native is verified by COMPILING (CI's Compile Android / Compile iOS), which proves nothing about
running. Owed on the **Mi 9T** and the **iPhone 12**, each with the rotation lock OFF and then ON:

- **Nothing turns outside the four screens**: the feed, a conversation and the settings stay upright
  with the phone sideways (lock off). A cold start with the phone held sideways opens in portrait
  (iOS: no landscape launch screen, `supported-orientations hook installed ... at launch` in the log
  before the first scene).
- **The camera** (reel tab, a chat's camera, a post's camera): lock off, it turns with the phone and
  the frame becomes 16:9; lock on, it does not turn, and the rotate button turns it; a second press
  returns to portrait. A photo and a take filmed in landscape are 16:9 files (read the size in the
  review), a take does not turn when the phone does, and a landscape reel publishes and plays
  letterboxed in the pager.
- **The broadcaster**: turned in the preview, `[LIVE-CAM] opened` then a landscape track size; the
  orientation stays put once on air; a viewer in portrait sees the whole picture with bars; the
  double tap on the preview switches the lens and never toggles anything else.
- **Android, the activity is not recreated**: logcat at a turn shows `configuration changed in place`
  and no second `onCreate`; a conversation open in the background keeps its state.
- **iOS, the notch**: in landscape the controls clear the notch on either side
  (`safe area published to the page: ... left N pt, right N pt` in the syslog).
- **A reload while turned** (Android: kill the WebView renderer; iOS: a WebContent kill) comes back
  portrait.
