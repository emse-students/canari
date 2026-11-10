/**
 * A FILE SENT AS A REPLY, IN THE OUTBOX (review of #3307).
 *
 * Two promises, both about a queued media row:
 *
 * 1. IT WAITS FOR WHAT IT QUOTES. `dependsOnAny` reads the queue's rows, and the queue read leaves a
 *    media row's encrypted payload undecoded - so its `replyTo` is unknown there. These cases read
 *    the queue through the REAL IndexedDB store (no mocked read), prove the premise (the slim row
 *    has no `replyTo`) and then that photo B, quoting a photo A still uploading, goes nowhere.
 * 2. NO AWAIT FROM THE GATES TO THE SEND. The quote decision (`decideQuote`: a store read and a
 *    round trip for the exclusion windows) is taken BEFORE the seal barrier, so the gates and the
 *    send follow with nothing awaited in between. Asserted by ORDER, never by a clock.
 */
// @vitest-environment happy-dom
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
import { MediaKind } from '$lib/proto/codec';
import { clearAllUploads } from './uploadProgress.svelte';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
let n = 0;
const freshName = () => `reply-file-${Date.now()}-${n++}`;

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

const REPLY = { id: 'quoted-A', senderId: 'bob', preview: 'the photo before' };

function photo(id: string, sentAt: number, over: Partial<OutboxEntry> = {}): OutboxEntry {
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
    },
    status: 'pending',
    attempts: 0,
    createdAt: sentAt,
    ...over,
  };
}

function setup(storage: IndexedDbStorage, over: Partial<OutboxDeps> = {}) {
  const order: string[] = [];
  const mlsService = {
    getLocalGroups: vi.fn(() => []),
    getGroupMeta: vi.fn(async (id: string) => ({
      groupId: id,
      name: '',
      isGroup: true,
      deletedAt: null,
    })),
    isGroupActive: vi.fn(async () => {
      order.push('gate: active');
      return true;
    }),
    getGroupExclusions: vi.fn(async () => {
      order.push('quote decided');
      return new Map();
    }),
    sendMessage: vi.fn(async () => {
      order.push('send');
      return accepted();
    }),
    waitForMessageQueueIdle: vi.fn(async (caller: string) => {
      order.push(`barrier: ${caller}`);
    }),
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
        messages: [],
      } as never,
    ],
  ]);
  const deps = {
    userId: 'u',
    deviceKey: () => KEY,
    conversations,
    log: () => {},
    requestReAdd: vi.fn().mockResolvedValue(undefined),
    recoverRosterDisagreement: vi.fn().mockResolvedValue(undefined),
    isGroupHealthy: () => {
      order.push('gate: healthy');
      return true;
    },
    markDeletedRemotely: vi.fn(),
    mlsService,
    storage,
    ...over,
  } as OutboxDeps;
  const outbox = createOutbox(deps);
  live.push(outbox);
  return { outbox, mlsService, order };
}

describe('a file sent as a reply waits for what it quotes', () => {
  it('the real queue read leaves its quote undecoded - the premise the fix rests on', async () => {
    const storage = new IndexedDbStorage(freshName());
    await storage.init();
    await storage.saveOutboxEntry(photo('B', 200, { replyTo: REPLY }), KEY);

    const [slim] = await storage.getOutboxQueue(KEY);
    expect(slim.id).toBe('B');
    expect(slim.replyTo).toBeUndefined();
    expect((await storage.getOutboxEntry('B', KEY))?.replyTo).toEqual(REPLY);
    storage.close();
  });

  it('photo B quoting photo A, still uploading, is held: it neither uploads nor sends before A', async () => {
    const storage = new IndexedDbStorage(freshName());
    await storage.init();
    // A's upload never ends in this test: A stays unsent for the whole pass.
    const uploadMedia = vi.fn(() => new Promise<never>(() => {}));
    const { outbox, mlsService } = setup(storage, { uploadMedia } as Partial<OutboxDeps>);
    await storage.saveOutboxEntry(photo('quoted-A', 100), KEY);
    await storage.saveOutboxEntry(photo('B', 200, { replyTo: REPLY }), KEY);

    // Not awaited: the flush waits on A's upload, which never ends here.
    void outbox.flush();
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalled());
    for (let i = 0; i < 200; i++) await Promise.resolve();

    // Only A was handed to the upload; B waited behind it, and nothing went out.
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect((await storage.getOutboxQueue(KEY)).map((e) => e.id)).toEqual(['quoted-A', 'B']);
    storage.close();
  });

  it('a file quoting a message that is NOT queued is not held', async () => {
    const storage = new IndexedDbStorage(freshName());
    await storage.init();
    const uploadMedia = vi.fn().mockResolvedValue({
      type: 'image',
      mediaId: 'mid',
      key: 'aa',
      iv: 'bb',
      mimeType: 'image/jpeg',
      size: 3,
    });
    const { outbox, mlsService } = setup(storage, { uploadMedia } as Partial<OutboxDeps>);
    await storage.saveOutboxEntry(photo('B', 200, { replyTo: REPLY }), KEY);

    await outbox.flush();
    await vi.waitFor(() => expect(mlsService.sendMessage).toHaveBeenCalledTimes(1));
    storage.close();
  });
});

describe('a file sent as a reply: nothing awaited from the gates to the send', () => {
  it('the quote is decided BEFORE the seal barrier, and no await separates the gates from the send', async () => {
    const storage = new IndexedDbStorage(freshName());
    await storage.init();
    const { outbox, order } = setup(storage);
    await storage.saveOutboxEntry(
      photo('B', 200, {
        replyTo: REPLY,
        media: {
          kind: MediaKind.MEDIA_KIND_IMAGE,
          mimeType: 'image/jpeg',
          size: 3,
          uploadedRef: { mediaId: 'mid-B', key: 'aa', iv: 'bb' },
        },
      }),
      KEY
    );

    await outbox.flush();
    await vi.waitFor(() => expect(order).toContain('send'));

    expect(order.filter((s) => s === 'quote decided')).toHaveLength(1);
    const decided = order.indexOf('quote decided');
    const barrier = order.indexOf('barrier: outbox media seal');
    const firstGate = Math.min(
      ...['gate: healthy', 'gate: active'].map((g) => order.indexOf(g)).filter((i) => i >= 0)
    );
    const send = order.indexOf('send');
    expect(decided).toBeGreaterThanOrEqual(0);
    expect(decided).toBeLessThan(barrier);
    expect(barrier).toBeLessThan(firstGate);
    // Nothing the quote needs (the store read, the exclusion round trip) runs after the gates.
    expect(order.slice(firstGate, send)).not.toContain('quote decided');
    expect(firstGate).toBeLessThan(send);
    storage.close();
  });
});
