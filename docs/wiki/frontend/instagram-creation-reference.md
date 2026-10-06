# Instagram's creation UI - a reference to copy the interaction model from (read 2026-10-05)

Read on the Mi 9T (Android, French UI, `com.instagram.android`) with the user watching, from the
accessibility tree plus screenshots. **Creation flows only**: nothing was published, sent or saved,
and the one test draft (an existing gallery clip with a text overlay) was discarded through
"Recommencer". Screenshots are NOT in the repo (they show the user's account). The reel editor
itself is Canari's [CanaReels client](modules/reels.md); this page is what to compare it to.

**What was reached and what was not.** Reached: the creation entry, the gallery picker, the reel
camera and its side tools, the editor, the text composer (every panel), the timeline editor (clip,
text and audio tracks, clip actions). **NOT reached**: the clip Volume, Speed and Rogner sub-panels
(the automation was denied that tap, so their semantics below are the ACTION NAMES only), the music
browser, drawing, stickers, filters, captions, voice-over, the share screen, and the STORY and
POST cameras (only their mode tabs). Anything marked *unread* below is recall, not observation.

## (a) Screen map

```
home "+" --> GALLERY PICKER ("Nouveau reel")  --camera tile--> CAMERA (mode strip: PUBLIER | STORY | REEL | EN DIRECT)
              |  Brouillons, Modeles, Recent v, Selectionner (multi)         |  tap tool -> inline popover
              |  pick a clip                                                 |  shutter -> take -> EDITOR
              v                                                              v
           EDITOR (full-bleed preview, tool tray, "Modifier la video", "Suivant")
              |-- Texte --> TEXT COMPOSER (keyboard + 7-tool strip) --check--> back to EDITOR (text is now a sticker)
              |-- tap an overlay --> TIMELINE EDITOR ("Tester Edits") --back arrow / Fermer--> EDITOR
              |-- Audio / Voix / Sous-titres / Stickers  (unread)
              |-- X --> sheet "Enregistrer le brouillon ?": Recommencer | Enregistrer | Continuer
              '-- Suivant --> SHARE screen (unread, not opened: it is where publishing happens)
```

## (b) Per-screen controls and gestures

**Gallery picker.** Close (top-left), camera settings gear (top-right). Row of chips: Drafts,
Templates. Album dropdown ("Recent") and a multi-select toggle. 3-column grid, a camera tile first,
duration badge bottom-right of each video. The destination strip is a floating pill at the bottom,
four labels, the current one bold: POST | STORY | REEL | LIVE (swipe or tap).

**Reel camera.** Full-bleed preview with rounded bottom corners, a black strip below it carrying the
shutter. Top: close (left), flash (centre), settings (right), and an "Add audio" pill under the flash.
Left rail, top to bottom: Audio, Effects (sparkles), Green screen, Retouch, Duration, Speed, Timer.
Bottom: gallery thumbnail (left), the shutter (centre) flanked by an effect carousel (circular
previews, the selected one is the shutter), lens flip (right), the mode strip under all of it.
Duration is a 2x2 popover: 15 s | 30 s | 60 s | 20 min (the cap is the camera's, set BEFORE
recording). Speed shows `1x` and opens a rail (unread past that).

**Editor.** The video fills the screen (no letterbox); top: X (left), and the audio-explorer toast
"Explore audio" when idle. Tapping the preview pauses and resumes. A chevron handle above the tray
expands more tools. Tray, left to right: Audio, Text, Voice, Captions, Stickers (icon tile + label).
Bottom row: "Modify video" (left, grey pill) and "Next ->" (right, filled blue pill); the same two
sit in the bottom safe area, 56 px above the home indicator, never under a tool.

**Text composer (the part worth copying exactly).** Tapping Text opens it with the keyboard up.
- Live text is centred on a dimmed preview; **a vertical size slider on the LEFT edge** (thumb
  mid-height, drag up for larger) - the system keyboard stays up while it is dragged.
- A 7-icon strip sits ABOVE the keyboard: keyboard, font, colour, animation, effect, highlight,
  alignment. Tapping an icon swaps the keyboard for that panel IN THE SAME SPACE (a bottom sheet with
  a drag handle); the keyboard icon brings it back. Check mark top-right commits.
- **Font**: 8 named styles in a 2-column grid (Modern, Modern Bold, Classic, Classic Light,
  Signature, Editor, Poster, Bubble), each rendered in its own face; the current has a white outline.
- **Colour**: a row of 9 swatches (eyedropper first, white, black, blue, green, yellow, orange, red,
  pink, purple) then three sliders: hue, saturation, brightness.
- **Animation** (text enters): None, Typewriter, Pop, Jump, Step by step, Step fade, Fade, Zoom.
- **Effect**: None, Hard shadow, Block offset, Neon, Halo, Shimmer, Digital (countdown), Dream.
- **Highlight**: a single button that CYCLES none, outline, and the filled/pill backgrounds (its icon
  and accessible name change: "highlight with a coloured outline"). **Alignment**: one button that
  cycles centre, left, right.
- On commit the text becomes a **sticker**: accessible name "Sticker. Long-press to reposition. Use
  two fingers to rotate or resize." Long-press then drag moves it, a two-finger gesture rotates and
  scales; tapping it re-enters the timeline editor with the text track selected (it did NOT reopen the
  composer).

**Timeline editor ("Tester Edits").** Opened by tapping an overlay. A one-time coach mark ("swipe up
or down to resize the preview", OK) appears first. Layout, top to bottom: header (collapse chevron,
a "Tester Edits" pill, a round "next" arrow); the preview, now a smaller rounded 9:16 card;
play/pause (left), `0:00 / 0:08` (centre), undo and redo (right); a ruler; then **tracks stacked
under a fixed centre playhead** which the content scrolls beneath: the video track (frame thumbnails,
a speaker/mute icon at its left, a "+" at its right end to append a clip), an audio track ("Add
audio" placeholder), and one bar per text overlay (purple, label inside).
- **A new text overlay spans the WHOLE clip** (accessible label "Text, TestIG, 0:00 - 0:08"). Its bar
  has yellow end handles when selected: drag an end to shorten it. The preview shows a yellow box on
  the selected overlay.
- Selecting the text bar: bottom actions Delete, Edit, Stickers, Duplicate (back chevron at left).
- **Selecting the video clip** wraps it in a yellow frame with end handles (accessibility: "Trim the
  start"), a duration label (`8,0 s`) on its left, and the playhead time turns yellow. Actions
  (scrolling row): Delete, Cut silences (flagged "New"), Volume, Speed, Crop ("Rogner"), more.
- With nothing selected the bottom row is the global tools: Audio, Text, Voice, Captions, Stickers,
  **Filters**.

**Draft sheet** (X from the editor): a bottom sheet "Save draft? If you go back you will lose this
draft." with a red Start over, Save draft, Continue editing. Start over is the destructive row.

## (c) What Canari has today versus what Instagram offers

Canari: `ReelCapture` + `CameraScreen` (back/front lens, torch where the lens has it, 90 s cap,
gallery tile, deadline-driven stop), `ReelEditor` (freehand strokes, one text at a fixed spot and
size, clear-all, render baked into the media), `ReelReview`, `ReelPublishSheet` (caption, 30-day
expiry note), `prepareVideoForUpload` ([video-preparation](video-preparation.md)).

| Instagram | Canari today | Gap |
| --- | --- | --- |
| Mode strip (post/story/reel/live) | one camera, reels only | by design (the destination is a post kind) |
| Duration chooser before recording (15/30/60 s) | a single 90 s cap | small |
| Speed, timer, retouch, green screen, effects carousel | none | see tiers |
| Gallery picker with album, multi-select, drafts, templates | gallery tile, single pick | multi-select and drafts |
| Text: font x8, colour + sliders, animation x8, effect x8, highlight, align, size slider | one text, one colour, a fixed size and position | large - the composer is the biggest single gap |
| Text becomes a sticker: move, two-finger rotate and scale, trash on drag | text is not movable after adding | gestures missing |
| Text/sticker duration on a timeline | overlays are drawn on the WHOLE clip | no per-overlay timing |
| Drawing | freehand strokes, one colour | brush types, undo |
| Trim handles, split, clip reorder, add clip, transitions | none (the recording is the clip) | multi-clip is a model change |
| Volume (clip and music), mute toggle on the track, cut silences | none | audio mixing |
| Music library, voice-over, captions, stickers | none | licensing and a mixer |
| Filters | none | tier 1 |
| Crop / aspect ("Rogner") | fixed 9:16 | small |
| Undo and redo | clear-all only | history stack |
| Draft sheet (save / start over / continue) | none | drafts store |
| Share screen: caption, audience, cover | `ReelPublishSheet`: caption only | cover frame |

## (d) Feasibility for a SvelteKit 5 + Tauri webview

Constraint that decides most rows: Canari renders edits by **drawing each frame on a canvas and
re-recording it** (`reelEditor.ts`), which keeps the output one fragmented H.264/AAC MP4 but is
real-time and lossy. Anything that needs the source's audio mixed with another track, a different
speed, or an offline export is where the pipeline has to change.

| Tier | Features |
| --- | --- |
| **1 - cheap: pointer events and a canvas** | movable/rotatable/scalable text object (pointer events with two-pointer rotate+scale, trash zone, bring-to-front by array order); the text panels (font strip of 8 `@font-face`s, colour swatches + three range sliders, alignment cycle, highlight pill on the canvas, size slider); outline/shadow/neon/halo text effects (canvas `shadowBlur`, stroke); drawing with undo; per-overlay start/end (a plain timeline of `[start, end]` pairs, drawn when `t` is inside); duration chooser; timer countdown; filters as canvas `filter` / CSS (brightness, contrast, sepia, hue); undo/redo history; a draft sheet and local drafts; crop by `object-position` plus a frame mask; mute toggle (set `muted` on the source when drawing). |
| **2 - needs a render and export pipeline** | text enter animations (Typewriter, Pop, Jump, Fade, Zoom: keyframes drawn per frame, so the render must be driven by a clock, not a live re-record); trim, split and multi-clip with transitions (a timeline model and a frame-accurate seek; WebCodecs where the webview has it, else a `MediaRecorder` pass); speed changes and slow-motion (re-time frames AND resample audio); clip and music volume (WebAudio mixing into the recording's audio track); voice-over (a mic track on that mixer); cut silences (offline analysis of the audio); cover frame; template reuse; multi-select gallery picks. |
| **3 - native, heavy or not ours to ship** | a music library (licensing, a catalogue, a rights holder - not a code problem); AR face effects, green screen and retouch (segmentation and face-mesh models; ML Kit or MediaPipe on native, a WASM model on the webview at a frame-rate cost); automatic captions (speech-to-text, on-device or a service); a native encoder for a faster, higher-quality export. |

## (e) Recommended MVP order

1. **The text object** (tier 1): move, rotate, scale by pointer, trash zone, size slider, colour
   swatches, the font strip. It is the thing users touch first and the largest gap, and it needs no
   new pipeline.
2. **Per-overlay timing** (tier 1): the default span is the whole clip (copying Instagram), two
   drag handles shorten it. This fixes the text-lasts-the-whole-reel problem with a data field.
3. **Undo/redo, a draft sheet and a mute toggle** (tier 1): all state, no rendering.
4. **Trim of the single clip** (tier 2, the cheapest member of it): two handles and a seek, one
   output re-record. Prove the timeline model here before multi-clip.
5. **Text animations and effects** (tier 2): after the render is clock-driven.
6. **Volume and a voice-over mixer** (tier 2), then **speed**.
7. Leave **music, AR and auto-captions** (tier 3) until a decision is taken outside the editor.

The layout rules worth copying regardless of tier: the commit control lives top-right in every
composer; the primary "Next" is bottom-right in the safe area and never shares a row with a tool;
tools open inline in the space the keyboard held, never as a modal over the preview; and the
destructive exit asks, with the safe option last-but-one and "continue" always offered.
