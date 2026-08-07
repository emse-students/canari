import { SvelteMap } from 'svelte/reactivity';

// Encryption is leader-only (WP-MULTITAB-1), so every flush case here is a leader unless it says
// otherwise. The cross-tab channel is stubbed too: what matters is which side is asked to act,
// not that a BroadcastChannel exists under happy-dom.
const isTabLeaderMock = vi.hoisted(() => vi.fn(() => true));
const tabOutboxMock = vi.hoisted(() => ({
  requestLeaderOutboxFlush: vi.fn(),
  publishOutboxEntrySent: vi.fn(),
  subscribeTabOutboxEvents: vi.fn(() => () => {}),
}));
// Only the leadership answer is overridden: this module is pulled in transitively by the session
// singleton, which registers the promotion/demotion handlers at import time.
vi.mock('$lib/mls-client/tabLeader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/tabLeader')>()),
  getIsTabLeader: () => isTabLeaderMock(),
}));
vi.mock('$lib/mls-client/tabMessageSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/tabMessageSync')>()),
  ...tabOutboxMock,
}));

import { createOutbox, buildOutboxProto, type OutboxDeps } from './outbox';
import { toMirrorEntry } from './outboxMirror';
import { MediaKind } from '$lib/proto/codec';
import { encodeOutboxSensitive, decodeOutboxEntry, outboxClearColumns } from '$lib/db/outboxCodec';
import { connectivity } from '$lib/stores/connectivity.svelte';
import type { OutboxEntry } from '$lib/db';
import type { Conversation } from '$lib/types';
import { recentSentSince, resetRecentSendsForTests } from '$lib/utils/chat/recentSends';

/**
 * A control entry, optionally flagged as the replay of something already sent once.
 *
 * `sentAt` is NOW, not the epoch-ish constant the other fixtures use: `recentSends` filters on a
 * five-minute retention window, so a `sentAt` of 50 is discarded by age and both the positive and
 * the negative assertion would read an empty ring - the negative one passing for the wrong reason.
 */
function controlEntry(id: string, isRetransmission: boolean): OutboxEntry {
  const now = Date.now();
  return {
    id,
    conversationId: 'g1',
    sentAt: now,
    kind: 'control',
    controlProto: new Uint8Array([9, 8, 7]),
    isRetransmission,
    status: 'pending',
    attempts: 0,
    createdAt: now,
  };
}

function textEntry(id: string, conversationId: string, sentAt: number): OutboxEntry {
  return {
    id,
    conversationId,
    sentAt,
    kind: 'text',
    text: `hello ${id}`,
    status: 'pending',
    attempts: 0,
    createdAt: sentAt,
  };
}

/** Minimal in-memory IStorage covering the outbox + saveMessage surface the flusher touches. */
function makeStorage(seed: OutboxEntry[] = []) {
  const map = new Map<string, OutboxEntry>(seed.map((e) => [e.id, structuredClone(e)]));
  return {
    _map: map,
    saveMessage: vi.fn().mockResolvedValue(undefined),
    saveOutboxEntry: vi.fn(async (e: OutboxEntry) => {
      map.set(e.id, structuredClone(e));
    }),
    getOutboxEntries: vi.fn(async () =>
      [...map.values()].sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id))
    ),
    getOutboxEntriesForConversation: vi.fn(async (cid: string) =>
      [...map.values()].filter((e) => e.conversationId === cid)
    ),
    updateOutboxEntry: vi.fn(async (id: string, patch: Partial<OutboxEntry>) => {
      const e = map.get(id);
      if (e) map.set(id, { ...e, ...patch });
    }),
    deleteOutboxEntry: vi.fn(async (id: string) => {
      map.delete(id);
    }),
  } as any;
}

/** mlsService stub: a group is "alive" by default; `meta` overrides per-group metadata. */
function makeMls(opts: { meta?: (id: string) => unknown; send?: () => Promise<void> } = {}) {
  return {
    getLocalGroups: vi.fn(() => []),
    getGroupMeta: vi.fn(async (id: string) =>
      opts.meta ? opts.meta(id) : { groupId: id, name: '', isGroup: true, deletedAt: null }
    ),
    sendMessage: vi.fn(opts.send ?? (async () => {})),
    waitForMessageQueueIdle: vi.fn(async () => {}),
  } as any;
}

