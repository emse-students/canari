import { SvelteMap } from 'svelte/reactivity';
import { createOutbox, buildOutboxProto, type OutboxDeps } from './outbox';
import { toMirrorEntry } from './outboxMirror';
import { MediaKind } from '$lib/proto/codec';
import { encodeOutboxSensitive, decodeOutboxEntry, outboxClearColumns } from '$lib/db/outboxCodec';
import type { OutboxEntry } from '$lib/db';
import type { Conversation } from '$lib/types';

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
    pin: 'pin',
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

describe('outbox flusher', () => {
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
        kind: MediaKind.MEDIA_IMAGE,
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
        kind: MediaKind.MEDIA_IMAGE,
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
