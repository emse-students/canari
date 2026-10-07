/**
 * "Modifier" is offered on a member's OWN plain-text message in a salon - and on nothing else.
 *
 * It was missing there for as long as salons existed: `MainChatPage` passed no `onEdit` for a
 * channel, so the bubble was never handed `onBeginEdit` and hid the action. The rule itself is the
 * bubble's `canEdit`, shared with DMs and groups, so it is pinned here at the component.
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

function render(props: Record<string, unknown>): void {
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
      onBeginEdit: () => {},
      ...props,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
}

/** Opens the desktop "..." menu when the bubble has one, and counts the "Modifier" entries in it. */
function editButtons(): number {
  document
    .querySelector<HTMLButtonElement>(`[aria-label="${m.msg_more_actions_label()}"]`)
    ?.click();
  flushSync();
  return [...document.querySelectorAll('[role="menuitem"]')].filter((el) =>
    el.textContent?.includes(m.common_edit_label())
  ).length;
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
});

describe('MessageBubble edit action in a salon', () => {
  it("shows it on the author's own text message when the parent can take an edit", () => {
    render({});
    expect(editButtons()).toBeGreaterThan(0);
  });

  it("hides it on someone else's message", () => {
    render({ isOwn: false, senderId: 'u-other' });
    expect(editButtons()).toBe(0);
  });

  it('hides it when the parent offers no edit', () => {
    render({ onBeginEdit: undefined });
    expect(editButtons()).toBe(0);
  });

  it('hides it on a deleted message', () => {
    render({ isDeleted: true });
    expect(editButtons()).toBe(0);
  });

  it('hides it on a poll', () => {
    render({
      content: serializeEnvelope(
        mkPollEnvelope(
          'q?',
          [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
          false,
          null
        )
      ),
    });
    expect(editButtons()).toBe(0);
  });
});
