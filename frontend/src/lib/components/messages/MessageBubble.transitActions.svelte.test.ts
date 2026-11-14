// @vitest-environment happy-dom
/**
 * A SEND IN TRANSIT KEEPS ITS AUTHOR'S HAND ON IT UNDER THE BUBBLE (review of #3490, N7).
 *
 * Since 2026-11-13 "En attente..." is drawn under the bubble, by the OUTSIDE `MessageMetadata`
 * (keyboard-and-send-motion.md). A salon text held for the server offers Retry and Delete there
 * (review of #3189): the bubble must hand that row its `onRetry` and `onDiscard`, and nothing of the
 * transit is drawn inside the bubble any more.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  getGlobalChat: () => null,
}));

import MessageBubble from './MessageBubble.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
});

describe('MessageBubble - a held salon text', () => {
  it('hands Retry and Delete to the status row under the bubble', async () => {
    const onRetry = vi.fn();
    const onDiscard = vi.fn();
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(MessageBubble, {
      target,
      props: {
        messageId: 'm1',
        senderId: 'u-me',
        currentUserId: 'u-me',
        authToken: 'tok',
        content: 'hello',
        timestamp: new Date('2026-11-13T10:00:00Z'),
        isOwn: true,
        isLastOwn: true,
        status: 'pending',
        onRetry,
        onDiscard,
        shouldAnimate: true,
      },
    });
    mounted.push(() => void unmount(app));
    flushSync();
    await Promise.resolve();
    flushSync();

    const pending = target.querySelectorAll('[data-testid="message-pending"]');
    expect(pending).toHaveLength(1);
    // Drawn under the bubble (the element that plays the entrance), never inside it.
    const bubble = target.querySelector('.motion-bubble-in');
    expect(bubble?.textContent).toContain('hello');
    expect(bubble?.contains(pending[0])).toBe(false);
    pending[0].querySelector<HTMLButtonElement>('[data-testid="message-retry"]')!.click();
    pending[0].querySelector<HTMLButtonElement>('[data-testid="message-discard"]')!.click();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledOnce();
  });
});
