// @vitest-environment happy-dom
/**
 * THE "MES NOTES" ROW IS DRAWN ONLY WHEN IT CAN BE OPENED. `MainChatPage` hands the sidebar
 * `onOpenSelfConversation` only once the session is signed in, as it does `onMarkCommunityRead`:
 * the logged-out preview (F1) has no account to hold notes, so the row is not drawn there.
 */
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';

// Same import-cycle break as `Sidebar.creationRefusal.svelte.test.ts`.
vi.mock('$lib/stores/globalChatSingleton.svelte', async () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: (await import('./globalChannelsStub')).globalChannelsStub(),
  globalNotifs: {},
}));

vi.mock('$lib/components/shared/Avatar.svelte', () => ({ default: () => {} }));

import { flushSync, mount, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import Sidebar from './Sidebar.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

const mounted: (() => void)[] = [];
afterAll(adoptTransitionAnimations());
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function mountSidebar(onOpenSelfConversation?: () => void) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Sidebar, {
    target,
    props: {
      conversations: new SvelteMap<string, Conversation>(),
      selectedContact: null,
      onAddContact: async () => ({ ok: true }) as never,
      onCreateGroup: async () => ({ ok: true }) as never,
      onSelectConversation: () => {},
      ...(onOpenSelfConversation ? { onOpenSelfConversation } : {}),
      currentUserId: 'me',
    },
  });
  mounted.push(() => unmount(app));
  flushSync();
}

const selfRow = () => document.querySelector('[data-self-conversation-row]');

describe('the "Mes notes" row', () => {
  it('is drawn when the sidebar can open it - a signed-in session', () => {
    mountSidebar(vi.fn());
    expect(selfRow()).not.toBeNull();
  });

  it('is not drawn without the handler - the logged-out preview', () => {
    mountSidebar();
    expect(selfRow()).toBeNull();
  });
});
