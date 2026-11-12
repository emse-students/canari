// @vitest-environment happy-dom
/**
 * A tile watches the presence of the peer it SHOWS, not the one it mounted with (review of #2618,
 * 2026-10-27): a reused tile or a peer resolved after mount moves its watch with the props.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { writable } from 'svelte/store';

const presence = vi.hoisted(() => ({
  watchUsers: vi.fn(),
  unwatchUsers: vi.fn(),
}));

vi.mock('$lib/stores/presenceStore', () => ({
  presenceMap: writable({}),
  watchUsers: presence.watchUsers,
  unwatchUsers: presence.unwatchUsers,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplay: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplay: () => {},
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `Name(${id})`,
  resolveUserDisplayName: async (id: string) => `Name(${id})`,
}));

import ConversationTile from './ConversationTile.svelte';

let target: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  target = document.createElement('div');
  document.body.appendChild(target);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  presence.watchUsers.mockClear();
  presence.unwatchUsers.mockClear();
});

afterEach(() => {
  if (app) unmount(app);
  app = null;
  target.remove();
  vi.restoreAllMocks();
});

describe('ConversationTile presence watch', () => {
  it('moves the watch when the peer changes, releasing the one it watched', () => {
    const props = $state({
      conversationId: 'dm-1',
      contactName: 'peer-a',
      displayName: 'Peer',
      conversationType: 'direct' as const,
      isReady: true,
      isSelected: false,
      unreadCount: 0,
      onClick: () => {},
    });
    app = mount(ConversationTile, { target, props });
    flushSync();
    expect(presence.watchUsers).toHaveBeenLastCalledWith(['peer-a']);

    props.contactName = 'peer-b';
    flushSync();

    expect(presence.unwatchUsers).toHaveBeenCalledWith(['peer-a']);
    expect(presence.watchUsers).toHaveBeenLastCalledWith(['peer-b']);
  });

  it('watches nobody for a group tile', () => {
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
    expect(presence.watchUsers).not.toHaveBeenCalled();
  });
});
