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
 * The stage size to keep while the keyboard may be open: the height only GROWS while the width is
 * unchanged (a new width is a rotation and is taken whole). The keyboard shrinks the layout viewport,
 * and the picture behind the controls must stay exactly where it was.
 */
export function stableStageSize(previous: StageSize, measured: StageSize): StageSize {
  if (measured.width <= 0 || measured.height <= 0) return previous;
  if (measured.width !== previous.width) return { ...measured };
  return { width: previous.width, height: Math.max(previous.height, measured.height) };
}

/** The stage the frame is laid in, and whether it is still held at a larger height than the box measures. */
export interface StageState {
  kept: StageSize;
  holding: boolean;
}

/**
 * One step of the stage's life. WHILE `latch` (the editor's text field, i.e. the keyboard, is open) the
 * stage keeps the largest height seen. When the latch drops the hold continues until the box grows back
 * (the keyboard closing) or changes width, so the frame does not jump to the shrunken box and back.
 * With no latch the stage FOLLOWS the box: the camera must record the box the member actually sees.
 */
export function stageStep(state: StageState, measured: StageSize, latch: boolean): StageState {
  if (measured.width <= 0 || measured.height <= 0) return state;
  if (latch) return { kept: stableStageSize(state.kept, measured), holding: true };
  if (state.holding && measured.width === state.kept.width && measured.height < state.kept.height) {
    return state;
  }
  return { kept: { ...measured }, holding: false };
}

/** A frame's rectangle inside the stage, in CSS pixels from the stage's top-left corner. */
export interface FrameBox extends StageSize {
  left: number;
  top: number;
  /** The frame takes the whole screen (within {@link FRAME_FILL_TOLERANCE}): square corners, no backdrop. */
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
 * The frame of aspect `ratio` in `stage`, centred: shown WHOLE (object-fit: contain) and rounded over
 * a backdrop when the screen's shape differs; when the screen has the frame's shape (within
 * {@link FRAME_FILL_TOLERANCE}) it is the WHOLE stage, edge to edge - cover ON PURPOSE, so no sliver of
 * backdrop shows. The media is then fitted to the frame by the caller, which crops at most 1 % per side.
 */
export function containFrame(stage: StageSize, ratio: number): FrameBox {
  if (stage.width <= 0 || stage.height <= 0 || !(ratio > 0)) {
    return { left: 0, top: 0, width: 0, height: 0, fillsStage: false };
  }
  if (Math.abs(stage.width / stage.height / ratio - 1) <= FRAME_FILL_TOLERANCE) {
    return { left: 0, top: 0, width: stage.width, height: stage.height, fillsStage: true };
  }
  const width = Math.min(stage.width, stage.height * ratio);
  const height = width / ratio;
  return {
    left: (stage.width - width) / 2,
    top: (stage.height - height) / 2,
    width,
    height,
    fillsStage: false,
  };
}

/**
 * Whether the frame's bottom edge is the stage's (to the pixel): only then does it sit under the
 * home indicator, so only then does what is drawn at its bottom owe the bottom safe-area inset. A
 * letterboxed (landscape) frame is centred well above it, and paying the inset there costs a
 * caption most of its room (review of #1942).
 */
export function frameReachesBottom(stage: StageSize, box: FrameBox): boolean {
  return box.height > 0 && box.top + box.height >= stage.height - 1;
}

/**
 * Where an overlay's centre (0..1 of the frame) is in the frame's pixels: the ONE mapping the export
 * paints with (`drawDecorations`), and the same share the preview writes as `left`/`top` percentages.
 */
export function frameToPixels(point: { x: number; y: number }, size: StageSize) {
  return { x: point.x * size.width, y: point.y * size.height };
}
