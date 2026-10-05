/**
 * THE COMMUNITY RAIL SHOWS A DOT WHEN ANY SALON OF A COMMUNITY HAS UNREAD MESSAGES.
 *
 * It reads the per-salon `unreadCount` the salon rows already read, so the dot must appear on an
 * incoming message, clear when the count returns to zero, and be spoken through the button's label
 * (the dot itself is decorative).
 */
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';

// Same import-cycle break as `Sidebar.creationRefusal.svelte.test.ts`.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

import { flushSync, mount, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import Sidebar from './Sidebar.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];
afterAll(adoptTransitionAnimations());
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const workspaces = [
  {
    id: 'w1',
    name: 'Alpha',
    avatarUserId: 'u',
    channels: [
      { id: 'channel-a1', name: 'general' },
      { id: 'channel-a2', name: 'random' },
    ],
  },
  { id: 'w2', name: 'Beta', avatarUserId: 'u', channels: [{ id: 'channel-b1', name: 'general' }] },
];

function mountRail(conversations: SvelteMap<string, Conversation>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Sidebar, {
    target,
    props: {
      viewMode: 'communities',
      conversations,
      channelWorkspaces: workspaces,
      selectedContact: null,
      newContactInput: '',
      newGroupInput: '',
      onContactInputChange: () => {},
      onGroupInputChange: () => {},
      onAddContact: async () => ({ ok: true }) as never,
      onCreateGroup: async () => ({ ok: true }) as never,
      onSelectConversation: () => {},
      currentUserId: 'me',
    },
  });
  mounted.push(() => unmount(app));
  flushSync();
}

const railButton = (name: string) =>
  Array.from(document.querySelectorAll('button')).find((b) =>
    b.getAttribute('aria-label')?.startsWith(name)
  )!;

const dots = () => document.querySelectorAll('[data-community-unread-dot]');

describe('community rail unread dot', () => {
  it('shows no dot when nothing is unread', () => {
    mountRail(new SvelteMap());
    expect(dots().length).toBe(0);
    expect(railButton('Alpha').getAttribute('aria-label')).toBe('Alpha');
  });

  it('lights only the community with an unread salon, live, and clears it when read', () => {
    const conversations = new SvelteMap<string, Conversation>();
    mountRail(conversations);

    conversations.set('channel-a2', { id: 'channel-a2', unreadCount: 3 } as Conversation);
    flushSync();
    expect(dots().length).toBe(1);
    expect(railButton('Alpha').getAttribute('aria-label')).toBe(
      `Alpha, ${m.sidebar_community_unread_label()}`
    );
    expect(railButton('Beta').getAttribute('aria-label')).toBe('Beta');
    expect(dots()[0].getAttribute('aria-hidden')).toBe('true');

    conversations.set('channel-a2', { id: 'channel-a2', unreadCount: 0 } as Conversation);
    flushSync();
    expect(dots().length).toBe(0);
  });
});
