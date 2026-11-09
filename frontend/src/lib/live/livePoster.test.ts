/**
 * THE PREVIEW SENDER: the segment cadence, one turn at a time, nothing retried, and every way a turn
 * ends logged and typed - plus the canvas grab's size and its "no frame yet". No timer anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveRefusalError } from './api';
import {
  LIVE_POSTER_JPEG_QUALITY,
  LIVE_POSTER_WIDTH_PX,
  LivePosterSender,
  posterEverySegments,
  grabPosterFrame,
} from './livePoster';
import { TransportFailureError } from '$lib/utils/transportFailure';

beforeEach(() => {
  for (const level of ['debug', 'log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function sender(overrides: Partial<ConstructorParameters<typeof LivePosterSender>[0]> = {}) {
  const deps = {
    capture: vi.fn(async (): Promise<Uint8Array | null> => new Uint8Array([1, 2, 3])),
    seal: vi.fn(async (plain: Uint8Array) => new Uint8Array(plain) as Uint8Array<ArrayBuffer>),
    put: vi.fn(async (_sealed: Uint8Array<ArrayBuffer>): Promise<unknown> => ({})),
    everySegments: 5,
    maxBytes: 100,
    ...overrides,
  };
  return { deps, s: new LivePosterSender(deps) };
}

describe('LivePosterSender', () => {
  it('sends on index 0 and every 5th, and on no other segment', async () => {
    const { deps, s } = sender();
    const turns = [];
    for (let i = 0; i <= 10; i++) turns.push(await s.onSegment(i));
    expect(turns.filter((t) => t === 'sent')).toHaveLength(3);
    expect(turns[1]).toBe('not-due');
    expect(deps.put).toHaveBeenCalledTimes(3);
  });

  it('never runs two turns at once: a due index during a turn is skipped, not queued', async () => {
    let release!: () => void;
    const { deps, s } = sender({
      put: vi
        .fn(async (_sealed: Uint8Array<ArrayBuffer>): Promise<unknown> => ({}))
        .mockImplementationOnce(() => new Promise<unknown>((r) => (release = () => r({})))),
    });
    const first = s.onSegment(0);
    await vi.waitFor(() => expect(deps.put).toHaveBeenCalledTimes(1));
    await expect(s.onSegment(5)).resolves.toBe('busy');
    release();
    await expect(first).resolves.toBe('sent');
    await expect(s.onSegment(10)).resolves.toBe('sent');
  });

  it('skips a turn with no frame, and a preview over the server bound', async () => {
    await expect(sender({ capture: vi.fn(async () => null) }).s.onSegment(0)).resolves.toBe(
      'no-frame'
    );
    const big = sender({ capture: vi.fn(async () => new Uint8Array(200)) });
    await expect(big.s.onSegment(0)).resolves.toBe('too-large');
    expect(big.deps.put).not.toHaveBeenCalled();
  });

  it('types every failure and retries none; an ended live stops it for good', async () => {
    const refusal = (status: number, code: string, kind: 'ended' | 'rate-limited') =>
      new LiveRefusalError(status, code, code, kind, null, null, null);
    const offline = sender({
      put: vi.fn(async () => {
        throw new TransportFailureError(new TypeError('x'));
      }),
    });
    await expect(offline.s.onSegment(0)).resolves.toBe('offline');
    const fast = sender({
      put: vi.fn(async () => {
        throw refusal(429, 'LIVE_POSTER_TOO_FAST', 'rate-limited');
      }),
    });
    await expect(fast.s.onSegment(0)).resolves.toBe('refused');
    expect(fast.deps.put).toHaveBeenCalledTimes(1);
    const over = sender({
      put: vi.fn(async () => {
        throw refusal(410, 'LIVE_ENDED', 'ended');
      }),
    });
    await expect(over.s.onSegment(0)).resolves.toBe('ended');
    await expect(over.s.onSegment(5)).resolves.toBe('stopped');
  });

  it('sends nothing once stopped, even a capture already running', async () => {
    let give!: (b: Uint8Array) => void;
    const { deps, s } = sender({
      capture: vi.fn(() => new Promise<Uint8Array | null>((r) => (give = r))),
    });
    const turn = s.onSegment(0);
    s.stop();
    give(new Uint8Array([1]));
    await expect(turn).resolves.toBe('stopped');
    expect(deps.put).not.toHaveBeenCalled();
  });
});

describe('posterEverySegments', () => {
  it("turns the server's ONE preview period into this client's 2 s segments, at least one", () => {
    expect(posterEverySegments(16_000)).toBe(8);
    expect(posterEverySegments(10_000)).toBe(5);
    expect(posterEverySegments(500)).toBe(1);
  });
});

describe('grabPosterFrame', () => {
  function fakeCanvas(blob: Blob | null) {
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob: vi.fn((cb: (b: Blob | null) => void, type: string, quality: number) => {
        expect(type).toBe('image/jpeg');
        expect(quality).toBe(LIVE_POSTER_JPEG_QUALITY);
        cb(blob);
      }),
    };
    return { canvas, drawImage };
  }
  const video = (w: number, h: number, readyState = 4) =>
    ({ videoWidth: w, videoHeight: h, readyState }) as unknown as HTMLVideoElement;

  it('draws the frame 480 px wide with its aspect, as a JPEG', async () => {
    const { canvas, drawImage } = fakeCanvas(new Blob([new Uint8Array([0xff, 0xd8])]));
    const bytes = await grabPosterFrame(
      video(720, 1280),
      () => canvas as unknown as HTMLCanvasElement
    );
    expect(bytes).toEqual(new Uint8Array([0xff, 0xd8]));
    expect(canvas.width).toBe(LIVE_POSTER_WIDTH_PX);
    expect(canvas.height).toBe(853);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 480, 853);
  });

  it('never upscales a smaller frame, and answers null with no frame or no image', async () => {
    const small = fakeCanvas(new Blob([new Uint8Array([1])]));
    await grabPosterFrame(video(320, 240), () => small.canvas as unknown as HTMLCanvasElement);
    expect(small.canvas.width).toBe(320);
    const none = fakeCanvas(null);
    await expect(
      grabPosterFrame(video(320, 240, 1), () => none.canvas as unknown as HTMLCanvasElement)
    ).resolves.toBeNull();
    await expect(
      grabPosterFrame(video(320, 240), () => none.canvas as unknown as HTMLCanvasElement)
    ).resolves.toBeNull();
  });
});
