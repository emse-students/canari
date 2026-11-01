// @vitest-environment happy-dom
/**
 * A PERSON SEEN IN A CONVERSATION OPENS THEIR PROFILE (owner, 2026-11-01), FROM THREE PLACES: the
 * sender of a message (avatar and name), a row of a members list, and the header of a direct
 * conversation. Each is a real link or a labelled button, so a keyboard reaches it, and each leaves
 * what already lived there alone: a bubble's own tap, a row's remove control, the settings.
 *
 * An account the server answered does not exist gets no link at all.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import { writable } from 'svelte/store';

const nav = vi.hoisted(() => ({ goto: vi.fn() }));
const chrome = vi.hoisted(() => ({ app: true }));

vi.mock('$app/navigation', () => ({ goto: nav.goto }));
// The shared stub ignores route params; the hrefs are what is asserted here.
vi.mock('$app/paths', () => ({
  resolve: (route: string, params?: Record<string, string>) =>
    route.replace(/\[(\w+)\]/g, (_, k: string) => params?.[k] ?? ''),
}));
vi.mock('$lib/mobile/glassChrome', () => ({ usesGlassChrome: () => chrome.app }));
vi.mock('$lib/stores/presenceStore', () => ({
  presenceMap: writable({}),
  watchUsers: () => {},
  unwatchUsers: () => {},
}));
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  getUserDisplayNameSync: (_id: string, fallback?: string) => fallback ?? 'Someone',
  getUserFirstNameSync: (_id: string, fallback: string) => fallback,
  resolveUserDisplayName: async () => null,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))),
}));
vi.mock('$lib/services/ChannelService', () => ({
  channelService: {
    listMembers: async () => [
      { id: 'm1', userId: 'alice', role: 'member', joinedAt: '' },
      { id: 'm2', userId: 'ghost', role: 'member', joinedAt: '' },
    ],
  },
}));
// The family-name order waits for every profile to settle; the order is not what this file asserts.
vi.mock('$lib/utils/users/memberOrder.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/memberOrder.svelte')>()),
  membersByFamilyName: (ids: () => string[]) => ({
    get current() {
      return ids();
    },
  }),
}));
vi.mock('../messages/MessageBubble.svelte', () => ({ default: () => {} }));

import { forgetAbsentUsers, noteAbsentUser } from '$lib/utils/users/absentUsers';
import ChatHeader from './ChatHeader.svelte';
import ChatGroupPanel from './ChatGroupPanel.svelte';
import ChannelMembersList from './ChannelMembersList.svelte';
import ChatMessageGroups from './ChatMessageGroups.svelte';
import type { ChatMessage } from '$lib/types';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
afterEach(() => {
  forgetAbsentUsers();
  chrome.app = true;
  nav.goto.mockClear();
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

async function render(component: unknown, props: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(component as never, { target, props });
  mounted.push(() => void unmount(app));
  await tick();
  flushSync();
  return target;
}

const links = (root: ParentNode, id: string) => [
  ...root.querySelectorAll<HTMLAnchorElement>(`a[href="/profile/${id}"]`),
];

function message(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'msg-1',
    senderId: 'alice',
    content: 'hi',
    timestamp: new Date('2026-11-01T10:00:00Z'),
    isOwn: false,
    isSystem: false,
    ...over,
  } as ChatMessage;
}

const groupsProps = (messages: ChatMessage[]) => ({
  visibleMessageGroups: messages.map((message) => ({ type: 'message' as const, message })),
  switchTime: 0,
  authToken: 't',
  currentUserId: 'me',
});

describe('a message in a conversation', () => {
  it('links the sender avatar AND the sender name to the profile, as real anchors', async () => {
    const root = await render(ChatMessageGroups, groupsProps([message({})]));
    const found = links(root, 'alice');
    expect(found).toHaveLength(2);
    expect(root.querySelector('[data-profile-link="alice"]')?.getAttribute('aria-label')).toMatch(
      /profil|profile/i
    );
    expect(root.querySelector('[data-sender-profile-link="alice"]')).not.toBeNull();
  });

  it('draws no link on your own message', async () => {
    const root = await render(
      ChatMessageGroups,
      groupsProps([message({ senderId: 'me', isOwn: true })])
    );
    expect(root.querySelectorAll('a[href^="/profile/"]')).toHaveLength(0);
  });

  it('draws no link for an account the server says is gone', async () => {
    noteAbsentUser('alice');
    const root = await render(ChatMessageGroups, groupsProps([message({})]));
    expect(root.querySelectorAll('a[href^="/profile/"]')).toHaveLength(0);
  });
});

describe('the members of a group', () => {
  const props = {
    effectiveDisplayName: 'Team',
    contactName: 'team',
    isGroupConversation: true,
    currentUserId: 'me',
    groupMembers: ['me', 'alice'],
    onClose: () => {},
    onRemoveMember: () => {},
  };

  it('links the avatar and the name of each row, and keeps the remove control', async () => {
    const root = await render(ChatGroupPanel, props);
    expect(links(root, 'alice').length).toBe(2);
    expect(root.querySelector('button[data-remove-member="alice"]')).not.toBeNull();
    // Your own row has no remove control and still opens your profile.
    expect(root.querySelector('button[data-remove-member="me"]')).toBeNull();
  });

  it('withdraws the link of a gone account', async () => {
    noteAbsentUser('alice');
    const root = await render(ChatGroupPanel, props);
    expect(links(root, 'alice')).toHaveLength(0);
  });
});

describe('the members of a community salon', () => {
  it('links the avatar and name from the ids alone, and skips a gone account', async () => {
    noteAbsentUser('ghost');
    const root = await render(ChannelMembersList, { selectedChannelId: 'c1', currentUserId: 'me' });
    expect(links(root, 'alice')).toHaveLength(2);
    expect(links(root, 'ghost')).toHaveLength(0);
  });
});

describe('the header of a direct conversation', () => {
  const props = {
    contactName: 'alice',
    displayName: 'Alice',
    isReady: true,
    isGroupConversation: false,
    onOpenSettings: vi.fn(),
    onBack: vi.fn(),
  };

  it('website: avatar and name are links, and the settings gear is still there', async () => {
    chrome.app = false;
    const root = await render(ChatHeader, props);
    const header = root.querySelector('header')!;
    expect(links(header, 'alice').length).toBe(2);
    expect(header.querySelector('button[aria-label="Paramètres de la discussion"]')).not.toBeNull();
  });

  it('phone: the centre pill opens the profile, the menu still holds the settings', async () => {
    const root = await render(ChatHeader, props);
    const pill = root.querySelector('.chat-header-phone [data-glass-title]')!
      .parentElement as HTMLButtonElement;
    pill.click();
    expect(nav.goto).toHaveBeenCalledWith('/profile/alice');
    expect(props.onOpenSettings).not.toHaveBeenCalled();
    (
      root.querySelector('.chat-header-phone button[aria-label="Plus d\'actions"]') as HTMLElement
    ).click();
    flushSync();
    const menu = [...document.querySelectorAll('[role="menu"] button')].map((b) =>
      b.textContent!.trim()
    );
    expect(menu).toContain('Paramètres');
  });

  it('phone: a group keeps the pill on the settings', async () => {
    const onOpenSettings = vi.fn();
    const root = await render(ChatHeader, {
      ...props,
      isGroupConversation: true,
      onOpenSettings,
    });
    (
      root.querySelector('.chat-header-phone [data-glass-title]')!.parentElement as HTMLElement
    ).click();
    expect(onOpenSettings).toHaveBeenCalled();
    expect(nav.goto).not.toHaveBeenCalled();
  });

  it('phone: a gone peer falls back to the settings', async () => {
    noteAbsentUser('alice');
    const onOpenSettings = vi.fn();
    const root = await render(ChatHeader, { ...props, onOpenSettings });
    (
      root.querySelector('.chat-header-phone [data-glass-title]')!.parentElement as HTMLElement
    ).click();
    expect(onOpenSettings).toHaveBeenCalled();
    expect(nav.goto).not.toHaveBeenCalled();
  });
});
