import { getContext, setContext } from 'svelte';

/**
 * A DIALOG OPENED FROM INSIDE A FULL-SCREEN VIEWER MUST CLEAR THAT VIEWER.
 *
 * The reel viewer sits on `--z-viewer` (300), above `--z-modal` (280) and `--z-sheet` (160) because
 * it opens from a modal. Its comments sheet (CanaReels, 2026-10-19) brought the first dialogs that
 * open FROM it - the comment GIF picker (`--z-sheet`) and the comment report dialog
 * (`--z-modal`) - and on their own rung both would open UNDER the viewer: present, focused, and
 * invisible. The viewer says so to its subtree through a context, and `ModalOverlay` and `Modal`
 * then take `--z-viewer-dialog` instead of their own rung. A context rather than a prop because the
 * opener is several components down (`PostComments` -> `GifPickerModal` -> `ModalOverlay`) and none
 * of them knows, or should know, what is above it. `--z-critical` (a confirmation) already clears
 * the viewer and is left alone.
 */
const VIEWER_LAYER = Symbol('viewer-layer');

/** Called by a full-screen viewer during its own initialisation: its subtree's dialogs clear it. */
export function markViewerLayer(): void {
  setContext(VIEWER_LAYER, true);
}

/** Whether the calling component was mounted inside a full-screen viewer. Call at initialisation. */
export function insideViewerLayer(): boolean {
  return getContext<boolean | undefined>(VIEWER_LAYER) === true;
}
