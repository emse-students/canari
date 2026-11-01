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
/** Which native platform the run is on - the extension's ids are recorded on iOS only. */
const platform = { ios: false };
vi.mock('$lib/utils/appVersion', () => ({ isIosTauriRuntime: () => platform.ios }));
const recordNotified = vi.fn();
vi.mock('$lib/utils/chat/notifiedMessages', () => ({
  recordNotified: (...a: unknown[]) => recordNotified(...a),
}));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { consumeFcmCache, placeholderIdentityForPushEntry, pushCacheMessageIds } from './fcmCache';

const KEY = 'device-key-b64';
const SELF = 'me-0000-0000';
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

/** The native side's answers: `take_fcm_cache` hands `entries` over, `ack_fcm_cache` deletes. */
const FILES = [{ name: 'fcm_message_cache.taken.0.ndjson', bytes: 128 }];

function taking(entries: unknown[], files = FILES) {
  invoke.mockImplementation(async (cmd: string) =>
    cmd === 'take_fcm_cache' ? { entries, files } : files.length
  );
}

const acks = () => invoke.mock.calls.filter(([cmd]) => cmd === 'ack_fcm_cache');

beforeEach(() => {
  vi.clearAllMocks();
  platform.ios = false;
  taking([pushEntry()]);
});

/**
 * WHAT THE iOS EXTENSION PRESENTED IS A MESSAGE ALREADY NOTIFIED - by id, and before the take erases
 * it (iPhone 12, `1.5.4-alpha.1`, 2026-11-01: a message the extension had shown was announced again
 * by the app after the cold start that followed).
 */
describe('the push cache is the record of what the extension presented', () => {
  it('records every taken id as notified on iOS, even one the injection drops', async () => {
    platform.ios = true;
    const { storage } = fakeStorage(envelopeRow());
    await consumeFcmCache(KEY, storage, SELF);
    expect(recordNotified).toHaveBeenCalledWith(SELF, [MESSAGE_ID]);
  });

  it('records nothing off iOS, where an entry does not prove a banner', async () => {
    const { storage } = fakeStorage(null);
    await consumeFcmCache(KEY, storage, SELF);
    expect(recordNotified).not.toHaveBeenCalled();
  });

  it('reads the ids still in the cache on iOS, and asks nothing elsewhere', async () => {
    invoke.mockResolvedValue(['a', 'b']);
    expect([...(await pushCacheMessageIds())]).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
    platform.ios = true;
    expect([...(await pushCacheMessageIds())]).toEqual(['a', 'b']);
    expect(invoke).toHaveBeenCalledWith('push_cache_message_ids');
  });
});

describe('consumeFcmCache never downgrades a row it did not write', () => {
  it('injects the preview when no row exists yet - the case the cache is FOR', async () => {
    const { storage, saveMessage } = fakeStorage(null);

    const result = await consumeFcmCache(KEY, storage, SELF);

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

    const result = await consumeFcmCache(KEY, storage, SELF);

    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(result.messages).toHaveLength(1);
  });

  it('leaves a full envelope alone, and does not report it as injected', async () => {
    const before = envelopeRow();
    const { storage, saveMessage } = fakeStorage(before);

    const result = await consumeFcmCache(KEY, storage, SELF);

    // THE WRITE IS THE DEFECT, so it is the write that is asserted away. Before 2026-09-17 this
    // call happened and replaced `content` with the caption and `isFcmPreview` with true.
    expect(saveMessage).not.toHaveBeenCalled();
    // AND IT MUST NOT BE REPORTED EITHER: `mergeFcmMessagesIntoConversations` draws whatever this
    // list contains over the in-memory conversation, so a row returned here is a caption painted
    // over a picture already on screen - the same defect, one layer up and without a restart.
    expect(result.messages).toHaveLength(0);
  });

  it('draws a system event as a banner only - no row, so no bubble with no subject', async () => {
    taking([
      { ...pushEntry(), content: 'a ajouté un membre au groupe', type: 'system', mediaKind: null },
    ]);
    const { storage, saveMessage } = fakeStorage(null);

    const result = await consumeFcmCache(KEY, storage, SELF);

    expect(saveMessage).not.toHaveBeenCalled();
    expect(result.messages).toHaveLength(0);
    expect(result.placeholders.size).toBe(0);
  });
});

