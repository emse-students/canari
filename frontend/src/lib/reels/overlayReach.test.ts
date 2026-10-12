import { describe, expect, it } from 'vitest';
import {
  NO_BANDS,
  OVERLAY_EDGE_INSET,
  controlBands,
  fitScale,
  keptInFrame,
  overlayExtent,
  placedAfterResize,
  settledClearOfControls,
  settlesOnRelease,
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
  it('reads the share of the frame under the header and the tray laid against the stage bottom', () => {
    const frame = { top: 0, height: 800 };
    expect(controlBands(frame, 0, { bottom: 80, height: 80 }, 200)).toEqual({
      top: 0.1,
      bottom: 0.25,
    });
  });

  it('gives the same bands with the keyboard up: the tray HEIGHT, never its raised top edge', () => {
    // The Mi 9T frame (latched, 102..877) in a 945 px box; the keyboard raises the tray but not its height.
    const frame = { top: 102, height: 775 };
    const keyboardDown = controlBands(frame, 0, { bottom: 90, height: 90 }, 184);
    const keyboardUp = controlBands(frame, 0, { bottom: 90, height: 90 }, 184);
    expect(keyboardUp).toEqual(keyboardDown);
    // The latched stage ends at 877 + 102 = 979; the tray covers 979 - 184 = 795 .. 877 of the frame.
    expect(keyboardDown.bottom).toBeCloseTo((877 - 795) / 775);
  });

  it('counts only what overlaps the frame, and a control not laid out as nothing', () => {
    const frame = { top: 100, height: 600 };
    expect(controlBands(frame, 0, { bottom: 80, height: 80 }, 0)).toEqual(NO_BANDS);
    expect(controlBands(frame, 0, null, 160).bottom).toBeCloseTo(0.1);
  });
});

describe('settlesOnRelease', () => {
  it('settles a gesture that changed the layout, never a tap, never while the text field is open', () => {
    expect(settlesOnRelease(false, true)).toBe(true);
    expect(settlesOnRelease(false, false)).toBe(false);
    expect(settlesOnRelease(true, true)).toBe(false);
  });
});

describe('the gesture start widens the bounds', () => {
  // A stroke drawn to the left edge: its centre sits where its cap and the inset stick out.
  const stroke = { width: 0.3, height: 0.012 };
  const start = { ...UPRIGHT, x: 0.15 };

  it('never makes an overlay jump inwards at the first move, and never pushes it further out', () => {
    expect(keptInFrame(start, stroke, FRAME).x).toBeGreaterThan(0.15);
    expect(keptInFrame(start, stroke, FRAME, start).x).toBe(0.15);
    expect(keptInFrame({ ...start, x: 0.05 }, stroke, FRAME, start).x).toBe(0.15);
    expect(keptInFrame({ ...start, x: 0.3 }, stroke, FRAME, start).x).toBe(0.3);
  });

  it('keeps a scale already above the fit, and lets it shrink', () => {
    const big = { ...UPRIGHT, scale: 0.9 };
    expect(keptInFrame(big, WIDE, FRAME, big).scale).toBe(0.9);
    expect(keptInFrame({ ...big, scale: 1.2 }, WIDE, FRAME, big).scale).toBe(0.9);
    expect(keptInFrame({ ...big, scale: 0.4 }, WIDE, FRAME, big).scale).toBe(0.4);
  });

  it('settles with the same widened bounds, so a release does not jump either', () => {
    const settled = settledClearOfControls(start, stroke, FRAME, { top: 0.1, bottom: 0.25 }, start);
    expect(settled.x).toBe(0.15);
  });
});

describe('a rotation that shrank a wide text', () => {
  it('does not give the size back when turned upright again: the gesture continues from the cap', () => {
    // A landscape frame: 1.5 short sides (600 px) fit across 711 px, not down 400 px.
    const landscape = { width: 711, height: 400 };
    const text = { width: 1.5, height: 0.1 };
    expect(keptInFrame(UPRIGHT, text, landscape).scale).toBe(1);
    const turned = keptInFrame({ ...UPRIGHT, rotation: Math.PI / 2 }, text, landscape);
    expect(turned.scale).toBeCloseTo(0.64);
    expect(keptInFrame({ ...turned, rotation: 0 }, text, landscape).scale).toBe(turned.scale);
  });
});

describe('placedAfterResize - a restyle with the keyboard up', () => {
  // Read on the Mi 9T (2026-10-12): a text near the right edge, restyled to serif then to a
  // background box with the field open, grew past the screen edge for the whole edit, and "OK"
  // pulled it back 73 px at once.
  const bands = { top: 0.08, bottom: 0.25 };
  const placed = { ...UPRIGHT, x: 0.7, y: 0.8 };
  const narrow = { width: 0.55, height: 0.1 };
  const widened = { width: 0.7, height: 0.12 };
  const rightEdge = (t: { x: number; scale: number }, extent: { width: number }) =>
    t.x * FRAME.width + (extent.width * t.scale * FRAME.width) / 2;

  it('the narrow text fits where it is, so nothing moves', () => {
    expect(placedAfterResize(placed, narrow, FRAME, bands, true)).toEqual(placed);
  });

  it('pulls the widened box back inside the frame DURING the edit', () => {
    const during = placedAfterResize(placed, widened, FRAME, bands, true);
    expect(rightEdge(placed, widened)).toBeGreaterThan(FRAME.width);
    expect(rightEdge(during, widened)).toBeCloseTo(FRAME.width * (1 - OVERLAY_EDGE_INSET), 6);
  });

  it('does not settle against the controls while the field is open', () => {
    // Its centre is in the tray band (0.8 > 0.75): only the commit moves it out of there.
    expect(placedAfterResize(placed, widened, FRAME, bands, true).y).toBe(0.8);
  });

  it('leaves the commit no width to correct: "OK" does not move it sideways', () => {
    const during = placedAfterResize(placed, widened, FRAME, bands, true);
    const committed = placedAfterResize(during, widened, FRAME, bands, false);
    expect(committed.x).toBe(during.x);
    expect(committed).toEqual(settledClearOfControls(during, widened, FRAME, bands));
  });
});
