## P3 - the conversation rises with the keyboard in one block; Android Messages rises with it frame by frame (owner, 2026-11-14) - a study, not built

The owner, 2026-11-14: Messenger stays the reference for the LAYOUT (every size and margin measured
in [design-reference](../frontend/design-reference.md) holds), but Google Messages does the MOTION
better - *"la fluidite avec laquelle les messages montent avec le clavier, au lieu d'un bloc, tout
est smooth"*. This entry is about the motion only.

**Decided by the owner, 2026-11-14 (asked to build it the same day):**
- **Both directions, both platforms**: the thread and the composer ride the keyboard on the rise
  AND the fall, on Android AND iOS - one mechanism, the ride of `keyboardRide.ts`, extended.
- **On iOS the pieces ride the keyboard's own curve, with no lead**: Apple Messages starts its
  thread ahead of the keys; Canari does not copy that.
- **A short thread sits at the BOTTOM**, against the composer, as in Messenger and Messages
  ([the readings](what-the-keyboard-readings-of-2026-11-14-filed.md), item 4).
- **The bench**: development and checks on the web, then the Mi 9T on a dev build; the owner's
  Pixel 6a only for the final reading of the pre-release, nothing else installed on it.

### What Google Messages does, measured (Pixel 6a, Android 17, 60 Hz, 2026-11-14)

A screen recording of a tap on the composer, then Back, read frame by frame (screenrecord at 20 Mb/s,
each frame's composer pill and last bubble located by template match against the resting frame):

| | frames | duration | travel | shape |
| --- | --- | --- | --- | --- |
| keyboard opening | 17 | ~280 ms | 836 px (physical) | 57 % of it in the first 3 frames, then 88 -> 62 -> 50 -> 38 -> 30 ... 2 px per frame |
| keyboard closing | 16 | ~270 ms | 836 px | the same decelerating shape, in reverse |

- **The composer is glued to the keyboard's top on every frame**: no frame shows the old layout
  under a half-risen keyboard, none shows the final layout before the keyboard is there.
- **The thread moves WITH it, as one surface**: the last bubble follows the composer one frame
  behind (bubble at frame n = composer at frame n-1, every frame of both directions), and the top of
  the thread slides under the header. The header does not move.
- The first 1-2 frames of the opening let the keyboard's toolbar overlap the composer before it
  catches up. That is invisible at speed, and it says the app drives its layout from the
  system's per-frame inset, not from a prediction.
- ~285 ms with a strongly decelerating curve is consistent with the platform's IME insets
  animation; **the design below reads the duration and the interpolator from the callback and
  assumes neither.**

### What Canari does today - Messenger's motion, built 2026-11-13

[keyboard-and-send-motion](../frontend/keyboard-and-send-motion.md) (#3490 Android, #3492 iOS)
copied MESSENGER's motion, which is not Messages': the content takes its keyboard layout in ONE
frame and the keyboard slides under or over it.

- **Android rise**: a `WindowInsetsAnimationCompat.Callback` (`ImeAnimationLog`, log only) selects
  the synced 285 ms slide; the page is handed the target first (`window.canariImeTarget`,
  `imeTarget.ts`, `ImeHandoff`), lays itself out for the keyboard, and the native padding lands once
  `postVisualStateCallback` says that frame is drawn.
- **Android fall**: unchanged - the padding goes at the end, the page relays out once (accepted on
  2026-11-13 because the synced keyboard was expected to cover the band).
- **iOS**: the rise is handed to the page the same way; the fall is RIDDEN (`keyboardRide.ts`): the
  page lays out full height, then every `[data-keyboard-ride]` piece is translated back by its own
  move and animated to its place over the keyboard's duration and curve, on the compositor.

**Measured on the owner's Pixel 6a** (Canari `1.6.12`; a long DM, 2026-11-14, the owner's go), the
same instrument as Messages. **`v1.6.12` is `1.6.12-alpha.2`'s commit plus the bump (`git ls-remote`,
2026-11-14): it carries NEITHER #3490 NOR #3492**, so this is the shipped behaviour BEFORE them - the
baseline, not a reading of either PR:

