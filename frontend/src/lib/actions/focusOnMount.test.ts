// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { focusOnMount } from './focusOnMount';

afterEach(() => {
  document.body.innerHTML = '';
});

function field(value = 'Ton plat') {
  const input = document.createElement('input');
  input.value = value;
  document.body.append(input);
  return input;
}

describe('focusOnMount', () => {
  it('focuses the element when enabled', () => {
    const input = field();
    focusOnMount(input, true);
    expect(document.activeElement).toBe(input);
  });

  it('does nothing when disabled', () => {
    const input = field();
    focusOnMount(input, false);
    expect(document.activeElement).not.toBe(input);
  });

  it('selects the text of a field when asked, and not otherwise', () => {
    const input = field();
    focusOnMount(input, { select: true });
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 8]);
    const plain = field('abc');
    focusOnMount(plain, { select: false });
    expect(document.activeElement).toBe(plain);
    expect(plain.selectionStart).toBe(3);
  });

  it('reads the argument once: it has no update, so a later change moves nothing', () => {
    const input = field();
    const action = focusOnMount(input, false) as unknown;
    expect(action).toBeUndefined();
    expect(document.activeElement).not.toBe(input);
  });
});
