/**
 * THE FOUR WAYS A HELD MICROPHONE CAN END, AND THE ONE WAY IT MUST NOT.
 *
 * A voice note is a single gesture - hold, slide, release - so the whole component is a decision
 * taken at `pointerup` from two numbers: how far the thumb travelled, and how long it was down.
 * Reading that code tells you nothing about whether it is wired to a pointer, which is why every
 * test here dispatches real pointer events at the real button and asserts on the blob that comes
 * out (or does not).
 *
 * The one that must not happen is at the bottom: a recording thrown away must never reach
 * `onRecordingComplete`. Everything else is recoverable by tapping again; that one sends audio a
 * person deliberately cancelled.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import VoiceRecorder from './VoiceRecorder.svelte';

const CANCEL_SLIDE_PX = 96;
const LOCK_SLIDE_PX = 72;
const MIN_RECORDING_MS = 700;

const mounted: (() => void)[] = [];

/**
 * Enough of a `MediaRecorder` to be driven: `stop()` emits one chunk, then `onstop`.
 *
 * `deferStop` is the interesting half. A real `stop()` returns immediately and delivers the last
 * chunk and `onstop` on a later task, which is the whole reason the component separates "the row
 * comes back" from "the device is handed back". With the flag off this fake is synchronous and
 * would let a component that conflated the two pass every other test in this file.
 */
class FakeMediaRecorder {
  static isTypeSupported = () => true;
  static instances: FakeMediaRecorder[] = [];
  static deferStop = false;
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  /** Set instead of flushing when `deferStop` is on; call it to play the device's own callback. */
  flushPending: (() => void) | null = null;
  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? 'audio/webm';
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    const flush = () => {
      this.ondataavailable?.({ data: new Blob(['audio'], { type: this.mimeType }) });
      this.onstop?.();
    };
    if (FakeMediaRecorder.deferStop) this.flushPending = flush;
    else flush();
  }
}

const trackStop = vi.fn();

interface Harness {
  complete: Mock<(blob: Blob) => void>;
  cancel: Mock<() => void>;
  activeChanges: boolean[];
}

