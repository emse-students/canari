# The CanaReels editor - what it is, what an Instagram-style one needs, the first slice and the rest

Written 2026-10-05 after the user's device test of the post-capture screens (*"catastrophique"*: the
editor is not intuitive, ugly, elements cannot be moved or resized; he compares it to Instagram's
story/reel editor). The capture screen is [reels](reels.md); this page owns what comes AFTER capture:
the review, the editor and the publish step. **Nothing below ran on a device yet.**

## What was reported, and the cause of each

| Report | Cause | Fixed in the first PR |
| --- | --- | --- |
| "Next" sits over the seek bar and the other controls | `ReelReview` laid "Next" as an `absolute` layer over a full-screen `VideoPlayer`, whose own bar is `absolute bottom-0` | Yes: one column, the take above, "Next" in a bar of its own that owns the home-indicator inset (`safeBottom={false}` on the player so the inset is paid once) |
| "Couper le son" does not remove the audio | The only sound control was the PLAYER's listening toggle (`followVideoSound`, the app's one sound answer). It never reached the export; `prepareVideoForUpload` always encoded the source's audio to AAC | Yes: a dedicated "remove the sound" button writes `clip.soundRemoved`; `publishReel` passes `removeAudio`; the conversion DISCARDS the audio track (`audio: { discard: true }`), so the published MP4 has no audio track. While it is on the preview is silent (`soundScope: 'silent'`) and the player's own toggle is disabled |
| The editor cannot move or resize anything | `ReelEditor` placed a text at 0.5/0.5, once, with `pointer-events-none`; there was no selection, no gesture, no delete | Yes, text and emoji (below) |
| (found while reading) what you see is not what is published | The overlay coordinates were normalized to a LETTERBOXED `object-contain` box, the export normalizes to the media's own pixels; the size used `cqh` with no container | Yes: the frame takes the media's own aspect ratio and every size is a share of the SHORT side, in one module read by both |

**Export of a decorated video, today (not changed in this PR).** `renderVideo` plays the clip at 1x
into a canvas and records `canvas.captureStream()` with `MediaRecorder`, then `prepareVideoForUpload`
re-encodes it AGAIN at publish. Two lossy encodes, real-time duration, and the audio comes from
`captureStream`. It works but it is the weakest link; WP-E4 below replaces it.

## What exists now (after this PR)

- `ReelReview` - the take, the player, edit / remove-sound / discard at the top, "Next" in its own bar.
- `ReelEditor` - one column (header with the apply button, the stage, the tool tray). Tools: text,
  emoji (a quick row of twelve), pen, clear. Overlays: select, drag, pinch to resize, twist to
  rotate, trash zone to delete, tap the selected text to reword it, colour swatches for text and pen.
- `lib/gestures/transformGesture.ts` - the ONE pure gesture helper (one finger drags, two fingers
  pinch and twist), unit-tested. `lib/reels/reelOverlays.ts` - the overlay DATA model and the size
  formulas. `lib/reels/reelEditor.ts` - the export, which paints the same data into the media.
