## Reading owed - rotation on the video, live and camera screens on both phones

target: 1.7.0

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
3. **The surfaces not being rewritten by the video-player stack**: the camera (`CameraScreen`; since
   2026-11-11 it keeps its layout portrait and turns its glyphs instead -
   [its own entry](camera-keeps-its-layout-and-volume-shutter.md)) and the live broadcaster (chosen in
   the preview, frozen on air, the rotate button; and the owner's double tap on the preview to switch
   the lens, 2026-11-09). The button is `ui/player/RotateButton.svelte`, the sides' padding
   `utils/sideSafeArea.ts` - both for step 4 to reuse.
4. **BUILT 2026-11-12 (draft PR, refs issue #3407; readings below still owed)** - after the stack landed (#3201 rewrites `MediaLightbox.svelte` and the player kit, #3202
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
   - **`ReelViewer` / the pager** (owner, 2026-11-12, replacing "stays portrait"): portrait, EXCEPT
     while the item on show is a LANDSCAPE VIDEO (stored width > height) - then `auto` and the
     rotate button, one request across landscape-to-landscape swipes. Vertical or square videos and
     photos change nothing. Draft PR, refs #3407 ([mechanism](../frontend/screen-orientation.md)).

### Readings owed on a pre-release

- **Step 4, both viewers (issue #3407, iPhone 11 / iOS 18.7.6)**: on the iPhone 12 and the Mi 9T, a
  landscape video opened from a post turns with the phone (lock off) and the rotate button turns it
  with the lock on, then back; a photo in the same gallery stays upright (swipe video -> photo ->
  video, the log shows `auto` / `portrait` / `auto`); closing returns to portrait; the header clears
  the notch on both sides. The live viewer on a live filmed in landscape: turns, chat as a column
  with the reaction bar at its right, the button forces landscape. The reel pager (a video tapped in a feed
  post): a landscape video turns with the phone (lock off) and with the rotate button (lock on), the
  log shows `auto` then `portrait` on a swipe to a vertical item or a photo, closing returns to
  portrait; the caption and the action column clear the notch and do not bury the picture; a swipe up
  or down while turned still pages; a vertical or square video never turns.

Native is verified by COMPILING (CI's Compile Android / Compile iOS), which proves nothing about
running. Owed on the **Mi 9T** and the **iPhone 12**, each with the rotation lock OFF and then ON:

- **Nothing turns outside the four screens**: the feed, a conversation and the settings stay upright
  with the phone sideways (lock off). A cold start with the phone held sideways opens in portrait
  (iOS: no landscape launch screen, `supported-orientations hook installed ... at launch` in the log
  before the first scene).
- **The camera**: replaced by [its own entry's readings](camera-keeps-its-layout-and-volume-shutter.md)
  (2026-11-11: the layout no longer turns).
- **The broadcaster**: turned in the preview, `[LIVE-CAM] opened` then a landscape track size; the
  orientation stays put once on air; a viewer in portrait sees the whole picture with bars; the
  double tap on the preview switches the lens and never toggles anything else.
- **Android, the activity is not recreated**: logcat at a turn shows `configuration changed in place`
  and no second `onCreate`; a conversation open in the background keeps its state.
- **iOS, the notch**: in landscape the controls clear the notch on either side
  (`safe area published to the page: ... left N pt, right N pt` in the syslog).
- **A reload while turned** (Android: kill the WebView renderer; iOS: a WebContent kill) comes back
  portrait.

### Defects of the `1.6.10` reading, fixed 2026-11-11

Chrome back around the camera when turned, and the rotate button unlike its siblings: cause and fix in
[screen-orientation](../frontend/screen-orientation.md#a-turned-phone-is-still-a-phone-and-a-full-screen-place-draws-no-chrome-2026-11-11).
Owed: a Mi 9T reading turned on a video screen (no header, no rail). The camera's rotate button is
gone since 2026-11-11 (the camera keeps its layout).
