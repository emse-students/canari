/**
 * A PAGE THE STORE LOADS SETTLES WHAT WAITS FOR ITS ROWS (third and fourth reviews of #3851). An edit,
 * a deletion or a reaction whose write onto a STORED row failed is parked, durably, and its frame is
 * acknowledged; the row is never written again, so the next time anything looks at it is when a page
 * loads it - after a reload, the only look there is.
 */
import 'fake-indexeddb/auto';
import { SvelteMap } from 'svelte/reactivity';
import { IndexedDbStorage } from '$lib/db/indexeddb';
import { mapStoredMessagesToChatMessages } from '$lib/utils/chat/messageUtils';
import { PENDING_MUTATION_LIMITS } from '$lib/utils/chat/pendingMutations';
import { envelopeBodyText, mkTextEnvelope, serializeEnvelope } from '$lib/envelope';
import type { StoredMessage } from '$lib/db/types';
import type { Conversation } from '$lib/types';

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
const GROUP_ID = 'e4c1f0aa-0000-4000-8000-000000000007';
const T0 = 1_700_000_000_000;

const stored = (id: string, timestamp: number): StoredMessage => ({
  id,
  conversationId: GROUP_ID,
  senderId: 'peer',
  content: serializeEnvelope(mkTextEnvelope(`body of ${id}`)),
  timestamp,
  serverTimestamp: timestamp,
});

it('an edit parked against a stored row lands when an older page loads that row', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const storage = new IndexedDbStorage(`settle-loaded-${Date.now()}`);
  await storage.init();
  const rows = Array.from({ length: 80 }, (_, i) =>
    stored(`m-${String(i).padStart(3, '0')}`, T0 + i * 1000)
  );
  await storage.saveMessages(rows, KEY);
  // Below the first page: parked by an edit whose write onto it failed in an earlier session.
  await storage.putPendingMutation(
    {
      conversationId: GROUP_ID,
      messageId: 'm-005',
      sender: 'peer',
      kind: 'edit',
      slot: '',
      rank: T0 + 500_000,
      at: T0 + 500_000,
      text: 'edited later',
    },
    PENDING_MUTATION_LIMITS,
    KEY
  );

  const convs = useConversations();
  convs.conversations.set(DM, {
    id: GROUP_ID,
    name: DM,
    messages: mapStoredMessagesToChatMessages(
      await storage.getMessagesPage(GROUP_ID, KEY, 50),
      'me'
    ),
  } as unknown as Conversation);
  const ctx = {
    storage,
    userId: 'me',
    deviceKeyB64: KEY,
    messageReactions: new SvelteMap(),
    log: vi.fn(),
  } as never;

  await convs.loadOlderMessages(DM, ctx);

  // Settled in the background: the row at rest carries the edit, the entry is gone, the screen shows it.
  await vi.waitFor(async () => {
    const read = await storage.getMessagesByIds(GROUP_ID, ['m-005'], KEY);
    expect(envelopeBodyText(read.rows.get('m-005')!.content)).toBe('edited later');
  });
  const left = await storage.getPendingMutations(GROUP_ID, ['m-005'], KEY);
  expect(left.entries).toEqual([]);
  const shown = convs.conversations.get(DM)!.messages.find((m) => m.id === 'm-005')!;
  expect(envelopeBodyText(shown.content)).toBe('edited later');
  await storage.close();
  vi.restoreAllMocks();
});