function convoWith(id: string, messageIds: string[]): Conversation {
  return {
    id,
    name: id,
    contactName: id,
    lifecycle: 'pending',
    mlsStateHex: null,
    messages: messageIds.map((mid) => ({
      id: mid,
      senderId: 'u',
      content: 'x',
      timestamp: new Date(1000),
      isOwn: true,
      status: 'pending' as const,
    })),
  };
}

function makeDeps(over: Partial<OutboxDeps> & { mlsService: any; storage: any }): OutboxDeps {
  return {
    userId: 'u',
    deviceKeyB64: 'device-key',
    conversations: new SvelteMap<string, Conversation>(),
    log: () => {},
    requestReAdd: vi.fn().mockResolvedValue(undefined),
    isGroupHealthy: () => true,
    markDeletedRemotely: vi.fn(),
    ...over,
  } as OutboxDeps;
}

describe('outboxCodec', () => {
  it('round-trips a text entry through clear columns + encrypted payload', () => {
    const e = textEntry('m1', 'g1', 123);
    const decoded = decodeOutboxEntry(outboxClearColumns(e), encodeOutboxSensitive(e));
    expect(decoded).toMatchObject({
      id: 'm1',
      conversationId: 'g1',
      sentAt: 123,
      kind: 'text',
      text: 'hello m1',
    });
  });

  it('round-trips media file bytes via base64', () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 255]);
    const e: OutboxEntry = {
      id: 'm2',
      conversationId: 'g1',
      sentAt: 1,
      kind: 'media',
      media: { kind: 1, mimeType: 'image/png', size: 5, fileBytes: bytes },
      status: 'pending',
      attempts: 0,
      createdAt: 1,
    };
    const decoded = decodeOutboxEntry(outboxClearColumns(e), encodeOutboxSensitive(e));
    expect(Array.from(decoded.media!.fileBytes!)).toEqual([1, 2, 3, 250, 255]);
  });

  it('round-trips a control entry proto via base64', () => {
    const e: OutboxEntry = {
      id: 'c1',
      conversationId: 'g1',
      sentAt: 7,
      kind: 'control',
      controlProto: new Uint8Array([9, 8, 7, 254]),
      status: 'pending',
      attempts: 0,
      createdAt: 7,
    };
    const decoded = decodeOutboxEntry(outboxClearColumns(e), encodeOutboxSensitive(e));
    expect(decoded.kind).toBe('control');
    expect(Array.from(decoded.controlProto!)).toEqual([9, 8, 7, 254]);
  });
});

describe('outbox native mirror', () => {
  it('projects a text entry to a mirror row carrying the base64 plaintext proto', () => {
    const e = textEntry('m1', 'g1', 123);
    const mirror = toMirrorEntry(e);
    expect(mirror).not.toBeNull();
    expect(mirror).toMatchObject({ id: 'm1', groupId: 'g1', sentAt: 123 });
    // proto is the same bytes the flusher would send, base64-encoded.
    const expected = buildOutboxProto(e)!;
    const decoded = Uint8Array.from(atob(mirror!.proto), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(expected));
    expect(decoded.length).toBeGreaterThan(0);
  });

  it('excludes media entries (their proto cannot be built before upload)', () => {
    const e: OutboxEntry = {
      id: 'mm',
      conversationId: 'g1',
      sentAt: 1,
      kind: 'media',
      media: { kind: 1, mimeType: 'image/png', size: 3, fileBytes: new Uint8Array([1, 2, 3]) },
      status: 'pending',
      attempts: 0,
      createdAt: 1,
    };
    expect(toMirrorEntry(e)).toBeNull();
    expect(buildOutboxProto(e)).toBeNull();
  });

  it('mirrors control entries as a silent send (delete/reaction/read background delivery)', () => {
    const e: OutboxEntry = {
      id: 'c1',
      conversationId: 'g1',
      sentAt: 1,
      kind: 'control',
      controlProto: new Uint8Array([1, 2, 3]),
      status: 'pending',
      attempts: 0,
      createdAt: 1,
    };
    const mirror = toMirrorEntry(e);
    expect(mirror).not.toBeNull();
    expect(mirror!.silent).toBe(true);
    expect(mirror!.id).toBe('c1');
    expect(mirror!.groupId).toBe('g1');
    expect(Array.from(buildOutboxProto(e)!)).toEqual([1, 2, 3]);
  });

  it('mirrors text entries as a non-silent send', () => {
    const mirror = toMirrorEntry(textEntry('m1', 'g1', 100));
    expect(mirror).not.toBeNull();
    expect(mirror!.silent).toBe(false);
  });
});

