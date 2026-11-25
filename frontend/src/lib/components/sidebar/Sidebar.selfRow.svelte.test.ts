// @vitest-environment happy-dom
/**
 * THE "MES NOTES" ROW IS DRAWN ONLY WHEN IT CAN BE OPENED. `MainChatPage` hands the sidebar
 * `onOpenSelfConversation` only once the session is signed in, as it does `onMarkCommunityRead`:
 * the logged-out preview (F1) has no account to hold notes, so the row is not drawn there.
 */
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';

// The own profile name, which a test makes arrive AFTER the first render.
const ownProfile = vi.hoisted(() => ({ resolve: (_name: string) => {} }));
vi.mock('$lib/utils/users/displayName', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/users/displayName')>();
  return {
    ...actual,
    resolveUserDisplayName: (id: string) =>
      id === 'me'
        ? new Promise<string>((resolve) => {
            ownProfile.resolve = resolve;
          })
        : actual.resolveUserDisplayName(id),
  };
});

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
import * as m from '$lib/paraglide/messages';
import { seedUserDisplayName } from '$lib/utils/users/displayName';
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import {
  buildConversationRow,
  restoredConversationRow,
  selfConversationIdentity,
  toConversationMeta,
} from '$lib/utils/chat/conversations';
import Sidebar from './Sidebar.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

const mounted: (() => void)[] = [];
afterAll(adoptTransitionAnimations());
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

/**
 * A held conversation whose last activity is `at`. A self row is built the way a RESTORED session
 * builds it - stored as meta, read back - so it carries no name of its own (`name: ''`) and is
 * keyed by its group id, like the real one: a hand-made `name: id` hid the #4100 regression.
 */
function row(id: string, type: 'direct' | 'self', at: number): Conversation {
  if (type === 'self') {
    const built = {
      ...buildConversationRow({ id, lifecycle: 'active', identity: selfConversationIdentity() }),
      lastMessageAt: at,
    };
    return restoredConversationRow(toConversationMeta(id, built, 'me'), 'me');
  }
  return {
    id,
    name: id,
    contactName: id,
    conversationType: type,
    ...(type === 'direct' ? { directPeerId: id } : {}),
    messages: [],
    lifecycle: 'active',
    mlsStateHex: null,
    unreadCount: 0,
    lastMessageAt: at,
  } as Conversation;
}

