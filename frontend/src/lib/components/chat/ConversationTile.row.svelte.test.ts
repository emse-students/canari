// @vitest-environment happy-dom
/**
 * THE ROW IS MESSENGER'S (audit M1): a 72 dp row, a 56 dp avatar, the relative time of the last
 * message on the name line, and an unread conversation bold in its name, time AND preview.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `Name(${id})`,
  resolveUserDisplayName: async (id: string) => `Name(${id})`,
}));

import ConversationTile from './ConversationTile.svelte';
import { timeAgo } from '$lib/utils/time';

let target: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

function render(extra: Record<string, unknown> = {}) {
  app = mount(ConversationTile, {
    target,
    props: {
      conversationId: 'g1',
      contactName: 'group-1',
      displayName: 'Group',
      conversationType: 'group',
      isReady: true,
      isSelected: false,
      unreadCount: 0,
      onClick: () => {},
      ...extra,
    },
  });
  flushSync();
}

beforeEach(() => {
  target = document.createElement('div');
  document.body.appendChild(target);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (app) unmount(app);
  app = null;
  target.remove();
  vi.restoreAllMocks();
});

describe('ConversationTile row anatomy', () => {
  it('is 72 dp tall and draws a 56 dp avatar', () => {
    render();
    const row = target.querySelector('[data-conversation-tile]')!;
    expect(row.className).toContain('h-18');
    expect(target.querySelector('.w-14.h-14')).not.toBeNull();
  });

  it('shows the relative time of the last message on the name line', () => {
    const at = Date.now() - 5 * 60_000;
    render({ lastActivityAt: at });
    const time = target.querySelector('[data-conversation-time]')!;
    expect(time.textContent!.trim()).toBe(timeAgo(new Date(at).toISOString()));
    expect(time.className).toContain('text-text-muted');
  });

  it('draws no time for a conversation with no message', () => {
    render();
    expect(target.querySelector('[data-conversation-time]')).toBeNull();
  });

  it('makes the time bold when unread, and keeps the unread badge', () => {
    render({ lastActivityAt: Date.now() - 60_000, unreadCount: 3 });
    expect(target.querySelector('[data-conversation-time]')!.className).toContain('font-semibold');
    expect(target.textContent).toContain('3');
  });
});