/**
 * A DM ARRIVING BY PUSH MUST NOT BE A GROUP, AND THE PUSH ALREADY SAID SO.
 *
 * Reported by the user on 2026-09-18 as two defects - no profile photo on a first contact until the
 * app is restarted, and "it is square instead of round for people". One cause: the placeholder row
 * carried a label and no type, so `buildConversationRow` wrote `group`, and a group is drawn with
 * `GroupAvatar` - a rounded square with no user whose photo to fetch.
 *
 * The three cases below are the three states of `groupName`, and the middle one is the whole point:
 * ABSENT is not EMPTY. A cache file written by an older native build has no such key, and reading
 * that as "DM" would invent a peer out of whoever happened to message first.
 */
/**
 * THE CACHE IS DELETED ONLY ONCE IT IS PERSISTED. The read used to delete the file before a single
 * `saveMessage`, so a process death in between lost the entries - and a quick reply's entry is the
 * only local record of a message the device sent. The native side now keeps what it handed over
 * until this acknowledgement, and replays it otherwise.
 */
describe('consumeFcmCache acknowledges the take only after writing it', () => {
  it('acknowledges exactly the files it was handed, after the write', async () => {
    const { storage, saveMessage } = fakeStorage(null);
    saveMessage.mockImplementation(async () => {
      expect(acks()).toHaveLength(0);
    });

    await consumeFcmCache(KEY, storage, SELF);

    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(acks()).toEqual([['ack_fcm_cache', { files: FILES }]]);
  });

  it('runs one take at a time: a second caller takes only after the first acknowledged', async () => {
    const order: string[] = [];
    invoke.mockImplementation(async (cmd: string) => {
      order.push(cmd);
      return cmd === 'take_fcm_cache' ? { entries: [pushEntry()], files: FILES } : 1;
    });
    const { storage } = fakeStorage(null);

    await Promise.all([consumeFcmCache(KEY, storage, SELF), consumeFcmCache(KEY, storage, SELF)]);

    expect(order).toEqual(['take_fcm_cache', 'ack_fcm_cache', 'take_fcm_cache', 'ack_fcm_cache']);
  });

  it('acknowledges a take that held only unparsable lines, and asks nothing when nothing was taken', async () => {
    const { storage } = fakeStorage(null);
    taking([]);
    await consumeFcmCache(KEY, storage, SELF);
    expect(acks()).toEqual([['ack_fcm_cache', { files: FILES }]]);

    invoke.mockClear();
    taking([], []);
    await consumeFcmCache(KEY, storage, SELF);
    expect(acks()).toHaveLength(0);
  });
});

describe('placeholderIdentityForPushEntry reads the type the push already carried', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    groupId: GROUP_ID,
    senderId: 'PEER-1',
    senderName: 'Someone',
    ...over,
  });

  it('an empty groupName is a DM, and the sender is the peer', () => {
    const id = placeholderIdentityForPushEntry(entry({ groupName: '' }), SELF);

    expect(id.conversationType).toBe('direct');
    expect(id.directPeerId).toBe('peer-1');
    expect(id.contactName).toBe('peer-1');
    // The canonical key, not the sender's display name: `ConversationMeta` has no type column, so
    // this string is the only thing a later boot can read the identity back out of.
    expect(id.name).toBe(`${SELF}::peer-1`);
  });

  it('a named groupName is a group, and the name is the label', () => {
    const id = placeholderIdentityForPushEntry(entry({ groupName: 'Les gourmands' }), SELF);

    expect(id.conversationType).toBe('group');
    expect(id.name).toBe('Les gourmands');
    expect(id.directPeerId).toBeUndefined();
  });

  it('an ABSENT groupName says nothing, and so does the identity', () => {
    const id = placeholderIdentityForPushEntry(entry(), SELF);

    // No type at all - the builder's own default then stands, which is what an entry written by a
    // pre-2026-09-15 native build has always got. Learning nothing is not learning `group`.
    expect(id.conversationType).toBeUndefined();
    expect(id.directPeerId).toBeUndefined();
    expect(id.name).toBe('Someone');
  });

  it('refuses to make this device its own peer', () => {
    const id = placeholderIdentityForPushEntry(entry({ groupName: '', senderId: SELF }), SELF);

    // A push from our own device for a DM cannot say who the other member is, and answering
    // "myself" would be a conversation with oneself - the exact row the roster repair exists for.
    expect(id.conversationType).toBeUndefined();
  });
});

