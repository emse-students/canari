// @vitest-environment happy-dom
/**
 * "MARQUER TOUT COMME LU" ON A COMMUNITY ICON (user, 2026-10-13): a long press under a finger, a
 * right click with a mouse, as on Discord. The rail is a `svelte-dnd-action` zone too, so what is
 * worth pinning is the boundary with the reorder: a hold the drag took opens nothing, a hold that
 * becomes a drag closes the menu, and the click that ends a hold never switches community.
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
import { TRIGGERS } from 'svelte-dnd-action';
import type { Conversation } from '$lib/types';
import Sidebar from './Sidebar.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import { LONG_PRESS_MS } from '$lib/actions/longPress';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];
afterAll(adoptTransitionAnimations());
afterEach(() => {
  vi.useRealTimers();
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const alpha = {
  id: 'w1',
  name: 'Alpha',
  avatarUserId: 'u',
  channels: [
    { id: 'channel_a1', name: 'general' },
    { id: 'channel_a2', name: 'random' },
  ],
};
const beta = { id: 'w2', name: 'Beta', avatarUserId: 'u', channels: [] };

function mountRail(conversations = new SvelteMap<string, Conversation>(), withHandler = true) {
  const onMarkCommunityRead = vi.fn();
  const onSelectCommunity = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Sidebar, {
    target,
    props: {
      viewMode: 'communities',
      conversations,
      channelWorkspaces: [alpha, beta],
      selectedContact: null,
      newContactInput: '',
      newGroupInput: '',
      onContactInputChange: () => {},
      onGroupInputChange: () => {},
      onAddContact: async () => ({ ok: true }) as never,
      onCreateGroup: async () => ({ ok: true }) as never,
      onSelectConversation: () => {},
      onSelectCommunity,
      ...(withHandler ? { onMarkCommunityRead } : {}),
      currentUserId: 'me',
    },
  });
  mounted.push(() => unmount(app));
  flushSync();
  return { onMarkCommunityRead, onSelectCommunity };
}

const railButton = (name: string) =>
  Array.from(document.querySelectorAll('button')).find((b) =>
    b.getAttribute('aria-label')?.startsWith(name)
  )!;
const menu = () => document.querySelector<HTMLElement>('[data-community-menu]');
const markItem = () => menu()?.querySelector<HTMLButtonElement>('[role="menuitem"]') ?? null;
const railZone = () => railButton('Alpha').parentElement!.parentElement!;

function rightClick(el: Element) {
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  flushSync();
}

function touchHold(el: Element) {
  vi.useFakeTimers();
  el.dispatchEvent(
    Object.assign(new Event('pointerdown', { bubbles: true }), {
      pointerType: 'touch',
      button: 0,
      clientX: 0,
      clientY: 0,
    })
  );
  vi.advanceTimersByTime(LONG_PRESS_MS + 20);
  flushSync();
}

function unread(): SvelteMap<string, Conversation> {
  return new SvelteMap([['channel_a2', { id: 'channel_a2', unreadCount: 3 } as Conversation]]);
}

describe('community rail menu', () => {
  it('a right click opens it, and picking the entry marks THAT community, once', () => {
    const { onMarkCommunityRead, onSelectCommunity } = mountRail(unread());
    rightClick(railButton('Alpha'));

    expect(menu()?.getAttribute('aria-label')).toBe(
      m.sidebar_community_menu_label({ name: 'Alpha' })
    );
    expect(markItem()?.textContent?.trim()).toBe(m.sidebar_community_mark_read());
    expect(markItem()?.getAttribute('aria-disabled')).toBe('false');

    markItem()!.click();
    flushSync();
    expect(onMarkCommunityRead).toHaveBeenCalledExactlyOnceWith('w1');
    expect(menu()).toBeNull();
    expect(onSelectCommunity).not.toHaveBeenCalled();
  });

  it('a touch hold opens it, and the click ending the hold does not switch community', () => {
    const { onSelectCommunity } = mountRail(unread());
    touchHold(railButton('Beta'));
    expect(menu()?.getAttribute('aria-label')).toBe(
      m.sidebar_community_menu_label({ name: 'Beta' })
    );

    // What `svelte-dnd-action` dispatches on `touchend` for a zone that prevented the touchstart.
    railButton('Beta').dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
    flushSync();
    expect(onSelectCommunity).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it('offers the entry greyed and inert when nothing in the community is unread', () => {
    const { onMarkCommunityRead } = mountRail();
    rightClick(railButton('Beta'));
    expect(markItem()?.getAttribute('aria-disabled')).toBe('true');
    markItem()!.click();
    flushSync();
    expect(onMarkCommunityRead).not.toHaveBeenCalled();
  });

  it('a hold the drag already took opens nothing', () => {
    mountRail(unread());
    railZone().dispatchEvent(
      new CustomEvent('consider', {
        detail: { items: [alpha, beta], info: { trigger: TRIGGERS.DRAG_STARTED, id: 'w1' } },
      })
    );
    touchHold(railButton('Alpha'));
    expect(menu()).toBeNull();
  });

  it('a hold that becomes a drag closes the menu - it is a reorder now', () => {
    mountRail(unread());
    touchHold(railButton('Alpha'));
    expect(menu()).not.toBeNull();
    railZone().dispatchEvent(
      new CustomEvent('consider', {
        detail: { items: [alpha, beta], info: { trigger: TRIGGERS.DRAG_STARTED, id: 'w1' } },
      })
    );
    flushSync();
    expect(menu()).toBeNull();
  });

  it('Escape closes it, from the focused entry, and hands focus back to the icon', () => {
    mountRail(unread());
    rightClick(railButton('Alpha'));
    // The keyboard lands in the menu, so Escape comes from the entry and bubbles to the menu.
    expect(document.activeElement).toBe(markItem());
    markItem()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(railButton('Alpha'));
  });

  it('is not offered where no handler is wired', () => {
    mountRail(unread(), false);
    rightClick(railButton('Alpha'));
    expect(menu()).toBeNull();
    expect(railButton('Alpha').hasAttribute('aria-haspopup')).toBe(false);
  });
});
