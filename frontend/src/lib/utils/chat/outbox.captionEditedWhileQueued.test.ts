// @vitest-environment happy-dom
/**
 * A CAPTION EDITED WHILE ITS FILE WAS STILL QUEUED STAYS EDITED (owner, 2026-11-11).
 *
 * The real envelope a queued file gets once uploaded is built from its QUEUE ENTRY, which holds the
 * caption typed at the tap. Swapped in whole, it put the old caption back on the author's screen
 * (and, through `persistSent`, at rest) after an edit made offline. The swap now keeps the row's
 * edited caption over the real attachment reference; the frame itself still carries the tap's
 * caption, and the edit's control frame - which names this message, so it waits behind it - is what
 * brings the peers the new one.
 */
import 'fake-indexeddb/auto';
import { SvelteMap } from 'svelte/reactivity';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/mls-client/tabLeader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/tabLeader')>()),
  getIsTabLeader: () => true,
  getTabLeadership: () => 'leader',
  whenTabLeadershipDecided: () => Promise.resolve('leader'),
}));
vi.mock('$lib/mls-client/tabMessageSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/tabMessageSync')>()),
  requestLeaderOutboxFlush: vi.fn(),
  publishOutboxEntrySent: vi.fn(),
  publishOutboxEntryCancelled: vi.fn(),
  publishOutboxEntryFailed: vi.fn(),
  publishOutboxEntryRetired: vi.fn(),
  subscribeTabOutboxEvents: vi.fn(() => () => {}),
}));

import { createOutbox, type OutboxController, type OutboxDeps } from './outbox';
import { IndexedDbStorage } from '$lib/db/indexeddb';
import type { OutboxEntry } from '$lib/db';
import type { Conversation } from '$lib/types';
import type { SentFrame } from '$lib/mls-client/mlsDeliveryApi';
import { MediaKind, decodeAppMessage } from '$lib/proto/codec';
import { mkMediaEnvelope, parseEnvelope, serializeEnvelope } from '$lib/envelope';
import { clearAllUploads } from './uploadProgress.svelte';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
let n = 0;
const freshName = () => `caption-queued-${Date.now()}-${n++}`;

const live: OutboxController[] = [];
afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  clearAllUploads();
});

const accepted = (): SentFrame => ({
  sealed: new Uint8Array(),
  authorProof: new Uint8Array(),
  receivedAt: 1_700_000_000_000,
});

function photo(id: string, sentAt: number): OutboxEntry {
  return {
    id,
    conversationId: 'g1',
    sentAt,
    kind: 'media',
    media: {
      kind: MediaKind.MEDIA_KIND_IMAGE,
      mimeType: 'image/jpeg',
      size: 3,
      fileName: `${id}.jpg`,
      fileBytes: new Uint8Array([1, 2, 3]),
      caption: 'typed at the tap',
    },
    status: 'pending',
    attempts: 0,
    createdAt: sentAt,
  };
}

/** The placeholder row a queued photo is drawn with, optionally edited since. */
function placeholderRow(edited: boolean) {
  const env = mkMediaEnvelope(
    { type: 'image', mediaId: '', key: '', iv: '', mimeType: 'image/jpeg', size: 3 },
    edited ? 'edited while queued' : 'typed at the tap'
  );
  return {
    id: 'A',
    senderId: 'u',
    content: serializeEnvelope(env),
    timestamp: new Date(100),
    isOwn: true,
    status: 'pending',
    ...(edited ? { isEdited: true, editedAt: new Date(150) } : {}),
  };
}

function setup(storage: IndexedDbStorage, edited: boolean) {
  const mlsService = {
    getLocalGroups: vi.fn(() => []),
    getGroupMeta: vi.fn(async (id: string) => ({
      groupId: id,
      name: '',
      isGroup: true,
      deletedAt: null,
    })),
    isGroupActive: vi.fn(async () => true),
    getGroupExclusions: vi.fn(async () => new Map()),
    sendMessage: vi.fn(async () => accepted()),
    waitForMessageQueueIdle: vi.fn(async () => {}),
  } as any;
  const conversations = new SvelteMap<string, Conversation>([
    [
      'g1',
      {
        id: 'g1',
        name: 'g1',
        contactName: 'g1',
        lifecycle: 'active',
        mlsStateHex: null,
        messages: [placeholderRow(edited)],
      } as never,
    ],
  ]);
  const uploadMedia = vi.fn().mockResolvedValue({
    type: 'image',
    mediaId: 'blob-1',
    key: 'aa',
    iv: 'bb',
    mimeType: 'image/jpeg',
    size: 3,
  });
  const outbox = createOutbox({
    userId: 'u',
    deviceKey: () => KEY,
    conversations,
    log: () => {},
    requestReAdd: vi.fn().mockResolvedValue(undefined),
    recoverRosterDisagreement: vi.fn().mockResolvedValue(undefined),
    isGroupHealthy: () => true,
    markDeletedRemotely: vi.fn(),
    mlsService,
    storage,
    uploadMedia,
  } as unknown as OutboxDeps);
  live.push(outbox);
  const shown = () => parseEnvelope(conversations.get('g1')!.messages[0].content);
  return { outbox, mlsService, shown };
}

describe('a queued file whose caption was edited before it left', () => {
  it('keeps the EDITED caption over the real attachment once uploaded', async () => {
    const storage = new IndexedDbStorage(freshName());
    await storage.init();
    const { outbox, mlsService, shown } = setup(storage, true);
    await storage.saveOutboxEntry(photo('A', 100), KEY);

    await outbox.flush();
    await vi.waitFor(() => expect(mlsService.sendMessage).toHaveBeenCalledTimes(1));

    const env = shown();
    expect(env.kind === 'media' && env.media.mediaId).toBe('blob-1');
    expect(env.kind === 'media' && env.caption).toBe('edited while queued');
    // The frame is the message as sent at the tap; the edit follows it as its own control frame.
    const frame = decodeAppMessage(mlsService.sendMessage.mock.calls[0][1]);
    expect(frame?.media?.caption).toBe('typed at the tap');
    storage.close();
  });

  it('takes the tap caption when nothing was edited', async () => {
    const storage = new IndexedDbStorage(freshName());
    await storage.init();
    const { outbox, mlsService, shown } = setup(storage, false);
    await storage.saveOutboxEntry(photo('A', 100), KEY);

    await outbox.flush();
    await vi.waitFor(() => expect(mlsService.sendMessage).toHaveBeenCalledTimes(1));

    const env = shown();
    expect(env.kind === 'media' && env.media.mediaId).toBe('blob-1');
    expect(env.kind === 'media' && env.caption).toBe('typed at the tap');
    storage.close();
  });
});
