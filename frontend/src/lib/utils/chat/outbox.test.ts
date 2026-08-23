import { SvelteMap } from 'svelte/reactivity';

// Encryption is leader-only (WP-MULTITAB-1), so every flush case here is a leader unless it says
// otherwise. The cross-tab channel is stubbed too: what matters is which side is asked to act,
// not that a BroadcastChannel exists under happy-dom.
const isTabLeaderMock = vi.hoisted(() => vi.fn(() => true));
// Leadership has THREE states (WP-OUTBOX-2). By default the two answers agree, so every case
// written before this existed keeps its meaning; the boot-gap case below drives them apart on
// purpose - `undecided` with a promise it resolves by hand.
const leadershipMock = vi.hoisted(() =>
  vi.fn((): 'undecided' | 'leader' | 'follower' => (isTabLeaderMock() ? 'leader' : 'follower'))
);
const decidedMock = vi.hoisted(() => ({
  promise: Promise.resolve('leader') as Promise<'leader' | 'follower'>,
}));
const tabOutboxMock = vi.hoisted(() => ({
  requestLeaderOutboxFlush: vi.fn(),
  publishOutboxEntrySent: vi.fn(),
  publishOutboxEntryCancelled: vi.fn(),
  subscribeTabOutboxEvents: vi.fn(() => () => {}),
}));
// Only the leadership answer is overridden: this module is pulled in transitively by the session
// singleton, which registers the promotion/demotion handlers at import time.
vi.mock('$lib/mls-client/tabLeader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/tabLeader')>()),
  getIsTabLeader: () => isTabLeaderMock(),
  getTabLeadership: () => leadershipMock(),
  whenTabLeadershipDecided: () => decidedMock.promise,
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
import type { TabOutboxEvent } from '$lib/mls-client/tabMessageSync';
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

/**
 * mlsService stub: a group is "alive" by default; `meta` overrides per-group metadata and
 * `active` overrides membership (false = this device was evicted, throw = membership unreadable).
 */
