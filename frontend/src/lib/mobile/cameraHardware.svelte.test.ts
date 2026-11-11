// @vitest-environment happy-dom
/**
 * The camera in front (owner, 2026-11-11; screen-orientation.md, "The camera keeps its layout"): the
 * phone's quarter turn, the glyphs' rotation, and the flag native holds for the volume keys - armed by
 * a live camera, dropped by its release, by the app leaving the screen, and at a page load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import {
  CAMERA_KEY_EVENT,
  DEVICE_ANGLE_EVENT,
  captureTurn,
  deviceTurn,
  holdCameraHardware,
  initCameraHardware,
  nextGlyphRotation,
  quadrantFor,
  resetCameraHardwareForTest,
} from './cameraHardware.svelte';

const runtime = vi.hoisted(() => ({ android: true }));
vi.mock('$lib/utils/appVersion', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/appVersion')>()),
  isAndroidTauriRuntime: () => runtime.android,
  isIosTauriRuntime: () => false,
}));

type Win = Window & { canariCamera?: { set: (s: string) => void } };

let sent: string[];

beforeEach(() => {
  resetCameraHardwareForTest();
  runtime.android = true;
  sent = [];
  (window as Win).canariCamera = { set: (s) => sent.push(s) };
  for (const level of ['debug', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  resetCameraHardwareForTest();
  delete (window as Win).canariCamera;
  delete (window as unknown as Record<string, unknown>).__canariForeground;
  vi.restoreAllMocks();
});

function key(phase: string) {
  window.dispatchEvent(new CustomEvent(CAMERA_KEY_EVENT, { detail: { phase } }));
}
function angle(degrees: number) {
  window.dispatchEvent(new CustomEvent(DEVICE_ANGLE_EVENT, { detail: { degrees } }));
}
function foreground(on: boolean) {
  (window as unknown as Record<string, unknown>).__canariForeground = on;
  window.dispatchEvent(new CustomEvent('canari:foreground', { detail: { foreground: on } }));
}

describe('quadrantFor - the phone held, with hysteresis', () => {
  it('takes the nearest quarter turn from nothing', () => {
    expect(quadrantFor(0, null)).toBe(0);
    expect(quadrantFor(80, null)).toBe(90);
    expect(quadrantFor(181, null)).toBe(180);
    expect(quadrantFor(260, null)).toBe(270);
    expect(quadrantFor(350, null)).toBe(0);
    expect(quadrantFor(-90, null)).toBe(270);
  });

  it('keeps the quadrant held until the phone is 15 degrees past the diagonal', () => {
    expect(quadrantFor(50, 0)).toBe(0);
    expect(quadrantFor(60, 0)).toBe(0);
    expect(quadrantFor(61, 0)).toBe(90);
    expect(quadrantFor(30, 90)).toBe(90);
    expect(quadrantFor(29, 90)).toBe(0);
    expect(quadrantFor(310, 0)).toBe(0);
    expect(quadrantFor(299, 0)).toBe(270);
  });
});

describe('captureTurn - how far the file is turned to come out upright', () => {
  it('is the phone turn on a screen locked upright', () => {
    expect(captureTurn(0, 0)).toBe(0);
    expect(captureTurn(90, 0)).toBe(90);
    expect(captureTurn(270, 0)).toBe(270);
  });

  it('is nothing where no sensor speaks (the web)', () => {
    expect(captureTurn(null, 90)).toBe(0);
  });

  it("is cancelled by a screen that turned with the phone (a tablet's free layout)", () => {
    // Device turned counter-clockwise (right side up, 270) and the layout followed (angle 90).
    expect(captureTurn(270, 90)).toBe(0);
    expect(captureTurn(90, 270)).toBe(0);
  });
});

describe('nextGlyphRotation - each glyph turns a quarter in place, the short way', () => {
  it('undoes the turn', () => {
    expect(nextGlyphRotation(0, 90)).toBe(-90);
    expect(nextGlyphRotation(0, 270)).toBe(90);
    expect(nextGlyphRotation(-90, 0)).toBe(0);
  });

  it('never spins three quarters to go one', () => {
    // 270 -> 0 then 0 -> 270 again: each step is one quarter.
    expect(nextGlyphRotation(90, 0)).toBe(0);
    expect(nextGlyphRotation(-90, 270)).toBe(-270);
    expect(Math.abs(nextGlyphRotation(-90, 270) - -90)).toBe(180);
    expect(nextGlyphRotation(360, 270)).toBe(450);
  });
});

describe('the flag native holds', () => {
  it('is armed by a live camera and dropped by its release, once each', () => {
    const release = holdCameraHardware('camera', () => {});
    expect(sent).toEqual(['on']);
    release();
    release();
    expect(sent).toEqual(['on', 'off']);
  });

  it('hands the volume keys to the newest holder, and to nobody once released', () => {
    const keys: string[] = [];
    const release = holdCameraHardware('camera', (p) => keys.push(p));
    key('down');
    key('up');
    key('cancel');
    key('sideways');
    release();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    key('down');
    expect(keys).toEqual(['down', 'up', 'cancel']);
  });

  it('a second camera keeps the flag up when the first releases', () => {
    const a = holdCameraHardware('a', () => {});
    const b = holdCameraHardware('b', () => {});
    a();
    expect(sent).toEqual(['on']);
    b();
    expect(sent).toEqual(['on', 'off']);
  });

  it('is dropped when the app leaves the screen and re-armed on its return', () => {
    const release = holdCameraHardware('camera', () => {});
    foreground(false);
    expect(sent).toEqual(['on', 'off']);
    foreground(true);
    expect(sent).toEqual(['on', 'off', 'on']);
    release();
    foreground(false);
    foreground(true);
    // Released: the return re-arms nothing.
    expect(sent).toEqual(['on', 'off', 'on', 'off']);
  });

  it('a page load posts what this page holds', () => {
    initCameraHardware();
    expect(sent).toEqual(['off']);
    const release = holdCameraHardware('camera', () => {});
    initCameraHardware();
    expect(sent).toEqual(['off', 'on', 'on']);
    release();
  });

  it('the phone turn follows the sensor while armed, and starts upright at the next arming', () => {
    const release = holdCameraHardware('camera', () => {});
    angle(85);
    flushSync();
    expect(deviceTurn.quadrant).toBe(90);
    angle(40);
    expect(deviceTurn.quadrant).toBe(90);
    release();
    expect(deviceTurn.quadrant).toBeNull();
  });

  it('posts nothing on the web', () => {
    runtime.android = false;
    const release = holdCameraHardware('camera', () => {});
    release();
    expect(sent).toEqual([]);
  });
});
