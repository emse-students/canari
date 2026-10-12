import { describe, it, expect, afterEach } from 'vitest';
import { clickMatchesPress, installPressedClickGuard } from './pressedClickGuard';

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
});
