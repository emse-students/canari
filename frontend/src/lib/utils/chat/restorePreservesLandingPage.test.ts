// @vitest-environment happy-dom
/**
 * F1 - THE RESTORE DOES NOT BLANK THE THREAD THE LANDING DREW.
 *
 * The notification landing draws its target from the local store before the session is up; the
 * startup restore then drops every non-salon row and rebuilds it, and Phase 2 reaches the target only
 * behind `getUserGroups` and the batch history - two round trips. Without `preserveMessagesOf`
 * the thread on screen went empty for that whole time. The round trip is held open here so the
 * assertion reads the map exactly in that window.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: {},
  globalSession: {},
  globalConvs: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

import { loadExistingConversations } from './conversations';

const TARGET = 'e4c1f0aa-0000-4000-8000-0000000000f1';
const OTHER = 'e4c1f0aa-0000-4000-8000-0000000000f2';

function run(preserveMessagesOf: string | null) {
  const conversations = new SvelteMap<string, Conversation>();
  for (const id of [TARGET, OTHER]) {
    conversations.set(id, {
      id,
      name: id,
      messages: [{ id: `${id}-m`, senderId: 'peer', content: 'x', timestamp: new Date(1) }],
    } as never);
  }
  const storage = {
    getConversations: vi.fn(async () => [
      { id: TARGET, name: 'Bench', lifecycle: 'active', updatedAt: 2 },
      { id: OTHER, name: 'Other', lifecycle: 'active', updatedAt: 1 },
    ]),
    saveConversation: vi.fn(async () => {}),
    getMessagesPage: vi.fn(async () => []),
    deleteMessagesForConversation: vi.fn(async () => {}),
    getMessages: vi.fn(async () => []),
    deleteConversation: vi.fn(async () => {}),
  };
  const mlsService = {
    // Never answers: the rebuild stays between Phase 1 and Phase 2 for the whole assertion.
    getUserGroups: vi.fn(() => new Promise(() => {})),
    beginBulkIngest: vi.fn(),
    endBulkIngest: vi.fn(),
    getLocalGroups: vi.fn(() => []),
    getDismissedGroups: vi.fn(async () => []),
    isDistributionGroup: vi.fn(() => false),
    notifyConversationRowsSeeded: vi.fn(),
  };
  void loadExistingConversations({
    storage,
    mlsService,
    conversations,
    messageReactions: new SvelteMap(),
    userId: 'u1',
    deviceKeyB64: 'k',
    historyBaseUrl: 'https://example.invalid',
    archivedConversationIds: [],
    onArchivedIdsChange: vi.fn(),
    log: vi.fn(),
    preserveMessagesOf,
  } as never);
  return { conversations, mlsService };
}

describe('the restore and the landing target', () => {
  it('keeps the landing target page through the rebuild, and only that one', async () => {
    const { conversations, mlsService } = run(TARGET);
    await vi.waitFor(() => expect(mlsService.getUserGroups).toHaveBeenCalled());
    expect(conversations.get(TARGET)?.messages.map((m) => m.id)).toEqual([`${TARGET}-m`]);
    expect(conversations.get(OTHER)?.messages).toEqual([]);
  });

  it('keeps nothing when there is no landing', async () => {
    const { conversations, mlsService } = run(null);
    await vi.waitFor(() => expect(mlsService.getUserGroups).toHaveBeenCalled());
    expect(conversations.get(TARGET)?.messages).toEqual([]);
  });
});
