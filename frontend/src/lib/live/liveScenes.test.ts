/**
 * THE SCENES' PURE RULES (owner, 2026-11-14): what each scene draws on the FIXED frame, the fit math,
 * where a dropped overlay snaps, and what a click on a scene must do.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERLAY,
  LIVE_SCENES,
  STUDIO_FRAME,
  containRect,
  cornerAfterKey,
  coverCrop,
  displayToFrame,
  frameToDisplay,
  overlayBox,
  planSceneChange,
  sceneAfterScreenEnded,
  sceneLayout,
  sceneShowsCamera,
  sceneShowsScreen,
  snapCorner,
  type OverlayCorner,
  type OverlaySettings,
  type Rect,
} from './liveScenes';

const CORNERS: OverlayCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const inside = (r: Rect) =>
  r.x >= 0 &&
  r.y >= 0 &&
  r.x + r.width <= STUDIO_FRAME.width &&
  r.y + r.height <= STUDIO_FRAME.height;

describe('the frame', () => {
  it('is 1280x720, frozen', () => {
    expect(STUDIO_FRAME).toEqual({ width: 1280, height: 720 });
    expect(Object.isFrozen(STUDIO_FRAME)).toBe(true);
  });
});

describe('sceneLayout', () => {
  it('draws each scene from its sources, a screen always whole (contain)', () => {
    const o = DEFAULT_OVERLAY;
    expect(sceneLayout('camera', o, true)).toEqual([
      {
        kind: 'source',
        source: 'camera',
        box: { x: 0, y: 0, width: 1280, height: 720 },
        fit: 'contain',
        round: false,
      },
    ]);
    expect(sceneLayout('screen', o, true)).toEqual([
      {
        kind: 'source',
        source: 'screen',
        box: { x: 0, y: 0, width: 1280, height: 720 },
        fit: 'contain',
        round: false,
      },
    ]);
    const pip = sceneLayout('screen-camera', o, true);
    expect(pip.map((d) => d.kind === 'source' && d.source)).toEqual(['screen', 'camera']);
    expect(pip[1]).toMatchObject({ fit: 'cover', round: true, box: overlayBox(o) });
    const side = sceneLayout('side-by-side', o, true);
    expect(side[0]).toMatchObject({ source: 'screen', fit: 'contain', box: { x: 0, width: 896 } });
    expect(side[1]).toMatchObject({ source: 'camera', fit: 'cover', box: { x: 896, width: 384 } });
    expect(sceneLayout('pause', o, true)).toEqual([
      { kind: 'card', card: 'pause', box: { x: 0, y: 0, width: 1280, height: 720 }, round: false },
    ]);
  });

  it('a camera switched off is its CARD in its box, never another source', () => {
    for (const scene of LIVE_SCENES) {
      const ops = sceneLayout(scene, DEFAULT_OVERLAY, false);
      expect(ops.some((d) => d.kind === 'source' && d.source === 'camera')).toBe(false);
      if (sceneShowsCamera(scene)) {
        expect(ops.some((d) => d.kind === 'card' && d.card === 'camera-off')).toBe(true);
      }
    }
  });

  it('pause shows nothing of either source', () => {
    expect(sceneShowsScreen('pause')).toBe(false);
    expect(sceneShowsCamera('pause')).toBe(false);
    expect(sceneLayout('pause', DEFAULT_OVERLAY, true).every((d) => d.kind === 'card')).toBe(true);
  });

  it('every box of every scene lies inside the frame', () => {
    for (const scene of LIVE_SCENES) {
      for (const corner of CORNERS) {
        for (const size of ['small', 'medium', 'large'] as const) {
          for (const shape of ['round', 'rect'] as const) {
            for (const d of sceneLayout(scene, { corner, size, shape }, true)) {
              expect(inside(d.box), `${scene} ${corner} ${size} ${shape}`).toBe(true);
            }
          }
        }
      }
    }
  });
});

describe('overlayBox', () => {
  it('is a square for a round overlay, 16:9 for a rectangle, growing with its size', () => {
    const round = (size: OverlaySettings['size']) =>
      overlayBox({ corner: 'top-left', size, shape: 'round' });
    expect(round('small').width).toBe(round('small').height);
    expect(round('small').height).toBeLessThan(round('medium').height);
    expect(round('medium').height).toBeLessThan(round('large').height);
    const rect = overlayBox({ corner: 'top-left', size: 'medium', shape: 'rect' });
    expect(rect.width / rect.height).toBeCloseTo(16 / 9, 1);
  });

  it('sits in its corner, at the same margin on both sides', () => {
    const tl = overlayBox({ corner: 'top-left', size: 'small', shape: 'rect' });
    const br = overlayBox({ corner: 'bottom-right', size: 'small', shape: 'rect' });
    expect(tl.x).toBe(tl.y);
    expect(STUDIO_FRAME.width - (br.x + br.width)).toBe(tl.x);
    expect(STUDIO_FRAME.height - (br.y + br.height)).toBe(tl.y);
  });
});

describe('containRect and coverCrop', () => {
  it('contain letterboxes a wide source and pillarboxes a tall one, centred', () => {
    const box = { x: 0, y: 0, width: 1280, height: 720 };
    expect(containRect({ width: 1920, height: 1080 }, box)).toEqual(box);
    // A window 2:1 - black bars above and below.
    expect(containRect({ width: 1000, height: 500 }, box)).toEqual({
      x: 0,
      y: 40,
      width: 1280,
      height: 640,
    });
    // A portrait window - black bars left and right.
    expect(containRect({ width: 720, height: 1280 }, box)).toEqual({
      x: (1280 - 405) / 2,
      y: 0,
      width: 405,
      height: 720,
    });
    expect(containRect({ width: 0, height: 0 }, box)).toBeNull();
  });

  it('cover reads the centred part of the source that fills the box', () => {
    // A 16:9 camera into a square: the middle square of it.
    expect(coverCrop({ width: 1280, height: 720 }, { width: 200, height: 200 })).toEqual({
      x: 280,
      y: 0,
      width: 720,
      height: 720,
    });
    expect(coverCrop({ width: 0, height: 720 }, { width: 200, height: 200 })).toBeNull();
  });

  it('a source that CHANGES SIZE is re-fitted inside the same box: the box never moves', () => {
    const box = { x: 0, y: 0, width: 1280, height: 720 };
    for (const size of [
      { width: 1920, height: 1080 },
      { width: 801, height: 977 },
      { width: 3440, height: 1440 },
      { width: 640, height: 360 },
    ]) {
      const at = containRect(size, box)!;
      expect(at.x).toBeGreaterThanOrEqual(0);
      expect(at.y).toBeGreaterThanOrEqual(0);
      expect(at.x + at.width).toBeLessThanOrEqual(1280 + 1e-9);
      expect(at.y + at.height).toBeLessThanOrEqual(720 + 1e-9);
    }
  });
});

describe('snapCorner and the arrow keys', () => {
  it("snaps to the corner of the dropped overlay's centre", () => {
    expect(snapCorner({ x: 100, y: 100 })).toBe('top-left');
    expect(snapCorner({ x: 1200, y: 100 })).toBe('top-right');
    expect(snapCorner({ x: 100, y: 700 })).toBe('bottom-left');
    expect(snapCorner({ x: 1200, y: 700 })).toBe('bottom-right');
    // On the middle lines: right and bottom, the default corner.
    expect(snapCorner({ x: 640, y: 360 })).toBe('bottom-right');
    // Dragged off the frame: still the nearest corner.
    expect(snapCorner({ x: -300, y: 2000 })).toBe('bottom-left');
  });

  it('an overlay dropped where it was stays in its corner', () => {
    for (const corner of CORNERS) {
      const box = overlayBox({ corner, size: 'large', shape: 'rect' });
      expect(snapCorner({ x: box.x + box.width / 2, y: box.y + box.height / 2 })).toBe(corner);
    }
  });

  it('the arrows move it corner to corner; other keys leave it', () => {
    expect(cornerAfterKey('bottom-right', 'ArrowLeft')).toBe('bottom-left');
    expect(cornerAfterKey('bottom-left', 'ArrowUp')).toBe('top-left');
    expect(cornerAfterKey('top-left', 'ArrowRight')).toBe('top-right');
    expect(cornerAfterKey('top-right', 'ArrowDown')).toBe('bottom-right');
    expect(cornerAfterKey('top-right', 'ArrowUp')).toBe('top-right');
    expect(cornerAfterKey('top-right', 'Tab')).toBe('top-right');
  });

  it('Enter and Space walk the corners clockwise, back to the start after four', () => {
    let corner: OverlayCorner = 'top-left';
    const seen: OverlayCorner[] = [];
    for (const key of ['Enter', ' ', 'Enter', ' ']) {
      corner = cornerAfterKey(corner, key);
      seen.push(corner);
    }
    expect(seen).toEqual(['top-right', 'bottom-right', 'bottom-left', 'top-left']);
  });
});

describe('frameToDisplay and displayToFrame', () => {
  it('place the overlay on a preview drawn contain, and read a pointer back onto the frame', () => {
    // A preview 1000x1000: the frame is drawn 1000x562.5, centred vertically.
    const display = { width: 1000, height: 1000 };
    const box = overlayBox(DEFAULT_OVERLAY);
    const shown = frameToDisplay(box, display)!;
    expect(shown.y).toBeCloseTo((1000 - 562.5) / 2 + box.y * (1000 / 1280));
    const back = displayToFrame(
      { x: shown.x + shown.width / 2, y: shown.y + shown.height / 2 },
      display
    )!;
    expect(back.x).toBeCloseTo(box.x + box.width / 2);
    expect(back.y).toBeCloseTo(box.y + box.height / 2);
    expect(frameToDisplay(box, { width: 0, height: 0 })).toBeNull();
  });
});

describe('planSceneChange - the scene state machine', () => {
  it('stays on the scene already shown', () => {
    expect(planSceneChange('camera', 'camera', false)).toEqual({ kind: 'stay' });
  });

  it('asks for the screen ONLY when a scene needs it and none is held', () => {
    for (const s of ['screen', 'screen-camera', 'side-by-side'] as const) {
      expect(planSceneChange('camera', s, false)).toEqual({ kind: 'ask-screen', scene: s });
      expect(planSceneChange('camera', s, true)).toEqual({ kind: 'switch', scene: s });
    }
  });

  it('switches at once to a scene that needs no screen', () => {
    expect(planSceneChange('screen', 'camera', true)).toEqual({ kind: 'switch', scene: 'camera' });
    expect(planSceneChange('screen', 'pause', true)).toEqual({ kind: 'switch', scene: 'pause' });
    expect(planSceneChange('camera', 'pause', false)).toEqual({ kind: 'switch', scene: 'pause' });
  });

  it('a share that ended turns a screen scene into pause - never into the camera', () => {
    expect(sceneAfterScreenEnded('screen')).toBe('pause');
    expect(sceneAfterScreenEnded('screen-camera')).toBe('pause');
    expect(sceneAfterScreenEnded('side-by-side')).toBe('pause');
    expect(sceneAfterScreenEnded('camera')).toBe('camera');
    expect(sceneAfterScreenEnded('pause')).toBe('pause');
  });
});
