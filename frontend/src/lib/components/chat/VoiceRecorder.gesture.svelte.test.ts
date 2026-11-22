// @vitest-environment happy-dom
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
import { RECORDING_AUDIO_CONSTRAINTS } from '$lib/utils/audio/recordingConstraints';
import { buildCallAudioConstraints } from '$lib/utils/callAudio';
import { reportCallSoundPhase, resetCallSoundGateForTest } from '$lib/utils/callSoundGate';

// The microphone hold (`audioSession.ts`, pinned by `audioSession.test.ts`) is passed through: this
// file's fake streams pin what is ASKED, not the session type.
vi.mock('$lib/utils/audioSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/audioSession')>()),
  captureUserMedia: (devices: MediaDevices, constraints: MediaStreamConstraints) =>
    devices.getUserMedia(constraints),
}));

/**
 * The loudness tap, injected: what is pinned here is WHEN the recorder makes and closes it, not how
 * it measures (`recordingLoudness.test.ts`). Every tap made is kept, each with its own `stop`.
 */
const taps = vi.hoisted(() => ({
  made: [] as { stop: import('vitest').Mock<() => unknown> }[],
  measured: { integratedLufs: -19, samplePeakDbfs: -3 } as unknown,
}));
vi.mock('$lib/utils/audio/recordingLoudness', () => ({
  tapRecordingLoudness: () => {
    const tap = { stop: vi.fn(() => taps.measured) };
    taps.made.push(tap);
    return tap;
  },
}));

/**
 * The mono downmix, injected: its graph is pinned by `monoRecording.test.ts`; here, that the recorder
 * records what it returns and releases it on every ending.
 */
const downmix = vi.hoisted(() => ({
  made: [] as { release: import('vitest').Mock<() => void>; stream: unknown }[],
  /** Set: the downmix's context did not run, and the step rejects (`DownmixNotRunningError`). */
  refuse: false,
}));
vi.mock('$lib/utils/audio/monoRecording', () => ({
  monoRecordingStream: async (microphone: unknown) => {
    if (downmix.refuse)
      throw new Error('the one-channel downmix context is suspended, not running');
    const made = { stream: microphone, granted: 'unknown', downmixed: true, release: vi.fn() };
    downmix.made.push(made);
    return made;
  },
}));

const CANCEL_SLIDE_PX = 96;
const LOCK_SLIDE_PX = 72;
const MIN_RECORDING_MS = 700;

const mounted: (() => void)[] = [];

/** A stream as the engine hands one over: one audio track, whose settings the capture report reads. */
function fakeStream() {
  const track = { stop: trackStop, label: '', getSettings: () => ({}) };
  return { getTracks: () => [track], getAudioTracks: () => [track] };
}

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
  complete: Mock<(blob: Blob, loudness: unknown) => void>;
  cancel: Mock<() => void>;
  activeChanges: boolean[];
}

