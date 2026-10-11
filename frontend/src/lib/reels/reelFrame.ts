/**
 * The geometry of the ONE frame every CanaReels surface draws (camera, review, editor, viewer; see
 * docs/wiki/frontend/modules/reel-editor.md): the frame is shown WHOLE in the screen, never cropped,
 * and never moves while the member types. Pure rules, so a test can hold them.
 */

/** A width and a height in CSS pixels. */
export interface StageSize {
  width: number;
  height: number;
}

/**
 * The stage size to keep, given the previous kept one and what the editor's box measures now.
 *
 * WHY: the keyboard shrinks the layout viewport on both platforms, and so the editor's box, but the
 * picture behind the controls must stay exactly where it was. So the height only ever GROWS while the
 * width is unchanged; a different width is a rotation or a window resize, and takes the new size whole.
 */
export function stableStageSize(previous: StageSize, measured: StageSize): StageSize {
  if (measured.width <= 0 || measured.height <= 0) return previous;
  if (measured.width !== previous.width) return { ...measured };
  return { width: previous.width, height: Math.max(previous.height, measured.height) };
}

/** A frame's rectangle inside the stage, in CSS pixels from the stage's top-left corner. */
export interface FrameBox extends StageSize {
  left: number;
  top: number;
  /** The frame IS the screen (within {@link FRAME_FILL_TOLERANCE}): edge to edge, no rounded corner. */
  fillsStage: boolean;
}

/** How far the stage's aspect may sit from the frame's before the frame stops being "the screen". */
export const FRAME_FILL_TOLERANCE = 0.02;

/**
 * The canonical CanaReels frame, width / height: what the camera records, the review and the editor
 * show, and the viewer plays. Every surface draws the SAME ratio, so what is seen in one is what is
 * seen in the next (user, 2026-10-11). A gallery import keeps its own ratio and uses it for all of them.
 */
export const REEL_FRAME_RATIO = 9 / 16;

/**
 * The frame of aspect `ratio` shown WHOLE in `stage` (object-fit: contain, never cropped), centred.
 * It reports `fillsStage` when the screen has the frame's shape, so the caller draws edge to edge with
 * square corners; otherwise the caller rounds the corners and fills the rest with the backdrop.
 */
export function containFrame(stage: StageSize, ratio: number): FrameBox {
  if (stage.width <= 0 || stage.height <= 0 || !(ratio > 0)) {
    return { left: 0, top: 0, width: 0, height: 0, fillsStage: false };
  }
  const width = Math.min(stage.width, stage.height * ratio);
  const height = width / ratio;
  return {
    left: (stage.width - width) / 2,
    top: (stage.height - height) / 2,
    width,
    height,
    fillsStage: Math.abs(stage.width / stage.height / ratio - 1) <= FRAME_FILL_TOLERANCE,
  };
}

/**
 * Where an overlay's centre (0..1 of the frame) is in the frame's pixels, and back: the ONE mapping the
 * preview and the export both use, so a position set on screen is the position published.
 */
export function frameToPixels(point: { x: number; y: number }, size: StageSize) {
  return { x: point.x * size.width, y: point.y * size.height };
}

/** The inverse of {@link frameToPixels}. */
export function pixelsToFrame(point: { x: number; y: number }, size: StageSize) {
  return { x: point.x / size.width, y: point.y / size.height };
}
