// @vitest-environment happy-dom
/**
 * A MEMBER SEES THAT AN ASK EXISTS FROM THE LIST: the tile carries a small count of the people asking
 * to join its conversation. Client-only, derived from the same store as the card in the thread, so
 * it appears and leaves with the ask - and the preview stays the last message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `Name(${id})`,
  resolveUserDisplayName: async (id: string) => `Name(${id})`,
}));

import ConversationTile from './ConversationTile.svelte';
import {
  raiseJoinRequest,
  resetJoinRequests,
  setJoinRequestHandlers,
  settleJoinRequest,
} from '$lib/utils/chat/joinRequests.svelte';
import { m } from '$lib/paraglide/messages';

let target: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

function render(conversationId = 'g1') {
  app = mount(ConversationTile, {
    target,
    props: {
      conversationId,
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

const badge = () => target.querySelector('[data-join-asks]');

beforeEach(() => {
  target = document.createElement('div');
  document.body.appendChild(target);
  resetJoinRequests();
  setJoinRequestHandlers({ approve: vi.fn(), decline: vi.fn() });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  if (app) unmount(app);
  app = null;
  target.remove();
  setJoinRequestHandlers(null);
  vi.restoreAllMocks();
});

describe('ConversationTile - pending join asks', () => {
  it('shows nothing when nobody asks', () => {
    render();
    expect(badge()).toBeNull();
  });

  it('counts the people asking to join THIS conversation, and no other', () => {
    raiseJoinRequest({ groupId: 'g1', requesterUserId: 'carol', requesterDeviceId: 'd1' });
    raiseJoinRequest({ groupId: 'g1', requesterUserId: 'erin', requesterDeviceId: 'd1' });
    raiseJoinRequest({ groupId: 'other', requesterUserId: 'dave', requesterDeviceId: 'd1' });
    render();

    expect(badge()!.textContent!.trim()).toBe('2');
    expect(badge()!.getAttribute('aria-label')).toBe(
      m.join_request_pending_badge_label({ count: 2 })
    );
  });

  it('counts a person once, whatever the number of their devices', () => {
    raiseJoinRequest({ groupId: 'g1', requesterUserId: 'carol', requesterDeviceId: 'd1' });
    raiseJoinRequest({ groupId: 'g1', requesterUserId: 'carol', requesterDeviceId: 'd2' });
    render();

    expect(badge()!.textContent!.trim()).toBe('1');
  });

  it('keeps the preview the last message, never the ask', () => {
    raiseJoinRequest({ groupId: 'g1', requesterUserId: 'carol', requesterDeviceId: 'd1' });
    render();

    expect(target.textContent).toContain(m.chat_e2e_established_preview());
    expect(target.textContent).not.toContain('veut rejoindre');
  });

  it('leaves with the ask when the server settles it', () => {
    raiseJoinRequest({
      groupId: 'g1',
      requesterUserId: 'carol',
      requesterDeviceId: 'd1',
      askId: 'a1',
    });
    render();
    expect(badge()).not.toBeNull();

    settleJoinRequest({ groupId: 'g1', userId: 'carol', askId: 'a1', outcome: 'admitted' });
    flushSync();

    expect(badge()).toBeNull();
  });

  it('shows nothing while nothing can answer, like the card', () => {
    setJoinRequestHandlers(null);
    raiseJoinRequest({ groupId: 'g1', requesterUserId: 'carol', requesterDeviceId: 'd1' });
    render();

    expect(badge()).toBeNull();
  });
});
