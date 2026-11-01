/**
 * "Load older" pages below where the STORE's pages stop, never below the oldest row in memory
 * (review of #2824, P2-4). A row that reached memory another way - live, from a history bundle, an
 * own send restored by the outbox - can sit far below the last stored page, and a cursor taken from
 * it skipped every stored row in between.
 */
import 'fake-indexeddb/auto';
import { SvelteMap } from 'svelte/reactivity';
import { IndexedDbStorage } from '$lib/db/indexeddb';
import { mapStoredMessagesToChatMessages } from '$lib/utils/chat/messageUtils';
import type { StoredMessage } from '$lib/db/types';
import type { Conversation } from '$lib/types';

// Same isolation reasoning as the other composable tests: the composable is reachable from the
// global chat singleton's own module-scope instantiation, so importing it directly closes a cycle.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

const { useConversations } = await import('./useConversations.svelte');

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const DM = 'peer-dm';
const GROUP_ID = 'e4c1f0aa-0000-4000-8000-000000000003';
const T0 = 1_700_000_000_000;

const stored = (id: string, timestamp: number): StoredMessage => ({
  id,
  conversationId: GROUP_ID,
  senderId: 'peer',
  content: id,
  timestamp,
  serverTimestamp: timestamp,
});

it('pages below the last stored page, not below a row injected far older than it', async () => {
  const storage = new IndexedDbStorage(`load-older-${Date.now()}`);
  await storage.init();
  const rows = Array.from({ length: 120 }, (_, i) =>
    stored(`m-${String(i).padStart(3, '0')}`, T0 + i * 1000)
  );
  await storage.saveMessages(rows, KEY);

  const convs = useConversations();
  const firstPage = mapStoredMessagesToChatMessages(
    await storage.getMessagesPage(GROUP_ID, KEY, 50),
    'me'
  );
  // Reached memory without a store page: a bundle row a day older than anything stored.
  const injected = {
    ...mapStoredMessagesToChatMessages([stored('injected', T0 - 86_400_000)], 'me')[0],
  };
  convs.conversations.set(DM, {
    id: GROUP_ID,
    name: DM,
    messages: [injected, ...firstPage],
  } as unknown as Conversation);
  const ctx = {
    storage,
    userId: 'me',
    deviceKeyB64: KEY,
    messageReactions: new SvelteMap(),
    log: vi.fn(),
  } as never;

  expect(await convs.loadOlderMessages(DM, ctx)).toBe(true);
  expect(await convs.loadOlderMessages(DM, ctx)).toBe(false);

  const held = new Set(convs.conversations.get(DM)!.messages.map((m) => m.id));
  expect(rows.filter((r) => !held.has(r.id)).map((r) => r.id)).toEqual([]);
  expect(held.has('injected')).toBe(true);
  await storage.close();
});
