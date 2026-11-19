import { describe, expect, it } from 'vitest';
import { appendGlidePx, type AppendGlide } from './threadAnchor';

/** A text row arriving under a reader at the bottom of a 470 px pane (Mi 9T, keyboard up). */
function arrival(overrides: Partial<AppendGlide> = {}): AppendGlide {
  return {
    cause: 'rows',
    previousScrollTop: 1000,
    currentScrollTop: 1070,
    previousClientHeight: 470,
    currentClientHeight: 470,
    isEntering: false,
    reducedMotion: false,
    ...overrides,
  };
}

describe('appendGlidePx', () => {
  it('glides by the distance the pin jumped when a row arrives', () => {
    // Messenger's own send: 70 px of room made for one line.
    expect(appendGlidePx(arrival())).toBe(70);
  });

  it('jumps when the pane itself changed size - the keyboard, a panel', () => {
    expect(appendGlidePx(arrival({ cause: 'box' }))).toBe(0);
    expect(appendGlidePx(arrival({ currentClientHeight: 113 }))).toBe(0);
  });

  it('jumps during the entry, for a batch, for a shrink and for reduced motion', () => {
    expect(appendGlidePx(arrival({ isEntering: true }))).toBe(0);
    expect(appendGlidePx(arrival({ currentScrollTop: 1000 + 236 }))).toBe(0);
    expect(appendGlidePx(arrival({ currentScrollTop: 990 }))).toBe(0);
    expect(appendGlidePx(arrival({ reducedMotion: true }))).toBe(0);
  });

  it('still glides a row half the pane tall', () => {
    expect(appendGlidePx(arrival({ currentScrollTop: 1235 }))).toBe(235);
  });
});
