// @vitest-environment happy-dom
/**
 * THE CONVERSATION RESTORE OWNS THE ROWS IT READS FROM STORAGE, AND ONLY THOSE.
 *
 * A salon's row is written by the COMMUNITY LOAD (`loadChannelWorkspacesFromBackend`), which never
 * persists it; storage holds a salon only once something saved it (a message, a read). The restore
 * used to `clear()` the whole map and rebuild it from storage, so a restore that ran AFTER the
 * community load - the login path awaits the socket before restoring, and `onWelcomeProcessed`
 * restores mid-session - erased every salon storage did not hold, while the sidebar, fed by
 * `channelWorkspaces`, still listed it. Tapping such a salon then selected a key absent from the map,
 * and the selection watchdog in `useConversations` deselected it on the spot: the row lit up and
 * nothing opened, until a restart ran the two loads in the other order.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: { isMessageCatchupActive: false, resetMessageCatchupState: vi.fn() },
  globalSession: {},
  globalConvs: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

import { buildConversationRow, loadExistingConversations } from './conversations';

function mls() {
  return {
    getLocalGroups: vi.fn(() => []),
    getUserGroups: vi.fn(async () => []),
    notifyConversationsRestored: vi.fn(),
    notifyConversationRowsSeeded: vi.fn(),
    beginBulkIngest: vi.fn(),
    endBulkIngest: vi.fn(),
    persistCheckpoint: vi.fn(async () => {}),
    isDistributionGroup: vi.fn(() => false),
    getDismissedGroups: vi.fn(async () => []),
  } as never;
}

function storageWith(metas: Record<string, unknown>[]) {
  return {
    getConversations: vi.fn(async () => metas),
    saveConversation: vi.fn(async () => {}),
    getMessagesPage: vi.fn(async () => []),
    deleteMessagesForConversation: vi.fn(async () => {}),
    getMessages: vi.fn(async () => []),
    deleteConversation: vi.fn(async () => {}),
  } as never;
}

function restore(conversations: SvelteMap<string, Conversation>, metas: Record<string, unknown>[]) {
  return loadExistingConversations({
    storage: storageWith(metas),
    mlsService: mls(),
    conversations,
    messageReactions: new SvelteMap(),
    userId: 'u1',
    deviceKeyB64: 'k',
    archivedConversationIds: [],
    historyBaseUrl: '',
    onArchivedIdsChange: vi.fn(),
    log: vi.fn(),
  } as never);
}

/** A salon row as the community load writes it. */
function salonRow(id: string, name: string): Conversation {
  return buildConversationRow({
    id,
    lifecycle: 'active',
    identity: { contactName: id, displayName: name },
  });
}

describe('a restore after the community load', () => {
  it('keeps the salons storage never held', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    conversations.set('channel_infos', salonRow('channel_infos', 'infos'));
    conversations.set('channel_tract', salonRow('channel_tract', 'tract'));

    await restore(conversations, []);

    expect([...conversations.keys()].sort()).toEqual(['channel_infos', 'channel_tract']);
  });

  it('keeps what an in-memory salon carries when storage holds a stub of it', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    const live = salonRow('channel_infos', 'infos');
    live.messages.push({
      id: 'm1',
      senderId: 'bob',
      content: 'hi',
      timestamp: new Date(),
    } as never);
    conversations.set('channel_infos', live);

    await restore(conversations, [
      { id: 'channel_infos', name: 'infos', lifecycle: 'active', updatedAt: 1 },
    ]);

    expect(conversations.get('channel_infos')?.messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('reads back the persisted state a cold salon row lacks, and lets the live row win', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    const live = salonRow('channel_infos', 'infos');
    live.historyFloor = 7 as never;
    conversations.set('channel_infos', live);

    await restore(conversations, [
      {
        id: 'channel_infos',
        name: 'infos',
        lifecycle: 'active',
        updatedAt: 42,
        readWatermarks: { bob: 30 },
        historyFloor: 3,
      },
    ]);

    const row = conversations.get('channel_infos')!;
    expect(row.lastMessageAt).toBe(42);
    expect(row.readWatermarks).toEqual({ bob: 30 });
    expect(row.historyFloor).toBe(7);
    expect('startedAt' in row).toBe(false);
  });

  it('still rebuilds every conversation storage owns, and drops the ones it no longer holds', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    conversations.set(
      'g-gone',
      buildConversationRow({
        id: 'g-gone',
        lifecycle: 'active',
        identity: { contactName: 'g-gone', displayName: 'gone' },
      })
    );

    await restore(conversations, [{ id: 'g-kept', name: 'Equipe', lifecycle: 'active' }]);

    expect(conversations.has('g-gone')).toBe(false);
    expect(conversations.has('g-kept')).toBe(true);
  });

  /**
   * A ROW WRITTEN WHILE THE STORE WAS BEING READ IS NOT ONE STORAGE "NO LONGER HOLDS". At a cold
   * start the redelivered Welcome of a group joined in the background writes its row while the
   * restore is between its read and its prune (Pixel 6a, prod 1.2.7, 2026-10-14); deleting it sent
   * every frame of that group back to `absent-conversation`.
   */
  it('keeps a row written after the store was read, which the read could not have returned', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    const storage = storageWith([]) as unknown as { getConversations: ReturnType<typeof vi.fn> };
    storage.getConversations.mockImplementation(async () => {
      conversations.set(
        'g-joined',
        buildConversationRow({
          id: 'g-joined',
          lifecycle: 'active',
          identity: { contactName: 'g-joined', displayName: 'Equipe' },
        })
      );
      return [];
    });

    await loadExistingConversations({
      storage,
      mlsService: mls(),
      conversations,
      messageReactions: new SvelteMap(),
      userId: 'u1',
      deviceKeyB64: 'k',
      archivedConversationIds: [],
      historyBaseUrl: '',
      onArchivedIdsChange: vi.fn(),
      log: vi.fn(),
    } as never);

    expect(conversations.get('g-joined')?.name).toBe('Equipe');
  });

  it('restores a stored salon the map does not hold yet', async () => {
    const conversations = new SvelteMap<string, Conversation>();

    await restore(conversations, [
      { id: 'channel_infos', name: 'infos', lifecycle: 'active', updatedAt: 1 },
    ]);

    expect(conversations.get('channel_infos')?.conversationType).toBe('channel');
  });
});
