/**
 * A PHOTO MUST NOT BECOME THE WORD "PHOTO" BECAUSE THE APP WAS RESTARTED.
 *
 * Reported from production by the user on 2026-09-17: the photo is drawn inside the notification,
 * and opening the conversation shows `📷 Photo` where the image belongs. Their own guess was that
 * the push had consumed the message; it had not, on three independent grounds recorded in the
 * backlog. The content was not lost on the way in - it was overwritten on the way back.
 *
 * `CanariFirebaseMessagingService` writes a cache entry for EVERY frame it decrypts. There is no
 * foreground check there; only the notification is suppressed while the app is open. So a message
 * received by a RUNNING app - rendered from its real envelope over the WebSocket, and acknowledged,
 * which deletes the server's queued copy - still left an entry on disk carrying the notification's
 * caption. The next boot drained it and `saveMessage`, a `put` on the primary key, wrote the
 * caption over the envelope. Nothing repaired it afterwards: an acknowledged message is never
 * delivered again, so `shouldUpgradeMessage` never got its envelope.
 *
 * It needed no race and no unusual timing. "The photo arrived while the app was open, and the app
 * was later restarted" is the whole reproduction, and it is the third case below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IStorage, StoredMessage } from '$lib/db/types';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({ appendLog: vi.fn() }));
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => true }));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { consumeFcmCache } from './fcmCache';

const KEY = 'device-key-b64';
const MESSAGE_ID = 'msg-0000-1111';
const GROUP_ID = 'grp-aaaa-bbbb';

/** The caption `proto_fields.rs` builds for an image, which is all the cache entry carries. */
const CAPTION = '\u{1f4f7} Photo';

/** One entry exactly as the native writers spell it, for an image message. */
const pushEntry = () => ({
  groupId: GROUP_ID,
  messageId: MESSAGE_ID,
  senderId: 'SENDER-1',
  senderName: 'Someone',
  groupName: '',
  content: CAPTION,
  timestamp: 1_700_000_000_000,
  type: 'media',
  mediaKind: 'image',
});

/** The row the MLS pipeline writes: a real media envelope, the thing that draws the picture. */
const envelopeRow = (): StoredMessage => ({
  id: MESSAGE_ID,
  conversationId: GROUP_ID,
  senderId: 'sender-1',
  content: JSON.stringify({ kind: 'media', mediaId: 'blob-1', mediaKind: 'image' }),
  timestamp: 1_700_000_000_000,
  isFcmPreview: false,
});

/** A row that is itself an older push preview - a caption, and nothing richer. */
const previewRow = (): StoredMessage => ({
  ...envelopeRow(),
  content: CAPTION,
  isFcmPreview: true,
});

function fakeStorage(existing: StoredMessage | null) {
  const saveMessage = vi.fn().mockResolvedValue(undefined);
  const storage = {
    getMessage: vi.fn().mockResolvedValue(existing),
    mergeConversation: vi.fn().mockResolvedValue(undefined),
    saveMessage,
  } as unknown as IStorage;
  return { storage, saveMessage };
}

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockResolvedValue([pushEntry()]);
});

describe('consumeFcmCache never downgrades a row it did not write', () => {
  it('injects the preview when no row exists yet - the case the cache is FOR', async () => {
    const { storage, saveMessage } = fakeStorage(null);

    const result = await consumeFcmCache(KEY, storage);

    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(saveMessage.mock.calls[0][0]).toMatchObject({
      id: MESSAGE_ID,
      content: CAPTION,
      isFcmPreview: true,
    });
    expect(result.messages).toHaveLength(1);
  });

  it('replaces an older push preview, which carries no more than this one does', async () => {
    const { storage, saveMessage } = fakeStorage(previewRow());

    const result = await consumeFcmCache(KEY, storage);

    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(result.messages).toHaveLength(1);
  });

  it('leaves a full envelope alone, and does not report it as injected', async () => {
    const before = envelopeRow();
    const { storage, saveMessage } = fakeStorage(before);

    const result = await consumeFcmCache(KEY, storage);

    // THE WRITE IS THE DEFECT, so it is the write that is asserted away. Before 2026-09-17 this
    // call happened and replaced `content` with the caption and `isFcmPreview` with true.
    expect(saveMessage).not.toHaveBeenCalled();
    // AND IT MUST NOT BE REPORTED EITHER: `mergeFcmMessagesIntoConversations` draws whatever this
    // list contains over the in-memory conversation, so a row returned here is a caption painted
    // over a picture already on screen - the same defect, one layer up and without a restart.
    expect(result.messages).toHaveLength(0);
  });
});
