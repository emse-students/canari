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

### iOS

Same idea, a different source: `UIKeyboardWillChangeFrame` carries the duration and the curve, and
`CanariApplyKeyboardLayout` ([mobile](../frontend/mobile.md#ios-shrinks-the-webview-and-that-is-the-same-decision-taken-twice))
shrinks the WebView's frame in one step today. Whether Apple Messages moves the same way, and how
Canari's iPhone 12 compares, is **not measured**. That reading comes before any iOS design.

### Readings owed before and after a build

- Canari on the Mi 9T, recorded and analysed exactly as above (frames, travel per frame, the
  composer-to-keyboard gap), as the "before". Reading #42 gives the one-frame jump but not the
  per-frame gap.
- After: the same, with a long DM and a salon, both directions, plus the GIF panel's
  [handoff](../frontend/modules/chat.md#one-attachment-menu-and-a-gif-panel-in-the-keyboards-place-2026-10-02),
  which must still swap with the keyboard in one frame.
- The measuring script (ffmpeg raw frames + numpy template match, ~40 lines) belongs in
  `tools/` if the build goes ahead, so the before and the after are the same instrument.
