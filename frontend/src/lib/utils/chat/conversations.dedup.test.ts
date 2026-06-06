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
  return { id, name: NAME, isReady: true, updatedAt };
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
  it('ne supprime PAS deleteGroupOnServer quand le duplicate est un ancêtre du canonical (successorId relationship)', async () => {
    // PRED → successorId → SUCC : le serveur a déjà soft-deleted PRED via claimSuccessor.
    // Appeler deleteGroupOnServer(PRED) suivrait la chaîne et supprimerait aussi SUCC.
    const storage = makeStorage();
    const mls = makeMlsService((id) => {
      if (id === PRED_ID) return { groupId: PRED_ID, successorId: SUCC_ID };
      if (id === SUCC_ID) return { groupId: SUCC_ID, successorId: null };
      return null;
    });

    const result = await mergeDirectConversationDuplicates(
      [makeMeta(PRED_ID, 900), makeMeta(SUCC_ID, 1000)],
      ME,
      'pin',
      storage,
      () => {},
      mls
    );

    // SUCC est conservé, PRED est retiré localement
    expect(result.map((c) => c.id)).toContain(SUCC_ID);
    expect(result.map((c) => c.id)).not.toContain(PRED_ID);
    expect(storage.deleteConversation).toHaveBeenCalledWith(PRED_ID);

    // Pas d'appel deleteGroupOnServer : le serveur a déjà supprimé PRED proprement
    expect((mls.deleteGroupOnServer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('fusionne une chaîne multi-niveaux vers le terminal actif', async () => {
    const MID_ID = 'mid00000-0000-0000-0000-000000000000';
    const storage = makeStorage();
    const mls = makeMlsService((id) => {
      if (id === PRED_ID) return { groupId: PRED_ID, successorId: MID_ID };
      if (id === MID_ID) return { groupId: MID_ID, successorId: SUCC_ID };
      if (id === SUCC_ID) return { groupId: SUCC_ID, successorId: null };
      return null;
    });

    const result = await mergeDirectConversationDuplicates(
      [makeMeta(PRED_ID, 700), makeMeta(MID_ID, 800), makeMeta(SUCC_ID, 900)],
      ME,
      'pin',
      storage,
      () => {},
      mls
    );

    expect(result.map((c) => c.id)).toEqual([SUCC_ID]);
    expect(storage.deleteConversation).toHaveBeenCalledWith(PRED_ID);
    expect(storage.deleteConversation).toHaveBeenCalledWith(MID_ID);
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
