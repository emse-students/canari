# Keyboard and send motion - Messenger measured, frame by frame (2026-11-13)

The owner's request (2026-11-13): watch Messenger and Canari _"fraction de seconde apres fraction de
seconde"_ - sending a message, and above all the keyboard opening, _"un probleme general (adaptation
de l'interface a l'ouverture du clavier)"_ - and bring Canari as close as possible to Messenger. Then
(same day) the composer bar's LAYOUT and DIMENSIONS as Messenger's, in Canari's own look.

This page holds the numbers, what was changed for each difference, and what is owed on a phone.
Numbers only: the recordings show private conversations and stay out of the repository.

## Sources

| Recording              | Device                                          | Capture                                                                     | What it shows                                                         |
| ---------------------- | ----------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| owner, Messenger       | owner's Android phone                           | 576 x 1280, variable frame rate, frames 16-18 ms apart while anything moves | keyboard open / close, two sends                                      |
| owner, Canari `1.6.x`  | same phone, light theme                         | same                                                                        | keyboard open / close, three sends, delivery                          |
| bench, Messenger       | Mi 9T, Android 16, LatinIME, `adb screenrecord` | 1080 x 2340, ~60 fps                                                        | keyboard close then open, composer geometry (screenshots)             |
| bench, Canari `1.6.11` | same, dark theme, a test account                | same, plus a per-frame CDP probe of the page                                | keyboard open then close, composer geometry (`getBoundingClientRect`) |

Method: every frame extracted with its presentation timestamp (`ffmpeg -vsync 0`, `ffprobe
pts_time`), then measured per frame by a script: the keyboard's top edge (its background colour from
the bottom up), the composer (the field's fill or the accent glyphs), the last bubble's box and the
new bubble's mean chroma (an opacity proxy). The bench phone is 2.475 px per dp (396 dpi override); a
CSS px in the app's WebView is one dp.

## 1. The keyboard opening

|                                                  | Messenger                                                                                                                                                                                                                                                                                          | Canari before                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyboard motion                                  | slides the full height, OPAQUE, on a decelerating curve: 281 ms on the bench (2340 -> 1454 px), 265 ms in the owner's capture. Share of the way per 16.7 ms frame: 4, 22, 43, 57, 67, 75, 80, 85, 89, 92, 94, 96 ... % - Android's SYNCED IME animation (285 ms, `PathInterpolator(0.2, 0, 0, 1)`) | FADES IN from a short offset, translucent over the page: ~200 ms on the bench, ~120 ms of visible ramp in the owner's capture - Android's UNSYNCED IME animation (200 ms, alpha twice as fast as the travel, an 80 dp offset)                                                     |
| Content (composer, list)                         | jumps to its final place in ONE frame, 35 ms BEFORE the keyboard's first move (bench 3.575 s vs 3.610 s; owner 2.035 s vs 2.051 s)                                                                                                                                                                 | the WebView shrinks at the keyboard's first frame, but shows its LAST frame cropped to the new size until the page draws again: the composer is cut off for **128 ms (8 frames) on the bench, 120 ms (7 frames) in the owner's capture**, then the page jumps to its final layout |
| Band between the content and the rising keyboard | the page's ground (black)                                                                                                                                                                                                                                                                          | the launch background: a dark navy strip under a light page (owner's capture, 7 frames)                                                                                                                                                                                           |
| Composer over the keyboard                       | rides on it from the first frame, field bottom 9.3 dp above the keyboard's top                                                                                                                                                                                                                     | 12 px above it once laid out                                                                                                                                                                                                                                                      |

Why Canari got the other animation: Android plays the synced IME animation only when a
`WindowInsetsAnimation` callback exists in the window's view hierarchy. `MainActivity` pads its
content by the IME inset from an `OnApplyWindowInsetsListener` and registered no callback, and the
WebView registers none either - so the keyboard faded.

## 2. The keyboard closing

|                 | Messenger                                                                                     | Canari before                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyboard motion | slides down, opaque, decelerating: 252 ms (owner), ~200 ms to 98 % (bench)                    | fades out nearly in place: ~180 ms (owner), ~85 ms of visible change (bench)                                                                              |
| Content         | jumps to the full-height layout at the first frame; the keyboard slides off over the composer | the page relays out 100-117 ms after the keyboard starts; meanwhile the composer stays where it was and the page's ground shows under the fading keyboard |

## 3. Sending a message

|                        | Messenger                                                                                                                                                                      | Canari before                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Field                  | cleared on the next frame                                                                                                                                                      | cleared on the next frame                                                                                                                                                                                               |
| The thread making room | GLIDES up by the new row's height: 70 px (one line) over ~217 ms, 16 / 46 / 83 % of the way at a quarter / half / three quarters - a symmetric ease-in-out. Same on both sends | JUMPS by the new row's height in one frame                                                                                                                                                                              |
| The new bubble         | invisible during the glide, then FADES IN where it lands: ~130 ms, no slide (its top stays on the same pixel), no scale. Glide + fade: ~370 ms                                 | fades in AND rises ~10 px (`riseIn`, 260 ms `ease`, 12 px): visible ramp ~165 ms, starting with the jump                                                                                                                |
| Status                 | an "Envoye" line under the last own message moves under the new one; the bubble never changes size                                                                             | "En attente..." then "Envoi..." INSIDE the bubble (two lines tall, its width changing at the switch), then at delivery (~680 ms after the tap) the bubble SHRINKS to one line in one frame and a check appears under it |
| Composer               | the folded icons come back in one frame when the field empties                                                                                                                 | the microphone comes back in one frame                                                                                                                                                                                  |

## 4. The composer bar (bench, dp)

