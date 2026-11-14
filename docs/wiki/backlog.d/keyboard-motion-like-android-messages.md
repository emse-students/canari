## P3 - the conversation rises with the keyboard in one block; Android Messages rises with it frame by frame (owner, 2026-11-14) - a study, not built

The owner, 2026-11-14: Messenger stays the reference for the LAYOUT (every size and margin measured
in [design-reference](../frontend/design-reference.md) holds), but Google Messages does the MOTION
better - *"la fluidite avec laquelle les messages montent avec le clavier, au lieu d'un bloc, tout
est smooth"*. This entry is about the motion only. **Not to be built until the owner asks** (the
directive of 2026-11-11: no new feature unless asked).

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

### What Canari does today

`MainActivity.applyKeyboardInsets` ([mobile](../frontend/mobile.md#androidwindowsoftinputmodeadjustresize-is-inert-and-the-manifest-still-carries-it))
pads `android.R.id.content` by the IME inset from a plain `OnApplyWindowInsetsListener`, which
sees only the END state. Reading #42 (Mi 9T, 2026-11-14, [chat](../frontend/modules/chat.md)):
`innerHeight` goes 945 -> 855 **in one frame**. The whole page jumps by the keyboard's height once,
while the keyboard itself takes ~280 ms to slide. That is the "bloc".

**Measured the same way as Messages, on the same Pixel 6a** (Canari `1.6.12`, the current stable,
no keyboard change on `main` since; a long DM, 2026-11-14, the owner's go):

| | what the frames show |
| --- | --- |
| keyboard opening | 5 frames of the old layout while the keyboard starts; then **3 frames (~50 ms) where the WebView is already shrunk but its bottom is not repainted**: a blank band where the last bubbles and the composer were, the keyboard rising into it; then the composer appears at its FINAL place (868 px up) while the keyboard is still a quarter short, the gap filling as it finishes |
| keyboard closing | **the composer stays up for 13 frames (~220 ms) while the keyboard slides away**, a blank band growing under it, then the whole page drops 868 px in one frame |

So the defect is worse than a jump: both directions show an empty band, and the closing one lasts
most of the animation. Both come from the same fact - the listener sees only the end state, and
applies it at the start of the opening (too early) and at the end of the closing (too late).

### Is it possible in a Tauri app: yes, the hook is ours

`MainActivity` is our Kotlin, and `WindowInsetsAnimationCompat.Callback` (API 30+ native, compat
below) gives `onPrepare` / `onStart(bounds, duration, interpolator)` / `onProgress(insets)` per frame
/ `onEnd`. What a WebView makes hard is not the signal but **who moves the pixels**:

| option | what moves per frame | verdict |
| --- | --- | --- |
| A. pad the WebView on every `onProgress` | a Chromium RESIZE + relayout per frame (17 of them) | refused: a layout per frame on a long thread is the jank we want gone, and the resize reaches the compositor frames late |
| B. translate the whole WebView natively (`translationY`) | one native layer | refused: the header moves too, and Messages' header does not |
| C. push the inset to the page every frame (`evaluateJavascript`) | a CSS transform | refused as the primary path: a bridge hop per frame lands 1-2 frames late, and late by a different amount on each frame |
| **D. ONE message at `onStart`, the page runs the animation on its compositor** | a CSS `transform` on the thread + composer, no layout | **recommended** |

**D in detail.** At `onStart` native knows the from/to insets, the duration, and the interpolator.
It samples the interpolator (say 24 points) and sends ONE event with
`{ fromInset, toInset, durationMs, easing: "linear(0, ...)" }`. CSS `linear()` (Chromium 113+)
reproduces the system curve exactly, so the page needs neither a guess nor a per-frame hop. The
page then translates ONE wrapper (the thread scroller and the composer, under the header and
clipped by it) from `0` to `-inset`, as a compositor animation that keeps running while JavaScript
is busy, and swaps the transform for the real layout at the end.

### The open question that decides the build

**The end swap must land in ONE frame**: removing the transform and shrinking the layout by the
same amount, or the thread jumps once at the end. With today's split, the native padding resizes
the WebView and the web owns the transform: two owners, no guarantee they land in the same frame. A
ledger that reconciles them afterwards is a heal, not a fix ([CLAUDE.md](../../../CLAUDE.md)). The
two shapes that give ONE owner:

1. **The page owns the keyboard's room on Android** (as `keyboardViewport` already does for a
   browser): native stops padding and hands the inset to the page, which sets its own bottom
   inset and drops the transform in the same task. The question to answer FIRST, on the Mi 9T, with
   a prototype: does Chromium, unresized, still scroll the document onto the white band when a field
   is focused? That band is why the native padding exists ([mobile](../frontend/mobile.md#androidwindowsoftinputmodeadjustresize-is-inert-and-the-manifest-still-carries-it)).
2. **Native keeps the padding, applied at `onStart` instead of at the end, and the page drives its
   transform off the RESIZE it observes** (the resize is the fact, the `onStart` message only
   supplies the curve), transforming from `+remaining` to `0`. One owner per frame, at the cost of
   1-3 frames at the start where the keyboard overlaps the old composer, the same lag Messages
   itself shows.

Shape 2 is the smaller change and keeps the white-band fix untouched. Shape 1 is the cleaner one if
the prototype says Chromium behaves.

### iOS, measured on the iPhone 12 (2026-11-14)

Read from WebDriverAgent's MJPEG stream (`mjpegServerFramerate` 60 asked, ~25 frames/s delivered, a
frame every 40 ms), so a curve is coarse but its shape is plain. A full screen in both apps.

| | keyboard opening | keyboard closing |
| --- | --- | --- |
| **Apple Messages** | the thread LEADS: ~75 % of its 309 pt travel in the first 40 ms, the rest eased; the composer rides the keyboard with a spring, ~16 pt past its rest (302) then 286 pt; ~300 ms in all | only by dragging the thread down: the keyboard follows the finger (interactive dismissal). No key, no tap and no drag from the composer closes it |
| **Canari `1.6.12`** (store build) | the composer jumps to its FINAL place in one frame while the keyboard is a quarter up, a blank band under it for ~3 frames; the GIF near the end is drawn WHITE for ~4 frames (160 ms) as the WebView's frame shrinks and WebKit repaints; the thread then rises over ~6 frames | a tap on the thread closes it: in the FIRST frame of the fall the whole page drops to its final layout, so the composer is hidden under the still-falling keyboard for ~3 frames |

So iOS shows the Android defect mirrored: the shrink applied at once on the rise, the growth applied
at once on the fall, and a repaint that blanks media in between. The same design applies, with a
different source: `UIKeyboardWillChangeFrame` carries the duration and the curve, and
`CanariApplyKeyboardLayout` ([mobile](../frontend/mobile.md#ios-shrinks-the-webview-and-that-is-the-same-decision-taken-twice))
resizes the WebView's frame in one step today. Messages' spring on the composer is the platform's
keyboard curve; the thread leading is a choice Canari need not copy.

### Readings owed before and after a build

- Canari on the Mi 9T, recorded and analysed exactly as above (frames, travel per frame, the
  composer-to-keyboard gap), as the "before". Reading #42 gives the one-frame jump but not the
  per-frame gap.
- After: the same, with a long DM and a salon, both directions, plus the GIF panel's
  [handoff](../frontend/modules/chat.md#one-attachment-menu-and-a-gif-panel-in-the-keyboards-place-2026-10-02),
  which must still swap with the keyboard in one frame.
- The measuring script (ffmpeg raw frames + numpy template match, ~40 lines) belongs in
  `tools/` if the build goes ahead, so the before and the after are the same instrument.
