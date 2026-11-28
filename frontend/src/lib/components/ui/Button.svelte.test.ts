// @vitest-environment happy-dom
/**
 * THE ONE BUTTON's two box-less variants: `link` (accent text in a line) and `bare` (a whole surface
 * that is one tap and has no address, an attachment card's PDF row). Neither wears `.ui-control`, so
 * a call site never has to cancel the control box with overrides it is not allowed to spell.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import Button from './Button.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(props: Record<string, unknown>): HTMLButtonElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Button, {
    target,
    props: { children: createRawSnippet(() => ({ render: () => '<span>x</span>' })), ...props },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return target.querySelector('button')!;
}

describe('Button variant="bare"', () => {
  it('drops the control box and every colour, keeping only the layout it is given', () => {
    const button = render({ variant: 'bare', class: 'flex w-full text-left' });
    expect(button.className).not.toContain('ui-control');
    expect(button.className).not.toMatch(/\bbg-|\bborder-|\btext-(?!left)/);
    expect(button.className).toContain('flex w-full text-left');
    expect(button.type).toBe('button');
  });

  it('is still a button: it takes the tap, and refuses it disabled', () => {
    const onclick = vi.fn();
    render({ variant: 'bare', onclick }).click();
    expect(onclick).toHaveBeenCalledTimes(1);
    const off = vi.fn();
    const disabled = render({ variant: 'bare', onclick: off, disabled: true });
    expect(disabled.disabled).toBe(true);
  });

  it('leaves every boxed variant on the control box', () => {
    expect(render({ variant: 'ghost' }).className).toContain('ui-control');
  });
});

describe('Button variant="success"', () => {
  it('is a solid green fill for white text, the learning path\'s "go on"', () => {
    const b = render({ variant: 'success' });
    expect(b.className).toContain('bg-green-solid');
    expect(b.className).toContain('text-white');
    expect(b.className).toContain('ui-control');
  });
});