|               | Messenger at rest                                                                                        | Messenger, keyboard up                                                      | Canari before (keyboard up)                                       |
| ------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Left controls | +, camera, gallery, microphone: glyphs centred at 20, 60, 100, 140 - a 40 dp pitch from the edge, no gap | one chevron, centred at 21                                                  | margin 12; "+" 44 at 12-56; gap 8; microphone 44 at 64-108        |
| Field         | 160 -> 392, 42 tall, corner ~20, emoji inside at 374                                                     | 40 -> 392 (396 while typing), 42 tall                                       | 116 -> 368, 44 tall, corner 20                                    |
| Right control | like, centred at 412 (4 dp from the edge to its box)                                                     | like, or send (centred 417) while typing                                    | gap 8; send 44 at 376-420, plus 4 of padding; margin 12           |
| What folds    | -                                                                                                        | all four left controls fold into the chevron as soon as the field has focus | the microphone folds when the first character is typed; "+" stays |
| Vertical      | field bottom 33 dp above the screen's bottom (navigation inset + 9)                                      | field bottom 9.3 dp above the keyboard                                      | field bottom = navigation inset at rest; 12 above the keyboard    |

## What was changed (PR `feat/keyboard-and-send-motion`)

**The keyboard animation (Android).** `MainActivity.applyKeyboardInsets` registers a
`WindowInsetsAnimationCompat.Callback` (`DISPATCH_MODE_STOP`). Its presence selects the synced
animation: the same 285 ms opaque slide Messenger gets on the same phone. This removes the ghost
keyboard on open and close. Since 2026-11-14 the same callback also hands the animation to the page -
section 6.

**The keyboard's room on Android: the hand-off of 2026-11-13 is GONE (2026-11-14).** It announced a
rise to the page (`canariImeTarget(<px>)`), waited for `postVisualStateCallback`, then padded the
content by the IME inset, and the fall padded at once. A padded WebView shows its LAST frame cropped or
stretched to the new size until the page has drawn at that size: 8 frames on the rise (Mi 9T,
2026-11-13) and 13 on the fall (Pixel 6a, 2026-11-14, the composer stuck up for ~220 ms while the keys
slid away). No order of announcing and padding hides that, and padding at the end of a fall leaves the
composer nowhere to ride. `ImeHandoff`, `imeStep`, `handOffIme`, `setImePadding`, the
`postVisualStateCallback` use and their tests were deleted with the resize; section 6 is what replaced
them.

**The send.** `threadGrowthObserver` keeps its instant pin to the bottom, then plays the distance it
jumped as a compositor transform from where the rows were (`appendGlidePx`, `threadAppendGlide.test.ts`):
only for rows ADDED under a reader at the bottom, by less than half the pane - never for the keyboard,
the entry, a batch or reduced motion. Tokens `--motion-thread-glide: 220ms` and
`--motion-ease-in-out: cubic-bezier(0.42, 0, 0.58, 1)`.

- **A glide is taken off the rows before anything is measured** (`createThreadGlide`, review B1). A
  transformed row counts in the scroller's scrollable overflow: measured in headless Chrome,
  2026-11-13, `scrollHeight` grows by `max(0, offset - padding-bottom)` (a 70 px glide over 0, 80 and
  200 px of padding: +70...0, 0, 0). So a pin taken mid-glide - the keyboard, a medium settling, a
  second arrival - went past the real bottom and the rows rose too far, then dropped back. Every
  follow now suspends the glide first (its animations are the state: their eased progress gives the
  offset drawn), measures the layout, then resumes it on the same frame of its curve. Per-frame
  numbers in Chrome, a 70 px arrival over 40 px of padding and the pane shrinking 100 px one frame
  in: before, `scrollTop` reached 1038 against a real maximum of 1010 and walked back over five
  frames, the last row parking at 300 then moving again; after, `scrollTop` is the real maximum on
  every frame and the last row only descends, 327 to 260 (`threadGlide.test.ts` holds it with a
  layout model that inflates the same way, and fails without the suspend).
- **Two arrivals inside one glide** start the second from where the rows are drawn - what the first
  had left, plus the new row - never a jump (review S5).
- **The bubble waits only for a glide that played** (review S6). `.motion-bubble-in` alone is a plain
  `--motion-fast` fade; the observer marks the arriving bubbles `data-glide-entrance` when its glide
  makes room for them, in the same task as their mount, and only those are transparent through the
  glide before the fade. A batch, a jump or a reader scrolled up shows its bubble at once. Neither
  fills, both end opaque (`riseInEntrance.test.ts`).
- **A salon echo is not remounted at delivery** (review B2). `salonEcho` re-keys the echo to the
  server's id; the thread keyed rows by `id`, so the row was destroyed and mounted again, replaying
  its entrance. The row now keeps `renderKey` (the client id it was drawn under) and the thread keys
  by it (`threadRowRekey.svelte.test.ts`, which fails on the old key).

A send in transit ("En attente...", "Envoi...") is drawn under the bubble where its check will be,
in a row held one `--text-2xs` line tall by that token's line height (so text zoom moves it), as a
`role="status"`, so the bubble keeps its size from the tap to delivery; a failure stays inside,
with its buttons. The bubble hands that row its Retry and Delete (`MessageBubble.transitActions`).

**The composer bar (phone, both platforms).** Below 768 px only: controls on a 40 px box with no gap,
a 42 px field (11 px padding), 4 px from the screen's edges, the send's extra padding gone. Expected
with the keyboard up: "+" 4-44, microphone 44-84, field 84-392, send 392-432; while typing, field
44-392. It is the owner's one exception to the 44 px touch floor ([design-reference](design-reference.md)):
a touch tablet keeps 44 px and its gaps, a pointer its 38 px. `iconButtonScale.test.ts` asserts the
rule, not the value: a box under 44 px sits under `pointer: fine`, is the hover strip's `--sm`, or is
this row inside `(max-width: 767px)` (review S4). In iPhone landscape the composer is already inside
the safe area: it is positioned in `ChatArea`'s root, inside the app shell that pads by
`env(safe-area-inset-left/right)` (review N4), so it adds none of its own.

## What is left different, and why

