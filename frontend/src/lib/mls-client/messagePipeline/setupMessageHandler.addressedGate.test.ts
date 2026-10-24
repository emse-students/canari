// @vitest-environment happy-dom
/**
 * STEP A, RULE 5 (docs/wiki/protocols/history-answer-addressing.md): in a conversation, a frame the
 * server routed to THIS device alone may only be a history answer. A message, an edit or a reaction
 * sent that way would show this device a conversation nobody else in the group saw, so the pipeline
 * refuses it before any of it is applied - and ACKs it, since redelivery would not change the answer.
 */
vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
  saveMlsStateEncrypted: vi.fn().mockResolvedValue(undefined),
  purgeLegacyPlainMlsState: vi.fn().mockResolvedValue(undefined),
}));

import { setupMessageHandler } from './setupMessageHandler';
import { encodeAppMessage, mkReaction, mkText } from '$lib/proto/codec';
import type { IncomingDeliveryMeta } from '../incomingDelivery';
import { createMlsServiceStub } from '../test/fixtures/mlsServiceStub';
import {
  createTestConversations,
  createTestMessageReactions,
  emptyConversation,
} from '../test/fixtures/conversationMap';

const groupId = '44444444-4444-4444-8444-444444444444';

function deps(plaintext: Uint8Array) {
  return {
    mlsService: createMlsServiceStub({
      getUserGroups: vi.fn().mockResolvedValue([{ groupId, name: 'Test', isGroup: true }]),
      getLocalGroups: vi.fn().mockReturnValue([groupId]),
      processIncomingMessage: vi.fn().mockResolvedValue({ plaintext, author: 'unsigned' }),
    }),
    storage: null,
    userId: 'user-a',
    deviceKey: () => 'device-key',
    historyBaseUrl: 'https://hist',
    conversations: createTestConversations([
      [groupId, emptyConversation(groupId, { lifecycle: 'active' })],
    ]),
    messageReactions: createTestMessageReactions(),
    recoveryTimers: new Map(),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    addMessageToChat: vi.fn().mockResolvedValue(undefined),
    loadHistoryForConversation: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
  };
}

async function deliver(plaintext: Uint8Array, meta: IncomingDeliveryMeta) {
  const d = deps(plaintext);
  setupMessageHandler(d as never);
  const onMsg = (d.mlsService as never as { onMessage: { mock: { calls: unknown[][] } } }).onMessage
    .mock.calls[0][0] as (...args: unknown[]) => Promise<boolean>;
  const acked = await onMsg(
    'Peer-User',
    new Uint8Array([7]),
    groupId,
    false,
    undefined,
    false,
    meta
  );
  return { d, acked };
}

const LIVE = { channel: 'live', senderDeviceId: 'dev-p', queuedMessageId: 'q1' } as const;

describe('an addressed conversation frame is a history answer or nothing', () => {
  beforeEach(() => localStorage.clear());

  it('a message routed to this device alone is refused, at error, and ACKed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { d, acked } = await deliver(encodeAppMessage(mkText('only you see this')), {
      ...LIVE,
      addressed: true,
    });

    expect(acked).toBe(true);
    expect(d.addMessageToChat).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('[HISTORY_ADDRESSED] REFUSED an addressed message')
    );
    error.mockRestore();
  });

  it('a reaction routed to this device alone is refused too', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await deliver(encodeAppMessage(mkReaction('m1', '+1', 1000)), { ...LIVE, addressed: true });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('[HISTORY_ADDRESSED] REFUSED'));
    error.mockRestore();
  });

  it('the same message reaching the whole group is shown', async () => {
    const { d } = await deliver(encodeAppMessage(mkText('everyone sees this')), LIVE);

    expect(d.addMessageToChat).toHaveBeenCalled();
  });
});