function makeMls(
  opts: {
    meta?: (id: string) => unknown;
    send?: () => Promise<void>;
    active?: (id: string) => Promise<boolean>;
  } = {}
) {
  return {
    getLocalGroups: vi.fn(() => []),
    getGroupMeta: vi.fn(async (id: string) =>
      opts.meta ? opts.meta(id) : { groupId: id, name: '', isGroup: true, deletedAt: null }
    ),
    isGroupActive: vi.fn(opts.active ?? (async () => true)),
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

/**
 * Lets a flush that nothing awaited run to completion.
 *
 * A connectivity listener is fire-and-forget by design - the store must not be blocked by whoever
 * subscribes to it - so a test that asserts right after the event asserts against a flush that has
 * not started. Draining the microtask queue a few times is enough: everything in `runFlush` up to
 * `sendMessage` is promises, no timers.
 */
async function outboxIdle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
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

  it('mirrors control entries as silent but DURABLE (delete/reaction/read background delivery)', () => {
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
    // The two are independent. They were one boolean until 2026-08-12, and because every control
    // frame is silent by construction that overload kept every reaction, edit, deletion and read
    // receipt out of the group's shared log - so a device that missed one could never recover it.
    // A background-sent mutation must be exactly as durable as a foreground one.
    expect(mirror!.durable).toBe(true);
    expect(mirror!.id).toBe('c1');
    expect(mirror!.groupId).toBe('g1');
    expect(Array.from(buildOutboxProto(e)!)).toEqual([1, 2, 3]);
  });

  it('mirrors text entries as a non-silent, durable send', () => {
    const mirror = toMirrorEntry(textEntry('m1', 'g1', 100));
    expect(mirror).not.toBeNull();
    expect(mirror!.silent).toBe(false);
    expect(mirror!.durable).toBe(true);
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

  // WP-OUTBOX-1. The two facts behind `isOffline` are restored by two different events at two
  // different times, and the retry used to be bound to the earlier one. Measured on production
  // 2026-08-14: queued at 14:25:38, the browser reported online at 14:25:41 and the retry was
  // refused because the server was not known reachable until 14:25:51 - ten seconds later, on an
  // event nothing here listened to. The message left at 14:28:49, on an unrelated reconnect.
  it('drains when the condition that blocked it clears, with no other event', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls();
    createOutbox(makeDeps({ mlsService, storage, isGroupHealthy: () => true }));

    connectivity.notifyServerUnreachable();
    await outboxIdle();
    expect(mlsService.sendMessage).not.toHaveBeenCalled();

    // The ONLY thing that happens: the server becomes reachable again. No `online` event, no
    // visibility change, no socket reconnect - none of which the queue should have to wait for.
    connectivity.notifyServerReachable();
    await outboxIdle();

    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    expect(storage._map.size).toBe(0);
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

    // 4th arg = the delivery class. A control event is a mutation: silent, but DURABLE - it must
    // reach the group's shared log, since its queue entry is deleted on ACK and a device that was
    // offline has nothing else to learn it from.
    expect(mlsService.sendMessage).toHaveBeenCalledWith('g1', expect.anything(), 'c1', {
      silent: true,
      durable: true,
    });
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

  it('never sends into a group this device was evicted from, and fails the entry for good', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    // The group is alive server-side and locally held - the ONLY thing wrong is our membership.
    const mlsService = makeMls({ active: async () => false });
    const markDeletedRemotely = vi.fn();
    const requestReAdd = vi.fn();
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['m1'])]]);
    const outbox = createOutbox(
      makeDeps({
        mlsService,
        storage,
        conversations,
        markDeletedRemotely,
        requestReAdd,
        isGroupHealthy: () => true,
      })
    );

    await outbox.flush();

    // Nothing reached the wire: the eviction is a fact read BEFORE encrypting, not a refusal caught
    // after. This is the assertion that separates the fix from the behaviour it replaced.
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    // And the Remove commit is authoritative, so no repair is attempted: an evicted group is a
    // correct group we are not in, never a broken one.
    expect(requestReAdd).not.toHaveBeenCalled();
    expect(markDeletedRemotely).toHaveBeenCalledWith('g1');
    expect(storage._map.has('m1')).toBe(false);
    expect(conversations.get('g1')!.messages[0].status).toBe('error');
  });

  it('does not raise the banner when the evicted entry is a control event', async () => {
    // A reaction or a read receipt must not be what tells the user the conversation is gone: the
    // same rule the deleted-group branch keeps, and eviction shares its code path.
    const entry = {
      ...textEntry('m1', 'g1', 100),
      kind: 'control',
      controlProto: new Uint8Array(1),
    };
    const storage = makeStorage([entry as never]);
    const mlsService = makeMls({ active: async () => false });
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

    expect(markDeletedRemotely).not.toHaveBeenCalled();
    expect(storage._map.has('m1')).toBe(false);
  });

  it('retries rather than destroying the message when membership cannot be read', async () => {
    // "Unreadable" and "evicted" are opposite facts, and only one of them may delete a queued
    // message. Reading a failed query as an eviction would discard messages on a transient fault.
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls({
      active: async () => {
        throw new Error('WASM client not ready');
      },
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
    expect(markDeletedRemotely).not.toHaveBeenCalled();
    expect(storage._map.has('m1')).toBe(true);
  });

  it('fails permanently on an EVICTED refusal even when the membership query said otherwise', async () => {
    // The backstop, for the device that never received the Remove commit at all: `isGroupActive`
    // answers "still a member" because no commit ever said otherwise, and OpenMLS refuses the send.
    // OpenMLS is the one that is right, and a retry ladder against it would never end.
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls({
      active: async () => true,
      send: async () => {
        throw new Error('EVICTED: g1');
      },
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

    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
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
    expect(mlsService.sendMessage).toHaveBeenCalledWith('g1', expect.anything(), 'mm', {
      silent: false,
      durable: true,
    });
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
    expect(mlsService.sendMessage).toHaveBeenCalledWith('g1', expect.anything(), 'mm', {
      silent: false,
      durable: true,
    });
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

/**
 * WP-OUTBOX-2 - the boot gap, sent into ON PURPOSE.
 *
 * `getIsTabLeader()` answers false while the election is still running, and the flush read that as
 * "another tab will do it": it broadcast a drain request to a leader that, on a single-tab client,
 * does not exist, and returned before scheduling anything - a never-attempted entry has no
 * `nextAttemptAt`, so the backoff would have armed nothing either. The message then waited for an
 * unrelated wake-up (a reconnect, a visibility change, the next enqueue). Seen twice on production,
 * neither time losing a message; nothing had ever sent inside the gap deliberately.
 *
 * The two assertions are the two halves of the defect: nothing is delegated while the answer is
 * unknown, and the entry goes out on the DECISION itself - no second trigger, no timer.
 */
describe('outbox flusher - an undecided leadership is not a follower (WP-OUTBOX-2)', () => {
  beforeEach(() => {
    connectivity.reset();
    isTabLeaderMock.mockReturnValue(true);
    tabOutboxMock.requestLeaderOutboxFlush.mockClear();
  });

  afterEach(() => {
    leadershipMock.mockImplementation(() => (isTabLeaderMock() ? 'leader' : 'follower'));
    decidedMock.promise = Promise.resolve('leader');
  });

  it('waits for the election instead of delegating to a leader that may not exist', async () => {
    let decide!: (side: 'leader' | 'follower') => void;
    decidedMock.promise = new Promise((r) => {
      decide = r;
    });
    leadershipMock.mockImplementation(() => 'undecided');

    const storage = makeStorage();
    const mlsService = makeMls();
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    // Enqueued INSIDE the gap - `enqueue` runs the flush that used to be the one skipped.
    const flushed = outbox.enqueue(textEntry('m1', 'g1', 100));
    await Promise.resolve();

    // Nothing may be delegated on a question nobody has answered yet.
    expect(tabOutboxMock.requestLeaderOutboxFlush).not.toHaveBeenCalled();
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    // ...and the message is durable meanwhile, which is what makes the wait safe.
    expect(storage._map.has('m1')).toBe(true);

    // The election resolving is the ONLY thing that happens next. `enqueue` starts its flush
    // without awaiting it - deliberately, a send must not block the composer - so the assertion
    // waits on the OUTCOME rather than on the call that started it.
    leadershipMock.mockImplementation(() => 'leader');
    decide('leader');
    await flushed;
    await vi.waitFor(() => expect(mlsService.sendMessage).toHaveBeenCalledTimes(1));

    expect(storage._map.size).toBe(0);
    expect(tabOutboxMock.requestLeaderOutboxFlush).not.toHaveBeenCalled();
  });

  it('delegates once the election says follower, which is the only time that is true', async () => {
    let decide!: (side: 'leader' | 'follower') => void;
    decidedMock.promise = new Promise((r) => {
      decide = r;
    });
    leadershipMock.mockImplementation(() => 'undecided');

    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls();
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    const flushed = outbox.flush();
    await Promise.resolve();
    expect(tabOutboxMock.requestLeaderOutboxFlush).not.toHaveBeenCalled();

    isTabLeaderMock.mockReturnValue(false);
    leadershipMock.mockImplementation(() => 'follower');
    decide('follower');
    await flushed;

    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(tabOutboxMock.requestLeaderOutboxFlush).toHaveBeenCalledTimes(1);
    expect(storage._map.get('m1')!.attempts).toBe(0);
  });
});

/**
 * MUT-19. Deleting a message that never left the outbox used to SEND it, then delete it: the two
 * legs were ordinary queue entries side by side, flushed in order, so the peer rendered the text
 * and only then received the tombstone. What is asserted here is the ABSENCE of the send, which no
 * assertion on the settled state can make - the tombstone wins everywhere either way, which is
 * exactly why this went unseen.
 */
describe('outbox cancellation', () => {
  beforeEach(() => {
    connectivity.reset();
    isTabLeaderMock.mockReturnValue(true);
    tabOutboxMock.publishOutboxEntryCancelled.mockClear();
    tabOutboxMock.subscribeTabOutboxEvents.mockImplementation(() => () => {});
  });

  it('withdraws a queued message so no later flush can send it', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls();
    connectivity.notifyServerUnreachable();
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    expect(await outbox.cancelPending('m1')).toBe(true);
    expect(storage._map.size).toBe(0);

    // The condition holding the queue clears: the exact moment the defect used to fire.
    connectivity.notifyServerReachable();
    await outboxIdle();
    await outbox.flush();

    expect(mlsService.sendMessage).not.toHaveBeenCalled();
  });

  it('tells the other tabs, whose snapshot of the queue predates the cancellation', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const outbox = createOutbox(makeDeps({ mlsService: makeMls(), storage }));

    await outbox.cancelPending('m1');

    expect(tabOutboxMock.publishOutboxEntryCancelled).toHaveBeenCalledWith('m1');
  });

  it('answers false for a message no longer queued, so the delete travels as an event', async () => {
    const outbox = createOutbox(makeDeps({ mlsService: makeMls(), storage: makeStorage([]) }));

    expect(await outbox.cancelPending('gone')).toBe(false);
  });

  it('does not claim a cancellation for the entry that is already on the wire', async () => {
    let release!: () => void;
    const onTheWire = new Promise<void>((r) => {
      release = r;
    });
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls({ send: () => onTheWire });
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    void outbox.flush();
    await outboxIdle();
    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);

    // The frame is gone. Answering `true` here would lose the delete outright: the caller would
    // skip the `delete_message` event and the peer would keep a message the user deleted.
    expect(await outbox.cancelPending('m1')).toBe(false);

    release();
    await outboxIdle();
  });

  it('drops an entry cancelled after the running flush read its snapshot', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100), textEntry('m2', 'g1', 200)]);
    let outbox: ReturnType<typeof createOutbox> | null = null;
    const mlsService = makeMls({
      // The user deletes m2 while m1 is being sent - the loop is already holding both.
      send: (async (_group: string, _proto: Uint8Array, id: string) => {
        if (id === 'm1') await outbox!.cancelPending('m2');
      }) as any,
    });
    outbox = createOutbox(makeDeps({ mlsService, storage }));

    await outbox.flush();

    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    expect(mlsService.sendMessage.mock.calls[0][2]).toBe('m1');
    expect(storage._map.size).toBe(0);
  });

  it('honours a cancellation from another tab, in the leader that is draining', async () => {
    let onTabEvent!: (e: TabOutboxEvent) => void;
    tabOutboxMock.subscribeTabOutboxEvents.mockImplementation(((h: (e: TabOutboxEvent) => void) => {
      onTabEvent = h;
      return () => {};
    }) as any);
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls();
    connectivity.notifyServerUnreachable();
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    // A follower withdrew it. The leader is the tab that would send it, and every other arm of
    // this subscriber returns early in the leader - which is why this one is placed above them.
    onTabEvent({ type: 'outbox_entry_cancelled', messageId: 'm1' });

    connectivity.notifyServerReachable();
    await outbox.flush();

    expect(mlsService.sendMessage).not.toHaveBeenCalled();
  });
});