- **What folds - DECIDED, kept as it is (owner, 2026-11-13).** Messenger folds every action into a
  chevron as soon as the field has focus; Canari hides the microphone at the first character typed and
  keeps "+", which already IS the group of actions (the owner's rule of 2026-09-08: _"les icones sur
  les bords disparaissent quand tu commences a taper"_). No chevron fold.
- **The gap above the keyboard**: 12 px against Messenger's 9.3 dp, and at rest the field sits 9 dp
  lower than Messenger's (Canari pads `max(0.75rem, inset)`, Messenger `inset + 9`). Kept: the GIF
  panel's hand-off is built on the same 0.75rem (chat.md), and iOS's home indicator makes `inset +
  gap` a different decision there.
- **The fall no longer resizes anything on Android** (section 6): the composer and the thread ride
  down on the keyboard's own curve, Google Messages' motion rather than Messenger's jump.
- **iOS** had the rise defect in another shape and takes the same hand-off; its fall now rides the
  keys like Messenger iOS's - section 5 below. The composer's dimensions and the send motion are CSS
  and apply there too.

## 5. iOS, measured on the iPhone 12 (2026-11-13)

`1.6.11` TestFlight (dev), iOS 27.0.1, light theme, `canari-test-gamma` in a DM; Messenger in a
test session, observe only, nothing sent. The store build's WebView is not inspectable
(`get-task-allow` false, `webinspector` lists nothing), so the page was not sampled per frame:
the screen was read from WDA's MJPEG stream (`mjpegScalingFactor` 25, a frame every 30-45 ms, so
**one frame here is two to three of the display's**), the native side from `syslog live`
(`[CanariIOS] keyboard overlap=301 -> webview height 543`). Positions are points, as the distance
from where the thing finally rests. WDA freezes the stream while it delivers a tap, so the frames
start with the keyboard already moving.

**The keyboard opening, Canari** (`CanariApplyKeyboardLayout` animating the WebView frame on the
keyboard's duration and curve):

| frame (ms) | keyboard top still to travel | page content still to travel | web composer               |
| ---------- | ---------------------------- | ---------------------------- | -------------------------- |
| 1251       | 240                          | 275                          | half covered               |
| 1288       | 148                          | 269                          | hidden behind the keyboard |
| 1325       | 82                           | 209                          | hidden                     |
| 1364       | 48                           | 127                          | hidden                     |
| 1419       | 23                           | 55                           | half covered               |
| 1474       | 2                            | 5                            | visible, in place          |

On the first frame that moves, the page is ALREADY laid out for the keyboard (the video in the
thread is already its keyboard-up size, and the native "+" twin, placed from the page's rects,
stands at its final place) but it is DRAWN one keyboard overlap lower, then slides up 60-75 ms
behind the keyboard. **The web composer is hidden behind the rising keyboard for four frames
(~150 ms)** while the native "+" floats alone above it - the same shape as the reading of
2026-10-11 on `v1.2.3-alpha.5` ([device-verification](../device-verification.md)), so it was never
fixed. The native completion lands 478 ms after `UIKeyboardWillChangeFrame`. A second run gave the
same picture. No band: the window's ground is `app.html`'s two literals, which are `--cn-bg` in
both themes.

**The keyboard opening, Messenger iOS**: the thread is at its final place on the first frame that
moves, and the composer stands ABOVE the rising keyboard on every frame - 125, 87, 57, 42, then 35 pt
between the field's centre and the keyboard's top - never covered.

**The keyboard closing.** Canari: the page is drawn full height on the first frame after the
keyboard starts down, and the keyboard slides off over the composer - Messenger Android's shape.
Messenger iOS instead keeps its composer riding on the falling keyboard (a near-constant ~58 pt
from the field's centre to the keyboard's top) and scrolls the thread with it. The owner wants
Messenger's, so the fall now rides (below).

### What changed on iOS (PR `feat/ios-keyboard-handoff`, on this branch)

**The rise is handed to the page, as on Android.** `CanariHandKeyboardRiseToPage` calls
`window.canariImeTarget(301)` (the same `imeTarget.ts`); the page lays itself out for the keyboard,
synchronously, inside the still full-size WebView. Then the PROOF that this layout is on screen,
`CanariAfterScreenUpdates`: `takeSnapshotWithConfiguration:` with `afterScreenUpdates = YES` on a 1 pt
rect, which WebKit takes "after incorporating any pending screen updates" - and the page's change is
pending once the script has returned. It is the public form of what Android's `postVisualStateCallback` did for the hand-off of 2026-11-13 (gone
since 2026-11-14, section 6); the private `_doAfterNextPresentationUpdate:` would say the same and is never called in a store build, and
a `CADisplayLink` watching commits sees the UI process's frames, not WebKit's. Only in the proof's
completion is the frame set, WITHOUT animation, since the page already is that picture.

A rise ends, without its proof, on a newer keyboard change or a navigation (the WebView's `URL`, read
by KVO since wry owns the navigation delegate), and says so apart: `rise #n ended WITHOUT its proof
after N ms: <why>`. A content process that dies fails the script's or the proof's completion with an
error: an `ERROR` line, as is a page that does not take the target; the frame is then set at once. A
fall withdraws the page's target with `canariImeTarget(0)` only when a rise was still pending - a rise
that landed spent its target when the WebView shrank.

**What would prove the proof insufficient.** Each rise logs `on screen after N ms (script S ms, proof
P ms)`. Two readings judge it: (1) in the MJPEG frames, any frame at the resize where the web composer
is missing, cropped or one keyboard lower means the snapshot completed before the page's layout was
presented - the proof does not cover what it claims; (2) an N past ~50 ms means the keys are seen
arriving under a composer that has not moved yet - the proof is true but too slow (P says whether the
proof or the script is the cost), and the cheaper order (frame set as soon as the script returns) is
the next candidate.

**Every frame change settles after the page's own reaction.** The frame is set by
`CanariSnapKeyboardFrame`, which removes any animation still running on the WebView's layer first (a
height change overtaken), and the settle - scroll clamp, safe-area publish, the settled report - runs
in a second proof's completion, so the report reads the page AFTER its resize handler and the safe area
is published after the page's CSS variables, never before. Every late callback (a proof, an animation's
completion) is checked against `g_keyboardChangeSeq`: an overtaken one settles nothing, so nothing
reports twice.

