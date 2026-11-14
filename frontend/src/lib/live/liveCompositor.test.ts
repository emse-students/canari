/**
 * THE COMPOSITOR (owner, 2026-11-14), on a fake canvas and a hand-driven clock: one frame per tick and
 * nothing else, the scene's draws, the camera's card, the sources followed - and THE INVARIANT the
 * owner's reading of `1.6.12-alpha.2` asked for: whatever size a source takes mid-live, the canvas
 * (so the recorder's track) keeps the size it was given at birth.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveCompositor, type CompositorDeps } from './liveCompositor';
import { DEFAULT_OVERLAY, STUDIO_FRAME, overlayBox } from './liveScenes';

/** A canvas that records every size written to it, and a context that records every draw. */
function fakeCanvas() {
  const sizeWrites: string[] = [];
  const draws: unknown[][] = [];
  const texts: string[] = [];
  const track = { readyState: 'live', stop: vi.fn(), requestFrame: vi.fn() };
  let width = 300;
  let height = 150;
  const ctx = {
    fillStyle: '',
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    fillRect: vi.fn(),
    drawImage: vi.fn((...args: unknown[]) => draws.push(args)),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    clip: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn((t: string) => texts.push(t)),
  };
  const canvas = {
    get width() {
      return width;
    },
    set width(v: number) {
      sizeWrites.push(`w=${v}`);
      width = v;
    },
    get height() {
      return height;
    },
    set height(v: number) {
      sizeWrites.push(`h=${v}`);
      height = v;
    },
    getContext: vi.fn(() => ctx),
    captureStream: vi.fn(() => ({ getVideoTracks: () => [track] })),
  };
  return { canvas, ctx, track, sizeWrites, draws, texts };
}

/** A detached video whose intrinsic size a test changes, as a resized shared window does. */
function fakeVideo() {
  return {
    muted: false,
    playsInline: false,
    autoplay: false,
    srcObject: null as MediaStream | null,
    videoWidth: 0,
    videoHeight: 0,
    play: vi.fn(() => Promise.resolve()),
  };
}

function setup() {
  const c = fakeCanvas();
  const videos: ReturnType<typeof fakeVideo>[] = [];
  let tick: (() => void) | null = null;
  const clock = { start: vi.fn((onTick: () => void) => (tick = onTick)), stop: vi.fn() };
  const sources = { camera: null as MediaStream | null, screen: null as MediaStream | null };
  const deps: CompositorDeps = {
    createCanvas: () => c.canvas as unknown as HTMLCanvasElement,
    createVideo: () => {
      const v = fakeVideo();
      videos.push(v);
      return v as unknown as HTMLVideoElement;
    },
    clock,
    camera: () => sources.camera,
    screen: () => sources.screen,
    now: () => 0,
  };
  const compositor = new LiveCompositor(DEFAULT_OVERLAY, deps);
  const [cameraEl, screenEl] = videos;
  return {
    ...c,
    compositor,
    clock,
    sources,
    cameraEl,
    screenEl,
    tick: () => tick!(),
  };
}

const stream = () => ({}) as MediaStream;

