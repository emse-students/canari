import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
  saveMlsStateEncrypted: vi.fn().mockResolvedValue(undefined),
  purgeLegacyPlainMlsState: vi.fn().mockResolvedValue(undefined),
  fromBase64: vi.fn(() => new Uint8Array([1])),
  toBase64: vi.fn((bytes: Uint8Array) => `b64:${bytes.length}`),
}));

vi.mock('$lib/utils/users/displayName', () => ({
  resolveDisplayNames: vi.fn(async () => (id: string) => id),
  getUserDisplayNameSync: vi.fn((id: string) => id),
}));

vi.mock('$lib/utils/chat/recovery', () => ({
  requestReAdd: vi.fn().mockResolvedValue(undefined),
  cancelReAdd: vi.fn(),
  reAddIsInFlight: vi.fn(() => false),
  resetReAddCooldowns: vi.fn(),
}));

import { setupMessageHandler } from './setupMessageHandler';
import { encodeAppMessage, mkCallHangup, mkVisibleSystem } from '$lib/proto/codec';
import { createMlsServiceStub } from '../test/fixtures/mlsServiceStub';
import {
  createTestConversations,
  createTestMessageReactions,
  emptyConversation,
} from '../test/fixtures/conversationMap';

/**
 * THE FRAME'S `sentAt` REACHES THE NOTICE THROUGH BOTH ENTRY POINTS OF THE PIPELINE.
 *
 * `handleSystemEvent` dates a notice by the context it is handed (`sentAt` and the delivery's
 * `queuedCreatedAt`); these tests enter through `setupMessageHandler` itself - a live frame for a
 * held group, and a frame buffered before its Welcome and replayed after it - so a call site that
 * stops passing `sentAt` fails here, not only the handler's own spec.
 */

const GROUP = '22222222-2222-4222-8222-222222222222';
const SENT_AT = Date.UTC(2026, 10, 1, 9, 0, 0);
const SERVER_AT = SENT_AT + 40;
/** The phone drains the frame six hours late - the instant the notice must NOT carry. */
const LATE = SENT_AT + 6 * 60 * 60 * 1000;

function world(
  held: boolean,
  frame: ReturnType<typeof mkCallHangup> = mkVisibleSystem(
    'memberAdded',
    JSON.stringify({ newUsers: ['a', 'b'] })
  )
) {
  const conversations = createTestConversations(
    held ? [[GROUP, emptyConversation(GROUP, { lifecycle: 'active' })]] : []
  );
  frame.sentAt = SENT_AT;
  const mls = createMlsServiceStub({
    getUserGroups: vi.fn().mockResolvedValue([{ groupId: GROUP, name: 'Groupe', isGroup: true }]),
    getLocalGroups: vi.fn().mockReturnValue(held ? [GROUP] : []),
    processIncomingMessage: vi.fn().mockResolvedValue({
      plaintext: encodeAppMessage(frame),
      author: { kind: 'unsigned' },
    }),
    processWelcome: vi.fn().mockResolvedValue(GROUP),
    getDeviceId: vi.fn().mockReturnValue('phone'),
  });
  const addMessageToChat = vi.fn().mockResolvedValue(undefined);
  const onCallSignal = vi.fn();
  setupMessageHandler({
    mlsService: mls,
    storage: null,
    userId: 'owner',
    deviceKey: () => 'device-key',
    historyBaseUrl: 'https://hist',
    conversations,
    messageReactions: createTestMessageReactions(),
    recoveryTimers: new Map(),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    addMessageToChat,
    loadHistoryForConversation: vi.fn().mockResolvedValue(undefined),
    onGroupReady: vi.fn(),
    log: vi.fn(),
    onCallSignal,
  } as never);
  const onMessage = (mls.onMessage as unknown as { mock: { calls: unknown[][] } }).mock
    .calls[0][0] as (
    sender: string,
    content: Uint8Array,
    groupId: string | undefined,
    isWelcome: boolean,
    ratchetTree: Uint8Array | undefined,
    isCommit: boolean,
    deliveryMeta?: { queuedCreatedAt?: number }
  ) => Promise<boolean>;
  return { onMessage, addMessageToChat, onCallSignal, frame };
}

/** The options the notice row was written with. */
function noticeOptions(addMessageToChat: ReturnType<typeof vi.fn>) {
  const call = addMessageToChat.mock.calls.find((c) => c[0] === 'system');
  expect(call, 'a notice was written').toBeDefined();
  return call![3] as { messageId?: string; timestamp?: Date; serverTimestamp?: number };
}

describe('setupMessageHandler hands the frame time to the notice it draws', () => {
  it('a live frame for a held group: the notice carries its sentAt and server time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LATE);
    try {
      const { onMessage, addMessageToChat, frame } = world(true);
      await onMessage('owner', new Uint8Array([7]), GROUP, false, undefined, false, {
        queuedCreatedAt: SERVER_AT,
      });
      const options = noticeOptions(addMessageToChat);
      expect(options.messageId).toBe(frame.messageId);
      expect(options.timestamp?.getTime()).toBe(SENT_AT);
      expect(options.serverTimestamp).toBe(SERVER_AT);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a frame buffered before its Welcome: the replay carries the same times', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LATE);
    try {
      const { onMessage, addMessageToChat, frame } = world(false);
      // Unknown group: buffered, kept in the server queue.
      await onMessage('owner', new Uint8Array([7]), GROUP, false, undefined, false, {
        queuedCreatedAt: SERVER_AT,
      });
      expect(addMessageToChat).not.toHaveBeenCalled();
      // The Welcome installs the group and replays what was held.
      await onMessage('owner', new Uint8Array([8]), GROUP, true, undefined, false);
      const options = noticeOptions(addMessageToChat);
      expect(options.messageId).toBe(frame.messageId);
      expect(options.timestamp?.getTime()).toBe(SENT_AT);
      expect(options.serverTimestamp).toBe(SERVER_AT);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a call signal reaches the call record with its frame time, not the drain instant', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LATE);
    try {
      const { onMessage, onCallSignal } = world(true, mkCallHangup('call-1', 'pc', 'cancelled'));
      await onMessage('owner', new Uint8Array([7]), GROUP, false, undefined, false, {
        queuedCreatedAt: SERVER_AT,
      });
      expect(onCallSignal).toHaveBeenCalledTimes(1);
      const at = onCallSignal.mock.calls[0][3] as { timestamp: Date; serverTimestamp?: number };
      expect(at.timestamp.getTime()).toBe(SENT_AT);
      expect(at.serverTimestamp).toBe(SERVER_AT);
    } finally {
      vi.useRealTimers();
    }
  });
});
