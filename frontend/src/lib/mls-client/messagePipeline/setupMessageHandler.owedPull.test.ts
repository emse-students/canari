// @vitest-environment happy-dom
/**
 * The overheard-pull retry is spent from INSIDE the pipeline, on a decrypted frame: this pins that
 * seam. `historyOverheardPull.test.ts` drives `retryPullsOwedTo` directly, so deleting the call in
 * `handleKnownGroup` - or handing it the envelope's sender instead of the verified device - would
 * leave every one of its tests green while the retry never fired again.
 */
vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
  saveMlsStateEncrypted: vi.fn().mockResolvedValue(undefined),
  purgeLegacyPlainMlsState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/utils/chat/historyOverheardPull', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/historyOverheardPull')>()),
  takeOwedPulls: vi.fn(() => []),
}));

import { setupMessageHandler } from './setupMessageHandler';
import { takeOwedPulls } from '$lib/utils/chat/historyOverheardPull';
import { encodeAppMessage, mkSystem } from '$lib/proto/codec';
import type { IncomingDeliveryMeta } from '../incomingDelivery';
import { createMlsServiceStub } from '../test/fixtures/mlsServiceStub';
import {
  createTestConversations,
  createTestMessageReactions,
  emptyConversation,
} from '../test/fixtures/conversationMap';

const groupId = '33333333-3333-4333-8333-333333333333';

function deps(event: string) {
  return {
    mlsService: createMlsServiceStub({
      getUserGroups: vi.fn().mockResolvedValue([{ groupId, name: 'Test', isGroup: true }]),
      getLocalGroups: vi.fn().mockReturnValue([groupId]),
      processIncomingMessage: vi.fn().mockResolvedValue({
        plaintext: encodeAppMessage(mkSystem(event, '{}')),
        author: 'unsigned',
      }),
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

async function deliver(meta: IncomingDeliveryMeta, event = 'no_such_event'): Promise<void> {
  const d = deps(event);
  setupMessageHandler(d as never);
  const onMsg = (d.mlsService as never as { onMessage: { mock: { calls: unknown[][] } } }).onMessage
    .mock.calls[0][0] as (...args: unknown[]) => Promise<boolean>;
  await onMsg('Peer-User', new Uint8Array([9, 9, 9]), groupId, false, undefined, false, meta);
}

beforeEach(() => {
  vi.mocked(takeOwedPulls).mockClear();
  localStorage.clear();
});

describe('the pipeline spends an owed pull', () => {
  it("on a LIVE frame, for the verified sender's device", async () => {
    await deliver({ channel: 'live', senderDeviceId: 'dev-p', queuedMessageId: 'q1' });

    expect(takeOwedPulls).toHaveBeenCalledWith('peer-user:dev-p');
  });

  it('never on a PULLED copy', async () => {
    await deliver({ channel: 'pull', senderDeviceId: 'dev-p', queuedMessageId: 'q2' });

    expect(takeOwedPulls).not.toHaveBeenCalled();
  });

  it("never on the author's own digest", async () => {
    await deliver(
      { channel: 'live', senderDeviceId: 'dev-p', queuedMessageId: 'q3' },
      'history_digest'
    );

    expect(takeOwedPulls).not.toHaveBeenCalled();
  });
});
