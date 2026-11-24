// @vitest-environment happy-dom
/**
 * FOCUS FOLLOWS A CARD OPENING AND CLOSING. The title input and the row button are rendered by the
 * very state change that moves the focus, so the move cannot be an `$effect` (Svelte 5.59 runs the
 * effect before those elements exist): the title takes it as it mounts, the row after an Escape.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import Harness from './FormBuilderFocusHarness.test.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(selectTitleOnOpen: boolean) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const c = mount(Harness, { target, props: { selectTitleOnOpen } }) as unknown as {
    setExpanded(v: boolean): void;
  };
  mounted.push(() => unmount(c as never));
  flushSync();
  return c;
}

const title = () => document.querySelector<HTMLInputElement>('input[type=text]')!;

describe('opening a card', () => {
  it('focuses its title', async () => {
    const c = render(false);
    expect(document.querySelector('[data-row-button]')).not.toBeNull();
    c.setExpanded(true);
    flushSync();
    await tick();
    expect(document.activeElement).toBe(title());
  });

  it('selects the title when asked, so typing replaces the placeholder text', async () => {
    const c = render(true);
    c.setExpanded(true);
    flushSync();
    await tick();
    expect(document.activeElement).toBe(title());
    expect(title().selectionStart).toBe(0);
    expect(title().selectionEnd).toBe(title().value.length);
  });
});

describe('closing a card from the keyboard', () => {
  it('returns focus to its row button', async () => {
    const c = render(false);
    c.setExpanded(true);
    flushSync();
    await tick();
    title().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    await tick();
    expect(document.activeElement).toBe(document.querySelector('[data-row-button]'));
  });

  it('leaves focus alone when the card closes by another path', async () => {
    const c = render(false);
    c.setExpanded(true);
    flushSync();
    await tick();
    c.setExpanded(false);
    flushSync();
    await tick();
    expect(document.activeElement).not.toBe(document.querySelector('[data-row-button]'));
  });
});
