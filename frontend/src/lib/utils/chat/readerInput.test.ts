// @vitest-environment happy-dom
/** `trackReaderInput`: the reader's input raises it, a placement with no finger down lowers it. */
import { describe, expect, it } from 'vitest';
import { noteKeyboardTransition, keyboardTransitionCount } from '$lib/stores/keyboardTransition';
import { isPageScrollingKey, trackReaderInput } from './readerInput';

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

  it('records the keyboard transition count at the reader last input', () => {
    const el = document.createElement('div');
    const input = trackReaderInput(el, { held: false });
    expect(input.lastInputTransition).toBe(keyboardTransitionCount());
    noteKeyboardTransition('test');
    // The transition came after the last input: the reader did not follow it with a move.
    expect(input.lastInputTransition).toBeLessThan(keyboardTransitionCount());
    el.dispatchEvent(new Event('touchstart'));
    expect(input.lastInputTransition).toBe(keyboardTransitionCount());
    input.dispose();
  });

  it('counts a scrolling key pressed on the page itself, and nothing typed in a field', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    const input = trackReaderInput(el, { held: false });
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(input.moving).toBe(false);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(input.moving).toBe(false);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    expect(input.moving).toBe(true);
    input.dispose();
    el.remove();
    field.remove();
  });
});

describe('isPageScrollingKey', () => {
  it('is a scrolling key whose target is the page itself', () => {
    expect(isPageScrollingKey({ key: ' ', target: document.body })).toBe(true);
    expect(isPageScrollingKey({ key: 'End', target: document.documentElement })).toBe(true);
    expect(isPageScrollingKey({ key: 'Enter', target: document.body })).toBe(false);
    expect(isPageScrollingKey({ key: 'PageUp', target: document.createElement('input') })).toBe(
      false
    );
  });
});
