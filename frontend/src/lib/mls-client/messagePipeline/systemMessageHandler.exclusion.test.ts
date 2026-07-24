// Resolve names offline: identity function so the handler runs without the user store / network.
vi.mock('$lib/utils/users/displayName', () => ({
  resolveDisplayNames: vi.fn(async () => (id: string) => id),
}));

import { handleSystemEvent } from './systemMessageHandler';

/** Minimal context to exercise the `memberRemoved` (self-exclusion) path. */
function makeCtx(overrides: Record<string, unknown> = {}) {
  const conversations = new Map<string, any>();
  conversations.set('g1', { id: 'g1', lifecycle: 'active', messages: [] });
  return {
    mlsService: { forgetGroup: vi.fn() },
    storage: null,
    userId: 'me',
    pin: 'pin',
    conversations,
    messageReactions: new Map(),
    addMessageToChat: vi.fn().mockResolvedValue(undefined),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => 'g1',
    setSelectedContact: vi.fn(),
    onReadReceiptReceived: vi.fn(),
    log: vi.fn(),
    convo: { id: 'g1', lifecycle: 'active', messages: [] },
    convoKey: 'g1',
    senderNorm: 'admin',
    persistMlsStateNow: vi.fn(),
    ...overrides,
  };
}

describe('handleSystemEvent - memberRemoved (self-exclusion)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exclusion de MOI -> banniere + lifecycle removed, PAS de purge silencieuse', async () => {
    const ctx = makeCtx({ senderNorm: 'admin', userId: 'me' });
    await handleSystemEvent('memberRemoved', { targetUser: 'me' }, ctx as any);

    // WASM oublie (on ne peut plus dechiffrer les epochs futurs) + persistance.
    expect(ctx.mlsService.forgetGroup).toHaveBeenCalledWith('g1');
    expect(ctx.persistMlsStateNow).toHaveBeenCalled();
    // Banniere systeme affichee, conversation passee en `removed` et sauvegardee.
    expect(ctx.addMessageToChat).toHaveBeenCalledWith(
      'system',
      expect.any(String),
      'g1',
      expect.objectContaining({ isSystem: true })
    );
    expect((ctx.conversations.get('g1') as any).lifecycle).toBe('removed');
    expect(ctx.saveConversation).toHaveBeenCalledWith('g1');
    // Surtout : PAS de suppression silencieuse (la conv reste lisible jusqu'a suppression manuelle).
    expect(ctx.deleteConversation).not.toHaveBeenCalled();
    expect(ctx.conversations.has('g1')).toBe(true);
    expect(ctx.setSelectedContact).not.toHaveBeenCalled();
  });

  it("exclusion d'un AUTRE membre -> simple message systeme, conversation intacte", async () => {
    const ctx = makeCtx({ senderNorm: 'admin', userId: 'me' });
    await handleSystemEvent('memberRemoved', { targetUser: 'other' }, ctx as any);

    expect(ctx.addMessageToChat).toHaveBeenCalled();
    expect((ctx.conversations.get('g1') as any).lifecycle).toBe('active');
    expect(ctx.mlsService.forgetGroup).not.toHaveBeenCalled();
    expect(ctx.deleteConversation).not.toHaveBeenCalled();
  });
});
