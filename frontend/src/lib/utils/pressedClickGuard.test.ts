// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { clickMatchesPress, installPressedClickGuard, isPointerClick } from './pressedClickGuard';

describe('pressedClickGuard', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('passes the same element, a descendant and an ancestor', () => {
    document.body.innerHTML = '<button id="b"><span id="i"></span></button>';
    const b = document.getElementById('b')!;
    const i = document.getElementById('i')!;
    expect(clickMatchesPress(b, b, 1)).toBe(true);
    expect(clickMatchesPress(b, i, 1)).toBe(true);
    expect(clickMatchesPress(i, b, 1)).toBe(true);
  });

  it('refuses a click on an unrelated element and passes keyboard clicks', () => {
    document.body.innerHTML = '<button id="a"></button><button id="b"></button>';
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    expect(clickMatchesPress(a, b, 1)).toBe(false);
    expect(clickMatchesPress(a, b, 0)).toBe(true);
  });

  it('passes a label and the control it names', () => {
    document.body.innerHTML = '<label id="l" for="c">x</label><input id="c" />';
    expect(clickMatchesPress(document.getElementById('l'), document.getElementById('c'), 1)).toBe(
      true
    );
  });

  it('stops a click whose press began elsewhere and lets the next honest one through', () => {
    document.body.innerHTML = '<button id="a"></button><button id="b"></button>';
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    let hits = 0;
    b.addEventListener('click', () => hits++);
    const dispose = installPressedClickGuard(document);
    a.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(hits).toBe(0);
    b.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(hits).toBe(1);
    dispose();
  });

  // The sequence measured on the Mi 9T (2026-10-13): pointerdown on the salon row, a script click on
  // the row during touchend (svelte-dnd-action's, a plain `Event`), then the browser's click on the
  // message the salon put under the finger. The script click used to CONSUME the press, so the
  // browser's click found none and passed.
  it.each([
    [
      'a plain Event, as svelte-dnd-action dispatches it',
      () => new Event('click', { bubbles: true }),
    ],
    ['a .click() (detail 0)', () => new MouseEvent('click', { bubbles: true, detail: 0 })],
  ])(
    'a script click on the pressed element (%s) leaves the press to the pointer click',
    (_, make) => {
      document.body.innerHTML = '<button id="row"></button><button id="message"></button>';
      const row = document.getElementById('row')!;
      const message = document.getElementById('message')!;
      let rowHits = 0;
      let messageHits = 0;
      row.addEventListener('click', () => rowHits++);
      message.addEventListener('click', () => messageHits++);
      const dispose = installPressedClickGuard(document);
      row.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      row.dispatchEvent(make());
      message.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      expect(rowHits).toBe(1);
      expect(messageHits).toBe(0);
      dispose();
    }
  );

  it('isPointerClick tells the pointer click apart from script ones', () => {
    expect(isPointerClick(new MouseEvent('click', { detail: 1 }))).toBe(true);
    expect(isPointerClick(new MouseEvent('click', { detail: 0 }))).toBe(false);
    expect(isPointerClick(new Event('click'))).toBe(false);
  });
});
