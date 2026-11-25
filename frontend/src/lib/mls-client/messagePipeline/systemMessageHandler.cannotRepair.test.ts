import { digestIdentity } from '$lib/utils/chat/historyDigestRendezvous';
import { ReactionsByConversation } from '$lib/utils/chat/reactionsByConversation';

/**
 * The frame that advances the HEAL-repair walk: a member we asked while holding frames we cannot
 * read says it holds nothing we lack. Believed only from the authenticated sender and only when
 * addressed to this device - it excludes a member from every later ask until the repair lands.
 */
const { noteCannotRepair } = vi.hoisted(() => ({
  noteCannotRepair: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/utils/chat/historyReconcile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/historyReconcile')>()),
  noteCannotRepair,
}));

import { handleSystemEvent } from './systemMessageHandler';

const ME = 'me';
const MY_DEVICE = 'device-me';
const GROUP = 'g1';
const PEER = 'peer';
const PEER_IDENTITY = digestIdentity(PEER, 'device-peer');

function makeCtx() {
  const conversations = new Map<string, any>();
  conversations.set(GROUP, { id: GROUP, unreadCount: 0, messages: [] });
  return {
    mlsService: { getDeviceId: () => MY_DEVICE },
    storage: {},
    userId: ME,
    deviceKey: () => 'device-key',
    conversations,
    messageReactions: new ReactionsByConversation(),
    addMessageToChat: vi.fn(),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convo: conversations.get(GROUP),
    convoKey: GROUP,
    senderNorm: PEER,
    persistMlsStateNow: vi.fn(),
  };
}

const frame = (over: Record<string, unknown> = {}) => ({
  from: PEER_IDENTITY,
  to: digestIdentity(ME, MY_DEVICE),
  since: 0,
  ...over,
});

beforeEach(() => noteCannotRepair.mockClear());

describe('history_cannot_repair', () => {
  it('advances the walk past the member that said it', async () => {
    expect(await handleSystemEvent('history_cannot_repair', frame(), makeCtx() as any)).toBe(true);

    expect(noteCannotRepair).toHaveBeenCalledWith(
      expect.anything(),
      GROUP,
      PEER_IDENTITY,
      expect.any(Function)
    );
  });

  it('ignores an answer addressed at another device', async () => {
    await handleSystemEvent(
      'history_cannot_repair',
      frame({ to: digestIdentity('someone-else', 'their-device') }),
      makeCtx() as any
    );

    expect(noteCannotRepair).not.toHaveBeenCalled();
  });

  it('refuses a `from` that does not match the authenticated MLS sender', async () => {
    // Excluding a member is a decision about who may repair this device: an impostor naming the
    // holder would steer the walk away from the one member that can help.
    await handleSystemEvent(
      'history_cannot_repair',
      frame({ from: digestIdentity('impostor', 'device-x') }),
      makeCtx() as any
    );

    expect(noteCannotRepair).not.toHaveBeenCalled();
  });
});
