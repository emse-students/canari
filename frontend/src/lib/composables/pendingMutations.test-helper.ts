/**
 * One device, as a catch-up drain runs it: the real messaging store (`useMessaging`), the real system
 * handler, the real reaction path, and a REAL local store (`IndexedDbStorage` over `fake-indexeddb`)
 * that every half reads and writes - so a test of a mutation that comes before its message sees what
 * the device would keep, show and relay. Imported by the tests of `pendingMutations.ts`' seams only.
 */
import 'fake-indexeddb/auto';
import { vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import type { RecordedAuthorship } from '$lib/crypto/messageAuthorship';
import type { IndexedDbStorage } from '$lib/db/indexeddb';
import { handleSystemEvent } from '$lib/mls-client/messagePipeline/systemMessageHandler';
import { applyReactionFrame } from '$lib/mls-client/messagePipeline/reactionFrame';

/** A device key `encryptData` accepts. */
export const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
/** Another device's key: what this device cannot open. */
export const OTHER_KEY = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
export const ME = 'me-user-id';
export const CONVO = 'conversation-key';
/** The phase a catch-up drain opens (`BaseMlsService`). */
export const DRAIN = { bufferUi: true, showOverlay: true };

let n = 0;

type UseMessaging = typeof import('./useMessaging.svelte').useMessaging;
type MessagingContext = import('./useMessaging.svelte').MessagingContext;

/**
 * A fresh store's name. The store itself is opened by the test file: a backend is named in
 * `db.ts` and in tests only (`backendChoice.test.ts`), and this module is neither.
 */
export function freshStoreName(): string {
  return `pending-device-${Date.now()}-${n++}`;
}

/**
 * A device over `storage`: its conversation as the boot restore seeds it (the row, no message shown),
 * its messaging store and its context. `useMessaging` is passed in because the test module mocks
 * its imports before loading it.
 */
export function makeDevice(useMessaging: UseMessaging, storage: IndexedDbStorage) {
  const messaging = useMessaging();
  const conversations = new SvelteMap<string, Conversation>([
    [CONVO, { id: CONVO, name: CONVO, messages: [], unreadCount: 0, lastMessageAt: 0 } as never],
  ]);
  const ctx = {
    conversations,
    userId: ME,
    deviceKeyB64: KEY,
    authToken: 'token',
    selectedContact: '',
    storage,
    setAuthToken: vi.fn(),
    getSendError: () => '',
    setSendError: vi.fn(),
    ensureMls: vi.fn(),
    log: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    playNotificationTone: vi.fn(),
    playReceiveTone: vi.fn(),
    sendSystemNotification: vi.fn().mockResolvedValue(undefined),
  } as unknown as MessagingContext;
  const shown = () => conversations.get(CONVO)?.messages ?? [];
  return { messaging, ctx, conversations, storage, shown };
}

/** What a system frame's handler is given, for `by`, over the device's own state. */
export function systemContext(
  device: ReturnType<typeof makeDevice>,
  by: string,
  extra: Record<string, unknown> = {}
) {
  const { messaging, ctx, conversations, storage } = device;
  return {
    mlsService: {
      getDeviceId: () => 'device-me',
      getGroupWithheld: async () => new Map([[ME, []]]),
    },
    storage,
    userId: ME,
    deviceKey: () => KEY,
    conversations,
    messageReactions: messaging.messageReactions,
    addMessageToChat: (s: string, c: string, k: string, o: never) =>
      messaging.addMessageToChat(s, c, k, ctx, o),
    batchAddMessages: (msgs: never, k: string, origin: never) =>
      messaging.batchAddMessages(msgs, k, ctx, origin),
    deleteConversation: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convo: conversations.get(CONVO),
    convoKey: CONVO,
    senderNorm: by,
    persistMlsStateNow: vi.fn(),
    deliveryMeta: { queuedCreatedAt: 9_000 },
    ...extra,
  } as never;
}

/** A `delete_message` from `by`, through the real handler. */
export function deleteFrame(device: ReturnType<typeof makeDevice>, by: string, messageId: string) {
  return handleSystemEvent('delete_message', { messageId }, systemContext(device, by));
}

/** An `edit_message` from `by`, dated `editedAt` by its sender. */
export function editFrame(
  device: ReturnType<typeof makeDevice>,
  by: string,
  messageId: string,
  newContent: string,
  editedAt: number
) {
  return handleSystemEvent(
    'edit_message',
    { messageId, newContent, editedAt },
    systemContext(device, by)
  );
}

/** A reaction frame from `by`, through the one reaction path. */
export function reactionFrame(
  device: ReturnType<typeof makeDevice>,
  by: string,
  messageId: string,
  emoji: string,
  at: number,
  removed = false,
  proof?: RecordedAuthorship
) {
  const { messaging, ctx, conversations, storage } = device;
  return applyReactionFrame(
    {
      storage,
      deviceKey: () => KEY,
      conversations,
      messageReactions: messaging.messageReactions,
      log: ctx.log,
    },
    CONVO,
    by,
    { messageId, emoji, at, removed },
    proof,
    9_000
  );
}

/** A message from `by`, as the drain hands it over. */
export function bodyFrame(
  device: ReturnType<typeof makeDevice>,
  by: string,
  messageId: string,
  text: string
) {
  return device.messaging.addMessageToChat(by, text, CONVO, device.ctx, {
    messageId,
    serverTimestamp: 2_000,
  });
}