**The fall rides the keys** (`keyboardRide.ts`, `CanariHandKeyboardFallToPage`). Before resizing,
the shell calls `window.canariKeyboardFall({ durationMs, curve, fromPx })` with the keyboard's own
`UIKeyboardAnimationDurationUserInfoKey` and `UIKeyboardAnimationCurveUserInfoKey` and the overlap it
had. The page records, for each `[data-keyboard-ride]` piece, the bottom edge of its probe: the composer
footer itself (`"box"`), the thread's last row (`"last-row"` - a scroll container's box does not move when it
grows, its content does, and only by what the bottom pin scrolls). Then the frame is set without
animation. On the resize the page lays itself out full height as before, and the ride is armed: a
`ResizeObserver` created then is notified in the next rendering update after every observer created
before it - after the thread's bottom pin (`threadGrowthObserver`) - and before that frame is painted.
There each piece is measured again and rides ITS OWN move, from where it stood to its new place: a Web
Animations transform over the keyboard's duration and the CSS easing of its curve. A thread shorter
than its box does not move and does not ride; a thread overflowing by less than the keyboard rides its
overflow; a reader scrolled up is not moved. The native "+" twin is re-read on every frame until the
LATEST ride settles (`followKeyboardRides`).

**A ride ends early** - every piece jumps to its place - on any rise (the rise's layout, and the proof
taken of it, must carry no stale transform), on a new fall's capture, and on any pointer press: while a
piece rides it is the containing block of its `position: fixed` descendants, so a picker opened by a
tap during the ~250 ms would be placed against the piece, not the screen.

**Which falls ride, and what is said.** Not announced by the shell, and refused by the page silently
(debug only): an instant fall (duration 0), a keyboard shorter than the page's open threshold (100 pt,
held equal on both sides by a test - a hardware keyboard's shortcut bar), a keyboard of another app
(`UIKeyboardIsLocalUserInfoKey` false), reduced motion. A WARN: a curve UIKit does not define, or a page
already full height when the announcement arrives - the order broke.

**The keyboard's curve 7 has no public definition.** `UIKIT_KEYBOARD_CURVE_EASING`
(`cubic-bezier(0.38, 0.7, 0.125, 1)`) is the ecosystem's stand-in for it, named in one place and NOT
measured here; the fall reading below confirms or replaces it. Curves 0-3 map to their CSS names.
Height changes while open keep the frame animated on the keyboard's curve, unmeasured against
Messenger. Android rides both directions since 2026-11-14 (section 6), with the same
`keyboardRide.ts`; the iOS fall above is unchanged by it - its thread still rides its box.

Tests: `iosKeyboardRiseHandoff.test.ts` reads the native contract against the page's hooks,
`iosKeyboardSettledReport.test.ts` the settle's place behind a proof, `keyboardRide.test.ts` the
parsing, the refusals, each piece's own move and the frame follower, `keyboardViewport.ride.test.ts`
the wiring (the close arming the ride, a rise or a press ending it, the refusals).

## 6. Android since 2026-11-14 - the keyboard covers the WebView, and the page rides it

The owner, 2026-11-14: Messenger stays the reference for the layout, Google Messages for the motion -
the thread and the composer rise and fall WITH the keys, frame by frame
(the study and its build specification: the backlog entry `keyboard-motion-like-android-messages`, merged with its own docs PR). On Android that needed a new
contract, because no ride can hide a WebView resize (above).

**The native half (`MainActivity`, `keyboard/ImeAnnouncement.kt`).**

- The content is NEVER padded for the IME. The WebView keeps its full height in both directions -
  below Android 15 as well: on an API 34 emulator (WebView 113, `enableEdgeToEdge`, 2026-11-14)
  `innerHeight` and `visualViewport.height` stayed 915 open and closed, the listener read an 883 px IME
  inset, `onPrepare` announced 285 ms with a `PathInterpolator`, and the page took `336.38` (F6).
- `ImeAnimationCapture` (the insets-animation callback, `DISPATCH_MODE_STOP`) keeps what `onPrepare`
  says about an IME animation - before the keys move: its duration, and its interpolator sampled at 24
  evenly spaced points over `[0..1]` (`sampleImeCurve`; a null interpolator is linear, a non-finite
  sample sends no curve). `onEnd` drops what no inset change took. A NEGATIVE duration is a
  CONTROLLED animation (`getDurationMillis()` is -1 when a gesture drives the inset: the
  predictive-back IME dismissal of targetSdk 36) and is announced as no animation at all
  (`rideableImeAnimation`); `ImeAnimationSpec` cannot even be built with one. The page refused a
  negative duration, and the refusal used to leave a keyboard-sized inset for good (review F2).
- The insets listener announces each CHANGE of the IME inset once:
  `window.canariImeTarget({ px, durationMs, curve })` (`imeAnnouncementScript`), `px` in CSS px
  (`imeCssPx`), `durationMs` and `curve` absent for a change with no animation (a rotation). One logcat
  line each: `IME inset: <px> px -> page told <css> (<ms> | no animation; <why>)`.
- An inset counts as told only once the page TOOK it (`ImeAnnouncements`); an announcement in flight
  is not sent twice (a second one would end the first one's ride). It used to be marked told BEFORE
  `evaluateJavascript` ran, so a refused value was never re-sent. The script answers which of three it
  is (`ImeAnswer`, classified by `imeAnswerOf`): `taken`; `not-ready` (no hook yet - `pageReady`
  announces); `refused` (anything else, a script error included): a broken contract, `Log.e`, and NOT
  re-sent by the next insets pass (the same page refuses the same way, and with a steady keyboard no
  pass came, so the page stayed desynced - second review). It is re-sent on the page's next ready
  signal: the page calls `pageReady` right after refusing an ANIMATED announcement, and is told the
  inset without one, which it always takes - so it asks at most once per refusal.
- `window.canariIme.pageReady()` (a new document, or the page after a refusal) forgets what the page
  held and re-announces the current inset, without animation. An answer from before it is stale
  (`ImeTicket.page`) and changes nothing, whichever reaches the UI thread first.
- The insets are passed on UNTOUCHED, the navigation bar's included (review D2, below). Kept:
  `canariTheme.setGround` still paints the page's ground under the transparent WebView (no band opens
  any more; the readings say whether a transparent strip ever shows it).

