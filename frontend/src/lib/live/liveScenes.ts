/**
 * THE SCENES OF A DESKTOP LIVE (owner, 2026-11-14): ready-made layouts switched in one click while on
 * air, OBS's idea made much simpler - no free layers, five scenes, and a camera overlay that snaps
 * to a corner. Everything here is PURE: which sources a scene shows, where each one is drawn on the
 * fixed output frame, where a dragged overlay lands, and what a click on a scene must do. The
 * canvas that draws it is `liveCompositor.ts`, the state that holds it `liveStudio.svelte.ts`.
 *
 * THE OUTPUT FRAME NEVER CHANGES SIZE (owner's reading of `1.6.12-alpha.2`, 2026-11-14: a window
 * resized while shared turned the viewer's picture into smeared streaks). Every layout below is
 * computed on {@link STUDIO_FRAME}, and every source is fitted INTO its box - a source that changes
 * size changes what is drawn inside the box, never the frame the recorder encodes.
 *
 * Wiki: docs/wiki/frontend/modules/live.md#scenes-on-a-desktop-live-owner-2026-11-14.
 */

import { LIVE_CAPTURE_LONG_SIDE_PX, LIVE_CAPTURE_SHORT_SIDE_PX } from './constants';

/** A width and a height, in pixels. */
export interface Size {
  width: number;
  height: number;
}

/** A rectangle, in pixels, from its top-left corner. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * THE ONE SIZE A COMPOSED LIVE IS ENCODED AT: 1280x720, the camera bench's size. Fixed for the whole
 * live, whatever the sources do - the recorder and the viewers' decoders never see a resolution change.
 */
export const STUDIO_FRAME: Readonly<Size> = Object.freeze({
  width: LIVE_CAPTURE_LONG_SIDE_PX,
  height: LIVE_CAPTURE_SHORT_SIDE_PX,
});

/** The five scenes, in the order the bar shows them. */
export const LIVE_SCENES = ['camera', 'screen', 'screen-camera', 'side-by-side', 'pause'] as const;

/** What a desktop live shows: one of {@link LIVE_SCENES}. */
export type LiveScene = (typeof LIVE_SCENES)[number];

/** A source a scene can draw. */
export type LiveSceneSource = 'camera' | 'screen';

/** The corner the camera overlay sits in. */
export type OverlayCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** The three overlay sizes. */
export type OverlaySize = 'small' | 'medium' | 'large';

/** The overlay's shape. */
export type OverlayShape = 'round' | 'rect';

/** How the camera overlay of {@link LiveScene} `screen-camera` is drawn. */
export interface OverlaySettings {
  corner: OverlayCorner;
  size: OverlaySize;
  shape: OverlayShape;
}

/** Where the overlay starts: bottom right, medium, round - the usual streaming corner. */
export const DEFAULT_OVERLAY: Readonly<OverlaySettings> = Object.freeze({
  corner: 'bottom-right',
  size: 'medium',
  shape: 'round',
});

/** The overlay's height as a share of the frame's height, per size. */
export const OVERLAY_HEIGHT_SHARE: Readonly<Record<OverlaySize, number>> = Object.freeze({
  small: 0.22,
  medium: 0.3,
  large: 0.4,
});

/** The gap between the overlay and the frame's edges, as a share of the frame's height. */
export const OVERLAY_MARGIN_SHARE = 0.035;

/** The share of the frame's width the screen takes in `side-by-side`; the camera has the rest. */
export const SIDE_BY_SIDE_SCREEN_SHARE = 0.7;

/** Whether `scene` draws the shared screen (and lets the share's own sound be heard). */
export function sceneShowsScreen(scene: LiveScene): boolean {
  return scene === 'screen' || scene === 'screen-camera' || scene === 'side-by-side';
}

/** Whether `scene` draws the camera. */
export function sceneShowsCamera(scene: LiveScene): boolean {
  return scene === 'camera' || scene === 'screen-camera' || scene === 'side-by-side';
}

/**
 * One thing to draw: a source fitted into a box, or a CARD - a plain panel with one line on it, drawn
 * where a camera would be when it is switched off or missing, and over the whole frame for `pause`.
 * `contain` shows the whole source with black bars (a screen: nothing of it is cut); `cover` fills
 * the box and crops (the camera in a box of another shape). `round` clips to the box's inscribed circle.
 */
