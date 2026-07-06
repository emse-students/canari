import { describe, expect, it, vi } from 'vitest';
import { mergeDirectConversationDuplicates } from './conversations';
import type { ConversationMeta } from '$lib/db/types';
import type { IStorage } from '$lib/db/types';
import type { IMlsService } from '$lib/mls-client/IMlsService';

const ME = 'aaaa0000-0000-0000-0000-000000000000';
const PEER = 'bbbb0000-0000-0000-0000-000000000000';
const PRED_ID = 'pred0000-0000-0000-0000-000000000000';
const SUCC_ID = 'succ0000-0000-0000-0000-000000000000';
const IND_A = 'inda0000-0000-0000-0000-000000000000';
const IND_B = 'indb0000-0000-0000-0000-000000000000';
const NAME = `${ME}::${PEER}`;

function makeMeta(id: string, updatedAt = 1000): ConversationMeta {
  return { id, name: NAME, lifecycle: 'active', updatedAt };
}

function makeStorage(): IStorage {
  return {
    init: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getConversations: vi.fn().mockResolvedValue([]),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    deleteMessagesForConversation: vi.fn().mockResolvedValue(undefined),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    saveMessages: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockResolvedValue([]),
    getMessagesPage: vi.fn().mockResolvedValue([]),
    deleteOldMessages: vi.fn().mockResolvedValue(0),
  } as unknown as IStorage;
}

function makeMlsService(getGroupMetaImpl: (id: string) => unknown): IMlsService {
  return {
    getGroupMeta: vi.fn().mockImplementation((id: string) => Promise.resolve(getGroupMetaImpl(id))),
    deleteGroupOnServer: vi.fn().mockResolvedValue(undefined),
  } as unknown as IMlsService;
}

describe('mergeDirectConversationDuplicates', () => {
  it('traite deux groupes du meme pair comme doublons independants (successeurs retires) - garde le plus recent', async () => {
    // Successors are retired: even a former predecessor/successor pair is now merged as two
    // independent duplicates, keeping the most recent and removing the older one everywhere.
    const storage = makeStorage();
    const mls = makeMlsService(() => null);

    const result = await mergeDirectConversationDuplicates(
      [makeMeta(PRED_ID, 900), makeMeta(SUCC_ID, 1000)],
      ME,
      'pin',
      storage,
      () => {},
      mls
    );

    // The most recent (SUCC) is kept, the older (PRED) is removed locally and on the server.
    expect(result.map((c) => c.id)).toContain(SUCC_ID);
    expect(result.map((c) => c.id)).not.toContain(PRED_ID);
    expect(storage.deleteConversation).toHaveBeenCalledWith(PRED_ID);
    expect((mls.deleteGroupOnServer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((mls.deleteGroupOnServer as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(PRED_ID);
  });

  it('supprime bien deleteGroupOnServer pour un vrai doublon sans relation de succession', async () => {
    // Deux groupes indépendants pour le même pair (deux devices ont ouvert la conv en même temps).
    const storage = makeStorage();
    const mls = makeMlsService(() => null); // aucune relation successeur

    const older = makeMeta(IND_A, 500);
    const newer = makeMeta(IND_B, 1000);

    const result = await mergeDirectConversationDuplicates(
      [older, newer],
      ME,
      'pin',
      storage,
      () => {},
      mls
    );

    // Le plus récent est conservé
    expect(result.map((c) => c.id)).toContain(IND_B);
    expect(result.map((c) => c.id)).not.toContain(IND_A);
    expect(storage.deleteConversation).toHaveBeenCalledWith(IND_A);
    // deleteGroupOnServer DOIT être appelé pour éviter une résurrection via discoverMissingGroups
    expect((mls.deleteGroupOnServer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((mls.deleteGroupOnServer as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(IND_A);
  });
});
