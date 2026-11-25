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
    anchorMovedPx: 0,
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

  it('pins a change ABOVE the viewport without a glide - the entry widen, a voice note settling', () => {
    // Owner's Android, 1.8.0, 2026-11-25: ten older rows mounted above a reader at the end move the
    // reach - and the reader's top row - by the same 200 px. Gliding that jump drew the thread a step
    // lower and slid it back: the open "yanked up then sliding down".
    expect(appendGlidePx(arrival({ currentScrollTop: 1200, anchorMovedPx: 200 }))).toBe(0);
    // A voice note above the fold turning from its placeholder into its player: same answer.
    expect(appendGlidePx(arrival({ currentScrollTop: 1024, anchorMovedPx: 24 }))).toBe(0);
  });

  it('glides only the arrival when the same change also moved the rows above', () => {
    // The live window steps forward by one row (40 px trimmed off the top) as a 70 px row arrives.
    expect(appendGlidePx(arrival({ currentScrollTop: 1030, anchorMovedPx: -40 }))).toBe(70);
  });

  it('never glides the rounding of an integer offsetTop against a fractional scrollTop', () => {
    // 40 px above the viewport, read as 40 by `offsetTop` while the pin moved 40.8: no arrival.
    expect(appendGlidePx(arrival({ currentScrollTop: 1040.8, anchorMovedPx: 40 }))).toBe(0);
    expect(appendGlidePx(arrival({ currentScrollTop: 1001, anchorMovedPx: 0 }))).toBe(0);
    // Past what two roundings can be off by, it is motion.
    expect(appendGlidePx(arrival({ currentScrollTop: 1041.5, anchorMovedPx: 40 }))).toBe(1.5);
  });

  it('jumps when the top row left the document: where the change happened is unknown', () => {
    expect(appendGlidePx(arrival({ anchorMovedPx: null }))).toBe(0);
  });
});
