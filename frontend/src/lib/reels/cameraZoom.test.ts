/**
 * The zoom's arithmetic (user, 2026-10-22): which mode a lens gets, how far a slide of the held
 * finger zooms, the clamp to the range, the 1x rest, and the digital zoom's crop - which must be the
 * part of the frame the preview's centred CSS scale shows.
 */
import { describe, expect, it } from 'vitest';
import {
  DIGITAL_ZOOM_MAX,
  DIGITAL_ZOOM_RANGE,
  ZOOM_DRAG_FULL_RANGE_PX,
  clampZoom,
  digitalZoomCrop,
  restingZoom,
  zoomFromDrag,
  zoomRangeFor,
  type ZoomRange,
} from './cameraZoom';

function track(caps: Record<string, unknown>): MediaStreamTrack {
  return { getCapabilities: () => caps } as unknown as MediaStreamTrack;
}

describe('zoomRangeFor', () => {
  it('uses the HARDWARE zoom where the track lists one', () => {
    expect(zoomRangeFor(track({ zoom: { min: 1, max: 8, step: 0.1 } }))).toEqual({
      mode: 'hardware',
      min: 1,
      max: 8,
    });
  });

  it('zooms DIGITALLY, 1x to 5x, where the track lists none (WKWebView)', () => {
    expect(zoomRangeFor(track({}))).toEqual(DIGITAL_ZOOM_RANGE);
    expect(DIGITAL_ZOOM_RANGE).toEqual({ mode: 'digital', min: 1, max: DIGITAL_ZOOM_MAX });
    expect(DIGITAL_ZOOM_MAX).toBe(5);
  });

  it('a capability with no room to zoom, or no track at all, is digital', () => {
    expect(zoomRangeFor(track({ zoom: { min: 1, max: 1 } })).mode).toBe('digital');
    expect(zoomRangeFor(track({ zoom: {} })).mode).toBe('digital');
    expect(zoomRangeFor(undefined).mode).toBe('digital');
    expect(zoomRangeFor({} as MediaStreamTrack).mode).toBe('digital');
  });
});

describe('the clamp and the rest', () => {
  const hw: ZoomRange = { mode: 'hardware', min: 0.5, max: 10 };

  it('keeps a level inside the range', () => {
    expect(clampZoom(12, hw)).toBe(10);
    expect(clampZoom(0.2, hw)).toBe(0.5);
    expect(clampZoom(3, hw)).toBe(3);
    expect(clampZoom(7, DIGITAL_ZOOM_RANGE)).toBe(5);
    expect(clampZoom(0.5, DIGITAL_ZOOM_RANGE)).toBe(1);
  });

  it('a non-number is the rest, never NaN reaching a track', () => {
    expect(clampZoom(Number.NaN, hw)).toBe(1);
  });

  it('rests at 1x, inside the range', () => {
    expect(restingZoom(hw)).toBe(1);
    expect(restingZoom(DIGITAL_ZOOM_RANGE)).toBe(1);
    expect(restingZoom({ mode: 'hardware', min: 2, max: 4 })).toBe(2);
  });
});

describe('zoomFromDrag', () => {
  it('no travel is no change', () => {
    expect(zoomFromDrag(1, 0, DIGITAL_ZOOM_RANGE)).toBe(1);
    expect(zoomFromDrag(2.5, 0, DIGITAL_ZOOM_RANGE)).toBeCloseTo(2.5);
  });

  it('sliding UP zooms in, and the whole range is one full travel', () => {
    expect(zoomFromDrag(1, ZOOM_DRAG_FULL_RANGE_PX / 2, DIGITAL_ZOOM_RANGE)).toBeCloseTo(
      Math.sqrt(5)
    );
    expect(zoomFromDrag(1, ZOOM_DRAG_FULL_RANGE_PX, DIGITAL_ZOOM_RANGE)).toBeCloseTo(5);
  });

  it('sliding DOWN zooms out, from where the slide began', () => {
    expect(zoomFromDrag(5, -ZOOM_DRAG_FULL_RANGE_PX, DIGITAL_ZOOM_RANGE)).toBeCloseTo(1);
    expect(zoomFromDrag(5, -ZOOM_DRAG_FULL_RANGE_PX / 2, DIGITAL_ZOOM_RANGE)).toBeCloseTo(
      Math.sqrt(5)
    );
  });

  it('is clamped at both ends, however far the finger goes', () => {
    expect(zoomFromDrag(1, 10_000, DIGITAL_ZOOM_RANGE)).toBe(5);
    expect(zoomFromDrag(1, -10_000, DIGITAL_ZOOM_RANGE)).toBe(1);
    const hw: ZoomRange = { mode: 'hardware', min: 1, max: 8 };
    expect(zoomFromDrag(1, 10_000, hw)).toBe(8);
  });

  it('is SMOOTH: each pixel moves it, in the same direction, with no step', () => {
    let previous = zoomFromDrag(1, 0, DIGITAL_ZOOM_RANGE);
    for (let px = 1; px <= ZOOM_DRAG_FULL_RANGE_PX; px++) {
      const next = zoomFromDrag(1, px, DIGITAL_ZOOM_RANGE);
      expect(next).toBeGreaterThan(previous);
      // No jump bigger than one pixel's worth of the logarithmic scale (5^(1/300) - 1, ~0.54 %).
      expect(next / previous).toBeLessThan(1.006);
      previous = next;
    }
  });

  it('a range with no room stays put', () => {
    expect(zoomFromDrag(1, 100, { mode: 'hardware', min: 2, max: 2 })).toBe(2);
  });
});

describe('digitalZoomCrop', () => {
  const crop = { sx: 100, sy: 0, sw: 720, sh: 1280 };

  it('is the crop itself at 1x', () => {
    expect(digitalZoomCrop(crop, 1)).toBe(crop);
  });

  it("is the centred 1/level part - exactly what the preview's centred scale shows", () => {
    const zoomed = digitalZoomCrop(crop, 2);
    expect(zoomed).toEqual({ sx: 100 + 180, sy: 320, sw: 360, sh: 640 });
    // Same centre, same aspect.
    expect(zoomed.sx + zoomed.sw / 2).toBe(crop.sx + crop.sw / 2);
    expect(zoomed.sy + zoomed.sh / 2).toBe(crop.sy + crop.sh / 2);
    expect(zoomed.sw / zoomed.sh).toBeCloseTo(crop.sw / crop.sh);
  });
});
