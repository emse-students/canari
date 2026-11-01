// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  callHoldsAppSound,
  callSoundHeld,
  noteToneSilenced,
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

  // iPhone 12, 2026-10-30: the line went through `console.debug`, which the in-app log never records,
  // so no device reading could show when the app went quiet. Control: `Log.d` back -> this fails.
  it('says each CHANGE of the gate at a level the in-app log records, and only a change', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    reportCallSoundPhase('a', 'calling');
    reportCallSoundPhase('a', 'incall');
    reportCallSoundPhase('a', 'ended');
    const lines = info.mock.calls.map((c) => String(c[0]));
    info.mockRestore();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[AUDIO] a call holds the app's sound (a is calling)");
    expect(lines[1]).toContain("the call released the app's sound (a is ended)");
  });

  it('counts the tones silenced during a call and tells the count on the release line, per call', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    reportCallSoundPhase('a', 'incall');
    noteToneSilenced();
    noteToneSilenced();
    noteToneSilenced();
    reportCallSoundPhase('a', 'ended');
    reportCallSoundPhase('a', 'incall');
    noteToneSilenced();
    reportCallSoundPhase('a', 'ended');
    const lines = info.mock.calls.map((c) => String(c[0]));
    info.mockRestore();
    expect(lines.filter((l) => l.includes('released'))).toEqual([
      expect.stringContaining('3 tone(s) silenced during the call'),
      expect.stringContaining('1 tone(s) silenced during the call'),
    ]);
  });

  it("one holder's idle never erases another holder's call (an account switch overlaps two)", () => {
    reportCallSoundPhase('old', 'incall');
    reportCallSoundPhase('new', 'idle');
    expect(callHoldsAppSound()).toBe(true);
    retireCallSoundHolder('old');
    expect(callHoldsAppSound()).toBe(false);
  });
});