function mountSidebar(
  onOpenSelfConversation?: () => void,
  rows: Conversation[] = [],
  map = new SvelteMap<string, Conversation>(rows.map((r) => [r.id, r]))
) {
  for (const id of ['alice', 'bob']) seedUserDisplayName(id, id, id);
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Sidebar, {
    target,
    props: {
      conversations: map,
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
  return target;
}

/** Types `value` into the sidebar's search box. */
function search(target: HTMLElement, value: string) {
  const input = target.querySelector('input') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

/** The ids of the drawn rows, top to bottom: the self row reads "self", a held one by its tile. */
const order = (target: HTMLElement) =>
  [...target.querySelectorAll('[data-conversation-tile]')].map((el) =>
    el.closest('[data-self-conversation-row]') ? 'self' : el.getAttribute('data-conversation-tile')
  );

const selfRow = () => document.querySelector('[data-self-conversation-row]');

describe('the "Mes notes" row', () => {
  it('is drawn when the sidebar can open it - a signed-in session', () => {
    mountSidebar(vi.fn());
    expect(selfRow()).not.toBeNull();
  });

  it('shows the own name and the suffix, no longer the old label and its icon', () => {
    mountSidebar(vi.fn());
    expect(selfRow()?.textContent).toContain('(Notes)');
    expect(selfRow()?.textContent).not.toContain('Mes notes');
    expect(selfRow()?.querySelector('svg.lucide-bookmark')).toBeNull();
  });

  it('repaints when the own profile name arrives after the first render', async () => {
    mountSidebar(vi.fn());
    expect(selfRow()?.textContent).not.toContain('Camille DUPONT');
    // the first frame is never " (Notes)" with an empty name
    expect(selfRow()?.textContent?.trimStart().startsWith('(Notes)')).toBe(false);
    ownProfile.resolve('Camille DUPONT');
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(selfRow()?.textContent).toContain('Camille DUPONT (Notes)');
  });

  it('is not drawn without the handler - the logged-out preview', () => {
    mountSidebar();
    expect(selfRow()).toBeNull();
  });

  describe('its place is its recency, like every other conversation (owner, 2026-11-25)', () => {
    it('sorts BELOW a DM with newer activity', () => {
      const t = mountSidebar(vi.fn(), [row('notes', 'self', 100), row('alice', 'direct', 200)]);
      expect(order(t)).toEqual(['alice', 'self']);
    });

    it('sorts ABOVE a DM with older activity', () => {
      const t = mountSidebar(vi.fn(), [row('notes', 'self', 300), row('alice', 'direct', 200)]);
      expect(order(t)).toEqual(['self', 'alice']);
    });

    it('is drawn LAST while this device holds none, and only once', () => {
      const t = mountSidebar(vi.fn(), [row('alice', 'direct', 200), row('bob', 'direct', 100)]);
      expect(order(t)).toEqual(['alice', 'bob', 'self']);
    });

    it('is found by "notes", held or not, and hidden by a query that is not its own', () => {
      const held = mountSidebar(vi.fn(), [row('notes', 'self', 100), row('alice', 'direct', 200)]);
      const search = held.querySelector('input') as HTMLInputElement;
      search.value = 'notes';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      flushSync();
      expect(order(held)).toEqual(['self']);
      search.value = 'zzz';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      flushSync();
      expect(order(held)).toEqual([]);
    });
    it('draws a RESTORED held row, keyed by its group id and nameless, in its recency place', () => {
      const notes = row('e4c1f0aa-0000-4000-8000-00000000005e', 'self', 300);
      expect(notes.name).toBe('');
      const t = mountSidebar(vi.fn(), [
        row('alice', 'direct', 200),
        notes,
        row('bob', 'direct', 400),
      ]);
      expect(order(t)).toEqual(['bob', 'self', 'alice']);
      expect(t.querySelectorAll('[data-self-conversation-row]')).toHaveLength(1);
      search(t, 'notes');
      expect(order(t)).toEqual(['self']);
      expect(t.textContent).not.toContain(m.chat_no_discussion_found());
    });

    it('replaces the placeholder when the row is created late, with no duplicate', () => {
      const rows = new SvelteMap<string, Conversation>([['alice', row('alice', 'direct', 200)]]);
      const t = mountSidebar(vi.fn(), [], rows);
      expect(order(t)).toEqual(['alice', 'self']);
      rows.set('notes', row('notes', 'self', 300));
      flushSync();
      expect(order(t)).toEqual(['self', 'alice']);
    });

    it('draws the placeholder when the only self row is removed', () => {
      const gone = { ...row('notes', 'self', 300), lifecycle: 'removed' } as Conversation;
      const t = mountSidebar(vi.fn(), [gone, row('alice', 'direct', 200)]);
      expect(order(t)).toEqual(['alice', 'self']);
      expect(t.querySelectorAll('[data-self-conversation-row]')).toHaveLength(1);
    });

    it('draws one row when two self groups are held', () => {
      const t = mountSidebar(vi.fn(), [row('n1', 'self', 300), row('n2', 'self', 100)]);
      expect(t.querySelectorAll('[data-self-conversation-row]')).toHaveLength(1);
    });

    it('hides the placeholder for a query that is not its own', () => {
      const t = mountSidebar(vi.fn());
      search(t, 'zzz');
      expect(order(t)).toEqual([]);
    });

    it('says "no discussion found" for a miss, but not beside the placeholder of "notes"', () => {
      const t = mountSidebar(vi.fn());
      expect(t.textContent).toContain(m.sidebar_no_conversations_title());
      search(t, 'notes');
      expect(order(t)).toEqual(['self']);
      expect(t.textContent).not.toContain(m.chat_no_discussion_found());
      search(t, 'zzz');
      expect(t.textContent).toContain(m.chat_no_discussion_found());
    });
  });
});