**The page's half: ONE module owns every keyboard variable, and writes it to TWO targets** (the leaf
channel, below) (`keyboardViewport.svelte.ts`, with the
pure `imeTarget.ts` and `keyboardRide.ts`). An object announcement is an OVERLAY target: never spent by
the viewport, 0 included, so the shell is the one source of the keyboard's room for as long as the page
lives (what the WebView reports of its own visual viewport is not read). Its measurement keeps the
layout at the window's REAL height (`innerHeight`, `overlayPx`) - never the baseline, which only grows:
a window made shorter for another reason (split screen, a freeform window, DeX, a fold) left the shell
870 px tall in a 450 px window (review F1). The snapshot gives every screen:

| variable                             | the Android app                                                                            | the web, iOS, an older shell  |
| ------------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------- |
| `--app-viewport-height` (while open) | never written: the shell keeps `100dvh`, the window's own height (the leaf channel, below) | the visible height, as before |
| `--keyboard-layout-inset-bottom`     | the keyboard's height, from its first pixel (a keyboard under the open threshold included) | 0, as it always was           |
| `--keyboard-occlusion-bottom` (new)  | the keyboard's height: what it covers of the WINDOW, for `fixed` elements                  | 0                             |

`--safe-area-inset-bottom` is pinned to `0px` while the overlay keyboard covers the window
(`keyboardSafeAreaBottomOverride`, from its first pixel), and `--keyboard-free-viewport-height` is never
written for an overlay. `isOpen` keeps the threshold every platform reads it with (it hides the bars and
remembers the keyboard's height). The web and iOS compute exactly what they computed before:
`keyboardViewport.overlay.test.ts` keeps the previous `computeSnapshot` as an oracle and checks every
measurement the suites hold, plus a grid of 1080 shapes around them.

**The ride, both directions.** `canariImeTarget` with an animation captures every `[data-keyboard-ride]`
piece where it stands, applies the layout at once, and - once the layout reactions have run (the
thread's bottom pin first, `afterLayoutReactions`) - rides each piece from where it stood to its place
on `linear(<points>)` (`linearEasing`, built from the numbers: 2 to 64 finite points, no CSS crosses
the bridge). `rideDistancePx` is signed: up on a rise, down on a fall. The composer rides its box. The
thread (`last-row`) rides its ROWS, the scroller's children as `createThreadGlide` moves them, never its
box: the box keeps its height, its room for the keyboard is its bottom padding
(`.chat-messages-scroll`), so a box ridden up would open a gap under the header and a box shrunk at
once would clip the band the keyboard has not covered yet. A send's glide still in flight is taken off
the rows (`takeThreadGlideOff`) after their drawn top is read. No ride: reduced motion, no animation, an
instant one. A press or a new announcement ends a running ride (`endRides`) - AFTER the new capture
has read where the pieces are DRAWN (`getBoundingClientRect` includes the transform), so a Back
mid-rise starts the fall from where the composer stood on screen, not from the rise's end (review F3).
The iOS hooks (`canariImeTarget(<number>)`, `canariKeyboardFall`) keep their own paths.

**The ride IS the keyboard's timeline (review D1).** Measured on the Mi 9T (debug build, 2026-11-14,
`screenrecord` at 60 fps + a per-frame CDP probe): the target arrives 2-10 ms after `onPrepare`, but the
ride started 60-75 ms later (the frame the layout reactions run in) and then ran its full 285 ms -
the keyboard at 62% of its rise with the thread unmoved, the composer under the keys for 4 frames; on
the fall the keyboard gone (180 ms) before the thread moved, a band of nothing, then the thread alone.
So `takeImeTarget` records the arrival (`now()`, the Android object path only) in the capture
(`announcedAt`), and each ride animation's `startTime` IS that arrival (`document.timeline` shares
`performance.now`'s origin): whatever frame first draws it draws the keyboard's phase there, and both
end together. A negative `delay` measured when the ride was created landed up to a frame late - a
pending animation starts on the NEXT frame, from 0 plus the delay (second review). `ridePhaseMs` only
says where the first frame is, and whether the keyboard has already landed. A ride that could only start after the
keyboard landed does not animate - the pieces stand at their place. This is phase alignment to an
animation whose duration and curve are known, not a timeout: the animation's own end still ends it.
The iOS fall has no arrival time and starts at 0, as before.

**One writer of the thread's bottom (review D2).** The probe saw `scrollTop` 3727 -> 4085 at the
ride's first frame, then 4073 one frame later (3715 then 3727 on the fall): the rows moved 7-12 px
under the ride. The two writers: the shell withdrew the navigation bar's inset while the keyboard was
up, and Chromium applies a changed inset to `env(safe-area-inset-bottom)` a frame or more AFTER the
announcement - the composer's floor `max(0.75rem, 23.8px)` fell to `0.75rem`, 12 px, one frame late;
and `--chat-composer-height`, published one frame after any footer resize (`composerHeight.ts`),
followed it a frame later still, the thread's padding shrinking and `scrollTop` clamping under the
ride. Now: the shell passes the insets on untouched; the page pins `--safe-area-inset-bottom` to 0 in the
announcement's own task; the footer's floor is ONE custom property, `--chat-composer-floor`, which
the thread's padding composes in CSS (`composer height without its floor + floor + keyboard room`), so
the floor and the padding change in the same style pass, and a keyboard move changes nothing the
publisher sees. No component reads `env(safe-area-inset-bottom)` but `app.css`'s definition of the
variable (the media viewer's info sheet and the video controls did, and kept the bar's strip under the
keyboard; `safeAreaBottomPin.test.ts` guards it, second review). The shell's half is guarded by
`androidWindowLayout.test.ts`, which reads the insets listener's own balanced block, not a lazy match
that could end in a later one. And `keyboardChangeResponse` no longer scrolls a reader who was at the bottom: the
thread's observer pins that reader in the keyboard's own layout, before the ride reads where the rows
went; the ChatArea effect answers only for a reader ABOVE the bottom whose composer the rising keyboard
is for (the Android "field still focused after Back" case of 2026-10-29), which the observer leaves
alone.

**Every read before the first write (review D3).** LoAF on the Mi 9T gave the announcement ~38 ms of
main thread, 28-33 ms of it forced style and layout. `innerWidth`, `innerHeight` and
`visualViewport.height` bring style and layout up to date on Android (the viewport meta is enabled),
and two of them ran AFTER the keyboard's `:root` variables were written - `rememberKeyboardHeight`'s
orientation (rises) and the baseline's `Math.max(..., innerHeight)` (falls) - each forcing a
whole-document style pass. Now `takeImeTarget` reads in order: the arrival time, the ground under the
keyboard (`postGroundToNative`: a hit test and computed colours), the window (`readWindow`, one
`WindowReading`), and every riding piece's drawn top (`captureKeyboardRide` only reads); then writes:
ends the running ride, takes a glide off (`releaseThreadGlides`), writes the variables (`update(reading)`,
which reads nothing after). `startKeyboardRide` reads every probe before its first `animate`. What
could NOT be removed: the ground's hit test is still a read in the announcement (it is first, so it pays
only what earlier work left dirty - normally nothing), and the style pass the variable writes cause was
the frame's own, now paid once by the renderer instead of forced in script; the inset listeners
(fixed popovers, F4) read layout on the NEXT frame, never in the task. Owed: the LoAF reading again on
this build. (Superseded by the leaf channel, below: the announcement no longer writes `:root` at all.)