/**
 * THE STATE AN EMPTY NAME COULD NEVER EXPRESS: A GROUP NOBODY NAMED.
 *
 * `groupName` was asked to be the label AND the discriminator, and it cannot be both - `''` is a DM
 * and also a group whose `name` column is null. Measured on production 2026-09-21: **467 of 1433
 * ordinary groups have no name, 374 of them past MLS epoch 0**, so the state is a third of the
 * population and not a curiosity. Each of those pushes produced a DM row with its first sender as
 * the peer: the wrong avatar, the wrong identity, and a `self::peer` key pointing at a person who
 * is merely one member of a group.
 *
 * The answer now travels as its own field. These cases pin that it is consulted FIRST, that an
 * older cache file still reads exactly as it did, and that absent still means absent.
 */
describe('placeholderIdentityForPushEntry - the kind comes from the wire, not from the label', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    groupId: GROUP_ID,
    senderId: 'PEER-1',
    senderName: 'Someone',
    ...over,
  });

  it('AN UNNAMED GROUP IS A GROUP, not a DM with whoever spoke first', () => {
    const id = placeholderIdentityForPushEntry(entry({ groupName: '', isGroup: true }), SELF);

    expect(id.conversationType).toBe('group');
    // Nothing to label it with, so it keeps the last resort - but it is not given a peer.
    expect(id.directPeerId).toBeUndefined();
    expect(id.name).toBe('Someone');
  });

  it('says group even when the push carried no name key at all', () => {
    const id = placeholderIdentityForPushEntry(entry({ isGroup: true }), SELF);

    expect(id.conversationType).toBe('group');
    expect(id.directPeerId).toBeUndefined();
  });

  it('a DM says so outright now, and still resolves to the sender as peer', () => {
    const id = placeholderIdentityForPushEntry(entry({ groupName: '', isGroup: false }), SELF);

    expect(id.conversationType).toBe('direct');
    expect(id.directPeerId).toBe('peer-1');
    expect(id.name).toBe(`${SELF}::peer-1`);
  });

  it('the name still wins as the LABEL when there is one', () => {
    const id = placeholderIdentityForPushEntry(
      entry({ groupName: 'Les gourmands', isGroup: true }),
      SELF
    );

    expect(id.conversationType).toBe('group');
    expect(id.name).toBe('Les gourmands');
  });

  it('an entry from an older native build behaves exactly as it did before', () => {
    // No `isGroup` key: the pre-2026-09-21 readings must be untouched, both of them.
    expect(placeholderIdentityForPushEntry(entry({ groupName: '' }), SELF).conversationType).toBe(
      'direct'
    );
    expect(placeholderIdentityForPushEntry(entry(), SELF).conversationType).toBeUndefined();
  });

  it('still refuses to make this device its own peer, whatever the wire says', () => {
    const id = placeholderIdentityForPushEntry(
      entry({ groupName: '', isGroup: false, senderId: SELF }),
      SELF
    );

    expect(id.conversationType).toBeUndefined();
  });
});
