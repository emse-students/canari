// @vitest-environment happy-dom
/**
 * A pending join ask replaces the tile's preview line and nothing else: no badge, no unread change
 * (owner, 2026-10-30). The ordinary preview returns once the ask is answered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `Name(${id})`,
  resolveUserDisplayName: async (id: string) => `Name(${id})`,
}));

import ConversationTile from './ConversationTile.svelte';
import { raiseJoinRequest, resetJoinRequests } from '$lib/utils/chat/joinRequests.svelte';
import { m } from '$lib/paraglide/messages';

let target: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

function render() {
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
    },
  });
  flushSync();
}

beforeEach(() => {
  target = document.createElement('div');
  document.body.appendChild(target);
  resetJoinRequests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  if (app) unmount(app);
  app = null;
  target.remove();
  vi.restoreAllMocks();
});

describe('ConversationTile - pending join ask preview', () => {
  it('shows the ordinary preview when nothing is pending', () => {
    render();
    expect(target.textContent).toContain(m.chat_e2e_established_preview());
  });

  it('reads the ask while pending, with no badge, and the normal preview returns after', () => {
    raiseJoinRequest({ groupId: 'g1', requesterUserId: 'carol', requesterDeviceId: 'd1' });
    render();
    expect(target.textContent).toContain('Name(carol) veut rejoindre la conversation par lien');
    expect(target.querySelector('[aria-label]')?.getAttribute('aria-label') ?? '').not.toMatch(
      /non lu|unread/i
    );
    resetJoinRequests();
    flushSync();
    expect(target.textContent).toContain(m.chat_e2e_established_preview());
    expect(target.textContent).not.toContain('veut rejoindre');
  });
});