**A message arriving mid-ride (review F8).** The thread's glide and the ride both animate the rows'
`transform`, and the later one replaces the other: the rows jumped from the ride's offset to the
glide's. The ride registers its row animations with the thread's observer (`attachThreadRide`); an
arrival takes them off where they drew the rows (`fromPx` times what is left of the eased progress) and
the glide starts from that offset plus the new row - negative on a fall, the rows drawn above their
place. The ride yields: the rows finish on the glide's curve, the composer rides on. A change that
brings no arrival leaves the ride alone.

**The baseline follows the window width, not a timer (review F1).** The 400 ms timer after
`orientationchange` that reset the baseline is gone: the overlay no longer reads the baseline at all,
and for iOS and a phone browser a new `innerWidth` IS a new window (not while pinch-zoomed: WebKit's
`innerWidth` follows the zoom). A keyboard never changes the width. The new baseline is a SETTLED
reading's height (second review): each update at the new width replaces it until the layout and the
visual viewport agree on the size, width and height (`isSettledWindow`), and from then on only `max()`
raises it. Taken from the first update, a transient taller post-rotation `innerHeight` stuck for good.

**Every keyboard screen is on the module's variables** (the inventory of 2026-11-14 is the PR's
checklist): inside the shell, the chat's composer is placed by the layout inset and its thread padded
by it, and every other page's scroller ends above the keyboard (`.page-scroll-wrap` takes the layout
inset as its `bottom`, the chat's excepted); a `fixed` layer with a field keeps its content clear of
`--keyboard-occlusion-bottom` (`[data-keyboard-aware-overlay]` and its panel cap, `ModalOverlay`, the
comments drawer, the live, broadcaster and CanaReels editor bars, the publish and send sheets, the carte
editor, `.side-panel`, the navigation drawer, the message actions, the tablet toasts, the GIF picker's
full screen). `[data-keyboard-aware-toast]` had no user and was deleted. After review: a panel inside
`ModalOverlay` is capped by the overlay's box, `min(<n>vh,100%)` (the poll composer, the GIF picker;
guarded by `ModalOverlay.test.ts`), the live chat by `0.38 x (100vh - occlusion)`, and every
`bindFixedPopover` panel (emoji pickers, mentions, `FloatingSurface`) re-places on the store's
`placeOnKeyboardMove` (it was `onKeyboardInsetChange` and a next-frame placement until the leaf channel, below) -
neither viewport fires anything for an overlay keyboard (F4, F5). The unused
`--keyboard-baseline-height` was deleted.

**Read on the Mi 9T at f364f3c47 (2026-11-14, debug sideload; the numbers are on the PR).** Once
moving, the thread and the composer follow the keys frame by frame in both directions (D1). One
`scrollTop` write per keyboard move (D2), and no forced style or layout in the announcement's script
(D3). Still owed: the ride starts 40-105 ms after the announcement (161 ms in the emoji picker), because
the announcement frame recalculates the whole document's style. Any custom-property write on `:root`
costs 17-30 ms on 1156 elements, against 0.2 ms on one leaf. That latency, and the emoji picker that
jumps rather than rides (N2), are the stacked follow-up's.