| | what the frames show |
| --- | --- |
| keyboard opening | 5 frames of the old layout while the keyboard starts; then **3 frames (~50 ms) of a cropped stale frame** (8 before #3490): a blank band where the last bubbles and the composer were; then the whole page in its FINAL layout (868 px up) while the keyboard is still a quarter short |
| keyboard closing | **the composer stays up for 13 frames (~220 ms) while the keyboard slides away**, a blank band growing under it, then the whole page drops 868 px in one frame |

So on Android the shipped rise crops and the shipped fall opens a band ABOVE the keys, under the
composer. #3490's owed readings 1 and 2 are NOT read by this: they need a build that carries it.

### The design: the ride, in both directions, on both platforms

`keyboardRide.ts` already IS the mechanism Messages' motion needs: one layout, then a compositor
transform per piece from where it stood to where it lands, over the keyboard's own timing. What
Messages does that Canari does not is ride the RISE too, and ride on Android at all. So:

1. **Android hands the timing to the page.** `onStart(bounds, duration, interpolator)` of the
   callback that already exists knows the duration and the interpolator: the interpolator is
   sampled (24 points) into a CSS `linear(...)` easing (Chromium 113+), which reproduces the system
   curve exactly, and sent with the target (`canariImeTarget`) on the rise and with a
   `canariKeyboardFall` announcement on the fall - the two hooks iOS already has. ONE message per
   animation, never one per frame.
2. **The page rides both directions.** On a rise it lays out for the keyboard (as today) and rides
   each piece up from where it stood; on a fall it rides them down (as iOS does). The thread's
   bottom pin runs first, so the measured move is the real one.
3. **What was refused, and why**: padding the WebView per `onProgress` frame (17 relayouts of a long
   thread), translating the whole WebView natively (the header would move, Messages' does not), and
   pushing the inset per frame over the bridge (1-2 frames late, by a different amount each frame).

**The open question that decides it**: on Android the native padding still resizes the WebView, and
the cropped frames come from that resize reaching the screen before the page's new frame. A ride
starts from the page's frame, so it hides nothing the resize crops. The hand-off of #3490 already
waits for the page's frame before padding on the rise; the fall has no hand-off. The first prototype
step is the fall's hand-off (announce, ride, then pad), read on the Mi 9T frame by frame.

**Answered by reading the code, 2026-11-14: a fall cannot be ridden while the WebView is resized
for the keyboard, so the WebView must not be.** The fall needs the WebView to GROW before the
composer can ride down into the space it gains. A grown WebView shows nothing new until the page
has drawn at the new size: 8 frames on the rise (Mi 9T, 2026-11-13) and 13 frames on the fall
(Pixel 6a, the composer stuck up for ~220 ms). No order of announce, ride and pad hides that, and
padding at the END of the fall leaves the composer nowhere to ride. So the ride owes a different
contract on Android:

- **The content is never padded for the keyboard.** The WebView keeps its full height. The shell
  announces every keyboard change: its target height, the animation's duration, and its
  interpolator sampled to points that the page turns into a CSS `linear()` easing. It announces
  from `onPrepare`, which knows the animation, so before the keys move. No resize means no stale
  frame in either direction.
- **The page lays out for the keyboard WITHOUT shrinking the thread's box.** The thread's room for
  the keyboard is its bottom padding, which `.keyboard-open .chat-messages-scroll` already adds. The
  composer is placed by the keyboard inset. Then the pieces ride with a FLIP (First, Last, Invert,
  Play): the composer box, and for the thread its ROWS - the scroller's children, as
  `createThreadGlide` already animates them. Riding the scroller's BOX would open a gap under the
  header on a rise (it is translated down), and a box shrunk at once would clip the band the keyboard
  has not yet covered.
- **What it costs, and why it needs a go:** every screen with a text field is then laid out by the
  page's keyboard variables instead of by a resize. Every screen that reads `dvh` or `svh`, or
  places a `fixed` element at the bottom, must be checked: 25 files use viewport units, and 5
  place a fixed element at the bottom. Today the snapshot pins `--app-viewport-height` to the
  visual viewport, so the shell still shrinks. The prototype must switch the Android chat to the
  overlay path and measure every keyboard screen (chat, salon, comments, forms, the PIN dialog,
  search). It is reversible (the shell and the page ship in one APK), so it is a lead's call
  during the owner's absence.

**Decided by the lead 2026-11-14** (the owner's goal: Messenger-smooth both ways): build it, on
these conditions:
1. ONE source of truth for the keyboard room on Android: one module exposes the variables, and no
   screen computes its own.
2. The PR body carries a checklist of every viewport-unit file and fixed-bottom element, each
   ticked with how it was verified.
3. `ImeHandoff`, `imeStep`, `postVisualStateCallback` and the resize path go in the same PR.
4. iOS is untouched unless the same module serves it unchanged.
5. A draft PR, an adversarial review by an agent that did not write it, and every keyboard screen
   read on a debug sideload on the Mi 9T with frames counted. The phone is restored afterwards.
6. It merges only once the readings rule allows.

### iOS, measured on the iPhone 12 (2026-11-14)

Read from WebDriverAgent's MJPEG stream (`mjpegServerFramerate` 60 asked, ~25 frames/s delivered, a
frame every 40 ms), so a curve is coarse but its shape is plain. A full screen in both apps.

| | keyboard opening | keyboard closing |
| --- | --- | --- |
| **Apple Messages** | the thread LEADS: ~75 % of its 309 pt travel in the first 40 ms, the rest eased; the composer rides the keyboard with a spring, ~16 pt past its rest (302) then 286 pt; ~300 ms in all | only by dragging the thread down: the keyboard follows the finger (interactive dismissal). No key, no tap and no drag from the composer closes it |
| **Canari `1.6.12-alpha.2`** (TestFlight, before #3492) | the composer jumps to its FINAL place in one frame while the keyboard is a quarter up, a blank band under it for ~3 frames; the GIF near the end is drawn WHITE for ~4 frames (160 ms) as the WebView's frame shrinks and WebKit repaints; the thread then rises over ~6 frames | a tap on the thread closes it: in the FIRST frame of the fall the whole page drops to its final layout, so the composer is hidden under the still-falling keyboard for ~3 frames |

The bench iPhone ran `1.6.12-alpha.2` (TestFlight), which predates #3492: the fall is not ridden
because that build has no ride - this is the shipped baseline, and #3492's readings are still owed
on a build that carries it. The rise blanking a medium for 160 ms is the WKWebView frame changing under a page
that has not repainted, the iOS face of Android's cropped frames. Messages' spring on the composer is
the platform's keyboard curve (curve 7, the stand-in of `keyboardRide.ts` is to be read against it);
the thread LEADING the keys is a choice Canari need not copy.

### Readings owed before and after a build

- Canari on the Mi 9T on a build carrying #3490/#3492 (`main`), recorded and analysed exactly as
  above (frames, travel per frame, the composer-to-keyboard gap), as the "before" of the ride - the
  Pixel and iPhone readings above are of the code before those two PRs.
- After: the same, with a long DM and a salon, both directions, plus the GIF panel's
  [handoff](../frontend/modules/chat.md#one-attachment-menu-and-a-gif-panel-in-the-keyboards-place-2026-10-02),
  which must still swap with the keyboard in one frame.
- The measuring script (ffmpeg raw frames + numpy template match, ~40 lines) belongs in
  `tools/` if the build goes ahead, so the before and the after are the same instrument.
