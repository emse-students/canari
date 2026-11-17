import { afterEach, describe, expect, it, vi } from 'vitest';

// Resolve names offline: identity function so the handler runs without the user store / network.
vi.mock('$lib/utils/users/displayName', () => ({
  resolveDisplayNames: vi.fn(async () => (id: string) => id),
}));

import { handleSystemEvent } from './systemMessageHandler';

/**
 * A GROUP'S NAME IS THE NEWEST ONE ITS MEMBERS STATED, NOT THE LAST ONE THIS DEVICE READ.
 *
 * Every `groupRenamed` frame used to be applied as it arrived, so a device that read an older rename
 * after a newer one - a queue drain behind a live frame, a replay page behind both - put the older
 * name back, and only the server's list could correct it. That list is going away
 * (docs/wiki/protocols/sealed-names.md), so the frames must settle it alone: by the server's
 * acceptance time of the frame that stated each name (`groupName.ts`).
 */

const T = Date.UTC(2026, 10, 17, 9, 0, 0);

function device(conversationType: 'group' | 'direct' = 'group') {
  const convo = {
    id: 'g1',
    contactName: 'g1',
    lifecycle: 'active',
    messages: [],
    name: 'Groupe',
    conversationType,
  };
  const conversations = new Map<string, any>([['g1', convo]]);
  const saveConversation = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    mlsService: {},
    storage: {},
    userId: 'me',
    deviceKey: () => 'device-key',
    conversations,
    messageReactions: new Map(),
    addMessageToChat: vi.fn().mockResolvedValue(undefined),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    saveConversation,
    getSelectedContact: () => 'g1',
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convoKey: 'g1',
    persistMlsStateNow: vi.fn(),
  };
  const rename = (newName: string, serverAt: number | undefined, sentAt: number = serverAt ?? T) =>
    handleSystemEvent('groupRenamed', { newName }, {
      ...ctx,
      convo: conversations.get('g1'),
      senderNorm: 'alice',
      messageId: crypto.randomUUID(),
      sentAt,
      deliveryMeta: serverAt === undefined ? undefined : { queuedCreatedAt: serverAt },
    } as never);
  return { conversations, saveConversation, rename };
}

describe('a received groupRenamed frame', () => {
  afterEach(() => vi.restoreAllMocks());

  it('an OLDER rename read after a newer one does not put the older name back', async () => {
    const phone = device();
    await phone.rename('Les ROOTz', T + 60_000);
    await phone.rename('Ancien nom', T);
    expect(phone.conversations.get('g1').name).toBe('Les ROOTz');
    expect(phone.conversations.get('g1').nameAt).toBe(T + 60_000);
  });

  it('dates the name it applies, and saves the row that carries both', async () => {
    const phone = device();
    await phone.rename('Les ROOTz', T);
    expect(phone.conversations.get('g1')).toMatchObject({ name: 'Les ROOTz', nameAt: T });
    expect(phone.saveConversation).toHaveBeenCalledWith('g1');
  });

  it('a frame with no server time names nothing, and says why at ERROR', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const phone = device();
    await phone.rename('Les ROOTz', undefined);
    expect(phone.conversations.get('g1').name).toBe('Groupe');
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'carries no server time'
    );
  });

  it('a server time far from the signed sentAt is refused at ERROR: a hostile stamp locks nothing in', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const phone = device();
    await phone.rename('Pour toujours', Date.UTC(2100, 0, 1), T);
    expect(phone.conversations.get('g1').name).toBe('Groupe');
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain('signed sentAt');
  });

  it('an empty name is refused for being empty, not for a missing server time', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const phone = device();
    await phone.rename('   ', T);
    const said = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('empty once trimmed');
    expect(said).not.toContain('server time');
  });

  it('a rename inside a DM names its true cause, not "not newer"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const phone = device('direct');
    await phone.rename('Les ROOTz', T);
    expect(phone.conversations.get('g1').name).toBe('Groupe');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('not a group');
  });
});