let harness: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  taps.made = [];
  downmix.made = [];
  downmix.refuse = false;
  trackStop.mockClear();
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.deferStop = false;
  (globalThis as Record<string, unknown>).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(fakeStream()) },
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
    complete: vi.fn<(blob: Blob, loudness: unknown) => void>(),
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
function pointer(type: string, clientX: number, pointerId = 1, isPrimary = true): Event {
  const Ctor = (globalThis as Record<string, unknown>).PointerEvent as
    | typeof PointerEvent
    | undefined;
  if (Ctor) return new Ctor(type, { bubbles: true, clientX, pointerId, isPrimary });
  const e = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(e, 'pointerId', { value: pointerId });
  Object.defineProperty(e, 'isPrimary', { value: isPrimary });
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

    // A recording, not a call: no voice-call processing, mono (recordingConstraints.ts).
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: RECORDING_AUDIO_CONSTRAINTS,
    });
    expect(RECORDING_AUDIO_CONSTRAINTS).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    expect(harness.activeChanges).toEqual([true]);
    expect(document.querySelector('.voice-recorder')?.getAttribute('data-phase')).toBe('holding');
  });

  it("during a live call, asks the call's own constraints so the call's capture is not reconfigured", async () => {
    reportCallSoundPhase('test-call', 'incall');
    try {
      await press();
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
        audio: buildCallAudioConstraints(),
      });
    } finally {
      resetCallSoundGateForTest();
    }
  });

  it('a ring coming in holds no microphone: the note is still a recording', async () => {
    reportCallSoundPhase('test-call', 'incoming');
    try {
      await press();
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
        audio: RECORDING_AUDIO_CONSTRAINTS,
      });
    } finally {
      resetCallSoundGateForTest();
    }
  });

  it('still records when the capture report throws (an odd WebView)', async () => {
    const track = {
      stop: trackStop,
      label: '',
      getSettings: () => {
        throw new Error('getSettings unsupported');
      },
    };
    (navigator.mediaDevices.getUserMedia as Mock).mockResolvedValue({
      getTracks: () => [track],
      getAudioTracks: () => [track],
    });
    await press();

    expect(FakeMediaRecorder.instances).toHaveLength(1);
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

  it('CANCELS at the screen edge when the microphone is nearer the edge than the full distance', async () => {
    // The phone case: the microphone sits ~86px from the left edge, so a flat 96px could never be
    // reached by a finger and sliding as far as the glass allows SENT the note instead.
    await press(86);
    await vi.advanceTimersByTimeAsync(MIN_RECORDING_MS + 100);
    moveTo(2);
    releaseAt(2);

    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.cancel).toHaveBeenCalledTimes(1);
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
    openMicrophone(fakeStream());
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

/**
 * THE LOUDNESS TAP LIVES EXACTLY AS LONG AS THE RECORDING (review of #3394): it is made only once
 * the recorder has started - its AudioContext must not outlive a failed start - and it is closed on
 * every ending, so no tap's context is ever left holding an audio output.
 */
describe('VoiceRecorder - the loudness tap is closed on every ending', () => {
  beforeEach(() => {
    harness = mountRecorder();
  });

  it('a SEND hands the tap measurement with the blob, and closes the tap', async () => {
    await press(300);
    await vi.advanceTimersByTimeAsync(MIN_RECORDING_MS + 100);
    releaseAt(300);
    expect(taps.made).toHaveLength(1);
    expect(taps.made[0].stop).toHaveBeenCalled();
    expect(harness.complete.mock.calls[0][1]).toEqual(taps.measured);
  });

  it('a CANCEL (the bin) closes it', async () => {
    await press(300);
    await vi.advanceTimersByTimeAsync(MIN_RECORDING_MS + 100);
    moveTo(300 - CANCEL_SLIDE_PX - 10);
    releaseAt(300 - CANCEL_SLIDE_PX - 10);
    expect(taps.made[0].stop).toHaveBeenCalled();
  });

  it("a DISCARD from a locked bar's own bin closes it", async () => {
    await press(300);
    moveTo(300 + LOCK_SLIDE_PX + 5);
    await vi.advanceTimersByTimeAsync(3000);
    document.querySelector<HTMLElement>('.chat-composer-icon-button')!.click();
    flushSync();
    expect(taps.made[0].stop).toHaveBeenCalled();
  });

  it('a TOO-SHORT press closes it', async () => {
    await press(300);
    await vi.advanceTimersByTimeAsync(MIN_RECORDING_MS - 200);
    releaseAt(300);
    expect(taps.made[0].stop).toHaveBeenCalled();
  });

  it('an UNMOUNT mid-recording closes it', async () => {
    await press(300);
    expect(taps.made[0].stop).not.toHaveBeenCalled();
    mounted.pop()!();
    expect(taps.made[0].stop).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
  });

  it('a start() that THROWS makes no tap at all, and gives the microphone back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(FakeMediaRecorder.prototype, 'start').mockImplementation(() => {
      throw new DOMException('the device is busy', 'NotReadableError');
    });
    await press(300);
    expect(taps.made).toHaveLength(0);
    expect(trackStop).toHaveBeenCalled();
    expect(document.querySelector('.voice-recorder')?.getAttribute('data-phase')).toBe('idle');
  });
});

/**
 * A PERMISSION PROMPT TAKES THE FINGER (iPhone 12, `1.7.3-alpha.4`): on the FIRST press the system
 * prompt took the touch, no `pointerup` nor `pointercancel` ever reached the page, and once the
 * prompt was answered the recorder sat in `holding` for good - its clock running, neither the slide
 * nor a bin able to end it, until the app was killed. Each test below plays one of the signals that
 * prove the gesture is over, and asserts the hold ends without a send.
 */