export type SceneDraw =
  | { kind: 'source'; source: LiveSceneSource; box: Rect; fit: 'contain' | 'cover'; round: boolean }
  | { kind: 'card'; card: 'pause' | 'camera-off'; box: Rect; round: boolean };

/** The overlay's box on `frame` for `settings`: a 16:9 rectangle or a circle's square, in its corner. */
export function overlayBox(settings: OverlaySettings, frame: Size = STUDIO_FRAME): Rect {
  const height = Math.round(frame.height * OVERLAY_HEIGHT_SHARE[settings.size]);
  const width = settings.shape === 'round' ? height : Math.round((height * 16) / 9);
  const margin = Math.round(frame.height * OVERLAY_MARGIN_SHARE);
  const left = settings.corner.endsWith('left');
  const top = settings.corner.startsWith('top');
  return {
    x: left ? margin : frame.width - margin - width,
    y: top ? margin : frame.height - margin - height,
    width,
    height,
  };
}

/**
 * What `scene` draws on `frame`, back to front. `cameraShown` is false while the member switched the
 * camera off or none is open: its box then carries the `camera-off` card, never another source - a
 * scene never shows something the member did not put in it.
 */
export function sceneLayout(
  scene: LiveScene,
  overlay: OverlaySettings,
  cameraShown: boolean,
  frame: Size = STUDIO_FRAME
): SceneDraw[] {
  const whole: Rect = { x: 0, y: 0, width: frame.width, height: frame.height };
  const camera = (box: Rect, fit: 'contain' | 'cover', round: boolean): SceneDraw =>
    cameraShown
      ? { kind: 'source', source: 'camera', box, fit, round }
      : { kind: 'card', card: 'camera-off', box, round };
  switch (scene) {
    case 'camera':
      return [camera(whole, 'contain', false)];
    case 'screen':
      return [{ kind: 'source', source: 'screen', box: whole, fit: 'contain', round: false }];
    case 'screen-camera':
      return [
        { kind: 'source', source: 'screen', box: whole, fit: 'contain', round: false },
        camera(overlayBox(overlay, frame), 'cover', overlay.shape === 'round'),
      ];
    case 'side-by-side': {
      const split = Math.round(frame.width * SIDE_BY_SIDE_SCREEN_SHARE);
      return [
        {
          kind: 'source',
          source: 'screen',
          box: { x: 0, y: 0, width: split, height: frame.height },
          fit: 'contain',
          round: false,
        },
        camera(
          { x: split, y: 0, width: frame.width - split, height: frame.height },
          'cover',
          false
        ),
      ];
    }
    case 'pause':
      return [{ kind: 'card', card: 'pause', box: whole, round: false }];
  }
}

/**
 * `content` fitted INSIDE `box` keeping its shape, centred: the black bars are what is left of the
 * box. A content with no size yet (a video before its first frame) answers null - nothing to draw.
 */
