// @vitest-environment happy-dom
/**
 * "Clore le sondage" is offered to the poll's author AND to a salon moderator - the same pair the
 * server's `closePoll` accepts. The bubble offered it to the author only, so a moderator could
 * close a poll through the API but never from the app.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  getGlobalChat: () => null,
}));

import MessageBubble from './MessageBubble.svelte';
import { serializeEnvelope, mkPollEnvelope } from '$lib/envelope';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];

const pollContent = serializeEnvelope(
  mkPollEnvelope(
    'Quel jour ?',
    [
      { id: 'a', label: 'Jeudi' },
      { id: 'b', label: 'Vendredi' },
    ],
    false,
    null
  )
);

function render(props: Record<string, unknown>): void {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MessageBubble, {
    target,
    props: {
      messageId: 'poll-1',
      senderId: 'u-author',
      currentUserId: 'u-me',
      content: pollContent,
      timestamp: new Date('2026-10-12T10:00:00Z'),
      isOwn: false,
      onClosePoll: () => {},
      ...props,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
}

function closeButtons(): number {
  return [...document.querySelectorAll('button')].filter(
    (el) => el.textContent?.trim() === m.channel_poll_close_button()
  ).length;
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
});

describe('MessageBubble poll close action', () => {
  it("is offered on the author's own poll", () => {
    render({ isOwn: true, senderId: 'u-me' });
    expect(closeButtons()).toBe(1);
  });

  it("is offered to a moderator on someone else's poll", () => {
    render({ canModerate: true });
    expect(closeButtons()).toBe(1);
  });

  it("is not offered to a plain member on someone else's poll", () => {
    render({});
    expect(closeButtons()).toBe(0);
  });

  it('is not offered when the parent cannot take a close', () => {
    render({ canModerate: true, onClosePoll: undefined });
    expect(closeButtons()).toBe(0);
  });
});
