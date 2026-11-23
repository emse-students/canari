// @vitest-environment happy-dom
/** `trackReaderInput`: the reader's input raises it, a placement with no finger down lowers it. */
import { describe, expect, it } from 'vitest';
import { trackReaderInput } from './readerInput';

describe('trackReaderInput', () => {
  it('is down until the reader touches, wheels, presses or types on the pane', () => {
    for (const type of ['touchstart', 'pointerdown', 'wheel', 'keydown']) {
      const el = document.createElement('div');
      const input = trackReaderInput(el, { held: false });
      expect(input.moving).toBe(false);
      el.dispatchEvent(new Event(type));
      expect(input.moving).toBe(true);
      input.dispose();
    }
  });

  it('stays up through a fling after the finger lifted, until the page places the pane', () => {
    const el = document.createElement('div');
    const input = trackReaderInput(el, { held: false });
    el.dispatchEvent(new Event('touchstart'));
    expect(input.moving).toBe(true);
    input.placed();
    expect(input.moving).toBe(false);
  });

  it('a placement under a finger does not end the reader move', () => {
    const el = document.createElement('div');
    const touch = { held: true };
    const input = trackReaderInput(el, touch);
    el.dispatchEvent(new Event('touchstart'));
    input.placed();
    expect(input.moving).toBe(true);
    touch.held = false;
    input.placed();
    expect(input.moving).toBe(false);
  });

  it('a jump the reader asked for counts as theirs; dispose stops listening', () => {
    const el = document.createElement('div');
    const input = trackReaderInput(el, { held: false });
    input.declare();
    expect(input.moving).toBe(true);
    input.dispose();
    expect(input.moving).toBe(false);
    el.dispatchEvent(new Event('wheel'));
    expect(input.moving).toBe(false);
  });
});
