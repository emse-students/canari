## Rotation on the video, live and camera screens, owed on both phones (a reading deferred to 1.7.1)

target: 1.7.3

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_Deferred 2026-11-18 under the owner's rule of 2026-11-18 ([owner-decisions-of-2026-11-18.md](owner-decisions-of-2026-11-18.md)): needs a hand rotating the phone, not a regression._

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
   its own entry (entry deleted 2026-11-15)) and the live broadcaster (chosen in
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
- **The camera**: replaced by its own entry's readings (entry deleted 2026-11-15)
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
- **A turn shows no stale frame** ([the owner's decision of 2026-11-15](../frontend/screen-orientation.md#a-turn-shows-no-stale-frame-2026-11-15)):
  over a landscape CanaReel, ten turns each way, recorded; no frame shows the old layout beside black.
  Android: measured on the Mi 9T before the merge (the table on that page); the log shows `draw
  released` for every turn. **iOS: never run** - the old picture must stay still while the interface
  turns (no black corner during the animation: tao's root view must not clip it), and the syslog shows
  `old picture released` for every turn. (An iPad Split View resize check: deleted 2026-11-16 by the owner's decision (16): hardware outside the bench; see [owner-decisions-of-2026-11-16](owner-decisions-of-2026-11-16.md).)
  **Android: the Mi 9T runs Android 16 (shell transitions, BLAST sync), which is where the table was
  measured.** (Android 9-12 and a second Android 13+ phone from another maker: deleted 2026-11-16 by the owner's decision (16): hardware outside the bench; see [owner-decisions-of-2026-11-16](owner-decisions-of-2026-11-16.md).)

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

**Mi 9T, 2026-11-15 (both-phones sitting): nothing left on the Mi bench.** Every row it can stage was read by the earlier sittings; what remains is the lock-OFF turn (a human holds the phone) and the iPhone 12's lightbox, reel pager, broadcaster and notch rows.

**2026-11-15, afternoon (owner's hands-on sitting, then an iPhone 12 bench sitting): every row on the list is now READ.** The owner held both phones with the rotation lock OFF: the lightbox photo stays portrait, a landscape CanaReel turns both ways in place, the feed stays portrait (Mi 9T), the iPhone reel turns both ways with nothing under the notch. The bench read the iPhone lightbox (photo with no rotate button; a video item turned to 844x390 with its back control at 59 pt, back to 390x844; a swipe while turned returns to portrait) and the reel pager (a landscape video post: rotate button, caption and action column clear of the notch, back to portrait, closed at 390x844). The camera's glyph and file-orientation rows are in [device-verification](../device-verification.md#the-owners-hands-on-sitting-of-2026-11-15). **Left, and why this entry is not deleted:** the reel tabs and the action rail on a landscape video were fixed by #3537 (merged 2026-11-14 after `alpha.2`) and are read on `1.7.0-alpha.1`. The stale frame after the system rotation animation (about 0.5 s, both phones) is being fixed elsewhere.

### Mi 9T, `1.7.0-alpha.1`, 2026-11-15 (first sitting on it): the stale-frame row and the reel tabs READ

On the release APK (versionCode `100700001`) with the dev estate: 14 forced turns over a landscape CanaReel logged `draw released` each time (259-390 ms), no `released WITHOUT`, and the MainActivity window's `finishDrawing of orientation change` always came after the release (14 of 14); a contact sheet of the first recorded turn shows the old portrait picture held whole, then the system turn onto the laid-out page, no stale layout beside black. The remaining recorded turns were not read frame by frame. The reel's "Pour toi / Recents" tabs stayed centred (page centre 218 and 472.5 CSS px, tabs' centre the same) with the rotate button drawn, and the action rail was complete in both orientations (#3537). **Still owed on this row:** Android 9-12 and a second Android 13+ maker, and the iPhone 12 (never run). Detail: [device-verification](../device-verification.md#the-mi-9t-readings-of-2026-11-15-170-alpha1-first-sitting-on-it).

### iPhone 12, `1.7.0-alpha.1`, 2026-11-15 (first sitting on it): the turn hold and the reel tabs READ

TestFlight `1.7.0 (100700001)`, dev, `gamma`. Three forced turns over a landscape CanaReel (the rotate button, both directions): the syslog printed `turn N: ... the old picture held until WebKit has its new layout on screen`, `the page is at the new width` and `new layout on screen ... old picture released` at 408, 402 and 373 ms, no `ERROR`; the MJPEG stream of the turns shows the old picture counter-rotating in its black corners and then the new layout at full size, with no frame of the old layout at its old size beside black. A fourth turn (the viewer closed while landscape) logged only its release line, at 1041 ms, and no frames were recorded for it. The reel's "Pour toi / Recents" tabs stayed centred (centre 195 pt on a 390 pt screen) with the rotate button drawn and the rail was complete (#3537). **Still owed on this row:** an iPad-like resize (Split View or Stage Manager: the `with no rotation ... not held` line was never printed), Android 9-12 and a second Android 13+ maker. Detail: [device-verification](../device-verification.md#the-iphone-12-readings-of-2026-11-15-170-alpha1-first-sitting-on-it).

**iPhone 12, 2026-11-16 (`1.7.0-alpha.4`), the reel pager, PARTIAL.** The turn was driven with WDA's orientation request (the lock-OFF case; the rotation lock itself cannot be set from the bench). A portrait reel REFUSED the turn (`Unable To Rotate Device`, orientation stays PORTRAIT); on a landscape reel ("Reel paysage 1115h") the request turned the window to 844x390 with the rotate button at the top right, the close control and caption clear of the left inset and the action rail on the right; a swipe to the next (vertical) item while turned put the app back in PORTRAIT on its own and a further turn was refused again. In portrait the landscape reel is letterboxed (player 390x220) with "Passer en paysage"; tapping it forced landscape (844x390, button now "Revenir en portrait") and tapping that returned to portrait. **Not read:** the rotation lock ON, the lightbox of a post video, the live viewer and broadcaster, a photo in a mixed gallery, and the Mi 9T lock-OFF turn (no way to turn that phone from the bench).

**Mi 9T, 2026-11-16 (`1.7.0-alpha.5`): not re-read.** The sitting was spent on the sealed-cache upgrade, the reel caption edit, the join and first-contact readings and the feed Back logger; no landscape video or live was staged, so no lock-ON row was read on `alpha.5` (all of them were read on `1.6.12-alpha.2`, above) and the lock-OFF rows stay unreachable for the bench. The entry keeps all its readings; the Mi half owes at most one re-read of the video lightbox and the reel pager on `alpha.5`, about 15 min.
**iPhone 12, fourth sitting 2026-11-16 (`1.7.0-alpha.5`, [readings](../device-verification.md#the-iphone-12-readings-of-2026-11-16-fourth-sitting-170-alpha5)): the lightbox, the live viewer and the broadcaster's preview `PASS` again.** A landscape chat video's lightbox, a live on air and the live preview each turned to 844x390 pt with the rotate button ("Passer en paysage") and back to 390x844 with "Revenir en portrait"; the controls stayed inside the side insets (left 47 / right 47) and the syslog printed `turn N: ... new layout on screen` at 373-467 ms with `old picture released`. The rotation lock's own state was not read (Control Center is not reachable from the bench), and the broadcaster on air, its double tap and a video post's lightbox (a feed video opens the CanaReels pager) were not taken. The Mi 9T halves are in other sittings.

**Mi 9T, 2026-11-16 (second sitting on `1.7.0-alpha.5`, [device-verification](../device-verification.md#the-mi-9t-readings-of-2026-11-16-second-sitting-on-170-alpha5-the-staged-rotation-and-editor-rows)): the reel pager and the live viewer READ again, with a STAGED landscape post and live, under the rotation lock ON and an emulated turn.** `beta` (a web seat) published a 12 s 1280x720 video post and then a live (a 1280x720 fake camera) in the Campus space `alpha` reads. The system's rotation lock (`accelerometer_rotation 0`) with `user_rotation 1` made the video screens turn in place (`configuration changed in place`, 10 of 10 turns `draw released` in 256-374 ms, no `released WITHOUT`, no second `onCreate`) and a swipe to a vertical reel put the phone back in portrait; the rotate button ("Passer en paysage" / "Revenir en portrait") forced landscape and back on both the pager and the live viewer, and closing in landscape (Back) returned to portrait. Feed, `/chat`, `/settings` and `/communities` stayed `SCREEN_ORIENTATION_PORTRAIT` with `user_rotation 1`. **This is NOT the physical turn:** a sensor cannot be tilted from here, so the lock-OFF half stays with the owner's hands-on sitting of 2026-11-15. Left: unchanged (Android 9-12 and a second Android 13+ maker, an iPad-like resize, the iPhone lock ON).


**iPhone 12, 2026-11-16 (`1.7.0-alpha.5`, [readings](../device-verification.md#the-iphone-12-readings-of-2026-11-16-fourth-sitting-b-170-alpha5)): the broadcaster ON AIR and its double tap, read.** On air ("IPH5B on air"), a WDA LANDSCAPE request is refused ("Unable To Rotate Device"; the orientation stays PORTRAIT 390x844) and no rotate button is drawn: the on-air orientation is frozen, as designed. A double tap on the on-air picture does NOT flip the lens (the gesture is a preview feature). A double tap on the PREVIEW picture flips the lens (the scene changed from rear to front) and leaves the title field, mic, camera and rotate buttons unchanged: **PASS**. The same reading found the on-air top row pushing the chat toggle and End off a 390 pt screen (P2 (entry deleted 2026-11-17)) and one live ending itself ([P2](p2-a-live-ended-itself-upload-too-slow-after-256-s-on-the-iphone.md)). Side effect: the refused LANDSCAPE request left the device sideways, so the next preview opened in landscape; PORTRAIT was restored. **Left: the lock-OFF turn of the phone itself (not reachable by the bench).**

**iPhone 12, 2026-11-17: three rows deleted by the owner's decision (20): not stageable on the bench** ([readings](../device-verification.md#the-iphone-12-readings-of-2026-11-17-night-sitting-170-alpha6)): the rotation lock ON (it cannot be set without Control Center), the physical lock-OFF turn of the phone (a sensor cannot be tilted from the bench) and an iPad-like resize (an iPhone has no Split View or Stage Manager). **Left: the Android halves** (Android 9-12 and a second Android 13+ maker, the Mi 9T re-read on `alpha.5`).

**iPhone 12, `1.7.0-alpha.6`, 2026-11-16/17 (seventh sitting, [verdicts](../device-verification.md)):** iPhone 12: the lock IS stageable from the bench (Control Center via a WDA swipe from (370,2) to (370,400), tile at (72,328)). Lock ON, the live viewer rotated to 844 x 390 and back to 390 x 844 with the controls whole. Lock OFF and the lightbox cases were not taken.

**Mi 9T, 2026-11-17 ([readings](../device-verification.md#the-mi-9t-night-readings-of-2026-11-17-170-alpha6)):** the physical lock-OFF turn, Android 9-12 and a second Android 13+ maker are DELETED under the owner's decision (20) (no sensor to tilt from the bench, no second device). What stays: the iPad-like resize and the iPhone lock ON.

**Restored 2026-11-17 (D20 review): two of the iPhone's three deleted rows are stageable.** The rotation lock ON is set from Control Center's lock tile at (72,328), as the seventh sitting of 2026-11-16 did (read there for the live viewer); the lightbox and reel-pager cases of the entry were not taken under it. The physical lock-OFF turn is a WDA orientation set (the app receives a real orientation change with the lock off). Read both on the lightbox, the reel pager and the live viewer, about 30 min. **Only the iPad-like resize stays deleted** (an iPhone has no Split View).

**iPhone 12, 2026-11-17 (`1.7.0-alpha.7`, [readings](../device-verification.md#ninth-sitting-continued-the-alpha7-code-the-institution-form-the-live-bars-trends-rotation-frame-timing)): the live viewer's rotation `PASS` both ways.** With the lock ON from Control Center the rotate button turns the viewer to 844 x 390 and back; with the lock OFF a WDA orientation set turns it and returns it (the driver answers "Unable To Rotate Device" while the app rotates). The close circle looks clipped by the right safe-area edge in landscape (looked at once, not measured).