**THE LEAF CHANNEL - ONE WRITER, TWO TARGETS (stacked on #3556, 2026-11-14).** Measured on the Mi 9T at
6d74c1437 (debug, WebView 152): the ride started 40-105 ms after the announcement (146 ms in the
comments drawer's fall, 161 ms in the emoji picker) and, being phase-aligned, its first visible frame
was already at 50-70 % of the travel - ~3 frames of composer under the keys on a rise, ~3 frames of
black band on a fall. The announcement frame's trace: 12-16 ms of script, then `UpdateLayoutTree`
36.5 ms (28.5 + 24.9 ms on two frames for a fall), then ~7 ms of paint. In the page through CDP (1156
elements, forced style): ANY custom property written on `:root` costs 17-30 ms, an unused `--zz`
included (24-83 ms); the same write on one leaf, 0.2 ms; a class toggle on `:root` with no rule, 0.
`bench/keyboard-announcement/run.mjs` reproduces the shape in a desktop Chromium (923 elements, CPU x4):
`:root` 27-35 ms; a REGISTERED inherited property on `:root` 28 ms (so `@property` alone, option (b),
buys nothing); an UNREGISTERED variable on the thread's scroller 20-24 ms (its 842 descendants inherit
it); a REGISTERED NON-INHERITED one on the scroller 0.1-0.7 ms; an unchanged value 0.

So `keyboardViewport` writes ONE computation (`keyboardVariables`) to TWO targets:

- **The riding pieces, in the announcement's task.** Every element whose own rules read the keyboard's
  room carries `data-keyboard-leaf` - the composer's footer (`bottom`, its floor), the thread's scroller
  (its padding) and the comments drawer's sheet (`bottom`, `max-height`, its safe area) - and gets the
  twins `--keyboard-leaf-layout-inset-bottom`, `--keyboard-leaf-occlusion-bottom` and
  `--keyboard-leaf-safe-area-inset-bottom` (`keyboardLeafValues`). They are registered
  `inherits: false` with no initial value (`app.css`), so a twin restyles its element alone, and an
  unwritten one falls back: every such rule reads `var(--keyboard-leaf-x, var(--x))`. The floor and the
  room are resolved on the two chat pieces themselves (`--chat-composer-floor`, `--chat-keyboard-room`,
  also non-inherited): resolved on `:root`, the floor carried the root's safe area down already
  substituted. A released pin's twin is what the root goes back to: the inline value the pin replaced,
  else `--safe-area-inset-bottom-unpinned`, the stylesheet's own value under a name no pin replaces.
- **`:root`, once the ride's first frame is out** - in the next rendering update's animation frame,
  requested from the ride's start (which runs in the layout reactions, after that update's frames): an
  event, never a timer. Not the animations' `ready`: the ride sets their `startTime` to the arrival,
  which settles it at once. The root takes the same values and the twins come off in
  that task, so every piece reads the same lengths through either name and nothing moves twice (the
  bench reads the footer's offset and height, the thread's `scrollTop`, padding and last row before and
  after that write: identical). The whole-document pass then lands while the compositor runs the ride.
  An announcement with no ride (no animation, reduced motion, nothing captured), a ride that moved
  nothing, a press before the first frame and the teardown write the root at once. A new announcement
  before that frame holds its own values instead; the WebView's no-change `resize` (N3) refreshes the
  pieces, never the root.
- **`--app-viewport-height` is no longer written for an overlay keyboard**: it pinned the shell to
  `innerHeight`, a whole CSS px, where `100dvh` is the window's exact height - moving every piece by the
  difference on the root's write.

Option (a) of the brief, decided by those numbers; (b) measured and refused (a registered inherited
property costs what an unregistered one does), and narrower scoping refused for the same reason (the
pieces' subtrees are most of the document - the thread). What stays on the critical path: the
announcement's reads (the ground's hit test first) and the pieces' own restyle, ~1 ms.

**N2: the popovers ride.** A `bindFixedPopover` panel registers with `placeOnKeyboardMove`. Its drawn
top is captured with the other pieces in the announcement; it is placed once the new layout is in -
a `ResizeObserver` on the document root created before the ride's, so the placement runs first in the
same rendering update, and observing the shallowest element keeps a panel resized by its new place
from being reported as a `ResizeObserver` loop - and it rides from where it was drawn to that place on
the keyboard's curve. It used to be placed on the next animation frame and jump there with the keyboard
half-way. Outside the Android ride (iOS, the web, an unanimated change) the panel is placed in the same
rendering update as before - after layout instead of in an animation frame, the same frame painted - and
it is not ridden: the iOS fall captures no panel.

**What iOS sees.** Unchanged: iOS never writes the leaf channel (only an Android announcement that is
ridden does), `--app-viewport-height` is still pinned there, and the floor and the drawer's terms resolve
to the same root variables as before, now on the pieces instead of `:root`. The one shared change is the
panels' placement on a keyboard change, moved from an animation frame to the layout reactions of the
same rendering update.

**Not measured on a phone yet (owed):** the ride's start after the announcement and its first visible
frame on the Mi 9T, rise and fall, in the salon, the drawer and the emoji picker; a LoAF of the
announcement (no `UpdateLayoutTree` of the whole document in it) and of the frame after (the deferred
pass). Read at 6d74c1437's logs: the ride listed ONE distance (`-346px`, the thread's rows) - the composer
band (`absolute bottom-0`, height 0) never moved, its footer moving inside it by `bottom`, so the
composer jumped. Riding a box by its bottom edge (above) does not change that: the band's bottom does
not move either (`bench/keyboard-announcement` reports which elements ride - the band is not among
them); OPEN, owed to the base branch, which owns the riding pieces. The script-placed panels ride by
the bottom edge like every box.

**Two fixes from that reading.** N3: the Android WebView fires a window `resize` and a visual-viewport
`resize`, with no size changed, ~15 ms after every overlay announcement. Each one re-ran `update()`,
which revealed the focused field again (`smooth`): three reveals per rise. A later update now reveals
only when the keyboard MOVED (`keyboardMoved`): its inset OR the visible height changed. The inset alone
regressed iOS and resizes-content browsers (second review): there the WebView is resized, `insetBottom`
is always 0 (the hand-off included), and a keyboard changing height while open (the emoji keyboard, the
predictive bar) no longer revealed a modal's field. The Android no-op resizes change neither. N4: the comments
drawer is a riding piece (`data-keyboard-ride="box"`), where it used to jump 68 ms (rise) and 138 ms
(fall) after the announcement. It rides by its BOTTOM edge, like every rider (`rideEdgeOf`, second review): its cap subtracts the
keyboard, so it also shrinks (~567 to ~510 px on the Mi), and ridden by its top its bottom stood ~57 px
above the keys at the rise's start. For a piece that keeps its height (the composer footer, the newest
row) both edges ride the same distance. `.keyboard-aware-bottom` lost its 180 ms `ease` transition: the sheet's
inline `transition: none` overrode it, and a clock of its own could only disagree with the keyboard's.
The sheet also rides the iOS fall, through the same `canariKeyboardFall` capture as the composer footer.