export function containRect(content: Size, box: Rect): Rect | null {
  if (content.width <= 0 || content.height <= 0) return null;
  const scale = Math.min(box.width / content.width, box.height / content.height);
  const width = content.width * scale;
  const height = content.height * scale;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

/**
 * The part of `content` that FILLS a box of `box`'s shape, centred: the source rectangle to read so
 * the box is covered with nothing stretched. Null for a content with no size yet.
 */
export function coverCrop(content: Size, box: Size): Rect | null {
  if (content.width <= 0 || content.height <= 0 || box.width <= 0 || box.height <= 0) return null;
  const scale = Math.max(box.width / content.width, box.height / content.height);
  const width = box.width / scale;
  const height = box.height / scale;
  return {
    x: (content.width - width) / 2,
    y: (content.height - height) / 2,
    width,
    height,
  };
}

/**
 * The corner nearest to where a dragged overlay was let go: its CENTRE's side of the frame, on each
 * axis. A centre exactly on the middle line keeps the right and the bottom (the default corner).
 */
export function snapCorner(
  center: { x: number; y: number },
  frame: Size = STUDIO_FRAME
): OverlayCorner {
  const left = center.x < frame.width / 2;
  const top = center.y < frame.height / 2;
  return `${top ? 'top' : 'bottom'}-${left ? 'left' : 'right'}`;
}

/** The corners in clockwise order, from the top left: the order Enter and Space walk. */
const CLOCKWISE: readonly OverlayCorner[] = [
  'top-left',
  'top-right',
  'bottom-right',
  'bottom-left',
];

/** The keys the overlay's handle answers, for its `aria-keyshortcuts`. */
export const OVERLAY_KEYS = 'ArrowUp ArrowDown ArrowLeft ArrowRight Enter Space';

/**
 * The corner a key moves the overlay to (the keyboard's drag), or the same corner. An arrow goes
 * to the corner on that side; Enter or Space - the handle's activation, being a button - moves it to
 * the next corner clockwise, so a keyboard reaches every corner with the one key too.
 */
export function cornerAfterKey(corner: OverlayCorner, key: string): OverlayCorner {
  if (key === 'Enter' || key === ' ') {
    return CLOCKWISE[(CLOCKWISE.indexOf(corner) + 1) % CLOCKWISE.length];
  }
  const top = corner.startsWith('top');
  const left = corner.endsWith('left');
  const next = (t: boolean, l: boolean): OverlayCorner =>
    `${t ? 'top' : 'bottom'}-${l ? 'left' : 'right'}`;
  switch (key) {
    case 'ArrowLeft':
      return next(top, true);
    case 'ArrowRight':
      return next(top, false);
    case 'ArrowUp':
      return next(true, left);
    case 'ArrowDown':
      return next(false, left);
    default:
      return corner;
  }
}

/**
 * Maps a rectangle of the frame onto the preview element that shows the frame with `object-fit:
 * contain` at `display` size - where to put the drag handle over the overlay the member sees. Null
 * before the preview has a size.
 */
export function frameToDisplay(rect: Rect, display: Size, frame: Size = STUDIO_FRAME): Rect | null {
  if (display.width <= 0 || display.height <= 0) return null;
  const shown = containRect(frame, { x: 0, y: 0, width: display.width, height: display.height });
  if (!shown) return null;
  const scale = shown.width / frame.width;
  return {
    x: shown.x + rect.x * scale,
    y: shown.y + rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/** The inverse of {@link frameToDisplay} for a point: where on the frame a pointer on the preview is. */
export function displayToFrame(
  point: { x: number; y: number },
  display: Size,
  frame: Size = STUDIO_FRAME
): { x: number; y: number } | null {
  if (display.width <= 0 || display.height <= 0) return null;
  const shown = containRect(frame, { x: 0, y: 0, width: display.width, height: display.height });
  if (!shown) return null;
  const scale = frame.width / shown.width;
  return { x: (point.x - shown.x) * scale, y: (point.y - shown.y) * scale };
}

/**
 * WHAT A CLICK ON A SCENE MUST DO - the scene state machine:
 * - the scene already shown: nothing;
 * - a scene that shows the screen while none is held: ASK FOR ONE (the browser's picker, which only
 *   a click may open - the caller is that click), and switch only once it is granted;
 * - anything else: switch at once - the sources it needs are held, or it needs none (`camera` with
 *   the camera off draws its card, `pause` draws nothing of either).
 */
export type SceneChange =
  | { kind: 'stay' }
  | { kind: 'switch'; scene: LiveScene }
  | { kind: 'ask-screen'; scene: LiveScene };

/** See {@link SceneChange}. */
export function planSceneChange(
  current: LiveScene,
  requested: LiveScene,
  screenHeld: boolean
): SceneChange {
  if (requested === current) return { kind: 'stay' };
  if (sceneShowsScreen(requested) && !screenHeld) return { kind: 'ask-screen', scene: requested };
  return { kind: 'switch', scene: requested };
}

/**
 * The scene after the share ENDED (stopped from the browser's own bar, or the shared window closed):
 * a scene that showed the screen becomes `pause` - never the camera, which would put the member's
 * face where they had chosen to show something else - and any other scene stays as it is.
 */
export function sceneAfterScreenEnded(current: LiveScene): LiveScene {
  return sceneShowsScreen(current) ? 'pause' : current;
}
