/**
 * A conversation opened MID-DRAIN shows the reactions memory holds, not the older ones the store
 * still has: while a catch-up window holds reaction writes (`catchupWrites.ts`), a frame has
 * updated memory and not yet the stored row, and the page draw used to replace memory with the row.
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from '$lib/db/indexeddb';
import type { StoredMessage } from '$lib/db/types';
import type { Conversation } from '$lib/types';
import { ReactionsByConversation } from '$lib/utils/chat/reactionsByConversation';

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
const GROUP_ID = 'e4c1f0aa-0000-4000-8000-000000000009';
const T0 = 1_700_000_000_000;

const reaction = (userId: string, at: number) => ({ userId, emoji: '+1', at });

it('keeps the reactions memory holds over the stored row a held write has not reached', async () => {
  const storage = new IndexedDbStorage(`open-mid-drain-${Date.now()}`);
  await storage.init();
  const row: StoredMessage = {
    id: 'm1',
    conversationId: GROUP_ID,
    senderId: 'peer',
    content: 'hello',
    timestamp: T0,
    serverTimestamp: T0,
    reactions: [reaction('x', 10)],
  };
  await storage.saveMessages([row], KEY);

  // A frame of the drain added Y's reaction in memory; the write onto the row is held.
  const messageReactions = new ReactionsByConversation();
  messageReactions.set(GROUP_ID, 'm1', [reaction('x', 10), reaction('y', 20)]);

  const convs = useConversations();
  convs.conversations.set(DM, {
    id: GROUP_ID,
    name: DM,
    lifecycle: 'removed', // the path that draws the stored page and asks the server for nothing
    messages: [],
  } as unknown as Conversation);
  const ctx = {
    storage,
    userId: 'me',
    deviceKeyB64: KEY,
    messageReactions,
    log: vi.fn(),
    ensureMls: () => ({ getDeviceId: () => 'dev-1' }),
  } as never;

  await convs.loadHistoryForConversation(DM, GROUP_ID, ctx);

  const shown = convs.conversations.get(DM)!.messages.find((m) => m.id === 'm1')!;
  expect(shown.reactions?.map((r) => r.userId).sort()).toEqual(['x', 'y']);
  expect(
    messageReactions
      .get(GROUP_ID, 'm1')
      ?.map((r) => r.userId)
      .sort()
  ).toEqual(['x', 'y']);
  await storage.close();
});
