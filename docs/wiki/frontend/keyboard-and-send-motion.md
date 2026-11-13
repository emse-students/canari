# Keyboard and send motion - Messenger measured, frame by frame (2026-11-13)

The owner's request (2026-11-13): watch Messenger and Canari *"fraction de seconde apres fraction de
seconde"* - sending a message, and above all the keyboard opening, *"un probleme general (adaptation
de l'interface a l'ouverture du clavier)"* - and bring Canari as close as possible to Messenger. Then
(same day) the composer bar's LAYOUT and DIMENSIONS as Messenger's, in Canari's own look.

This page holds the numbers, what was changed for each difference, and what is owed on a phone.
Numbers only: the recordings show private conversations and stay out of the repository.

## Sources

| Recording | Device | Capture | What it shows |
| --- | --- | --- | --- |
| owner, Messenger | owner's Android phone | 576 x 1280, variable frame rate, frames 16-18 ms apart while anything moves | keyboard open / close, two sends |
| owner, Canari `1.6.x` | same phone, light theme | same | keyboard open / close, three sends, delivery |
| bench, Messenger | Mi 9T, Android 16, LatinIME, `adb screenrecord` | 1080 x 2340, ~60 fps | keyboard close then open, composer geometry (screenshots) |
| bench, Canari `1.6.11` | same, dark theme, a test account | same, plus a per-frame CDP probe of the page | keyboard open then close, composer geometry (`getBoundingClientRect`) |

Method: every frame extracted with its presentation timestamp (`ffmpeg -vsync 0`, `ffprobe
pts_time`), then measured per frame by a script: the keyboard's top edge (its background colour from
the bottom up), the composer (the field's fill or the accent glyphs), the last bubble's box and the
new bubble's mean chroma (an opacity proxy). The bench phone is 2.475 px per dp (396 dpi override); a
CSS px in the app's WebView is one dp.

## 1. The keyboard opening

| | Messenger | Canari before |
| --- | --- | --- |
| Keyboard motion | slides the full height, OPAQUE, on a decelerating curve: 281 ms on the bench (2340 -> 1454 px), 265 ms in the owner's capture. Share of the way per 16.7 ms frame: 4, 22, 43, 57, 67, 75, 80, 85, 89, 92, 94, 96 ... % - Android's SYNCED IME animation (285 ms, `PathInterpolator(0.2, 0, 0, 1)`) | FADES IN from a short offset, translucent over the page: ~200 ms on the bench, ~120 ms of visible ramp in the owner's capture - Android's UNSYNCED IME animation (200 ms, alpha twice as fast as the travel, an 80 dp offset) |
| Content (composer, list) | jumps to its final place in ONE frame, 35 ms BEFORE the keyboard's first move (bench 3.575 s vs 3.610 s; owner 2.035 s vs 2.051 s) | the WebView shrinks at the keyboard's first frame, but shows its LAST frame cropped to the new size until the page draws again: the composer is cut off for **128 ms (8 frames) on the bench, 120 ms (7 frames) in the owner's capture**, then the page jumps to its final layout |
| Band between the content and the rising keyboard | the page's ground (black) | the launch background: a dark navy strip under a light page (owner's capture, 7 frames) |
| Composer over the keyboard | rides on it from the first frame, field bottom 9.3 dp above the keyboard's top | 12 px above it once laid out |

Why Canari got the other animation: Android plays the synced IME animation only when a
`WindowInsetsAnimation` callback exists in the window's view hierarchy. `MainActivity` pads its
content by the IME inset from an `OnApplyWindowInsetsListener` and registered no callback, and the
WebView registers none either - so the keyboard faded.

## 2. The keyboard closing

| | Messenger | Canari before |
| --- | --- | --- |
| Keyboard motion | slides down, opaque, decelerating: 252 ms (owner), ~200 ms to 98 % (bench) | fades out nearly in place: ~180 ms (owner), ~85 ms of visible change (bench) |
| Content | jumps to the full-height layout at the first frame; the keyboard slides off over the composer | the page relays out 100-117 ms after the keyboard starts; meanwhile the composer stays where it was and the page's ground shows under the fading keyboard |

## 3. Sending a message

| | Messenger | Canari before |
| --- | --- | --- |
| Field | cleared on the next frame | cleared on the next frame |
| The thread making room | GLIDES up by the new row's height: 70 px (one line) over ~217 ms, 16 / 46 / 83 % of the way at a quarter / half / three quarters - a symmetric ease-in-out. Same on both sends | JUMPS by the new row's height in one frame |
| The new bubble | invisible during the glide, then FADES IN where it lands: ~130 ms, no slide (its top stays on the same pixel), no scale. Glide + fade: ~370 ms | fades in AND rises ~10 px (`riseIn`, 260 ms `ease`, 12 px): visible ramp ~165 ms, starting with the jump |
| Status | an "Envoye" line under the last own message moves under the new one; the bubble never changes size | "En attente..." then "Envoi..." INSIDE the bubble (two lines tall, its width changing at the switch), then at delivery (~680 ms after the tap) the bubble SHRINKS to one line in one frame and a check appears under it |
| Composer | the folded icons come back in one frame when the field empties | the microphone comes back in one frame |

## 4. The composer bar (bench, dp)

