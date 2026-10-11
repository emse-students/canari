/**
 * The geometry of the reel editor's stage (docs/wiki/frontend/modules/reel-editor.md): the media
 * ALWAYS fills the whole screen, whatever the editing state, and never moves or resizes while the
 * member types. Two pure rules carry that, so a test can hold them.
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

/**
 * The size of the media's own frame (aspect `ratio` = width / height) when it COVERS the stage, as
 * `object-fit: cover` would: the smaller scale that fills both dimensions. The frame may overflow the
 * stage on one axis (the stage clips it); overlays and the export keep addressing the whole frame, so
 * the published media is the one the member saw, minus the sliver the screen shape cropped.
 */
export function coverFrameSize(stage: StageSize, ratio: number): StageSize {
  if (stage.width <= 0 || stage.height <= 0 || !(ratio > 0)) return { width: 0, height: 0 };
  const width = Math.max(stage.width, stage.height * ratio);
  return { width, height: width / ratio };
}
