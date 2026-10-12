/**
 * A `MediaRecorder` stand-in for the reel tests: it records nothing, hands over one chunk per
 * `requestChunk()` and on `stop()`, and lets a test decide which containers it "supports".
 */
import { vi } from 'vitest';

export class FakeMediaRecorder {
  static supported = new Set<string>([
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp9,opus',
    'video/mp4;codecs=avc1,mp4a',
  ]);
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supported.has(type);
  }

  state: 'inactive' | 'recording' = 'inactive';
  readonly mimeType: string;
  readonly options: MediaRecorderOptions;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  /** Bytes the next `stop()` hands over as its last chunk; empty means an empty take. */
  lastChunk = 'take';

  constructor(_stream: MediaStream, options: MediaRecorderOptions) {
    this.options = options;
    this.mimeType = options.mimeType ?? '';
    FakeMediaRecorder.instances.push(this);
  }

  start = vi.fn(() => {
    this.state = 'recording';
  });

  stop = vi.fn(() => {
    this.state = 'inactive';
    if (this.lastChunk) this.ondataavailable?.({ data: new Blob([this.lastChunk]) });
    // The real one fires `stop` asynchronously, after the last `dataavailable`.
    queueMicrotask(() => this.onstop?.());
  });
}

/** Installs the fake as the global `MediaRecorder` and forgets earlier instances. */
export function installFakeMediaRecorder(): typeof FakeMediaRecorder {
  FakeMediaRecorder.instances = [];
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  return FakeMediaRecorder;
}
