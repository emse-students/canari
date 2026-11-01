import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  callHoldsAppSound,
  callSoundHeld,
  reportCallSoundPhase,
  resetCallSoundGateForTest,
  retireCallSoundHolder,
} from './callSoundGate';

describe("the app's sound gate during a call", () => {
  beforeEach(() => resetCallSoundGateForTest());

  it('is held from ringing (out or in) through the call, and released at the summary', () => {
    for (const phase of ['calling', 'incoming', 'incall']) {
      reportCallSoundPhase('a', phase);
      expect(callHoldsAppSound(), phase).toBe(true);
      expect(get(callSoundHeld), phase).toBe(true);
    }
    reportCallSoundPhase('a', 'ended');
    expect(callHoldsAppSound()).toBe(false);
    expect(get(callSoundHeld)).toBe(false);
  });

  it("one holder's idle never erases another holder's call (an account switch overlaps two)", () => {
    reportCallSoundPhase('old', 'incall');
    reportCallSoundPhase('new', 'idle');
    expect(callHoldsAppSound()).toBe(true);
    retireCallSoundHolder('old');
    expect(callHoldsAppSound()).toBe(false);
  });
});