let harness: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  trackStop.mockClear();
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.deferStop = false;
  (globalThis as Record<string, unknown>).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: trackStop }] }) },
  });
  // happy-dom has no pointer capture; the component asks before releasing, so a truthful stub is
  // enough and a throwing one would hide a real mis-sequence behind an exception.
  const captured = new Set<number>();
  HTMLElement.prototype.setPointerCapture = function (id: number) {
    captured.add(id);
  };
  HTMLElement.prototype.releasePointerCapture = function (id: number) {
    captured.delete(id);
  };
  HTMLElement.prototype.hasPointerCapture = function (id: number) {
    return captured.has(id);
  };
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function mountRecorder(): Harness {
  const h: Harness = {
    complete: vi.fn<(blob: Blob) => void>(),
    cancel: vi.fn<() => void>(),
    activeChanges: [],
  };
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(VoiceRecorder, {
    target,
    props: {
      onRecordingComplete: h.complete,
      onCancel: h.cancel,
      onActiveChange: (active: boolean) => h.activeChanges.push(active),
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return h;
}

function thumb(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.voice-recorder-thumb');
  if (!el) throw new Error('microphone button not found');
  return el;
}

/** happy-dom may not implement `PointerEvent`; a mouse event carrying `pointerId` is equivalent. */
function pointer(type: string, clientX: number): Event {
  const Ctor = (globalThis as Record<string, unknown>).PointerEvent as
    | typeof PointerEvent
    | undefined;
  if (Ctor) return new Ctor(type, { bubbles: true, clientX, pointerId: 1, isPrimary: true });
  const e = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  Object.defineProperty(e, 'pointerType', { value: 'touch' });
  return e;
}

/** Press, let `getUserMedia` resolve, and let the recorder actually start. */
async function press(x = 300): Promise<void> {
  thumb().dispatchEvent(pointer('pointerdown', x));
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
}

function moveTo(x: number): void {
  thumb().dispatchEvent(pointer('pointermove', x));
  flushSync();
}

function releaseAt(x: number): void {
  thumb().dispatchEvent(pointer('pointerup', x));
  flushSync();
}

describe('VoiceRecorder - hold, slide, release', () => {
  beforeEach(() => {
    harness = mountRecorder();
  });

  it('records nothing until the microphone is pressed', () => {
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(harness.activeChanges).toEqual([]);
  });

  it('opens the microphone on press and tells the composer to stand down', async () => {
    await press();

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(harness.activeChanges).toEqual([true]);
    expect(document.querySelector('.voice-recorder')?.getAttribute('data-phase')).toBe('holding');
  });

  it('SENDS on a plain release once the hold is long enough', async () => {
    await press(300);
    await vi.advanceTimersByTimeAsync(MIN_RECORDING_MS + 100);
    releaseAt(300);

    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.complete.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(harness.cancel).not.toHaveBeenCalled();
    expect(harness.activeChanges).toEqual([true, false]);
  });

  it('THROWS IT AWAY when the thumb slid past the bin - and sends nothing at all', async () => {
    await press(300);
    await vi.advanceTimersByTimeAsync(MIN_RECORDING_MS + 100);
    moveTo(300 - CANCEL_SLIDE_PX - 10);
    releaseAt(300 - CANCEL_SLIDE_PX - 10);

    // The whole point of the gesture: a cancelled recording is not a quiet one, it is no message.
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.cancel).toHaveBeenCalledTimes(1);
    expect(harness.activeChanges).toEqual([true, false]);
  });

  it('still sends when the thumb wandered left but stopped short of the bin', async () => {
    await press(300);
    await vi.advanceTimersByTimeAsync(MIN_RECORDING_MS + 100);
    moveTo(300 - (CANCEL_SLIDE_PX - 20));
    releaseAt(300 - (CANCEL_SLIDE_PX - 20));

    expect(harness.complete).toHaveBeenCalledTimes(1);
  });

  it('LOCKS the moment the thumb crosses to the right, with no release needed', async () => {
    await press(300);
    moveTo(300 + LOCK_SLIDE_PX + 5);

    expect(document.querySelector('.voice-recorder')?.getAttribute('data-phase')).toBe('locked');
    // The microphone is gone: what is under the finger now is a bar with its own two buttons.
    expect(document.querySelector('.voice-recorder-thumb')).toBeNull();
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it('keeps recording after the finger leaves a locked bar, and sends on the send button', async () => {
    await press(300);
    moveTo(300 + LOCK_SLIDE_PX + 5);
    // The `pointerup` that necessarily follows a lock must not be read as a decision.
    document.querySelector('.voice-recorder')!.dispatchEvent(pointer('pointerup', 400));
    flushSync();
    expect(harness.complete).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    document.querySelector<HTMLElement>('.chat-composer-send-button')!.click();
    flushSync();

    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.activeChanges).toEqual([true, false]);
  });

  it('throws away a locked recording from its own bin', async () => {
    await press(300);
    moveTo(300 + LOCK_SLIDE_PX + 5);
    await vi.advanceTimersByTimeAsync(3000);
    document.querySelector<HTMLElement>('.chat-composer-icon-button')!.click();
    flushSync();

    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.cancel).toHaveBeenCalledTimes(1);
  });

  it('discards a press too short to be a message rather than sending room tone', async () => {
    await press(300);
    await vi.advanceTimersByTimeAsync(MIN_RECORDING_MS - 200);
    releaseAt(300);

    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.cancel).toHaveBeenCalledTimes(1);
  });

  it('gives the microphone back on every ending, so no tab is left holding the device', async () => {
    await press(300);
    await vi.advanceTimersByTimeAsync(MIN_RECORDING_MS + 100);
    releaseAt(300);

    expect(trackStop).toHaveBeenCalled();
  });

  it('discards on a pointercancel - a system gesture is not a send', async () => {
    await press(300);
    await vi.advanceTimersByTimeAsync(MIN_RECORDING_MS + 100);
    thumb().dispatchEvent(pointer('pointercancel', 300));
    flushSync();

    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('VoiceRecorder - the microphone opens slower than a finger lifts', () => {
  beforeEach(() => {
    harness = mountRecorder();
  });

  it('records nothing, and closes the device again, when released while still arming', async () => {
    let openMicrophone!: (s: unknown) => void;
    navigator.mediaDevices.getUserMedia = vi
      .fn()
      .mockReturnValue(new Promise((resolve) => (openMicrophone = resolve)));

    thumb().dispatchEvent(pointer('pointerdown', 300));
    flushSync();
    expect(document.querySelector('.voice-recorder')?.getAttribute('data-phase')).toBe('arming');

    // Finger up BEFORE the permission prompt resolves - the ordinary first-use case.
    releaseAt(300);
    openMicrophone({ getTracks: () => [{ stop: trackStop }] });
    await vi.advanceTimersByTimeAsync(0);
    flushSync();

    expect(harness.complete).not.toHaveBeenCalled();
    // Opened and handed straight back: leaving it open is a recording light that never goes out.
    expect(trackStop).toHaveBeenCalled();
    expect(document.querySelector('.voice-recorder')?.getAttribute('data-phase')).toBe('idle');
  });
});

/**
 * THE DEVICE CLOSES LATER THAN THE FINGER LIFTS, and the two must not be tied together.
 *
 * `MediaRecorder.stop()` is asynchronous. Tying the row's return to `onstop` means the composer
 * stays hidden while a microphone closes - visible as a bar that hangs after a cancel - and it also
 * means a second press can arrive while the first recording is still flushing. The component keeps
 * one object per recording so those two never share a field.
 */
describe('VoiceRecorder - a recording that is still closing', () => {
  beforeEach(() => {
    harness = mountRecorder();
    FakeMediaRecorder.deferStop = true;
  });

  it('gives the composer its row back immediately, before the device has closed', async () => {
    await press(300);
    await vi.advanceTimersByTimeAsync(MIN_RECORDING_MS + 100);
    releaseAt(300);

    // The row is already back...
    expect(harness.activeChanges).toEqual([true, false]);
    expect(document.querySelector('.voice-recorder')?.getAttribute('data-phase')).toBe('idle');
    // ...while the recorder has not delivered anything yet.
    expect(harness.complete).not.toHaveBeenCalled();
    expect(trackStop).not.toHaveBeenCalled();

    FakeMediaRecorder.instances[0].flushPending!();
    flushSync();

    expect(harness.complete).toHaveBeenCalledTimes(1);
    // Only now, once the last chunk is in: releasing it earlier truncates the message being sent.
    expect(trackStop).toHaveBeenCalled();
  });

  it('keeps a new recording apart from the one still flushing behind it', async () => {
    await press(300);
    await vi.advanceTimersByTimeAsync(MIN_RECORDING_MS + 100);
    releaseAt(300);

    // Pressed again straight away, while the first recorder is still holding its last chunk.
    await press(300);
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    expect(document.querySelector('.voice-recorder')?.getAttribute('data-phase')).toBe('holding');

    // The FIRST one finally delivers. It must send its own audio and must not end the second.
    FakeMediaRecorder.instances[0].flushPending!();
    flushSync();

    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.voice-recorder')?.getAttribute('data-phase')).toBe('holding');

    await vi.advanceTimersByTimeAsync(MIN_RECORDING_MS + 100);
    releaseAt(300);
    FakeMediaRecorder.instances[1].flushPending!();
    flushSync();

    expect(harness.complete).toHaveBeenCalledTimes(2);
  });

  it('sends nothing at all when the one still flushing was thrown away', async () => {
    await press(300);
    await vi.advanceTimersByTimeAsync(MIN_RECORDING_MS + 100);
    moveTo(300 - CANCEL_SLIDE_PX - 10);
    releaseAt(300 - CANCEL_SLIDE_PX - 10);

    expect(harness.cancel).toHaveBeenCalledTimes(1);
    FakeMediaRecorder.instances[0].flushPending!();
    flushSync();

    // The chunk arrived after the decision, which is the ordinary case - and it goes nowhere.
    expect(harness.complete).not.toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
  });
});