- Exports an edited PHOTO exactly (canvas at the image's pixels). A decorated VIDEO goes through the
  real-time path above.

## What an Instagram-style editor needs, and what the first slice chose

| Capability | Instagram | First slice |
| --- | --- | --- |
| Text: add, move, resize, rotate, recolour, reword | yes | **built** (one colour; no font styles, no background pill, no alignment) |
| Stickers / emoji: add, move, resize, rotate | yes | **built** (twelve quick emoji as Noto SVG pictures; a full picker is WP-E3) |
| Delete by dragging to a trash zone | yes | **built** |
| Drawing | yes (pen, marker, neon, eraser) | the existing pen, one width, kept as a mode |
| Trim the video | yes | not built (WP-E5; mediabunny's `trim` does it in the encode) |
| Music / sound library | yes | **no**; the only sound control is remove-the-sound (built) |
| Filters, stickers with data (location, poll, mention) | yes | no |
| Undo | yes | no (clear everything) |

## The gesture model (the contract every overlay kind follows)

- **A finger on an overlay selects it and drags it.** The selected overlay is drawn on top and
  outlined. **A second finger anywhere** pinches (scale = distance ratio, clamped 0.3 to 8) and twists
  (rotation = angle change) the SAME overlay, about its centre.
- **A tap on empty space deselects.** A tap that does not move (under 8 px) on the ALREADY selected
  text opens the text field on it.
- **While an overlay is being dragged a trash circle shows at the bottom**; releasing with the finger
  over it (plus a 12 px margin) deletes the overlay. A cancelled gesture never deletes.
- **The helper applies increments**, so a finger lifting or landing mid-gesture does not jump the
  element, and a twist past half a turn keeps turning. Pointer events with pointer capture on the
  frame; `touch-action: none` there. Where an overlay may be is the reach rule (last section): its
  whole box stays inside the frame, and a release settles its centre clear of the controls.
- **Safe areas** (layout superseded 2026-10-11, see the last section): the header pads the top inset, the tool tray the bottom one; the stage was the
  space between, so nothing overlaps and the keyboard (which resizes the layout viewport on both
  platforms, [durable-rules](../../durable-rules.md)) only shortens the stage.
- **Drawing is a mode**, not a gesture: while it is on, overlays do not take pointers.
- Keyboard and screen reader reach the same actions through the tool buttons; the arrangement
  gestures themselves are pointer-only (owed: arrow-key nudging, WP-E6).

## The rendering and export pipeline (what you see is what is published)

1. The media sits in a frame of its OWN aspect ratio (read from `videoWidth` / `naturalWidth`),
   sized by container-query units so it is as large as the stage allows.
2. Every overlay is `{ x, y, scale, rotation }`: `x`, `y` the CENTRE in 0..1 of the frame. Its size is
   `TEXT_BASE_SIZE` / `EMOJI_BASE_SIZE` (shares of the frame's SHORT side) times `scale`. The preview
   writes that share in `cqmin`; the export multiplies it by `min(width, height)` of the media. The
   formulas live in `reelOverlays.ts` and nowhere else.
3. The export does `translate(centre)`, `rotate`, then draws: text with `fillText`, an emoji with
   `drawImage` of the same Noto SVG the screen shows (never the platform glyph: the font is deleted,
   [emoji](../emoji.md)).
4. **Sound is separate from the pixels**: `clip.soundRemoved` is read at publish, by
   `prepareVideoForUpload`, so removing the sound never costs a re-record.

## Tranche 2 - the decisions taken (2026-10-06, no video editing: user)

Tranche 2 is built as small independent PRs: text style row, drawing, stickers, Next -> publish,
exit/discard. **No trim, no cut, no filter on the video itself (user)**, so WP-E5 is dropped. Every
choice below was the simplest one consistent with this page and is open to the lead's veto.

- **Text style row** (a text being written or selected): three typefaces (`sans` = the app's own,
  `serif`, `mono`, system stacks so canvas and DOM resolve the same face with no font download) and
  ONE background switch, the pill. With a pill the chosen colour fills the band and the glyphs take
  the contrasting ink (`textPaint`); without it the colour is the glyphs on a shadow. **Alignment is
  NOT built**: a text is a single line (80 characters), so left/centre/right changes nothing; it
  returns if multi-line text is ever wanted. The pill geometry is in `em` (`PILL_*_EM`,
  `pillSize`), read by the preview's CSS and by the export, so both draw the same band.

- **Drawing (WP-E6, done)**: a stroke is an OVERLAY (`kind: 'stroke'`), so it selects, drags,
  pinches, twists and goes to the trash like text and emoji; the old canvas layer is deleted and
  `ReelEdits` is `{ overlays }`. Points are in short-side units relative to the stroke's centre
  (`reelStrokes.ts`): the preview is an SVG sized in `cqmin`, the export multiplies by
  `min(width, height) * scale`. Three pen widths (thin 0.6 %, medium 1.2 %, thick 2.4 % of the short
  side), the colour row shared with text. **Eraser** = a mode that deletes every stroke the finger
  crosses (reach 3 % of the short side, hit-tested through the stroke's own transform); text and
  emoji are removed by the trash, never by the eraser. **Undo** steps back through the layouts
  before each change (new stroke, erase pass, text/emoji added, recolour, a drag/pinch that moved
  something, clear), 30 steps; a tap or a reselection takes none. "Clear" is now a trash icon, one
  undoable step. Not built: redo, per-stroke recolour, marker/neon brushes.
  **Seen in a browser** (Chrome, 390x844 touch emulation, synthetic pointer events, 2026-10-06): a
  thick and a thin stroke, moving one, erase removing only the crossed one, undo restoring it,
  clear then undo, and the exported 720x1280 WebP having its white pixels where the preview drew
  them (to within the line width). NOT seen on a phone.

- **Stickers = emoji (WP-E3, done)**: the tray shows a shelf of twelve (the member's recents first,
  the SAME history the chat's pickers share via `emojiPickerShared`, completed by `QUICK_EMOJI`:
  `emojiShelf`) and an "All emoji" button that opens the chat's own `EmojiGrid` (categories, search,
  skin tone) on a surface of its own under the shelf. Picking records the emoji as recent. **No
  stickers with data (location, poll, mention, GIF)**: out of scope, no server support.

- **Next -> publish (done)**: the editor's top-right button is "Next" (no "Use this capture"): it
  exports the overlays and opens the publish step directly (`onnext(blob | null)`; null when
  nothing was added, so an untouched take is never re-encoded). The publish sheet's back arrow
  returns to the REVIEW, from where the pencil reopens the editor on the already-baked media
  (edits stack; the originals are not kept). The "Use this capture" string is deleted.

- **Exit and discard (done)**: three rules. (1) The editor's arrow asks before dropping edits
  ("Discard your edits?"), says nothing when there are none, and never interrupts an export
  (`requestLeave`). (2) **Android Back / the iOS swipe with the editor open leaves the EDITOR**
  (before, it threw away the whole take silently): `ReelCapture`'s take entry re-arms itself and
  hands the Back to the editor's `requestLeave`, so the arrow and the gesture share one answer; the
  editor owns no history entry of its own (an entry removed with a `history.back()` while the
  publish sheet pushed its own would have eaten the sheet's entry). (3) **Discarding a finished
  take asks first** (the review's X and Back share `confirmDiscardTake`); keeping it re-arms the
  Back entry the question spent. A take still being recorded keeps the old behaviour (Back ends and
  discards it, there is nothing yet to protect). The publish sheet's Back is unchanged.

## Work packages (estimates are focused engineering days, before device readings)

| WP | What | Est. |
| --- | --- | --- |
| E1 | **DONE in the first PR**: review layout, remove-the-sound end to end, overlay model, gesture helper, text and emoji overlays, trash, export | - |
| E2 | Device reading of E1 on the Mi 9T and the iPhone (gestures under a real thumb, the safe areas, the keyboard, the export of a photo and a video); fix what it shows | 1 |
| E3 | The sticker tray: the full emoji picker (reuse the composer's grid), recent emoji, a text style row (font, background pill, alignment) | 1.5 |
| E4 | **Single-pass export**: apply overlays per frame inside `prepareVideoForUpload` (mediabunny's `video.process`), so a decorated video is encoded ONCE at publish, at real speed, and the real-time `MediaRecorder` path is deleted. The editor then stores edits on the clip instead of baking a blob | 2 to 3 |
| E5 | Trim: two handles over a thumbnail strip, `trim` in the same conversion; the 90 s cap re-checked on the trimmed length | 2 |
| E6 | Undo/redo, keyboard nudging, drawing tools (width, eraser), the drawn strokes as overlays so they move too | 2 |
| E7 | Music: a decision, not a package (licensing, a library, a server cost the user ruled against in C3) | to decide |

## Questions for the user (to continue)

See the report that accompanied the PR. In short: which Instagram screens to copy for the
text-style row, the sticker tray, the trim bar and the editor's top toolbar; whether music is wanted
at all; whether "Next" after the editor should open the publish step directly.

## The review controls over the letterbox, and leaving the camera (2026-10-06)

Read on the Mi 9T (build `5b56dcb74`). **The pencil was not clipped**: the controls sit in the review's
full-width box and overflow the letterboxed video, but their `bg-black/30` disc is INVISIBLE over the black
bars beside a narrow clip, so the pencil seemed to lose its left third. `ReelReview` buttons now carry
`ring-1 ring-white/30` and `bg-black/40`, readable on the bars and on a bright frame.

**Leaving the camera** (`CameraScreen.close`) used `history.back()`, whose target is whatever entry sits
below the camera; on the phone it landed on the Dashboard. It now goes to `cameraOriginFrom(from.url)`
(`reels/cameraOrigin.ts`, recorded by `afterNavigate`; the feed for a cold link, never the camera) with
`replaceState`, so Back from that tab does not reopen the camera. Trade-off: no history step, so the origin
tab is re-rendered rather than restored. **NOT reproduced:** the discard itself (X or Back, confirmed) never
navigates in code, and a jsdom replay of the overlay stack (sheet Back, Back, re-arm, X) stays on `/camera`;
the Dashboard landing was reached through the camera's own close. Owed ONE re-read on the phone: discard
stays on the camera, the camera's X returns to the tab it came from.

## One frame for capture, edit and publish (2026-10-11, replaces the cover-and-crop of #1739)

User report (Android WebView): the preview was letterboxed, and when the text field took focus it SHRANK
to a small centred box. Cause: the editor was a flex column and the stage a `flex-1` slot; the keyboard
shrinks the layout viewport on both platforms ([durable-rules](../../durable-rules.md)), so the stage and
the frame (a contain fit in container-query units) shrank with it. #1739 fixed the shrink with a cover
fit, which cropped a sliver the export still kept. **The owner then decided FULL PARITY: what the camera
shows is what the editor shows and what viewers see; no crop that differs, no overlay off-screen.**

- **ONE canonical frame, 9:16** (`REEL_FRAME_RATIO`, `reels/reelFrame.ts`). The camera asks the sensor
  for that frame as large as the screen shows it (`cameraAccess`), previews it `object-cover` INSIDE the
  frame, and the capture crop is the frame element's own box (`framedCapture`, unchanged), so the
  recorded file IS 9:16 whatever the phone's screen. A gallery import keeps its own ratio, and the
  review and the editor wear it (`setRatio`). **The viewer passes the reel's recorded width / height**
  (`media.width/height`) so a legacy reel (captured to a screen box, ~0.46 on a 20:9 phone) and an import
  are not pillarboxed in a small 9:16 frame; 9:16 only when the size is unknown.
- **`ReelFrame.svelte` is the one component** used by `CameraScreen`, `ReelReview`, `ReelEditor` and
  `ReelSlide`. `containFrame`: the frame is shown WHOLE (contain, never cropped) and centred with
  `rounded-2xl` (`--radius-2xl`, 12 px, "the larger card": the scale has no larger media step) over the
  backdrop; **within 2 % of the screen's shape it is the WHOLE stage instead - cover ON PURPOSE**, square
  corners, no backdrop sliver, the media cropped by at most 1 % per side (`data-reel-frame-fills`).
- **`ReelBackdrop`**: a 24 px canvas copy of the frame's own video or image, upscaled by the browser
  (that IS the blur: no CSS filter re-applied per repaint) and dimmed - NO second decoder (5.6 GB
  phones). It exists and samples ONLY when the frame leaves stage uncovered; a still image once, a video
  only while it plays on a visible tab; listeners and timer are released with the effect.
- **The keyboard cannot move the frame, and the camera sees what is visible**: `stageStep` makes the stage
  FOLLOW the measured box, except while `latch` is set - the editor passes `composing !== null`, the text
  field being open - when it keeps the largest height seen; on release it holds until the box grows back
  (the keyboard closing) so the frame does not jump. Every other surface follows the box, so
  `CameraScreen.previewBox` records the visible box. The editor's header and tool tray are overlays on
  `cn-scrim` gradients that let touches through (`pointer-events-none`, only their controls take them),
  and the tray rides above the keyboard (the scrims alone did NOT keep a dropped overlay grabbable: see
  the next section). The trash
  circle sits in the editor root at `z-20`, above the tray.
- **Overlays live inside the frame**: `x`, `y` are 0..1 of it, kept in by the reach rule (next section), and the
  export paints at `frameToPixels(overlay, media size)` (`drawDecorations`, tested), the same share the
  preview writes as `left`/`top` percentages. **A new text starts at y = 0.3** (`TEXT_START_Y`): the
  member has just typed it under the keyboard and tray, so the centre would be hidden. The viewer's
  caption sits INSIDE the frame above the player's bar, so the two never overlap.

**Not verified (no device, no browser run):** the camera's real recorded size (the constraint is
`ideal`; the track may answer another mode, and the crop then still yields 9:16); the backdrop on the
Android WebView; the viewer with a legacy reel and the caption over the bar on 360x800; a real soft
keyboard (the stage latch follows the box, not `visualViewport`, so an engine that does NOT shrink the
layout viewport is unreleased by that path); the iPhone's `<video>` layer inside a rounded
`overflow-hidden` box (a WebKit clip bug is possible).

## The reach rule: an overlay stays whole in the frame and grabbable (2026-10-12)

Read on the Mi 9T (`v1.2.4-alpha.2`, [device-verification](../../device-verification.md)): a text
dropped on the tool tray was drawn over the tray icons, could not be grabbed again (the only free
part was at the screen edge, where Android takes a grab as its Back gesture and the editor asked
"Abandonner vos modifications"), and was published clipped at the frame edge ("Test reel al").

**Causes.** (1) The gesture clamped only the CENTRE to 0..1 of the frame (`clampCentre`), so half an
overlay could sit outside it, and the export, which paints into the frame's pixels, cut it there.
(2) The tray's scrim lets touches through, but its rows do not: the tool row is a full-width child
with `pointer-events: auto`, so an overlay under it was covered everywhere but the 12 px gutters.
(3) Nothing decided what a release over the tray means. (4) **Found on the phone while fixing it:
the preview's text was smaller than the published text.** The Mi 9T runs `font_scale` 0.85, and
Android's WebView multiplies FONT sizes by the system text size (lengths stay as they are:
[textZoom](../../../../frontend/src/lib/utils/textZoom.ts)). So `7cqmin` drew at 25.9 px instead of 30.5 px,
while the export's canvas `700 50.4px` is never scaled: the caption came out 18 % wider than the
screen showed it (measured 244 vs 287 CSS px). A text placed flush with the edge on screen would
still have been published clipped, and at 200 % text it would come out half the size it showed.

**The rule (`reels/overlayReach.ts`, pure, tested):**

- **Inside the frame, always**: every gesture step goes through `keptInFrame`, handed to
  `TransformGesture.begin` as its constraint. The scale is capped at `fitScale` (the largest at which
  the TURNED box fits) and the centre is held so the whole box is in, less an inset of 2 % of the
  short side on every edge (`OVERLAY_EDGE_INSET`): the frame's 12 px corners and a width rounded to
  whole pixels must not decide whether the last glyph is published. The gesture continues from the
  constrained result, so pushing past an edge and coming back has no dead zone. What the member sees
  during the drag is what the export paints.
- **One rule for a release**: on the trash it is deleted; ANYWHERE ELSE (the tray, the header, a
  cancelled gesture such as the system Back) it stays and settles with `settledClearOfControls`: its
  centre moved vertically to the nearest place clear of the header and the tray, whose bands are read
  from their boxes at that moment (`controlBands`; a selected text's style rows are already part of
  the tray). The centre is the point a finger grabs, and it is then never under a control nor only at
  the screen edge. If the controls leave no room, the centre takes the middle between them, still
  inside the frame: never clipped does not give way.
- **Extent**: an emoji's and a stroke's box come from the data; a text's is its span as the screen drew
  it (`offsetWidth/offsetHeight`, untransformed, the same font the export measures). A text whose words
  or face change settles again once redrawn, so a long caption is shrunk to fit at creation.
- **The text's size undoes the system text size**: `font-size: calc(7cqmin * scale / var(--text-zoom, 1))`,
  the factor `publishTextZoom` already measures for the avatar initials. The text is part of the
  picture, not reading text, and the export never scales it; the span's measured width then equals
  the canvas's `measureText` (287 vs 287.4 px on the Mi 9T).

**Read on the Mi 9T (2026-10-12)**, with the REAL editor component served to the installed
`alpha.2` app's own WebView over `adb reverse` from a temporary route (never committed), and real
touches (`input swipe`). A text was dragged from the middle to the bottom-right corner, onto the tray.
It stopped with its box 8.6 px short of the right edge, and its centre settled at the top of the tray
(top 85.09 %, the tray's edge). It was grabbed again from its centre, away from the screen edge, and
moved. The exported 720x1280 picture shows the whole caption ("Test reel alpha deux") with its
margin. **Not read:** the iPhone, a video take, and the signed-in app shell (a build carrying this
change is needed for both).