| | Messenger at rest | Messenger, keyboard up | Canari before (keyboard up) |
| --- | --- | --- | --- |
| Left controls | +, camera, gallery, microphone: glyphs centred at 20, 60, 100, 140 - a 40 dp pitch from the edge, no gap | one chevron, centred at 21 | margin 12; "+" 44 at 12-56; gap 8; microphone 44 at 64-108 |
| Field | 160 -> 392, 42 tall, corner ~20, emoji inside at 374 | 40 -> 392 (396 while typing), 42 tall | 116 -> 368, 44 tall, corner 20 |
| Right control | like, centred at 412 (4 dp from the edge to its box) | like, or send (centred 417) while typing | gap 8; send 44 at 376-420, plus 4 of padding; margin 12 |
| What folds | - | all four left controls fold into the chevron as soon as the field has focus | the microphone folds when the first character is typed; "+" stays |
| Vertical | field bottom 33 dp above the screen's bottom (navigation inset + 9) | field bottom 9.3 dp above the keyboard | field bottom = navigation inset at rest; 12 above the keyboard |

## What was changed (PR `feat/keyboard-and-send-motion`)

**The keyboard animation (Android).** `MainActivity.applyKeyboardInsets` registers
`ImeAnimationLog`, a `WindowInsetsAnimationCompat.Callback` (`DISPATCH_MODE_STOP`) that only logs.
Its presence selects the synced animation: the same 285 ms opaque slide Messenger gets on the same
phone. This removes the ghost keyboard on open and close.

**The rise is handed to the page before the WebView is resized (Android).** One mechanism for every
screen with a text field, because it acts on the viewport every screen already reads:

1. The insets listener asks `imeStep` (`keyboard/ImeHandoff.kt`, pure, `ImeHandoffTest`) what to do.
   A rise from no keyboard, with a page present, is a HAND-OFF; anything else (a fall, a height change
   while open, no page) pads at once as before and ends any hand-off still in flight.
2. Hand-off: `window.canariImeTarget(<keyboard height in CSS px>)` is evaluated. The page
   (`keyboardViewport.svelte.ts` + `imeTarget.ts`, `imeTarget.test.ts`) answers by laying itself out
   as the resize WILL measure - layout and visual viewport both `baseline - target` - synchronously,
   and returns `true`.
3. `WebView.postVisualStateCallback` reports when that frame is drawn - a proof, not a delay - and
   only then is the content padded. The crop that follows removes only the band the keyboard is
   sliding over; the frames before and after the resize are the same picture.
4. The target is spent as soon as either viewport gives up height of its own (the padding landed, or
   the WebView shrank its visual viewport itself), or when the shell announces 0 on a fall.

A page that does not answer `true` (not hydrated yet, an older bundle) is said at WARN in logcat
(`the page did not take the target`) and the padding lands at once, as before.

**The band under the page (Android).** `themeStore` sends the page's `--cn-bg` to
`canariTheme.setGround` on every theme apply; `MainActivity` paints it on the content view, under the
transparent WebView. The band any resize opens is the page's ground in both themes.

**The send.** `threadGrowthObserver` keeps its instant pin to the bottom, then plays the distance it
jumped as a compositor transform from where the rows were (`appendGlidePx`, `threadAppendGlide.test.ts`):
only for rows ADDED under a reader at the bottom, by less than half the pane - never for the keyboard,
the entry, a batch or reduced motion. Tokens `--motion-thread-glide: 220ms` and
`--motion-ease-in-out: cubic-bezier(0.42, 0, 0.58, 1)`. The bubble plays `.motion-bubble-in`:
transparent through the glide, then a `--motion-fast` fade, no slide, no fill
(`riseInEntrance.test.ts`). A send in transit ("En attente...", "Envoi...") is drawn under the
bubble where its check will be, in a row one `--text-2xs` line tall, so the bubble keeps its size
from the tap to delivery; a failure stays inside, with its buttons.

**The composer bar (phone, both platforms).** Controls on a 40 px box with no gap
(`.chat-composer-panel .ui-icon-button`, the one row allowed a size of its own in
`iconButtonScale.test.ts`), a 42 px field (11 px padding), 4 px from the screen's edges, the send's
extra padding gone. Expected with the keyboard up: "+" 4-44, microphone 44-84, field 84-392, send
392-432; while typing, field 44-392. A pointer keeps its 38 px controls and its gaps.

## What is left different, and why

- **What folds.** Messenger folds every action into a chevron as soon as the field has focus; Canari
  folds the microphone on the first character and keeps "+", which already IS the group of actions
  (the owner's rule of 2026-09-08: *"les icones sur les bords disparaissent quand tu commences a
  taper"*). Folding the microphone on focus instead is one condition (`controlsCollapsed`) if the
  owner wants it.
- **The gap above the keyboard**: 12 px against Messenger's 9.3 dp, and at rest the field sits 9 dp
  lower than Messenger's (Canari pads `max(0.75rem, inset)`, Messenger `inset + 9`). Kept: the GIF
  panel's hand-off is built on the same 0.75rem (chat.md), and iOS's home indicator makes `inset +
  gap` a different decision there.
- **The fall still resizes before the page redraws** (100-117 ms measured). With the synced animation
  the keyboard now covers that band while it slides, as Messenger's covers its composer.
- **iOS** is untouched: its native layer already resizes the WebView on every keyboard frame
  (`CanariApplyKeyboardLayout`, [mobile](mobile.md)). The composer's dimensions and the send motion are
  CSS and apply there too.

## Owed on a phone (nothing here is measured after the change - it needs a build)

On the Mi 9T, a pre-release, the same three recordings (`adb screenrecord`, the frame script):

1. Keyboard open: a 285 ms opaque slide; logcat `IME animation: 285 ms` and `IME rise #n: the page
   drew its keyboard layout`; the composer above the keyboard from its first frames, no cropped
   frame, no navy band; and never `the page did not take the target`.
2. Keyboard close: an opaque slide down, no fade.
3. Send: the thread glides ~220 ms, then the bubble fades in; the bubble's box unchanged from the tap
   to the check.
4. The composer's boxes read through CDP against the expected numbers above, light and dark.

And on the iPhone 12: the composer's dimensions and the send motion, which apply there unchanged.
