import { describe, expect, it } from 'vitest';
import {
  NO_BANDS,
  OVERLAY_EDGE_INSET,
  controlBands,
  fitScale,
  keptInFrame,
  overlayExtent,
  settledClearOfControls,
} from './overlayReach';
import { createEmojiOverlay, createTextOverlay, EMOJI_BASE_SIZE } from './reelOverlays';

/** A 9:16 frame as the Mi 9T draws it (CSS px). */
const FRAME = { width: 400, height: 711 };
const UPRIGHT = { x: 0.5, y: 0.5, scale: 1, rotation: 0 };
/** A text twice the frame's short side wide and a tenth of it tall, at scale 1. */
const WIDE = { width: 2, height: 0.1 };

describe('overlayExtent', () => {
  it('reads an emoji from the data and a text from the box the screen drew', () => {
    expect(overlayExtent(createEmojiOverlay('x'), null, 400)).toEqual({
      width: EMOJI_BASE_SIZE,
      height: EMOJI_BASE_SIZE,
    });
    const text = { ...createTextOverlay('salut', '#fff')!, scale: 2 };
    // 320 x 40 px drawn at scale 2 on a 400 px short side: 0.4 x 0.05 short sides at scale 1.
    expect(overlayExtent(text, { width: 320, height: 40 }, 400)).toEqual({
      width: 0.4,
      height: 0.05,
    });
  });

  it('gives a text the screen has not measured no extent, which constrains only the centre', () => {
    const text = createTextOverlay('salut', '#fff')!;
    expect(overlayExtent(text, null, 400)).toEqual({ width: 0, height: 0 });
    expect(fitScale({ width: 0, height: 0 }, 0, FRAME)).toBe(Infinity);
  });
});

describe('keptInFrame', () => {
  it('keeps the whole box inside, less the edge inset: a text dragged off the right edge stops short of it', () => {
    const kept = keptInFrame({ ...UPRIGHT, x: 1, y: 1 }, { width: 0.5, height: 0.1 }, FRAME);
    // Half of 0.5 short sides (200 px) is 100 px = 0.25 of the width, plus the 8 px inset (0.02);
    // half of 40 px tall is 20 px, plus 8 px, over 711.
    expect(OVERLAY_EDGE_INSET * 400).toBe(8);
    expect(kept.x).toBeCloseTo(0.73);
    expect(kept.y).toBeCloseTo(1 - 28 / 711);
    expect(kept.scale).toBe(1);
  });

  it('shrinks a text wider than the frame to the largest scale that fits, and centres it', () => {
    const kept = keptInFrame({ ...UPRIGHT, x: 0.9 }, WIDE, FRAME);
    // 800 px at scale 1 in a 400 px frame that keeps 8 px each side: 384 / 800.
    expect(kept.scale).toBeCloseTo(0.48);
    expect(kept.x).toBeCloseTo(0.5);
  });

  it('measures a turned overlay by its turned box', () => {
    // A quarter turn: the wide text now stands, 2 short sides (800 px) tall in a 711 px frame.
    const kept = keptInFrame({ ...UPRIGHT, rotation: Math.PI / 2 }, WIDE, FRAME);
    expect(kept.scale).toBeCloseTo((711 - 16) / 800);
  });

  it('never grows a scale, only caps it', () => {
    const kept = keptInFrame({ ...UPRIGHT, scale: 0.4 }, WIDE, FRAME);
    expect(kept.scale).toBe(0.4);
  });
});

describe('settledClearOfControls', () => {
  const emoji = { width: EMOJI_BASE_SIZE, height: EMOJI_BASE_SIZE };

  it('moves a centre released over the tray up to the tray edge', () => {
    const settled = settledClearOfControls({ ...UPRIGHT, y: 0.92 }, emoji, FRAME, {
      top: 0.1,
      bottom: 0.25,
    });
    expect(settled.y).toBeCloseTo(0.75);
  });

  it('moves a centre released under the header down to its edge', () => {
    const settled = settledClearOfControls({ ...UPRIGHT, y: 0.05 }, emoji, FRAME, {
      top: 0.1,
      bottom: 0.25,
    });
    expect(settled.y).toBeCloseTo(0.1);
  });

  it('leaves an overlay that is clear of both as it is', () => {
    const at = { ...UPRIGHT, x: 0.3, y: 0.4 };
    expect(settledClearOfControls(at, emoji, FRAME, { top: 0.1, bottom: 0.25 })).toEqual(at);
    expect(settledClearOfControls(at, emoji, FRAME, NO_BANDS)).toEqual(at);
  });

  it('when the controls leave no room, takes the middle between them and stays inside the frame', () => {
    const settled = settledClearOfControls({ ...UPRIGHT, y: 0.9 }, emoji, FRAME, {
      top: 0.6,
      bottom: 0.6,
    });
    expect(settled.y).toBeCloseTo(0.5);
  });
});

describe('controlBands', () => {
  it('reads the share of the frame under the header and above the tray', () => {
    const frame = { top: 0, height: 800 };
    expect(controlBands(frame, { bottom: 80, height: 80 }, { top: 600, height: 200 })).toEqual({
      top: 0.1,
      bottom: 0.25,
    });
  });

  it('counts only what overlaps a frame centred lower on the screen, and a control not laid out as nothing', () => {
    const frame = { top: 100, height: 600 };
    expect(controlBands(frame, { bottom: 80, height: 80 }, { top: 0, height: 0 })).toEqual(
      NO_BANDS
    );
    expect(controlBands(frame, null, { top: 640, height: 200 }).bottom).toBeCloseTo(0.1);
  });
});