describe('outbox flusher - offline guards', () => {
  beforeEach(() => {
    connectivity.reset();
  });

  it('keeps the queue intact instead of failing every entry while offline', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls();
    const outbox = createOutbox(makeDeps({ mlsService, storage, isGroupHealthy: () => true }));
    connectivity.notifyServerUnreachable();

    await outbox.flush();

    // Attempting a send with no network is not merely wasted: each entry takes a failed attempt
    // and a longer backoff, so the queue drains slowest exactly when connectivity returns.
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(storage._map.get('m1')!.attempts).toBe(0);
    expect(storage._map.size).toBe(1);
  });

  it('holds the queue while an offline-unlocked session has no token yet', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls();
    // The browser can report `online` before the session has been promoted; a flush in that
    // window fails every entry for a reason that has nothing to do with the entry.
    const outbox = createOutbox(
      makeDeps({ mlsService, storage, isGroupHealthy: () => true, canFlush: () => false })
    );

    await outbox.flush();

    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(storage._map.get('m1')!.attempts).toBe(0);
  });

  it('drains normally once the session can send again', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls();
    let ready = false;
    const outbox = createOutbox(
      makeDeps({ mlsService, storage, isGroupHealthy: () => true, canFlush: () => ready })
    );

    await outbox.flush();
    expect(mlsService.sendMessage).not.toHaveBeenCalled();

    ready = true;
    await outbox.flush();
    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    expect(storage._map.size).toBe(0);
  });
});

