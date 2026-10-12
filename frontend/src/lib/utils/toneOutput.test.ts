/**
 * THE APP HOLDS NO AUDIO OUTPUT WHEN IT IS NOT PLAYING SOMETHING (2026-10-09, a Pixel 6a's
 * `dumpsys audio` showed the tones' stream `started` for ever, frozen app included).
 *
 * Pinned against a fake `AudioContext` whose oscillators end when the test says so: the output is
 * suspended when the LAST tone in flight ends (not the first), resumed by the next tone, closed when
 * the app leaves the screen (web visibility AND Android's foreground event), and rebuilt afterwards.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { playTone, resetToneOutputForTest, type ToneScore } from '$lib/utils/toneOutput';

class FakeOscillator extends EventTarget {
  disconnect = vi.fn();
  /** What the audio thread does when the scheduled stop time passes. */
  end() {
    this.dispatchEvent(new Event('ended'));
  }
}

const contexts: FakeContext[] = [];

class FakeContext {
  state: AudioContextState = 'running';
  currentTime = 0;
  resume = vi.fn(() => {
    this.state = 'running';
    return Promise.resolve();
  });
  suspend = vi.fn(() => {
    this.state = 'suspended';
    return Promise.resolve();
  });
  close = vi.fn(() => {
    this.state = 'closed';
    return Promise.resolve();
  });
  constructor() {
    contexts.push(this);
  }
}

/** A tone of `voices` oscillators; the test ends them by hand. */
function tone(voices: number, out: FakeOscillator[]): ToneScore {
  return () => {
    const made = Array.from({ length: voices }, () => new FakeOscillator());
    out.push(...made);
    return made as unknown as OscillatorNode[];
  };
}

function setPageVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  contexts.length = 0;
  resetToneOutputForTest();
  vi.stubGlobal('AudioContext', FakeContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'visibilityState');
  Reflect.deleteProperty(window, '__canariForeground');
});

it('suspends the output once the last tone in flight has ended, not before', () => {
  const voices: FakeOscillator[] = [];
  playTone('ring', tone(2, voices));
  playTone('send', tone(1, voices));
  const [ctx] = contexts;
  expect(contexts).toHaveLength(1);

  voices[0].end();
  voices[2].end();
  expect(ctx.suspend, 'one ring voice is still sounding').not.toHaveBeenCalled();
  voices[1].end();
  expect(ctx.suspend).toHaveBeenCalledTimes(1);
  expect(voices.every((v) => v.disconnect.mock.calls.length === 1)).toBe(true);
});

it('the next tone resumes the suspended output instead of opening a second one', () => {
  const voices: FakeOscillator[] = [];
  playTone('notification', tone(1, voices));
  voices[0].end();
  const [ctx] = contexts;
  expect(ctx.state).toBe('suspended');

  playTone('read', tone(1, voices));
  expect(contexts).toHaveLength(1);
  expect(ctx.resume).toHaveBeenCalledTimes(1);
});

it('closes the output when the page is hidden, and the next tone opens a fresh one', () => {
  const voices: FakeOscillator[] = [];
  playTone('notification', tone(1, voices));
  const [first] = contexts;
  setPageVisibility('hidden');
  expect(first.close).toHaveBeenCalledTimes(1);

  // A voice of the closed context ending late must not suspend anything.
  voices[0].end();
  expect(first.suspend).not.toHaveBeenCalled();

  setPageVisibility('visible');
  playTone('send', tone(1, voices));
  expect(contexts).toHaveLength(2);
  voices[1].end();
  expect(contexts[1].suspend, 'the new output counts from zero').toHaveBeenCalledTimes(1);
});

it('closes the output when Android says the app left the foreground (its visibility never moves)', () => {
  playTone('notification', tone(1, []));
  Reflect.set(window, '__canariForeground', false);
  window.dispatchEvent(new CustomEvent('canari:foreground', { detail: { foreground: false } }));
  expect(contexts[0].close).toHaveBeenCalledTimes(1);
});

it('a tone that fails to schedule leaves no output running', () => {
  playTone('broken', () => {
    throw new Error('no oscillator');
  });
  expect(contexts[0].suspend).toHaveBeenCalledTimes(1);
});
