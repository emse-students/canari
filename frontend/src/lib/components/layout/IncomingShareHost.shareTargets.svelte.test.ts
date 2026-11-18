// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';

/**
 * THE HOST'S WIRING OF THE SHARE-SHEET SUGGESTIONS: a change of the conversation list while the app
 * is in front sends nothing - only the member leaving does. A host that followed the map again (an
 * `$effect` reading it, which republished every provisional state of a first sync) fails here.
 */
const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));
vi.mock('$lib/utils/appVersion', () => ({
  isAndroidTauriRuntime: () => true,
  isIosTauriRuntime: () => false,
  isMobileTauriRuntime: () => true,
}));
vi.mock('$lib/components/chat/ForwardMessageModal.svelte', () => ({ default: () => {} }));
vi.mock('$lib/mobile/incomingShareDrain', () => ({ drainNativeShare: async () => null }));

const live = vi.hoisted(() => ({ conversations: null as unknown as Map<string, unknown> }));
vi.mock('$lib/stores/globalChatSingleton.svelte', async () => {
  const { SvelteMap: Map_ } = await import('svelte/reactivity');
  live.conversations = new Map_();
  return {
    globalSession: { isLoggedIn: true, userId: '11111111-1111-4111-8111-111111111111' },
    globalConvs: { conversations: live.conversations, conversationSourcesSettled: true },
    globalChannels: { channelWorkspaces: [] },
    appendLog: () => {},
  };
});

const { default: IncomingShareHost } = await import('./IncomingShareHost.svelte');
const { resetShareTargetsStateForTests } = await import('$lib/sharing/shareTargetsNative');

const PUBLISH = 'plugin:gallery|publish_share_targets';

function row(id: string, at: number): Conversation {
  const msg = { id: `m${at}`, senderId: 'peer', content: 'x', timestamp: at, serverTimestamp: at };
  return {
    id,
    name: `Groupe ${id}`,
    contactName: `Groupe ${id}`,
    messages: [msg],
    lifecycle: 'active',
    mlsStateHex: null,
    conversationType: 'group',
  } as unknown as Conversation;
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const leave = (foreground: boolean) =>
  window.dispatchEvent(new CustomEvent('canari:foreground', { detail: { foreground } }));

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

it('a change of the list while in front publishes nothing; leaving the app publishes it once', async () => {
  invoke.mockImplementation(async (cmd: string) =>
    cmd === PUBLISH ? { present: 2, leftover: 0 } : 0
  );
  resetShareTargetsStateForTests();
  (window as unknown as { __canariForeground: boolean }).__canariForeground = true;
  leave(true);
  const instance = mount(IncomingShareHost, { target: document.body });
  stop = () => unmount(instance);
  flushSync();

  const conversations = live.conversations as SvelteMap<string, Conversation>;
  for (let i = 0; i < 6; i++) {
    conversations.set(`g${i}`, row(`g${i}`, 100 + i));
    flushSync();
  }
  conversations.set('g0', row('g0', 500));
  flushSync();
  await settle();
  expect(invoke.mock.calls.filter(([c]) => c === PUBLISH)).toHaveLength(0);

  leave(false);
  await settle();
  const published = invoke.mock.calls.filter(([c]) => c === PUBLISH);
  expect(published).toHaveLength(1);
  expect((published[0][1] as { targets: { id: string }[] }).targets[0].id).toBe('c:g0');
});
