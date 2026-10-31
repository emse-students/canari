/**
 * Fakes for the broadcast tests: a camera stream whose lens can end or mute, a recorder starter that
 * records which stream it was given and hands chunks on demand, an uploader with the real queue
 * contract, and the dependency bundle around them. No real clock: `now` is a counter a test moves.
 */
import { vi } from 'vitest';
import { CameraSession } from '$lib/reels/cameraSession.svelte';
import type { LiveSegmentUploaderOptions } from './api';
import type { LiveBroadcastDeps } from './liveBroadcast.svelte';
import type { LiveLimits, LiveRulesStatus, LiveView } from './types';

export class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live';
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
  getCapabilities = () => ({});
  getSettings = () => ({ width: 720, height: 1280, frameRate: 30 });
  /** The OS took the lens: `ended` fires (a `stop()` by the page never fires it). */
  end(): void {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

export interface FakeStream {
  stream: MediaStream;
  video: FakeTrack;
  audio: FakeTrack;
}

export function fakeStream(): FakeStream {
  const video = new FakeTrack();
  const audio = new FakeTrack();
  const stream = {
    getTracks: () => [video, audio],
    getVideoTracks: () => [video],
    getAudioTracks: () => [audio],
  };
  // A `<video>`'s `srcObject` setter checks the type (happy-dom as a browser does).
  if (typeof MediaStream !== 'undefined') Object.setPrototypeOf(stream, MediaStream.prototype);
  return { stream: stream as unknown as MediaStream, video, audio };
}

/** A camera session whose every open answers a fresh fake stream (or what `next` says). */
export function fakeCamera() {
  const opened: FakeStream[] = [];
  const control = {
    opened,
    /** The next open's answer instead of a stream, once. */
    nextFailure: null as unknown,
  };
  const session = new CameraSession(async () => {
    if (control.nextFailure) {
      const e = control.nextFailure;
      control.nextFailure = null;
      throw e;
    }
    const s = fakeStream();
    opened.push(s);
    return s.stream;
  });
  return { session, control };
}

export interface FakeRecorder {
  stream: MediaStream;
  onChunk: (chunk: Blob) => void;
  onError: (e: unknown) => void;
  stop: ReturnType<typeof vi.fn>;
}

export class FakeUploader {
  nextIndex: number;
  readonly sent: { index: number; sealed: Uint8Array }[] = [];
  stopped = false;
  backlog = 0;
  idle = vi.fn(() => Promise.resolve());
  stop = vi.fn(() => {
    this.stopped = true;
  });
  constructor(readonly options: LiveSegmentUploaderOptions) {
    this.nextIndex = options.startIndex ?? 0;
  }
  enqueue(index: number, sealed: Uint8Array<ArrayBuffer>): void {
    if (this.stopped) throw new Error('stopped');
    if (index !== this.nextIndex) throw new RangeError('wrong index');
    this.nextIndex++;
    this.sent.push({ index, sealed });
  }
}

export const LIMITS: LiveLimits = {
  segmentMaxBytes: 4 * 1024 * 1024,
  reconnectWindowMs: 60_000,
  maxDurationMs: 3_600_000,
  manifestWindow: 10,
  byteBudget: 1_687_500_000,
  segmentMinDurationMs: 1000,
  segmentBurst: 15,
  startsPerHour: 6,
  viewerCap: 24,
  seatLeaseMs: 30_000,
  chatMessageMaxChars: 300,
  chatSealedMaxBytes: 928,
  chatMessagesPerWindow: 3,
  chatRateWindowMs: 5_000,
  chatBacklog: 50,
  reactionKinds: ['like', 'laugh', 'clap', 'fire', 'canari'],
  reactionWindowMs: 2_000,
  reactionBurstsPerWindow: 2,
  reactionTapsPerWindow: 10,
};

export const LIVE_ID = '0b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';
export const KEY = 'cd'.repeat(32);

export function liveView(): LiveView {
  return {
    id: LIVE_ID,
    broadcasterId: 'u1',
    associationId: null,
    startedAt: '2026-10-19T10:00:00.000Z',
    lastSegmentAt: null,
    nextIndex: 0,
    key: KEY,
  };
}

/** The whole dependency bundle, every function a spy. */
export function fakeDeps() {
  const recorders: FakeRecorder[] = [];
  const uploaders: FakeUploader[] = [];
  const clock = { t: 1_000 };
  /** Every bounded wait started, fired only by the test: no real time passes. */
  const timers: { ms: number; fire: () => void }[] = [];
  let hidden = false;
  const deps = {
    fetchLiveLimits: vi.fn(async () => LIMITS),
    // Accepted already by default: a test of the rules step overrides it.
    fetchLiveRules: vi.fn(async (): Promise<LiveRulesStatus> => ({
      version: 1,
      acceptedVersion: 1,
      acceptedAt: '2026-10-19T09:00:00.000Z',
    })),
    startLive: vi.fn(async () => liveView()),
    fetchLive: vi.fn(async () => liveView()),
    endLive: vi.fn(async () => ({
      id: LIVE_ID,
      endedAt: '2026-10-19T10:30:00.000Z',
      endReason: 'broadcaster' as const,
    })),
    createUploader: vi.fn((_id: string, options: LiveSegmentUploaderOptions) => {
      const u = new FakeUploader(options);
      uploaders.push(u);
      return u;
    }),
    seal: vi.fn(async (_k: string, _l: string, index: number, plain: Uint8Array) => {
      const out = new Uint8Array(4 + plain.byteLength);
      new DataView(out.buffer).setUint32(0, index);
      out.set(plain, 4);
      return out;
    }),
    generateKeyHex: vi.fn(async () => KEY),
    recordingSupported: vi.fn(() => true),
    startRecorder: vi.fn(
      (stream: MediaStream, onChunk: (c: Blob) => void, onError: (e: unknown) => void) => {
        const r: FakeRecorder = { stream, onChunk, onError, stop: vi.fn(() => Promise.resolve()) };
        recorders.push(r);
        return { stop: r.stop as unknown as () => Promise<void> };
      }
    ),
    wakeLock: { hold: vi.fn(() => Promise.resolve()), release: vi.fn() },
    now: () => clock.t,
    sleep: vi.fn((ms: number) => new Promise<void>((fire) => timers.push({ ms, fire }))),
    isHidden: () => hidden,
    screenShareAvailable: vi.fn(() => false),
    openScreen: vi.fn(async () => fakeStream().stream),
  } satisfies LiveBroadcastDeps;
  return {
    deps,
    recorders,
    uploaders,
    clock,
    timers,
    /** Fires every pending bound of `ms`. */
    fireTimers: (ms: number) => {
      for (const t of timers.filter((x) => x.ms === ms)) t.fire();
    },
    setHidden: (h: boolean) => {
      hidden = h;
    },
  };
}
