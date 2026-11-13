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
   while open, no page) pads at once as before and ends any hand-off still in flight. The hand-off in
   flight is one `ImeHandoff` object: a number per hand-off, and only the current number's answers
   decide anything.
2. Hand-off: `window.canariImeTarget(<keyboard height in CSS px>)` is evaluated. The page
   (`keyboardViewport.svelte.ts` + `imeTarget.ts`, `imeTarget.test.ts`) answers by laying itself out
   as the resize WILL measure - layout and visual viewport both `baseline - target` - synchronously,
   and returns `true`.
3. `WebView.postVisualStateCallback` reports when that frame is drawn - a proof, not a delay - and
   only then is the content padded. The crop that follows removes only the band the keyboard is
   sliding over; the frames before and after the resize are the same picture.
4. The target is spent as soon as either viewport gives up height of its own (the padding landed, or
   the WebView shrank its visual viewport itself), or when the shell announces 0 on a fall - which it
   does only for a hand-off whose padding never landed (a landed one is already spent).
5. A hand-off ends when its page goes away. A new WebView ends it (`onWebViewCreate`), and so does a
   new document in the same WebView: `initKeyboardViewport` calls `window.canariIme.pageReady()`, the
   shell ends the hand-off and dispatches the insets again, so a keyboard still up is handed to the new
   page. Without this, a reload that swallowed the answer left the hand-off pending and the keyboard
   over the composer until it closed (review S1). Wry's generated client offers no page-start hook,
   and a gone renderer takes the process with it (wry does not override `onRenderProcessGone`).
6. The opening is two updates on the page - the announced layout, then the real resize that spends
   the target - and both reveal the focused field at once (`auto`), never smoothly under the keyboard
   (`keyboardRevealOnUpdate`, review S3: a modal, the PIN dialog, a payment overlay).

One logcat line per padding change: `IME inset: <px> -> content padding (<why>)`, the why being
`rise #n: the page drew its keyboard layout`, `applied at once`, `hand-off to <px> superseded`,
`rise #n, target refused` or `no page to hand off to`.

A page that does not answer `true` (not hydrated yet, an older bundle) is said at WARN in logcat
(`the page did not take the target`) and the padding lands at once, as before.

**The band under the page (Android).** When the page takes a keyboard target it sends
`canariTheme.setGround` the first opaque background painted where the keyboard will sit
(`imeGround.ts`: `elementFromPoint` at the bottom edge, up through its ancestors, a translucent glass
composer looked through, the colour converted by the engine on a one-pixel canvas), and `MainActivity`
paints it on the content view, under the transparent WebView. A conversation's band is its grey, a
full-bleed CanaReels, live or camera screen's is black (review N1). Read once per rise, when the layout
changes anyway - never on a theme apply at boot (review N5).

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
  keeps "+", which already IS the group of actions (the owner's rule of 2026-09-08: *"les icones sur
  les bords disparaissent quand tu commences a taper"*). No chevron fold.
- **The gap above the keyboard**: 12 px against Messenger's 9.3 dp, and at rest the field sits 9 dp
  lower than Messenger's (Canari pads `max(0.75rem, inset)`, Messenger `inset + 9`). Kept: the GIF
  panel's hand-off is built on the same 0.75rem (chat.md), and iOS's home indicator makes `inset +
  gap` a different decision there.
- **The fall still resizes before the page redraws** (100-117 ms measured). With the synced animation
  the keyboard now covers that band while it slides, as Messenger's covers its composer.
- **iOS** had the rise defect in another shape and takes the same hand-off - section 5 below. Its
  fall is left as it was. The composer's dimensions and the send motion are CSS and apply there too.

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

| frame (ms) | keyboard top still to travel | page content still to travel | web composer |
| --- | --- | --- | --- |
| 1251 | 240 | 275 | half covered |
| 1288 | 148 | 269 | hidden behind the keyboard |
| 1325 | 82 | 209 | hidden |
| 1364 | 48 | 127 | hidden |
| 1419 | 23 | 55 | half covered |
| 1474 | 2 | 5 | visible, in place |

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
from the field's centre to the keyboard's top) and scrolls the thread with it. Left as it is: nothing is ever cut or hidden, and riding it would need
the page to follow the keyboard per frame.

**What changed (PR `feat/ios-keyboard-handoff`, on this branch).** A rise from no keyboard is
handed to the page, as on Android: `CanariHandKeyboardRiseToPage` calls `window.canariImeTarget(301)`
(the same `imeTarget.ts`), the page lays itself out for the keyboard inside the still full-size
WebView, the script answers after two animation frames - by WebKit's ordering the layer tree the
first frame committed reaches the app before an answer sent from the second, which is a proof of
order, not a delay - and only then is the frame set, WITHOUT animation, since the page already is
that picture. A newer keyboard change supersedes a pending rise (`g_keyboardChangeSeq`); a fall
withdraws the target with `canariImeTarget(0)`; a page that does not take it is an `ERROR` line and
the frame is set at once. Falls and height changes while open keep the animated frame.
`iosKeyboardRiseHandoff.test.ts` reads the contract on both sides.

## Owed on a phone (nothing here is measured after the change - it needs a build)

On the Mi 9T, a pre-release, the same three recordings (`adb screenrecord`, the frame script):

1. Keyboard open: a 285 ms opaque slide; logcat `IME animation: 285 ms` and `IME inset: <px> ->
   content padding (rise #n: the page drew its keyboard layout)`; the composer above the keyboard
   from its first frames, no cropped frame; the band the page's ground (grey in a conversation,
   black on a CanaReel's comment field); and never `the page did not take the target`.
2. Keyboard close: an opaque slide down, no fade.
3. Send: the thread glides ~220 ms, then the bubble fades in; the bubble's box unchanged from the tap
   to the check. In a salon, no second fade at delivery. Two sends in a row, and a send with the
   keyboard closing mid-glide: no row rising past its place, `scrollTop` against `scrollHeight` per
   frame through CDP.
4. The composer's boxes read through CDP against the expected numbers above, light and dark.
5. A field in a modal (the PIN change dialog): revealed at once when the keyboard opens, no smooth
   scroll under it. A pull-to-refresh reload with the keyboard up: the composer still lifts
   (`IME hand-off to <px> ended: the page started a new document`).

And on the iPhone 12, a pre-release carrying both PRs (the store build cannot be inspected, so the
MJPEG stream and the syslog are the instruments, as in section 5):

5. Keyboard open in a DM, five times: syslog `keyboard overlap=301 -> webview height 543, handed to
   the page first` then `keyboard rise #n: the page drew its keyboard layout in N ms`, and never the
   `ERROR` line. In the frames, the web composer above the keyboard on every frame from the first one
   that moves (no frame where it is hidden or the page is drawn lower), the native "+" beside its web
   twin, no band, no cropped frame. N is the hand-off's cost: if it runs past the keyboard's first
   ~50 ms the composer stands still while the keys arrive, which is the reading that decides whether
   the two-frame wait is right.
6. Keyboard close: as before - page full height at once, keyboard sliding off.
7. Open, then switch to the emoji keyboard and back (a height change while open), then close before
   the rise lands (tap the field and the thread at once): the frame always ends at the keyboard's
   edge, `rise withdrawn` when it was overtaken.
8. The composer's dimensions and the send motion, which apply there unchanged, and the composer in
   landscape clear of the notch.
