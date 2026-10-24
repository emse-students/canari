// @vitest-environment happy-dom
/**
 * ONE TAP ON A SALON ROW IS ONE CLICK - THE BROWSER'S - AND ONE ACTIVATION.
 *
 * Reported 2026-10-13 (and on the Pixel 6a 2026-10-08): tapping a salon also opened the read
 * receipts, a profile or a like on the message that the salon put under the finger. Measured on the
 * Mi 9T with an OS tap, for whoever may reorder the list: `svelte-dnd-action` dispatched its OWN
 * click (a plain `Event`) on `touchend`, the row opened the salon, then the browser's click arrived
 * at the new layout and hit the message. The library's click exists for the zone whose `touchstart`
 * it prevents (the browser then sends none); on the `delayTouchStart` path it prevents nothing, so
 * the browser's click comes too and the library's is a second click on the same tap. The patch in
 * `frontend/patches/svelte-dnd-action@*.patch` keeps that click for the prevented path alone.
 *
 * happy-dom synthesises no click from a touch, so the browser's click is dispatched by hand, shaped
 * as Chromium sends it (`detail: 1`). The touch carries the one field the library reads.
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

const mounted: (() => void)[] = [];
afterAll(adoptTransitionAnimations());
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function mountList(viewerCanManageChannels: boolean) {
  const onSelectChannelConversation = vi.fn();
  const onSelectCommunity = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Sidebar, {
    target,
    props: {
      viewMode: 'communities',
      conversations: new SvelteMap<string, Conversation>(),
      channelWorkspaces: [
        {
          id: 'w1',
          name: 'Mines',
          avatarUserId: 'u',
          viewerCanManageChannels,
          channels: [
            { id: 'channel_g', name: 'general' },
            { id: 'channel_t', name: 'tract' },
          ],
        },
        { id: 'w2', name: 'Bureau', avatarUserId: 'u', channels: [] },
      ],
      selectedContact: null,
      selectedChannelId: 'channel_g',
      newContactInput: '',
      newGroupInput: '',
      onContactInputChange: () => {},
      onGroupInputChange: () => {},
      onAddContact: async () => ({ ok: true }) as never,
      onCreateGroup: async () => ({ ok: true }) as never,
      onSelectConversation: () => {},
      onSelectChannelConversation,
      onSelectCommunity,
      onReorderChannels: () => {},
      currentUserId: 'me',
    },
  });
  mounted.push(() => unmount(app));
  flushSync();
  return { onSelectChannelConversation, onSelectCommunity };
}

/** A touch event with the one field the library reads; happy-dom has no `TouchEvent`. */
function touch(target: Element, type: 'touchstart' | 'touchend') {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const list = type === 'touchstart' ? [{ clientX: 10, clientY: 10 }] : [];
  Object.defineProperty(e, 'touches', { value: list });
  Object.defineProperty(e, 'changedTouches', { value: [{ clientX: 10, clientY: 10 }] });
  target.dispatchEvent(e);
  return e;
}

/** A short tap as Chromium delivers it: the touch, then - unless prevented - the browser's click. */
function tap(target: Element) {
  const start = touch(target, 'touchstart');
  touch(target, 'touchend');
  flushSync();
  if (!start.defaultPrevented)
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  flushSync();
}

describe('one tap on a salon row', () => {
  it('opens the salon exactly once for whoever may reorder the list', () => {
    const { onSelectChannelConversation } = mountList(true);
    tap(document.querySelector('[data-channel-row="tract"]')!);
    expect(onSelectChannelConversation).toHaveBeenCalledExactlyOnceWith('channel_t');
  });

  it('opens nothing before the browser click: the touch alone dispatches no click', () => {
    const { onSelectChannelConversation } = mountList(true);
    const row = document.querySelector('[data-channel-row="tract"]')!;
    let clicks = 0;
    row.addEventListener('click', () => clicks++);
    touch(row, 'touchstart');
    touch(row, 'touchend');
    flushSync();
    expect(clicks).toBe(0);
    expect(onSelectChannelConversation).not.toHaveBeenCalled();
  });

  it('opens the salon exactly once for a member who cannot reorder it', () => {
    const { onSelectChannelConversation } = mountList(false);
    tap(document.querySelector('[data-channel-row="tract"]')!);
    expect(onSelectChannelConversation).toHaveBeenCalledExactlyOnceWith('channel_t');
  });
});

describe('one tap on a community of the rail', () => {
  // The rail's zone has no hold delay, the other shape the patch touches: whichever of the library
  // and the browser clicks, a tap must select the community once. (The open salon belongs to w1, so
  // w1 is already selected and the tap goes to w2.)
  it('selects the community exactly once', () => {
    const { onSelectCommunity } = mountList(true);
    tap(document.querySelector('button[title="Bureau"]')!);
    expect(onSelectCommunity).toHaveBeenCalledExactlyOnceWith('w2');
  });

  // A finger lands on the AVATAR, not on the button: the button is filled by it. The library skips a
  // touch only when its target has a `value` (the button itself), so on the avatar it prevents the
  // `touchstart`, the browser sends no click, and the library's click is the ONLY one - the path the
  // patch must keep.
  it('selects the community exactly once when the finger lands on its avatar', () => {
    const { onSelectCommunity } = mountList(true);
    const avatar = document.querySelector('button[title="Bureau"]')!.firstElementChild!;
    expect(avatar).not.toBeNull();
    const start = touch(avatar, 'touchstart');
    expect(start.defaultPrevented).toBe(true);
    touch(avatar, 'touchend');
    flushSync();
    expect(onSelectCommunity).toHaveBeenCalledExactlyOnceWith('w2');
  });
});
