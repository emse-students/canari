// @vitest-environment happy-dom
/**
 * A SALON ROW PRESSED PAST THE REORDER HOLD AND RELEASED IN PLACE OPENS THE SALON.
 *
 * For whoever may reorder the list, `svelte-dnd-action` turns a touch held 350 ms into a drag with no
 * movement at all, and the browser's click never reaches the row it lifted. Measured on the iPhone 12
 * bench (2026-10-12): every hold of 400 ms or more opened nothing. The zone's own events are what the
 * Sidebar reads, so they are what this test feeds it - the placeholder that never left its index is
 * a tap, the one that moved is a reorder.
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
import { SHADOW_ITEM_MARKER_PROPERTY_NAME, TRIGGERS } from 'svelte-dnd-action';
import type { Conversation } from '$lib/types';
import Sidebar from './Sidebar.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

const mounted: (() => void)[] = [];
afterAll(adoptTransitionAnimations());
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const general = { id: 'channel_g', name: 'general' };
const infos = { id: 'channel_i', name: 'infos' };
const tract = { id: 'channel_t', name: 'tract' };
const shadow = { id: 'id:dnd-shadow-placeholder-0000', [SHADOW_ITEM_MARKER_PROPERTY_NAME]: true };

function mountList() {
  const onSelectChannelConversation = vi.fn();
  const onReorderChannels = vi.fn();
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
          viewerCanManageChannels: true,
          channels: [general, infos, tract],
        },
      ],
      selectedContact: null,
      newContactInput: '',
      newGroupInput: '',
      onContactInputChange: () => {},
      onGroupInputChange: () => {},
      onAddContact: async () => ({ ok: true }) as never,
      onCreateGroup: async () => ({ ok: true }) as never,
      onSelectConversation: () => {},
      onSelectChannelConversation,
      onReorderChannels,
      currentUserId: 'me',
    },
  });
  mounted.push(() => unmount(app));
  flushSync();
  const zone = document.querySelector('[data-channel-row="infos"]')!.parentElement!;
  return { zone, onSelectChannelConversation, onReorderChannels };
}

/** One event of the zone, shaped as `svelte-dnd-action` dispatches it. */
function fire(zone: Element, type: 'consider' | 'finalize', items: object[], trigger: string) {
  zone.dispatchEvent(
    new CustomEvent(type, {
      detail: { items, info: { trigger, id: infos.id, source: 'pointer' } },
    })
  );
  flushSync();
}

describe('a salon row pressed past the reorder hold', () => {
  it('opens the salon when released where it was, and persists no order', () => {
    const { zone, onSelectChannelConversation, onReorderChannels } = mountList();
    fire(zone, 'consider', [general, shadow, tract], TRIGGERS.DRAG_STARTED);
    fire(zone, 'consider', [general, shadow, tract], TRIGGERS.DRAGGED_ENTERED);
    fire(zone, 'finalize', [general, infos, tract], TRIGGERS.DROPPED_INTO_ZONE);

    expect(onSelectChannelConversation).toHaveBeenCalledExactlyOnceWith(infos.id);
    expect(onReorderChannels).not.toHaveBeenCalled();
  });

  it('reorders, and opens nothing, when the row was carried somewhere - even back home', () => {
    const { zone, onSelectChannelConversation, onReorderChannels } = mountList();
    fire(zone, 'consider', [general, shadow, tract], TRIGGERS.DRAG_STARTED);
    fire(zone, 'consider', [general, tract, shadow], TRIGGERS.DRAGGED_OVER_INDEX);
    fire(zone, 'consider', [general, shadow, tract], TRIGGERS.DRAGGED_OVER_INDEX);
    fire(zone, 'finalize', [general, infos, tract], TRIGGERS.DROPPED_INTO_ZONE);

    expect(onSelectChannelConversation).not.toHaveBeenCalled();
    expect(onReorderChannels).toHaveBeenCalledExactlyOnceWith('w1', [general, infos, tract]);
  });

  it('reorders when the row left the list before coming back', () => {
    const { zone, onSelectChannelConversation, onReorderChannels } = mountList();
    fire(zone, 'consider', [general, shadow, tract], TRIGGERS.DRAG_STARTED);
    fire(zone, 'consider', [general, tract], TRIGGERS.DRAGGED_LEFT);
    fire(zone, 'consider', [general, shadow, tract], TRIGGERS.DRAGGED_LEFT_ALL);
    fire(zone, 'finalize', [general, infos, tract], TRIGGERS.DROPPED_OUTSIDE_OF_ANY);

    expect(onSelectChannelConversation).not.toHaveBeenCalled();
    expect(onReorderChannels).toHaveBeenCalledOnce();
  });
});

/**
 * ENTER ON A FOCUSED SALON ROW OPENED NOTHING for whoever may reorder the list: the row is the
 * zone's draggable and the library claims Enter and Space for its keyboard drag, cancelling the
 * button's activation. The keyboard reorder is Alt + arrows and must keep working.
 */
describe('a salon row driven from the keyboard', () => {
  function key(el: Element, init: KeyboardEventInit): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(e);
    flushSync();
    return e;
  }

  it('leaves Enter and Space to the button, so the salon opens', () => {
    mountList();
    const row = document.querySelector('[data-channel-row="infos"]')!;
    expect(key(row, { key: 'Enter' }).defaultPrevented).toBe(false);
    expect(key(row, { key: ' ' }).defaultPrevented).toBe(false);
  });

  it('still reorders with Alt + arrows', () => {
    const { onReorderChannels } = mountList();
    const row = document.querySelector('[data-channel-row="infos"]')!;
    key(row, { key: 'ArrowUp', altKey: true });
    expect(onReorderChannels).toHaveBeenCalledExactlyOnceWith('w1', [infos, general, tract]);
  });
});