describe('outbox flusher', () => {
  beforeEach(() => {
    connectivity.reset();
  });

  it('sends queued entries in sentAt order then deletes them', async () => {
    const storage = makeStorage([textEntry('m2', 'g1', 200), textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls();
    const conversations = new SvelteMap<string, Conversation>([
      ['g1', convoWith('g1', ['m1', 'm2'])],
    ]);
    const outbox = createOutbox(
      makeDeps({ mlsService, storage, conversations, isGroupHealthy: () => true })
    );

    await outbox.flush();

    const sentIds = mlsService.sendMessage.mock.calls.map((c: any[]) => c[2]);
    expect(sentIds).toEqual(['m1', 'm2']);
    expect(storage._map.size).toBe(0);
    expect(conversations.get('g1')!.messages.every((m) => m.status === 'sent')).toBe(true);
  });

  it('sends a control entry silently (silent=true) then deletes it', async () => {
    const controlEntry: OutboxEntry = {
      id: 'c1',
      conversationId: 'g1',
      sentAt: 50,
      kind: 'control',
      controlProto: new Uint8Array([9, 8, 7]),
      status: 'pending',
      attempts: 0,
      createdAt: 50,
    };
    const storage = makeStorage([controlEntry]);
    const mlsService = makeMls();
    const outbox = createOutbox(makeDeps({ mlsService, storage, isGroupHealthy: () => true }));

    await outbox.flush();

    // 4th arg = silent = true for control events; the verbatim proto is sent under the entry id.
    expect(mlsService.sendMessage).toHaveBeenCalledWith('g1', expect.anything(), 'c1', true);
    expect(storage._map.has('c1')).toBe(false);
  });

  it('retains an ordinary control entry for a later retransmission', async () => {
    resetRecentSendsForTests();
    const storage = makeStorage([controlEntry('c1', false)]);
    const outbox = createOutbox(makeDeps({ mlsService: makeMls(), storage }));

    await outbox.flush();

    // The whole point of the ring: a peer that cannot decrypt this can still be handed it again.
    expect(recentSentSince('g1', 0)).toHaveLength(1);
  });

  it('does NOT retain a retransmission - that is what turned one desync into a broadcast', async () => {
    resetRecentSendsForTests();
    const storage = makeStorage([controlEntry('c2', true)]);
    const outbox = createOutbox(makeDeps({ mlsService: makeMls(), storage }));

    await outbox.flush();

    // A replay is already retained under its original id and timestamp. Re-noting it minted a
    // fresh id and a fresh `sentAt`, so the five-minute window never aged out and the id-based
    // dedup no longer matched - the ring accumulated copies and every later `decrypt_failed`
    // replayed all of them. Measured on production 2026-08-07: ~430 frames/minute for thirteen
    // minutes across three clients, 4 921 queued for one phone, with nobody typing.
    expect(recentSentSince('g1', 0)).toHaveLength(0);
  });

  it('drops a channel entry without any MLS call (channels are server-authoritative)', async () => {
    const storage = makeStorage([textEntry('m1', 'channel_ee943652', 100)]);
    const mlsService = makeMls();
    const requestReAdd = vi.fn().mockResolvedValue(undefined);
    const outbox = createOutbox(
      makeDeps({ mlsService, storage, requestReAdd, isGroupHealthy: () => true })
    );

    await outbox.flush();

    // No welcome-request / group resolution loop: the channel entry is simply purged.
    expect(mlsService.getGroupMeta).not.toHaveBeenCalled();
    expect(requestReAdd).not.toHaveBeenCalled();
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(storage._map.has('m1')).toBe(false);
  });

  it('does not send into an unhealthy group; emits welcome_request and keeps the entry pending', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls();
    const requestReAdd = vi.fn().mockResolvedValue(undefined);
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['m1'])]]);
    const outbox = createOutbox(
      makeDeps({ mlsService, storage, conversations, requestReAdd, isGroupHealthy: () => false })
    );

    await outbox.flush();

    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(requestReAdd).toHaveBeenCalledWith('g1');
    expect(storage._map.has('m1')).toBe(true);
  });

  it('marks a deleted-group entry as a permanent error', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls({
      meta: (id) => ({
        groupId: id,
        name: '',
        isGroup: true,
        deletedAt: '2020-01-01',
      }),
    });
    const markDeletedRemotely = vi.fn();
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['m1'])]]);
    const outbox = createOutbox(
      makeDeps({
        mlsService,
        storage,
        conversations,
        markDeletedRemotely,
        isGroupHealthy: () => true,
      })
    );

    await outbox.flush();

    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(markDeletedRemotely).toHaveBeenCalledWith('g1');
    expect(storage._map.has('m1')).toBe(false);
    expect(conversations.get('g1')!.messages[0].status).toBe('error');
  });

  it('keeps the entry pending and backs off on a transient send failure', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls({
      send: async () => {
        throw new Error('WrongEpoch');
      },
    });
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['m1'])]]);
    const outbox = createOutbox(
      makeDeps({ mlsService, storage, conversations, isGroupHealthy: () => true })
    );

    await outbox.flush();

    const e = storage._map.get('m1');
    expect(e).toBeDefined();
    expect(e.attempts).toBe(1);
    expect(e.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(conversations.get('g1')!.messages[0].status).toBe('pending');
  });

  it('uploads a queued media, sends it, then swaps the placeholder for the real attachment', async () => {
    const mediaEntry: OutboxEntry = {
      id: 'mm',
      conversationId: 'g1',
      sentAt: 100,
      kind: 'media',
      media: {
        kind: MediaKind.MEDIA_KIND_IMAGE,
        mimeType: 'image/png',
        size: 3,
        fileName: 'a.png',
        fileBytes: new Uint8Array([1, 2, 3]),
      },
      status: 'pending',
      attempts: 0,
      createdAt: 100,
    };
    const storage = makeStorage([mediaEntry]);
    const mlsService = makeMls();
    const uploadMedia = vi.fn().mockResolvedValue({
      type: 'image',
      mediaId: 'mid-1',
      key: 'aa',
      iv: 'bb',
      mimeType: 'image/png',
      size: 3,
      fileName: 'a.png',
    });
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['mm'])]]);
    const outbox = createOutbox(
      makeDeps({ mlsService, storage, conversations, uploadMedia, isGroupHealthy: () => true })
    );

    await outbox.flush();

    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(mlsService.sendMessage).toHaveBeenCalledWith('g1', expect.anything(), 'mm', false);
    expect(storage._map.has('mm')).toBe(false);
    // Placeholder content swapped for the real attachment envelope (now carries the mediaId).
    expect(conversations.get('g1')!.messages[0].content).toContain('mid-1');
    expect(conversations.get('g1')!.messages[0].status).toBe('sent');
  });

  it('does not re-upload media on a retry once uploadedRef is stored', async () => {
    const mediaEntry: OutboxEntry = {
      id: 'mm',
      conversationId: 'g1',
      sentAt: 100,
      kind: 'media',
      media: {
        kind: MediaKind.MEDIA_KIND_IMAGE,
        mimeType: 'image/png',
        size: 3,
        fileName: 'a.png',
        uploadedRef: { mediaId: 'mid-1', key: 'aa', iv: 'bb' },
      },
      status: 'pending',
      attempts: 0,
      createdAt: 100,
    };
    const storage = makeStorage([mediaEntry]);
    const mlsService = makeMls();
    const uploadMedia = vi.fn();
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['mm'])]]);
    const outbox = createOutbox(
      makeDeps({ mlsService, storage, conversations, uploadMedia, isGroupHealthy: () => true })
    );

    await outbox.flush();

    expect(uploadMedia).not.toHaveBeenCalled();
    expect(mlsService.sendMessage).toHaveBeenCalledWith('g1', expect.anything(), 'mm', false);
    expect(storage._map.has('mm')).toBe(false);
  });
});