**The composer rides by its FOOTER (Mi 9T reading of 2026-11-14).** The marker sat on ChatArea's
composer band (`absolute inset-x-0 bottom-0`, no height of its own). On the Android overlay the band never
moves - the window keeps its height - and only the `.chat-composer-footer` inside it does (`bottom:
var(--keyboard-layout-inset-bottom)`), so the ride measured 0 px and the composer jumped to the keys at
the end while the thread glided. The marker is now on the footer (`ChatComposer.svelte`); on iOS the
footer moves with its band, so that reading is unchanged, and exactly one of the two may carry it or
the footer rides twice (`iosKeyboardRiseHandoff.test.ts`).

**The Android app declares the keyboard an OVERLAY to the engine (Mi 9T reading of 2026-11-15).** With
the footer riding, the first re-read showed the composer a whole keyboard ABOVE the keys and the header
off the screen. The WebView (152) receives the IME inset and shrinks its visual viewport (945 to 588
CSS px) without resizing the layout; on the keyboard's show Chromium scrolls the focused field into
that shrunk viewport, and while the footer rides its caret is still DRAWN at its old place under the
keys - so it panned the visual viewport by the keyboard (`visualViewport.offsetTop` 357.58), on top of
the page's own move. Removing the marker live removed the pan, which is how the cause was named.
`initKeyboardViewport` now sets `navigator.virtualKeyboard.overlaysContent = true` when the shell's
bridge `canariIme` is present (`declareKeyboardOverlay`): 0 pans in 6 taps against 6 in 6 without it,
on the same build. The WebView still shrinks the visual viewport (its `boundingRect` stays empty, so
the API is honoured only as far as the pan), and a field outside a ride is still revealed by the page
(`keyboardRevealOnUpdate`): a poll option under the keys scrolled above them with the declaration on.
The browser and the iOS app never declare it - there the engine's own keyboard handling is the contract.

**A reveal follows what COVERS, not what is OPEN (review of #3556).** With Chromium no longer revealing
the field, the page's reveal is the only one, and it was gated on `isOpen` - over the open threshold
(160 px on Android). A one-row IME, a floating or split keyboard or the ADB keyboard stays under it
while the overlay still lifts the shell by its height, so a field under it stayed covered.
`keyboardCovers` answers the reveal's own question: under the overlay any inset above 0 covers;
elsewhere the engine resizes for the keyboard and `isOpen` stays the answer. `isOpen` keeps its own
jobs (the bars, the remembered height).

## Owed on a phone (nothing here is measured after the change - it needs a build)

On the Mi 9T, a pre-release, the same three recordings (`adb screenrecord`, the frame script):

1. Keyboard open, on a debug sideload of the ride (section 6), frames counted: a 285 ms opaque slide;
   logcat `IME animation: 285 ms` then `IME inset: <px> px -> page told <css> (285 ms; the keyboard
   moved)` and the page's `keyboard to <css> ridden over 285 ms from <N> ms in`; the composer on the keys' top on every
   frame (no frame of the old layout under a half-risen keyboard, none of the final layout before the
   keys), the last bubble following it, the header still; no cropped or stretched frame; never `the
   page did not take the keyboard`.
2. Keyboard close: an opaque slide down, no fade, the composer and the thread riding down with it.
3. Send: the thread glides ~220 ms, then the bubble fades in; the bubble's box unchanged from the tap
   to the check. In a salon, no second fade at delivery. Two sends in a row, and a send with the
   keyboard closing mid-glide: no row rising past its place, `scrollTop` against `scrollHeight` per
   frame through CDP.
4. The composer's boxes read through CDP against the expected numbers above, light and dark.
5. A field in a modal (the PIN change dialog): revealed at once when the keyboard opens, no smooth
   scroll under it. A pull-to-refresh reload with the keyboard up: the composer still lifts
   (`IME inset: <px> px -> page told <css> (no animation; the page started a new document)`). Then
   every screen of the ride's checklist with its keyboard up and down: a salon, the comments drawer
   (post and CanaReel), a form, the search, a `ModalOverlay` prompt, the live chat, and the GIF panel
   swapping with the keyboard in one frame.

And on the iPhone 12, a pre-release carrying both PRs (the store build cannot be inspected, so the
MJPEG stream and the syslog are the instruments, as in section 5):

6. Keyboard open in a DM, five times: syslog `keyboard overlap=301 -> webview height 543, handed to
   the page first` then `keyboard rise #n: the page's keyboard layout is on screen after N ms`, and
   never an `ERROR` line. In the frames, the web composer above the keyboard on every frame from the
   first one that moves (no frame where it is hidden or the page is drawn lower), the native "+"
   beside its web twin, no band, no cropped frame. N, five values: the two readings that would prove
   the proof insufficient are above.
7. Keyboard close in a DM resting on its last message, five times: syslog `keyboard fall (N ms, curve
   7): the page rides it` and the page's `keyboard fall ridden over N ms: D, D px`. In the frames, the
   gap from the field's centre to the keyboard's top near-constant through the fall, like Messenger's
   ~58 pt (a gap that grows then closes means the curve-7 stand-in leads or lags the keys), the thread
   moving with the composer, no frame with the composer at the bottom before the keys get there. **The
   native "+" against its web twin on every frame of the fall**: it is re-read per frame over the
   bridge, so a "+" trailing the web composer by a frame or more is the cost of that bridge, measured
   here. Then: a thread with two short messages (shorter than its box) - only the composer rides
   (`D px`, one value); a thread scrolled up a screen - the same; once with Reduce Motion on - no ride,
   the page full height at once, no WARN. And a tap on the thread during a fall: the ride ends, the
   pieces at their places, nothing left translated.
8. Open, then switch to the emoji keyboard and back (a height change while open), then close before
   the rise lands (tap the field and the thread at once): the frame always ends at the keyboard's
   edge, `ended WITHOUT its proof` when a rise was overtaken (never confused with a slow one), never a
   ride left half way, and one settled report per change, never two.
9. The composer's dimensions and the send motion, which apply there unchanged, and the composer in
   landscape clear of the notch.
