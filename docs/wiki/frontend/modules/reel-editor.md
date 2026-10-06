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
  frame; `touch-action: none` there. The centre is clamped to the frame so an element cannot be lost
  off-screen.
- **Safe areas**: the header pads the top inset, the tool tray the bottom one; the stage is the
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