beforeEach(() => {
  for (const level of ['debug', 'info', 'warn'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

describe('LiveCompositor', () => {
  it('sizes its canvas ONCE, at the frame - and never again, whatever the sources do', () => {
    const f = setup();
    expect(f.sizeWrites).toEqual([`w=${STUDIO_FRAME.width}`, `h=${STUDIO_FRAME.height}`]);
    f.compositor.start();
    f.compositor.setScene('screen');
    f.sources.screen = stream();
    // The shared window is resized mid-live, three times, then the camera joins.
    for (const [w, h] of [
      [1920, 1080],
      [801, 977],
      [3440, 1440],
    ]) {
      f.screenEl.videoWidth = w;
      f.screenEl.videoHeight = h;
      f.tick();
      expect(f.compositor.size).toEqual({ width: 1280, height: 720 });
    }
    f.compositor.setScene('side-by-side');
    f.sources.camera = stream();
    f.cameraEl.videoWidth = 640;
    f.cameraEl.videoHeight = 480;
    f.tick();
    expect(f.sizeWrites).toHaveLength(2);
    expect(f.compositor.size).toEqual({ width: 1280, height: 720 });
  });

  it('draws a resized screen letterboxed INSIDE the frame', () => {
    const f = setup();
    f.compositor.setScene('screen');
    f.sources.screen = stream();
    f.screenEl.videoWidth = 1000;
    f.screenEl.videoHeight = 500;
    f.compositor.drawFrame();
    expect(f.draws.at(-1)).toEqual([f.screenEl, 0, 40, 1280, 640]);
    f.screenEl.videoWidth = 720;
    f.screenEl.videoHeight = 1280;
    f.compositor.drawFrame();
    expect(f.draws.at(-1)).toEqual([f.screenEl, (1280 - 405) / 2, 0, 405, 720]);
  });

  it('pushes exactly one frame per tick, and draws only on the clock', () => {
    const f = setup();
    f.compositor.start();
    f.compositor.start();
    expect(f.clock.start).toHaveBeenCalledTimes(1);
    expect(f.track.requestFrame).not.toHaveBeenCalled();
    f.tick();
    f.tick();
    f.tick();
    expect(f.track.requestFrame).toHaveBeenCalledTimes(3);
  });

  it('follows a new stream by itself, and plays it', () => {
    const f = setup();
    const first = stream();
    f.sources.camera = first;
    f.compositor.drawFrame();
    expect(f.cameraEl.srcObject).toBe(first);
    const reopened = stream();
    f.sources.camera = reopened;
    f.compositor.drawFrame();
    expect(f.cameraEl.srcObject).toBe(reopened);
    expect(f.cameraEl.play).toHaveBeenCalledTimes(2);
    f.compositor.drawFrame();
    expect(f.cameraEl.play).toHaveBeenCalledTimes(2);
  });

  it('crops the camera into the overlay (cover), clipped round', () => {
    const f = setup();
    f.compositor.setScene('screen-camera');
    f.sources.camera = stream();
    f.cameraEl.videoWidth = 1280;
    f.cameraEl.videoHeight = 720;
    f.compositor.drawFrame();
    const box = overlayBox(DEFAULT_OVERLAY);
    expect(f.draws.at(-1)).toEqual([
      f.cameraEl,
      280,
      0,
      720,
      720,
      box.x,
      box.y,
      box.width,
      box.height,
    ]);
    expect(f.ctx.clip).toHaveBeenCalled();
  });

  it('a camera switched off draws its card and lets go of the stream; pause draws its card', () => {
    const f = setup();
    f.compositor.setLabels({ pause: 'Je reviens', cameraOff: 'Caméra coupée' });
    f.sources.camera = stream();
    f.cameraEl.videoWidth = 1280;
    f.cameraEl.videoHeight = 720;
    f.compositor.setCameraOn(false);
    f.compositor.drawFrame();
    expect(f.cameraEl.srcObject).toBeNull();
    expect(f.draws).toHaveLength(0);
    expect(f.texts).toEqual(['Caméra coupée']);
    f.compositor.setScene('pause');
    f.compositor.drawFrame();
    expect(f.texts.at(-1)).toBe('Je reviens');
  });

  it('a source with no frame yet draws nothing in its box (black), never a stale size', () => {
    const f = setup();
    f.compositor.setScene('screen');
    f.sources.screen = stream();
    f.compositor.drawFrame();
    expect(f.draws).toHaveLength(0);
  });

  it('stop stops the clock and its own track, and lets go of the sources', () => {
    const f = setup();
    f.compositor.start();
    f.sources.screen = stream();
    f.tick();
    f.compositor.stop();
    expect(f.clock.stop).toHaveBeenCalled();
    expect(f.track.stop).toHaveBeenCalled();
    expect(f.screenEl.srcObject).toBeNull();
  });
});
