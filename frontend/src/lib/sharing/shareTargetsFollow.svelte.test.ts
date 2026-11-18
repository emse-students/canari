// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';

/**
 * WHEN the share sheet's suggestions are sent: a first sync, replayed on a live reactive map, sends
 * nothing while it runs and ONE list - the final one - when the member leaves the app. Measured
 * before: 23 publishes in one first sync (`1.7.0-alpha.12`, Mi 9T), each following an intermediate
 * state of the map.
 */
const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));
vi.mock('$lib/utils/appVersion', () => ({
  isAndroidTauriRuntime: () => true,
  isMobileTauriRuntime: () => true,
}));

const { followShareTargets } = await import('./shareTargetsFollow.svelte');
const { selectShareTargets } = await import('./shareTargets');
const { resetShareTargetsStateForTests } = await import('./shareTargetsNative');

const ME = '11111111-1111-4111-8111-111111111111';
const PUBLISH = 'plugin:gallery|publish_share_targets';
const CLEAR = 'plugin:gallery|clear_share_targets';

function row(id: string, name: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    name,
    contactName: name,
    messages: [],
    lifecycle: 'active',
    mlsStateHex: null,
    conversationType: 'group',
    ...extra,
  } as Conversation;
}

/** One real message sent at `at` - what a landed history brings. */
function said(at: number) {
  return [{ id: `m${at}`, senderId: 'peer', content: 'x', timestamp: at, serverTimestamp: at }];
}

function calls(cmd: string) {
  return invoke.mock.calls.filter(([c]) => c === cmd);
}

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
}

/** A live session: the stores the host reads, and the wiring under test. */
function session() {
  const conversations = new SvelteMap<string, Conversation>();
  const state = $state({ enabled: true, ready: false });
  let onChange: ((onScreen: boolean) => void) | null = null;
  const read = () => ({
    enabled: state.enabled,
    signedIn: true,
    conversationsReady: state.ready,
    conversations: () => conversations.entries(),
    currentUserId: ME,
    workspaces: () => [],
  });
  const destroy = $effect.root(() => {
    followShareTargets({
      enabled: () => state.enabled,
      read,
      subscribe: (cb) => {
        onChange = cb;
        return () => (onChange = null);
      },
    });
  });
  flushSync();
  return {
    conversations,
    state,
    destroy,
    /** Every change of the map is flushed, as the reactive graph would run it. */
    set(id: string, c: Conversation) {
      conversations.set(id, c);
      flushSync();
    },
    leave() {
      onChange?.(false);
    },
    back() {
      onChange?.(true);
    },
    final() {
      return selectShareTargets(conversations.entries(), ME, []);
    },
  };
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) =>
    cmd === PUBLISH ? { present: 5, leftover: 0 } : 0
  );
  resetShareTargetsStateForTests();
});

describe('a first sync', () => {
  it('sends nothing while it runs, then once - the final list - when the member leaves', async () => {
    const s = session();
    // Older conversations the restore brought, with their real last messages.
    for (let i = 0; i < 6; i++)
      s.set(`old${i}`, row(`old${i}`, `Ancien ${i}`, { messages: said(100 + i) } as never));
    // The sources settle - the gate the old effect opened on, mid-sync.
    s.state.ready = true;
    flushSync();
    // A new device's groups arrive one Welcome at a time: each row pending, then active and seeded
    // with the admission's time (near "now"), which puts it on top...
    const NOW = 10_000;
    for (let i = 0; i < 8; i++) {
      s.set(`g${i}`, row(`g${i}`, `g${i}`, { lifecycle: 'pending', lastMessageAt: NOW + i }));
      s.set(`g${i}`, row(`g${i}`, `Groupe ${i}`, { lastMessageAt: NOW + i }));
    }
    // ...then each one's history lands and it falls to its real place (mechanism A), some above the
    // restored ones and some below.
    for (let i = 0; i < 8; i++) {
      s.set(
        `g${i}`,
        row(`g${i}`, `Groupe ${i}`, {
          lastMessageAt: NOW + i,
          messages: said(i % 2 ? 50 + i : 200 + i),
        } as never)
      );
    }
    // A late relabel (mechanism C).
    s.set('g0', row('g0', 'Groupe zero', { messages: said(200) } as never));
    await settle();
    expect(invoke).not.toHaveBeenCalled();

    s.leave();
    await settle();
    expect(calls(PUBLISH)).toHaveLength(1);
    expect(calls(PUBLISH)[0][1]).toEqual({ targets: s.final() });
    // The final list: the groups whose history is the newest, then the newest restored ones.
    expect(s.final().map((t) => t.id)).toEqual(['c:g6', 'c:g4', 'c:g2', 'c:g0', 'c:old5']);

    // Back and away again with nothing changed: the native side already holds it.
    s.back();
    s.leave();
    await settle();
    expect(calls(PUBLISH)).toHaveLength(1);
    s.destroy();
  });

  it('leaving before the sources settle sends nothing; the next departure sends the list', async () => {
    const s = session();
    s.set('a', row('a', 'A', { messages: said(1) } as never));
    s.leave();
    await settle();
    expect(invoke).not.toHaveBeenCalled();
    s.back();
    s.state.ready = true;
    flushSync();
    s.leave();
    await settle();
    expect(calls(PUBLISH)).toHaveLength(1);
    s.destroy();
  });

  it('a later message that changes the top is sent at the next departure, not before', async () => {
    const s = session();
    s.state.ready = true;
    s.set('a', row('a', 'A', { messages: said(1) } as never));
    s.leave();
    s.back();
    s.set('b', row('b', 'B', { messages: said(2) } as never));
    await settle();
    expect(calls(PUBLISH)).toHaveLength(1);
    s.leave();
    await settle();
    expect(calls(PUBLISH)).toHaveLength(2);
    expect(calls(PUBLISH)[1][1]).toEqual({ targets: s.final() });
    s.destroy();
  });
});

describe('the switch', () => {
  it('a start with the switch on sends nothing; off clears at once, on publishes at once', async () => {
    const s = session();
    s.state.ready = true;
    s.set('a', row('a', 'A', { messages: said(1) } as never));
    await settle();
    expect(invoke).not.toHaveBeenCalled();
    s.state.enabled = false;
    flushSync();
    s.state.enabled = true;
    flushSync();
    await settle();
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([CLEAR, PUBLISH]);
    s.destroy();
  });

  it('a start with the switch off clears, as before', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    const destroy = $effect.root(() => {
      followShareTargets({
        enabled: () => false,
        read: () => ({
          enabled: false,
          signedIn: true,
          conversationsReady: true,
          conversations: () => conversations.entries(),
          currentUserId: ME,
          workspaces: () => [],
        }),
        subscribe: () => () => {},
      });
    });
    flushSync();
    await settle();
    // Cleared once: "nothing published" is unknown at a fresh start, so the clear is sent.
    expect(calls(CLEAR)).toHaveLength(1);
    destroy();
  });
});
