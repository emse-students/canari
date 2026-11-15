## P2 - on iOS an edited VIDEO take cannot leave the reel editor ("La capture n'a pas pu etre preparee")

target: 1.7.0

**Found** on the iPhone 12 (TestFlight `1.6.12-alpha.2`) during the reading of 2026-11-15: a video take (3.5 s long press on the shutter, lens covered) opens the editor and every tool works (text, sticker, drawing), but "Suivant" with ANY overlay shows the error "La capture n'a pas pu etre preparee. Reessayez." (`reels_editor_error`), twice in a row. Clearing the overlays (trash) and tapping "Suivant" goes through to "Nouveau CanaReel". So only the re-render of an edited video fails.

**Suspected cause (read in source, not yet proven):** `renderEditedReelMedia` in `frontend/src/lib/reels/reelEditor.ts` re-renders a video through `video.captureStream` + `canvas.captureStream` + `MediaRecorder`, and throws "video editing is unavailable on this device" when one is missing; WebKit lacks `HTMLMediaElement.captureStream`. Unconfirmed: the photo-take control (overlay then "Suivant") was not completed on the phone, because typing into the overlay field was refused by the keyboard guard.

**What closes it:** a probe on the phone that logs which of the three APIs is missing; then either a WebKit-capable export path (frame-by-frame canvas to MediaRecorder) or an honest editor on iOS that offers the tools only where the export works, and the photo-take control read on the phone. Reference: [reel-editor](../frontend/modules/reel-editor.md).
