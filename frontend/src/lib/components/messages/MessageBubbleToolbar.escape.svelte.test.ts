// @vitest-environment happy-dom
/**
 * ESCAPE IS LISTENED FOR ONLY WHILE A POPOVER IS OPEN.
 *
 * Every desktop bubble mounts this toolbar, and the thread's render window only grows
 * (`renderWindow.ts`), so a `<svelte:window onkeydown>` here was one window listener per bubble the
 * reader ever scrolled past (backlog "the thread's render window only grows, with listeners per
 * bubble"). The count is what is pinned, alongside the behaviour it must not lose.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageBubbleToolbar from './MessageBubbleToolbar.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mountToolbar(): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MessageBubbleToolbar, {
    target,
    props: {
      isOwn: false,
      isDeleted: false,
      hasMedia: false,
      showEmojiPicker: false,
      onReact: () => {},
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

/** The window `keydown` listeners attached and not yet removed, counted from the two spies. */
function liveKeydownListeners(
  add: { mock: { calls: unknown[][] } },
  remove: { mock: { calls: unknown[][] } }
): number {
  const count = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((call) => call[0] === 'keydown').length;
  return count(add) - count(remove);
}

describe('MessageBubbleToolbar keyboard dismissal', () => {
  it('adds no window keydown listener for a closed toolbar, however many are mounted', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');

    for (let i = 0; i < 20; i++) mountToolbar();

    expect(liveKeydownListeners(add, remove)).toBe(0);
  });

  it('closes an open quick bar on Escape, then lets go of the listener', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const target = mountToolbar();
    const opener = target.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!opener) throw new Error('quick-reaction opener not found');

    opener.click();
    flushSync();
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    expect(liveKeydownListeners(add, remove)).toBe(1);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();

    expect(opener.getAttribute('aria-expanded')).toBe('false');
    expect(liveKeydownListeners(add, remove)).toBe(0);
  });
});
