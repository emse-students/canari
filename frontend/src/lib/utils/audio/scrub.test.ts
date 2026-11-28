import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetVoicePosition,
  recallVoicePosition,
  rememberVoicePosition,
  scrubTimeAt,
  scrubTimeForKey,
} from './scrub';

describe('scrubTimeAt', () => {
  const strip = { left: 100, width: 200 };
  it('maps a position proportionally onto the note', () => {
    expect(scrubTimeAt(200, strip, 40)).toBe(20);
    expect(scrubTimeAt(125, strip, 40)).toBe(5);
  });
  it('clamps a captured drag that left the strip', () => {
    expect(scrubTimeAt(0, strip, 40)).toBe(0);
    expect(scrubTimeAt(900, strip, 40)).toBe(40);
  });
  it('is 0 without a width or a length', () => {
    expect(scrubTimeAt(200, { left: 0, width: 0 }, 40)).toBe(0);
    expect(scrubTimeAt(200, strip, 0)).toBe(0);
  });
});

describe('scrubTimeForKey', () => {
  it('steps, jumps and clamps', () => {
    expect(scrubTimeForKey('ArrowRight', 10, 45)).toBe(15);
    expect(scrubTimeForKey('ArrowLeft', 2, 45)).toBe(0);
    expect(scrubTimeForKey('End', 10, 45)).toBe(45);
    expect(scrubTimeForKey('Home', 10, 45)).toBe(0);
  });
  it('leaves other keys alone', () => {
    expect(scrubTimeForKey('Enter', 10, 45)).toBeNull();
    expect(scrubTimeForKey('ArrowRight', 10, 0)).toBeNull();
  });
});

describe('voice position memory', () => {
  beforeEach(() => forgetVoicePosition('a'));
  it('returns what was left, and forgets it', () => {
    rememberVoicePosition('a', { time: 7, playing: true });
    expect(recallVoicePosition('a')).toEqual({ time: 7, playing: true });
    forgetVoicePosition('a');
    expect(recallVoicePosition('a')).toBeNull();
  });
  it('keeps nothing for a note at its start, paused', () => {
    rememberVoicePosition('a', { time: 0, playing: false });
    expect(recallVoicePosition('a')).toBeNull();
  });
});