describe('VoiceRecorder - a permission prompt takes the finger', () => {
  let openMicrophone!: (s: unknown) => void;

  beforeEach(() => {
    harness = mountRecorder();
    navigator.mediaDevices.getUserMedia = vi
      .fn()
      .mockReturnValueOnce(new Promise((resolve) => (openMicrophone = resolve)))
      .mockResolvedValue(fakeStream());
  });

  /** Pressed: the prompt is up, `getUserMedia` pending. */
  function pressIntoPrompt(): void {
    thumb().dispatchEvent(pointer('pointerdown', 300));
    flushSync();
    expect(phaseNow()).toBe('arming');
  }

  /** The prompt answered: the microphone opens, after the gesture was taken. */
  async function answerPrompt(): Promise<void> {
    openMicrophone(fakeStream());
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
  }

  const phaseNow = () => document.querySelector('.voice-recorder')?.getAttribute('data-phase');

  it('the window losing focus to the prompt ends the press: nothing records, the device goes back', async () => {
    pressIntoPrompt();
    window.dispatchEvent(new Event('blur'));
    flushSync();
    expect(phaseNow()).toBe('idle');

    await answerPrompt();
    expect(phaseNow()).toBe('idle');
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(trackStop).toHaveBeenCalled();
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it('the pointer capture lost to the prompt ends the press the same way', async () => {
    pressIntoPrompt();
    thumb().dispatchEvent(pointer('lostpointercapture', 300));
    flushSync();
    expect(phaseNow()).toBe('idle');

    await answerPrompt();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(trackStop).toHaveBeenCalled();
  });

  it('the page hidden ends the press the same way', async () => {
    pressIntoPrompt();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      flushSync();
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
    expect(phaseNow()).toBe('idle');
    await answerPrompt();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  it('a second finger landing during a hold leaves the hold alone (no second recorder)', async () => {
    pressIntoPrompt();
    await answerPrompt();
    expect(phaseNow()).toBe('holding');

    thumb().dispatchEvent(pointer('pointerdown', 300, 2, false));
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(phaseNow()).toBe('holding');
    expect(harness.cancel).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(MIN_RECORDING_MS + 100);
    releaseAt(300);
    expect(harness.complete).toHaveBeenCalledTimes(1);
  });

  it('a focus lost while HOLDING discards the recording, never sends it', async () => {
    pressIntoPrompt();
    await answerPrompt();
    await vi.advanceTimersByTimeAsync(MIN_RECORDING_MS + 100);
    window.dispatchEvent(new Event('blur'));
    flushSync();

    expect(phaseNow()).toBe('idle');
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.cancel).toHaveBeenCalledTimes(1);
    expect(downmix.made[0].release).toHaveBeenCalled();
  });

  it('a LOCKED recording is no gesture: a focus lost leaves it recording', async () => {
    pressIntoPrompt();
    await answerPrompt();
    moveTo(300 + LOCK_SLIDE_PX + 5);
    window.dispatchEvent(new Event('blur'));
    flushSync();
    expect(phaseNow()).toBe('locked');
    expect(harness.cancel).not.toHaveBeenCalled();
  });

  it('an up, then the capture released with it, is one ending, not two', async () => {
    pressIntoPrompt();
    await answerPrompt();
    await vi.advanceTimersByTimeAsync(MIN_RECORDING_MS + 100);
    releaseAt(300);
    document
      .querySelector('.voice-recorder-thumb')
      ?.dispatchEvent(pointer('lostpointercapture', 300));
    flushSync();
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.cancel).not.toHaveBeenCalled();
  });
});

describe('VoiceRecorder - one channel', () => {
  beforeEach(() => {
    harness = mountRecorder();
  });

  it('records the stream the mono step returns, and releases it with the device', async () => {
    await press(300);
    expect(downmix.made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MIN_RECORDING_MS + 100);
    releaseAt(300);
    expect(downmix.made[0].release).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
  });
});

/**
 * A RELEASE THEN A NEW PRESS WHILE THE FIRST MICROPHONE IS STILL OPENING (review of #3955): each
 * `beginRecording` carries its own token, checked after every await, so the first attempt gives its
 * device back and only the second records - never two recorders, never a microphone left open.
 */
describe('VoiceRecorder - one attempt at a time', () => {
  beforeEach(() => {
    harness = mountRecorder();
  });

  it('release, press again, then the FIRST microphone opens: only the second records', async () => {
    const opens: ((s: unknown) => void)[] = [];
    navigator.mediaDevices.getUserMedia = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => opens.push(resolve)));
    const firstStop = vi.fn();
    const first = { stop: firstStop, label: '', getSettings: () => ({}) };

    thumb().dispatchEvent(pointer('pointerdown', 300));
    flushSync();
    releaseAt(300);
    thumb().dispatchEvent(pointer('pointerdown', 300));
    flushSync();
    expect(opens).toHaveLength(2);

    // The first attempt's microphone arrives while the second press is arming.
    opens[0]({ getTracks: () => [first], getAudioTracks: () => [first] });
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(firstStop).toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(document.querySelector('.voice-recorder')?.getAttribute('data-phase')).toBe('arming');

    opens[1](fakeStream());
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(document.querySelector('.voice-recorder')?.getAttribute('data-phase')).toBe('holding');
  });
});

/**
 * A DOWNMIX WHOSE CONTEXT DOES NOT RUN WOULD RECORD SILENCE (review of #3955): the step rejects, the
 * recorder never starts, the microphone goes back and the refusal toast is the answer - a silent note
 * is never sent.
 */
describe('VoiceRecorder - a downmix that does not run', () => {
  beforeEach(() => {
    harness = mountRecorder();
  });

  it('records nothing, gives the microphone back and goes idle', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    downmix.refuse = true;
    await press(300);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(taps.made).toHaveLength(0);
    expect(trackStop).toHaveBeenCalled();
    expect(document.querySelector('.voice-recorder')?.getAttribute('data-phase')).toBe('idle');
    expect(harness.complete).not.toHaveBeenCalled();
  });
});
