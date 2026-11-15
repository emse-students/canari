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

### iPhone 12 reading of 2026-11-15 (second sitting): the live viewer, landscape live from the rig seat

TestFlight `1.6.12-alpha.2`, dev; W5 broadcast a landscape live (fake camera, 640x480). In the live viewer the "Passer en paysage" button turned the app to 844x390 pt (WDA `size`), the top bar kept its controls clear of the left side (the first control starts at 60 pt, the chat input and the reaction column sit at the bottom and the right), the picture stayed whole, and the same button ("Passer en portrait") returned to 390x844. When W5 ended the live the viewer drew "Le live est termine" with "Retour au fil". READ for the live viewer in landscape on the iPhone. The log lines (`auto` / `portrait`, `safe area published`) were not read: the TestFlight WebView is not inspectable. **Left: the iPhone's rotation lock OFF (a physical turn), the video lightbox and the reel pager, the broadcaster and the camera on the iPhone, and the whole Mi 9T half.**

### Defects of the `1.6.10` reading, fixed 2026-11-11

Chrome back around the camera when turned, and the rotate button unlike its siblings: cause and fix in
[screen-orientation](../frontend/screen-orientation.md#a-turned-phone-is-still-a-phone-and-a-full-screen-place-draws-no-chrome-2026-11-11).
Owed: a Mi 9T reading turned on a video screen (no header, no rail). The camera's rotate button is
gone since 2026-11-11 (the camera keeps its layout).

**Triage 2026-11-14 - what can be read on the bench, and what is DELETED.** Left, on both phones with the rotation LOCK ON: the rotate button forces landscape and back on a landscape video opened from a post, on the live viewer (a live filmed in landscape by the other phone) and on the reel pager; the photo in the same gallery stays upright (log `auto` / `portrait` / `auto`); closing returns to portrait; the header clears the notch on both sides (`safe area published` in the syslog); the broadcaster's preview orientation and its double tap; nothing turns outside the four screens (the lock ON keeps them upright whatever); a reload while landscape comes back portrait; Android `configuration changed in place`, no second `onCreate`: Mi 9T about 20 min, iPhone about 20 min. **DELETED: "turns with the phone, lock OFF" and every reading of a held-sideways cold start**: it needs the phone physically turned, which the bench cannot do (no hand, and `adb`/WDA rotation is not a turned sensor); the same code path is read through the rotate button.

**Mi 9T, 2026-11-15: not taken.** The rows need a landscape video (the viewer) and a live seen on screen under the rotation lock, and none was staged in the 2026-11-15 Mi 9T session (spent on the push and sealed-cache rows); the entry keeps all its readings.

**Mi 9T, 2026-11-15, second sitting (dev, `1.6.12-alpha.2`, rotation lock ON): the video lightbox READ; the rest stays owed.** Beta sent a 1280x720 H.264 video in its DM with alpha (a web seat has no phone camera: the file is generated, 12 s test pattern). Opened full screen on the phone: the log `MainActivity: orientation portrait -> auto (requestedOrientation=2)`; the rotate button ("Rotate to landscape") forced landscape (`auto -> landscape (requestedOrientation=11)`, `configuration changed in place: landscape (activity not recreated)`, the screen read 2340x1080, header and buttons clear of the cutout); the button then returned to portrait (`landscape -> portrait (requestedOrientation=1)`, again in place); forced landscape and then a reload of the page came back portrait. **Left:** the photo-stays-upright swipe (`auto`/`portrait`/`auto`), the live viewer on a landscape live, the reel pager, the broadcaster's preview and its double tap, and the iPhone: they need a mixed gallery and a live from a phone camera or a harness seat that can publish a landscape live. Build note: read on `v1.6.12-alpha.2` (built for dev, tag on `fa1bc2655`), not the stable APK; `v1.6.12` is the bump commit `0b6947d20` directly over it (version files and changelog fragments only), so the code read is the stable's.

### Mi 9T, step 4 viewers, READ 2026-11-15 (`1.6.12-alpha.2`, dev, the rotation lock ON)

A beta web seat sent alpha ONE message with three attachments (a 640x360 landscape video, a portrait photo, a second landscape video); `adb logcat` reads `MainActivity` and `WindowManager`.

- **Mixed gallery, auto / portrait / auto: READ.** Opening the first video logs `orientation portrait -> auto (requestedOrientation=2)`; a swipe to the photo logs `auto -> portrait (requestedOrientation=1)` (the photo upright, no rotate button); a swipe to the second video logs `portrait -> auto`. The `portrait` line is printed twice for the one swipe (two identical `MainActivity` lines in the same millisecond): harmless, but a double request, not investigated.
- **Rotate button with the lock ON: READ.** On the second video the button logs `auto -> landscape (requestedOrientation=11)`, `WindowManager` rotation 0 to 90, then `configuration changed in place: landscape (activity not recreated)`; the top bar (back, date, download, info) is drawn in the turned frame with no header band; the button again logs `landscape -> portrait` and the rotation returns to 0; the back arrow closes the lightbox in portrait.
- **Reel pager: READ.** Paging the For-you reels: a vertical item changes nothing; reaching a LANDSCAPE video logs `portrait -> auto` and draws the rotate button, the video letterboxed in the portrait frame; the button logs `auto -> landscape (11)` (rotation 90, activity not recreated), the caption and the action column are drawn inside the turned frame and the picture is not buried; a swipe up while turned pages to the next item and logs `landscape -> portrait` (rotation 0); a square video between the two never requested anything.
- **Left (iPhone 12 and the rest of this entry):** the lock-OFF turn with the phone physically sideways (nothing here can tilt the phone), the live viewer, the broadcaster, the iOS notch and the cold start held sideways; the same rows on the iPhone 12.

### iPhone 12, sixth sitting, 2026-11-15 (`1.6.12-alpha.2`, dev): the broadcaster's preview, upright elsewhere and the reload READ

The broadcaster's preview turned to 844x390 pt with "Passer en paysage" (form in a left column, "Fermer" at x 59 pt clear of the notch), "Revenir en portrait" returned to 390x844, and closing the preview in landscape returned to portrait. The feed, the chat list, a conversation and the settings read 390x844 pt. A WebContent kill (`pymobiledevice3 developer dvt kill`) with the preview in landscape came back at 390x844 on the PIN gate. **Left on the iPhone: the rotation lock's own state (Control Center cannot be driven from the bench), the video lightbox and the reel pager, the double tap on the preview, the notch log lines (the WebView is not inspectable); and the whole Mi 9T half.** Evidence: [device-verification](../device-verification.md#the-iphone-12-readings-of-2026-11-15-sixth-sitting).
### Mi 9T sitting 6, 2026-11-15 - the rows owed with the rotation lock ON (dev, `1.6.12-alpha.2`, beta's web seat as the broadcaster, a fake camera in landscape)

- **The live viewer on a landscape live: READ.** From the feed's live card the viewer opened portrait (`MainActivity: orientation portrait -> auto`, then `auto -> landscape` on the rotate button, `requestedOrientation=SCREEN_ORIENTATION_USER_LANDSCAPE`, `mDisplayRotation=ROTATION_90`), with the system lock ON; `configuration changed in place: landscape (activity not recreated)`. In landscape the comment bar sits at the left with the reaction column at ITS right, the top buttons clear the screen edges, the video is whole with side bars; the chat button hides the bar and brings it back. The button back, or the close, returned `landscape -> portrait` with the viewer gone. The picture was NOT checked for a notch (the Mi 9T has none).
- **The broadcaster preview and its double tap: READ.** The phone's own preview (the rear camera on a dark surface, no face) turned with its rotate button (`requestedOrientation=11`, the track went 720x1280 -> 1280x720, `[LIVE-CAM]` track `state live`), "Démarrer le live" is below the fold in landscape and the sheet scrolls to it, closing returned portrait. A double tap on the picture flipped the lens (`facingMode` user -> environment) and left the title field, the mic and camera buttons and the rotate button as they were.
- **Nothing turns outside the four screens (lock ON side): READ.** After a viewer in landscape, `/posts`, `/chat`, a DM and `/settings` each read `SCREEN_ORIENTATION_PORTRAIT`. The lock-OFF side (the phone held sideways) is not reached by the bench.
- **A reload while in landscape: READ.** `Page.reload` through CDP with the viewer in landscape came back `PORTRAIT` (the root layout posts the effective mode). **Found on the way, known: a renderer kill is the process dying** - `Page.crash` took the whole activity with it (`Force finishing activity`, the launcher in front), and the cold start opened `SCREEN_ORIENTATION_PORTRAIT`; the Android shell cannot kill a sandboxed renderer (`Operation not permitted`), so the real WebView-kill path of `screen-orientation.md` is the same death and not a reload.
- **Left: the iPhone 12, the lock-OFF rows (a human holds the phone), the lightbox and reel pager rows, the iOS notch.**
