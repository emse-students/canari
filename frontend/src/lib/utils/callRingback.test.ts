import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallRingback, RINGBACK_SRC, type RingbackElement } from './callRingback';
import { RINGBACK_PERIOD_S, RINGBACK_PHRASE } from './soundPalette';

vi.mock('$lib/utils/sessionLog', () => ({ appendLog: vi.fn() }));
const { appendLog } = await import('$lib/utils/sessionLog');

/** An audio element whose `play()` the test settles. */
function fakeElement(outcome: 'resolve' | DOMException = 'resolve') {
  const el = {
    src: '',
    loop: false,
    muted: false,
    paused: true as boolean,
    currentTime: 3,
    play: vi.fn(() => {
      if (outcome !== 'resolve') return Promise.reject(outcome);
      el.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      el.paused = true;
    }),
  } satisfies RingbackElement;
  return el;
}

const logged = (text: string) =>
  vi.mocked(appendLog).mock.calls.some(([l]) => String(l).includes(text));

describe("the caller's ringback player", () => {
  beforeEach(() => vi.mocked(appendLog).mockClear());

  it('loops the rendered asset, the pause being part of the file', () => {
    const el = fakeElement();
    new CallRingback(el);
    expect(el.src).toBe(RINGBACK_SRC);
    expect(el.loop).toBe(true);
  });

  it('plays from the top on start, and logs why', async () => {
    const el = fakeElement();
    const ringback = new CallRingback(el);
    ringback.start('the other phone rings');
    await Promise.resolve();
    expect(el.play).toHaveBeenCalledTimes(1);
    expect(el.currentTime).toBe(0);
    expect(el.muted).toBe(false);
    expect(logged('ringback playing (the other phone rings)')).toBe(true);
  });

  it('stops at once, rewinds, and logs why; a repeat stop says nothing', () => {
    const el = fakeElement();
    const ringback = new CallRingback(el);
    ringback.start('rings');
    ringback.stop('the ring is over');
    expect(el.pause).toHaveBeenCalledTimes(1);
    expect(el.currentTime).toBe(0);
    expect(logged('ringback stopped (the ring is over)')).toBe(true);
    vi.mocked(appendLog).mockClear();
    ringback.stop('again');
    expect(el.pause).toHaveBeenCalledTimes(1);
    expect(appendLog).not.toHaveBeenCalled();
  });

  it('a stop before play() resolved leaves nothing looping', async () => {
    const el = fakeElement();
    const ringback = new CallRingback(el);
    ringback.start('rings');
    ringback.stop('answered at once');
    await Promise.resolve();
    await Promise.resolve();
    expect(el.paused).toBe(true);
  });

  it('a second start is a no-op', () => {
    const el = fakeElement();
    const ringback = new CallRingback(el);
    ringback.start('a');
    ringback.start('b');
    expect(el.play).toHaveBeenCalledTimes(1);
  });

  it('tells a refusal for want of a gesture from any other failure', async () => {
    const el = fakeElement(new DOMException('no gesture', 'NotAllowedError'));
    new CallRingback(el).start('rings');
    await Promise.resolve();
    await Promise.resolve();
    expect(logged('WARN ringback refused without a gesture (rings)')).toBe(true);
  });

  it('a prime inside the tap is a muted play paused again, unless the ringback started meanwhile', async () => {
    const el = fakeElement();
    const ringback = new CallRingback(el);
    ringback.prime('the dial tap');
    expect(el.muted).toBe(true);
    await Promise.resolve();
    expect(el.pause).toHaveBeenCalledTimes(1);
    expect(el.muted).toBe(false);

    const busy = fakeElement();
    const second = new CallRingback(busy);
    second.prime('the dial tap');
    second.start('rings');
    await Promise.resolve();
    await Promise.resolve();
    expect(busy.paused).toBe(false);
  });
});

describe('the ringback phrase', () => {
  it('stays below the notification trills and well inside its loop', () => {
    const top = Math.max(
      ...RINGBACK_PHRASE.filter((v) => v.peak > 0.06).flatMap((v) => v.path.map(([, h]) => h))
    );
    expect(top).toBeLessThanOrEqual(2150);
    const end = Math.max(...RINGBACK_PHRASE.map((v) => v.offset + v.dur));
    // The phrase, plus the 0.9 s room the renderer adds, leaves at least 1.5 s of silence per loop.
    expect(end + 0.9).toBeLessThanOrEqual(RINGBACK_PERIOD_S - 1.5);
  });
});