describe('outbox flusher - tab leadership (WP-MULTITAB-1)', () => {
  beforeEach(() => {
    connectivity.reset();
    isTabLeaderMock.mockReturnValue(true);
    tabOutboxMock.requestLeaderOutboxFlush.mockClear();
    tabOutboxMock.publishOutboxEntrySent.mockClear();
  });

  afterEach(() => {
    isTabLeaderMock.mockReturnValue(true);
  });

  it('never encrypts from a follower tab, and asks the leader to drain instead', async () => {
    isTabLeaderMock.mockReturnValue(false);
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls();
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    await outbox.flush();

    // A send from the follower would be encrypted at a generation the peer has already consumed:
    // it reaches the server (201) and is dropped on arrival as a duplicate. The entry stays queued,
    // untouched - no attempt, no backoff - because the leader is about to send it.
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(storage._map.get('m1')!.attempts).toBe(0);
    expect(tabOutboxMock.requestLeaderOutboxFlush).toHaveBeenCalledTimes(1);
  });

  it('queues from a follower and still nudges the leader (the queue is shared storage)', async () => {
    isTabLeaderMock.mockReturnValue(false);
    const storage = makeStorage();
    const mlsService = makeMls();
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    await outbox.enqueue(textEntry('m1', 'g1', 100));

    // The message is durable and visible to the leader tab; only the encryption moved.
    expect(storage.saveOutboxEntry).toHaveBeenCalledTimes(1);
    expect(storage._map.has('m1')).toBe(true);
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(tabOutboxMock.requestLeaderOutboxFlush).toHaveBeenCalled();
  });

  it('tells the other tabs when an entry has gone out, so a follower can settle its echo', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls();
    const outbox = createOutbox(
      makeDeps({
        mlsService,
        storage,
        conversations: new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['m1'])]]),
      })
    );

    await outbox.flush();

    expect(tabOutboxMock.publishOutboxEntrySent).toHaveBeenCalledWith('m1', undefined);
  });
});
