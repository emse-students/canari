// @vitest-environment happy-dom
/**
 * A bubble mounts its four closed overlays (the reaction picker, the info panel, the actions sheet,
 * the delete confirmation) on its first `pointerdown` or `focusin`, never with the bubble: a salon
 * open mounts 20 bubbles and paid their setup for panels nobody opened (community-open-budget,
 * "Per-bubble and per-day work"). The intent comes in an EARLIER event than any open, so the
 * overlay is mounted closed before it opens and its intro still plays.
 *
 * The four components are replaced by stubs that count their mounts: what is pinned is WHEN the
 * bubble creates them, not what they draw.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const mounts = vi.hoisted(() => [] as string[]);

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  getGlobalChat: () => null,
}));
vi.mock('./MessageEmojiPicker.svelte', () => ({ default: () => void mounts.push('picker') }));
vi.mock('./MessageInfoTooltip.svelte', () => ({ default: () => void mounts.push('info') }));
vi.mock('./MessageMobileActions.svelte', () => ({ default: () => void mounts.push('actions') }));
vi.mock('../shared/Modal.svelte', () => ({ default: () => void mounts.push('modal') }));

import MessageBubble from './MessageBubble.svelte';

const mounted: (() => void)[] = [];

function render(props: Record<string, unknown> = {}): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MessageBubble, {
    target,
    props: {
      messageId: 'm1',
      senderId: 'u-me',
      currentUserId: 'u-me',
      content: JSON.stringify({ kind: 'text', text: 'hello' }),
      timestamp: new Date('2026-10-05T10:00:00Z'),
      isOwn: true,
      onDelete: () => {},
      onReact: () => {},
      ...props,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return target.querySelector<HTMLElement>('#msg-m1')!;
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  mounts.length = 0;
  document.body.innerHTML = '';
});

const ALL_FOUR = ['actions', 'info', 'modal', 'picker'];

describe('MessageBubble closed overlays', () => {
  it('mounts none of the four with the bubble', () => {
    render();
    expect(mounts).toEqual([]);
  });

  it('mounts all four, closed, on the first pointerdown inside the bubble', () => {
    const root = render();
    root
      .querySelector('[data-swipe-reply]')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    flushSync();
    expect([...mounts].sort()).toEqual(ALL_FOUR);
  });

  it('mounts them on a focusin too, the first step of a keyboard open', () => {
    const root = render();
    root
      .querySelector('[data-swipe-reply]')!
      .dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    flushSync();
    expect([...mounts].sort()).toEqual(ALL_FOUR);
  });

  it('mounts them once for the life of the bubble, whatever the next intents', () => {
    const root = render();
    const bubble = root.querySelector('[data-swipe-reply]')!;
    for (let i = 0; i < 3; i++) {
      bubble.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })
      );
      bubble.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
      flushSync();
    }
    expect([...mounts].sort()).toEqual(ALL_FOUR);
  });

  it('still mounts them for an open that had no intent before it', () => {
    const root = render();
    root.querySelector<HTMLElement>('[data-swipe-reply]')!.click();
    flushSync();
    expect([...mounts].sort()).toEqual(ALL_FOUR);
  });
});
