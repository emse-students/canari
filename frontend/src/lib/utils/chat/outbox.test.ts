// @vitest-environment happy-dom
import { SvelteMap } from 'svelte/reactivity';
import { TransportFailureError } from '$lib/utils/transportFailure';

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
  publishOutboxEntryFailed: vi.fn(),
  // The handler is named in the signature rather than dropped: a flush trigger arrives through
  // this subscription, so the R-D8 trigger table has to read it back out of `mock.calls`.
  subscribeTabOutboxEvents: vi.fn((_handler: (event: TabOutboxEvent) => void) => () => {}),
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

import {
  createOutbox as createOutboxController,
  buildOutboxProto,
  MAX_CONCURRENT_SENDS,
  MAX_CONCURRENT_UPLOADS,
  MAX_UNEXPECTED_ATTEMPTS,
  MAX_CONSECUTIVE_SERVER_ERRORS,
  MAX_RETRY_AFTER_MS,
  SERVER_ERROR_HOLD_MS,
  serverErrorHoldMs,
  enqueueOutboxMessage,
  isOutboxEntryQueued,
  registerOutbox,
  unregisterOutbox,
  type OutboxController,
  type OutboxDeps,
} from './outbox';
import {
  DeliveryUnreachableError,
  MlsDeliveryApi,
  ExclusionsRefusedError,
  GroupDeletedError,
  SenderNotActiveError,
  SendForbiddenError,
  SendEdgeRefusedError,
  SendServerError,
} from '$lib/mls-client/mlsDeliveryApi';
import { ApiRefusalError } from '$lib/utils/apiRefusal';
import { toMirrorEntry } from './outboxMirror';
import {
  MediaKind,
  decodeAppMessage,
  encodeAppMessage,
  mediaReelFromProto,
  mkReaction,
  mkSystem,
} from '$lib/proto/codec';
import {
  drainOwedDmReadMarksOnOutbox,
  flushOwedDmReadMarks,
  queuedReadWatermarkAt,
  sendReadWatermark,
} from './messaging';
import {
  flushDmReadMarks,
  owedDmReadMarks,
  owedStampedDmReadMarks,
  recordDmReadMark,
} from './salonReadMarkQueue';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { MediaUploadError } from '$lib/utils/mediaErrors';
import {
  UploadAbortedError,
  UploadAnswerTimeoutError,
  UploadNetworkError,
  UploadStalledError,
} from '$lib/utils/uploadXhr';
import { clearAllUploads, uploadPercent, uploadViewOf } from './uploadProgress.svelte';
import {
  encodeOutboxSensitive,
  decodeOutboxEntry,
  outboxClearColumns,
  OutboxPayloadUnreadableError,
} from '$lib/db/outboxCodec';
import { connectivity } from '$lib/stores/connectivity.svelte';
import type { TabOutboxEvent } from '$lib/mls-client/tabMessageSync';
import type { SentFrame } from '$lib/mls-client/mlsDeliveryApi';
import { mkTextEnvelope, parseEnvelope, serializeEnvelope } from '$lib/envelope';
import type { OutboxEntry } from '$lib/db';
import type { StoredMessage } from '$lib/db/types';
import { drainPendingGroupExits } from './pendingGroupExits';
import { toBase64 } from '$lib/utils/hex';
import type { Conversation } from '$lib/types';

/**
 * EVERY CONTROLLER A CASE CREATES IS DISPOSED WHEN THE CASE ENDS. A controller subscribes to the
 * process-wide `connectivity.onReconnect` and to `visibilitychange`, so one left alive answers the
 * NEXT case's `connectivity.reset()` with a flush of its own queue - and the last ones were still
 * uploading and logging after the file had finished, which vitest reports as an
 * `EnvironmentTeardownError` ("Closing rpc while onUserConsoleLog was pending") and fails the run
 * on, intermittently, on `main` as on every branch (2026-10-18). `dispose` is idempotent, so a case
 * that disposes its own controller mid-test is unaffected.
 */
const liveControllers: OutboxController[] = [];
function createOutbox(deps: OutboxDeps): OutboxController {
  const controller = createOutboxController(deps);
  liveControllers.push(controller);
  return controller;
}
afterEach(() => {
  for (const controller of liveControllers.splice(0)) controller.dispose();
});

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
  /** The owed group exits (`pendingGroupExits`); none by default. */
  const exits: Array<{ groupId: string; kind: 'leave' | 'delete'; requestedAt: number }> = [];
  const rows = new Map<string, StoredMessage>();
  return {
    _map: map,
    _exits: exits,
    getPendingGroupExits: vi.fn(async () => [...exits]),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    // The stored message rows - only what a test seeds; the flusher reads them to keep their proofs.
    _messages: rows,
    getMessage: vi.fn(async (id: string) => rows.get(id) ?? null),
    saveOutboxEntry: vi.fn(async (e: OutboxEntry) => {
      map.set(e.id, structuredClone(e));
    }),
    // Like the real stores: a media entry comes back WITHOUT its payload.
    getOutboxQueue: vi.fn(async () =>
      [...map.values()]
        .sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id))
        .map((e) => (e.kind === 'media' ? { ...e, media: undefined } : e))
    ),
    getOutboxEntry: vi.fn(async (id: string) => {
      const e = map.get(id);
      return e ? structuredClone(e) : null;
    }),
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
    send?: (...args: unknown[]) => Promise<void>;
    active?: (id: string) => Promise<boolean>;
    /** The server's exclusion windows; nobody was ever out by default. */
    exclusions?: (
      id: string
    ) => Promise<Map<string, Array<{ from: number; until: number | null }>>>;
  } = {}
) {
  return {
    getLocalGroups: vi.fn(() => []),
    getGroupMeta: vi.fn(async (id: string) =>
      opts.meta ? opts.meta(id) : { groupId: id, name: '', isGroup: true, deletedAt: null }
    ),
    isGroupActive: vi.fn(opts.active ?? (async () => true)),
    getGroupExclusions: vi.fn(opts.exclusions ?? (async () => new Map())),
    // Whatever a test's own `send` does (throw, wait), an accepted frame answers what the real
    // service answers: the sealed bytes and the server's receive time.
    sendMessage: vi.fn(async (...args: unknown[]) => {
      await (opts.send ?? (async () => {}))(...args);
      return accepted();
    }),
    waitForMessageQueueIdle: vi.fn(async () => {}),
  } as any;
}

/** What `sendMessage` answers for a frame the server took: the sealed bytes and its receive time. */
function accepted(): SentFrame {
  return { sealed: new Uint8Array(), authorProof: new Uint8Array(), receivedAt: 1_700_000_000_000 };
}

/**
 * A conversation row holding `messageIds`. `active` by default - the row of a group that can be sent
 * into; `pending` is the row awaiting (re-)admission, which the outbox HOLDS rather than fails.
 */
function convoWith(
  id: string,
  messageIds: string[],
  lifecycle: Conversation['lifecycle'] = 'active'
): Conversation {
  return {
    id,
    name: id,
    contactName: id,
    lifecycle,
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
    deviceKey: () => 'device-key',
    conversations: new SvelteMap<string, Conversation>(),
    log: () => {},
    requestReAdd: vi.fn().mockResolvedValue(undefined),
    recoverRosterDisagreement: vi.fn().mockResolvedValue(undefined),
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
  // Microtask turns, not a clock: a flush is read-queue -> claim a lane -> barrier -> read-queue ->
  // send -> delete, each an await. 10 sufficed for the single loop; the lanes add a few more.
  for (let i = 0; i < 60; i++) await Promise.resolve();
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

  it('reads a row queued BEFORE blobs (inline base64 bytes) and never writes the bytes into a row', () => {
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
    // The legacy format, spelled out: this is what an older build left in the queue.
    const legacy = { media: { kind: 1, mimeType: 'image/png', size: 5, fileBytesB64: 'AQID+v8=' } };
    const decoded = decodeOutboxEntry(outboxClearColumns(e), legacy);
    expect(Array.from(decoded.media!.fileBytes!)).toEqual([1, 2, 3, 250, 255]);
    // The writer keeps the bytes OUT of the payload: only the blob's key is recorded.
    const written = encodeOutboxSensitive(e, { keyB64: 'a2V5' }) as {
      media: Record<string, unknown>;
    };
    expect(written.media.fileBytesB64).toBeUndefined();
    expect(written.media.fileBytes).toBeUndefined();
    expect(written.media.blob).toEqual({ keyB64: 'a2V5' });
    expect(JSON.stringify(written).length).toBeLessThan(1024);
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

  it("dates a sent message by the server's receive time, in memory and on disk", async () => {
    // A history answer places our OWN copies against exclusion windows by this field - left
    // undated, they could only be placed by the phone clock.
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls();
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['m1'])]]);
    const outbox = createOutbox(makeDeps({ mlsService, storage, conversations }));

    await outbox.flush();

    expect(conversations.get('g1')!.messages[0].serverTimestamp).toBe(1_700_000_000_000);
    expect(storage.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm1', serverTimestamp: 1_700_000_000_000 }),
      'device-key'
    );
  });

  describe("keeps this device's own signature on what it sent (history-reconciliation, authorship)", () => {
    const PROOF = new Uint8Array([7, 7]);
    const ORIGINAL = { body: 'b3JpZ2luYWw=', proof: 'cHJvb2Y=', group: 'g1' };
    function signingMls() {
      const mlsService = makeMls();
      mlsService.sendMessage.mockImplementation(async () => ({
        ...accepted(),
        authorProof: PROOF,
      }));
      return mlsService;
    }
    function control(event: string): OutboxEntry {
      return {
        id: 'm1',
        conversationId: 'g1',
        sentAt: 50,
        kind: 'control',
        controlProto: encodeAppMessage(mkSystem(event, JSON.stringify({ messageId: 'm1' }))),
        status: 'pending',
        attempts: 0,
        createdAt: 50,
      };
    }

    it('records a sent message with its proof and the group it was signed in', async () => {
      const storage = makeStorage([textEntry('m1', 'g1', 100)]);
      const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['m1'])]]);
      const outbox = createOutbox(makeDeps({ mlsService: signingMls(), storage, conversations }));

      await outbox.flush();

      expect(storage.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'm1',
          authorship: expect.objectContaining({ proof: toBase64(PROOF), group: 'g1' }),
        }),
        'device-key'
      );
    });

    it('keeps the message proof the row holds and adds the signed edit beside it', async () => {
      const storage = makeStorage([control('edit_message')]);
      storage._messages.set('m1', { id: 'm1', authorship: ORIGINAL } as StoredMessage);
      const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['m1'])]]);
      const outbox = createOutbox(makeDeps({ mlsService: signingMls(), storage, conversations }));

      await outbox.flush();

      expect(storage.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'm1',
          authorship: ORIGINAL,
          editProof: expect.objectContaining({ proof: toBase64(PROOF), group: 'g1' }),
        }),
        'device-key'
      );
    });

    it('drops the original bytes on a deletion and keeps only the signed tombstone', async () => {
      const storage = makeStorage([control('delete_message')]);
      storage._messages.set('m1', { id: 'm1', authorship: ORIGINAL } as StoredMessage);
      const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['m1'])]]);
      const outbox = createOutbox(makeDeps({ mlsService: signingMls(), storage, conversations }));

      await outbox.flush();

      const row = storage.saveMessage.mock.calls.at(-1)[0];
      expect(row.authorship).toBeUndefined();
      expect(row.deleteProof).toMatchObject({ proof: toBase64(PROOF), group: 'g1' });
    });
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

  /**
   * THE DEFECT THIS PAIR EXISTS FOR, and it shipped because every mechanism that could have caught
   * it was asking the wrong question. A device holding a well-formed tree for a group whose server
   * roster row never left `pending` is refused on every send; the connection sync and the
   * SYNC_WATCHDOG both skip it (they test local ABSENCE, and it is present), `requestReAdd` returns
   * at its own WASM guard, and the outbox logged the refusal and re-queued it as a "transient
   * failure" for ever. Measured on the local estate 2026-09-04: eight messages at attempt 18-23
   * against a roster seat two and a half hours old, surviving a full page reload.
   */
  it('drives the roster repair when the server refuses the frame as a non-member', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const notActive = new SenderNotActiveError('g1', 'pending');
    const mlsService = makeMls({
      send: async () => {
        throw notActive;
      },
    });
    const recoverRosterDisagreement = vi.fn().mockResolvedValue(undefined);
    const requestReAdd = vi.fn().mockResolvedValue(undefined);
    const outbox = createOutbox(
      makeDeps({
        mlsService,
        storage,
        recoverRosterDisagreement,
        requestReAdd,
        // Healthy by every LOCAL measure - which is exactly the population that was unreachable.
        isGroupHealthy: () => true,
      })
    );

    await outbox.flush();

    // The repair is driven on the group, from the one place that holds the server's own refusal.
    expect(recoverRosterDisagreement).toHaveBeenCalledWith('g1');
    // And NOT through the seam that skips groups the WASM holds - it cannot serve this population.
    expect(requestReAdd).not.toHaveBeenCalled();
    // The message is kept, not dropped: it goes out intact once the device is a member again.
    expect(storage._map.get('m1')?.status).toBe('pending');
    expect(storage._map.get('m1')?.attempts).toBe(1);
  });

  /**
   * The refusal is permanent until the repair lands, so calling it "transient" is what let eight
   * stuck messages read as ordinary network noise. The line has to separate the two arms.
   */
  it('does not report a non-member refusal as a transient failure', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls({
      send: async () => {
        throw new SenderNotActiveError('g1', 'pending');
      },
    });
    const lines: string[] = [];
    const outbox = createOutbox(
      makeDeps({
        mlsService,
        storage,
        log: (l: string) => lines.push(l),
        isGroupHealthy: () => true,
      })
    );

    await outbox.flush();

    // The MISLEADING FORM, not the words: the corrected sentence says "not a transient failure",
    // so a bare substring match on "transient failure" passes on the defect and fails on the fix.
    expect(lines.some((l) => l.includes('transient failure (attempt'))).toBe(false);
    expect(lines.some((l) => l.includes('held for the roster repair'))).toBe(true);
  });

  it('still reports an ordinary send failure as transient', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls({
      send: async () => {
        throw new Error('network went away');
      },
    });
    const lines: string[] = [];
    const recoverRosterDisagreement = vi.fn().mockResolvedValue(undefined);
    const outbox = createOutbox(
      makeDeps({
        mlsService,
        storage,
        recoverRosterDisagreement,
        log: (l: string) => lines.push(l),
        isGroupHealthy: () => true,
      })
    );

    await outbox.flush();

    expect(lines.some((l) => l.includes('transient failure (attempt'))).toBe(true);
    // A blip must never cost the group its tree.
    expect(recoverRosterDisagreement).not.toHaveBeenCalled();
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
    // THE HOLD OWES A CLOCK AND A COUNTER, and this branch wrote neither until 2026-09-14 - which
    // is why the assertions above stopped at `has('m1')`. `attempts` is the only durable record of
    // how long a message has been held, and nothing can grow a terminal disposition on a counter
    // that does not count.
    expect(storage._map.get('m1')?.status).toBe('pending');
    expect(storage._map.get('m1')?.attempts).toBe(1);
    expect(storage._map.get('m1')?.nextAttemptAt).toBeGreaterThan(Date.now());
  });

  /**
   * THE ENTRY HAD NO WAKE-UP OF ITS OWN, which is the half a count alone would not have shown.
   *
   * `scheduleBackoff` wakes the flush at the earliest `nextAttemptAt` pending. An entry that never
   * writes one contributes nothing to that list, so it was retried only when something unrelated
   * happened to flush - a reconnection, a tab becoming visible, another message being enqueued. On
   * a device where none of those happens, a message held on an unhealthy group sat for the life of
   * the install with nothing scheduled to look at it again.
   *
   * Asserted through the re-add rather than through the timer, because the re-add is the observable
   * consequence: a second flush inside the backoff window must not ask again. **And asking less
   * often costs nothing** - `requestReAdd` throttles to one attempt per `RECOVERY_TIMEOUT_MS`
   * (60 s), which is exactly where this backoff caps, so every suppressed call here is one the
   * recovery seam was going to refuse anyway. The first four steps (2 s, 5 s, 15 s, 30 s) are
   * FASTER than that throttle, so the repair is never delayed by this.
   */
  it('holds the entry on its own clock: a second flush inside the window does not ask again', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls();
    const requestReAdd = vi.fn().mockResolvedValue(undefined);
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['m1'])]]);
    const outbox = createOutbox(
      makeDeps({ mlsService, storage, conversations, requestReAdd, isGroupHealthy: () => false })
    );

    await outbox.flush();
    await outbox.flush();

    expect(requestReAdd).toHaveBeenCalledTimes(1);
    // The count did not move either: a skipped flush is not an attempt, and counting it would make
    // any future ceiling a function of how often the device happens to wake up.
    expect(storage._map.get('m1')?.attempts).toBe(1);
  });

  /**
   * A SENDABLE TEXT ENTRY ASKS NO PRE-FLIGHT: the POST is the question. `GET /api/mls/groups/:id`
   * before every send was the largest step of a text reply's flush (148-245 ms of ~450 on the Mi
   * 9T, 2026-10-12), and the delivery service already refuses a deleted group with a typed 410.
   */
  it('asks the server nothing before sending a text entry into a sendable group', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls();
    const outbox = createOutbox(makeDeps({ mlsService, storage, isGroupHealthy: () => true }));

    await outbox.flush();

    expect(mlsService.getGroupMeta).not.toHaveBeenCalled();
    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    expect(storage._map.has('m1')).toBe(false);
  });

  /**
   * AN UNSENDABLE GROUP IS STILL ASKED, because its next step is the re-add, which never reaches the
   * server's refusal: without the question, a deleted group would be re-added for ever.
   */
  it('retires an entry of an unsendable group the server reports deleted, without a re-add', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls({
      meta: (id) => ({ groupId: id, name: '', isGroup: true, deletedAt: '2020-01-01' }),
    });
    const markDeletedRemotely = vi.fn();
    const requestReAdd = vi.fn().mockResolvedValue(undefined);
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['m1'])]]);
    const outbox = createOutbox(
      makeDeps({
        mlsService,
        storage,
        conversations,
        markDeletedRemotely,
        requestReAdd,
        isGroupHealthy: () => false,
      })
    );

    await outbox.flush();

    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(requestReAdd).not.toHaveBeenCalled();
    expect(markDeletedRemotely).toHaveBeenCalledWith('g1');
    expect(storage._map.has('m1')).toBe(false);
    expect(conversations.get('g1')!.messages[0].status).toBe('error');
  });

  /**
   * THE SAME DISPOSITION, REACHED FROM THE SERVER'S ANSWER - for a sendable text entry the only
   * place a deletion is learnt, and for a media entry a deletion that landed after its pre-flight
   * (measured on the local estate 2026-09-05: a delete's sweep running between a send's recipient
   * resolution and its enqueue). The record must not be able to tell the seams apart: one `cause`,
   * one entry kind, one line.
   */
  it('retires the entry when the server refuses the send because the group is deleted', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls({
      // Alive by every local measure - which is the whole population this arm serves.
      meta: (id) => ({ groupId: id, name: '', isGroup: true, deletedAt: null }),
      send: async () => {
        throw new GroupDeletedError('g1');
      },
    });
    const markDeletedRemotely = vi.fn();
    const recoverRosterDisagreement = vi.fn().mockResolvedValue(undefined);
    const requestReAdd = vi.fn().mockResolvedValue(undefined);
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['m1'])]]);
    const lines: string[] = [];
    const outbox = createOutbox(
      makeDeps({
        mlsService,
        storage,
        conversations,
        markDeletedRemotely,
        recoverRosterDisagreement,
        requestReAdd,
        log: (l: string) => lines.push(l),
        isGroupHealthy: () => true,
      })
    );

    await outbox.flush();

    expect(markDeletedRemotely).toHaveBeenCalledWith('g1');
    // Not retried: the entry is gone from the queue and the echo says so.
    expect(storage._map.has('m1')).toBe(false);
    expect(conversations.get('g1')!.messages[0].status).toBe('error');
    // And NOT confused with the other permanent refusal, which wants a roster repair. There is no
    // roster left to repair.
    expect(recoverRosterDisagreement).not.toHaveBeenCalled();
    expect(requestReAdd).not.toHaveBeenCalled();
    expect(lines.find((l) => l.includes('permanent failure'))).toContain('group-deleted');
    // The line names the server's answer as the source, so it is not read as a local guess.
    expect(lines.some((l) => l.includes('is deleted on the server (410 on this frame)'))).toBe(
      true
    );
  });

  // THE SAME EVENT, THE OPPOSITE SEVERITY, AND ONE LINE FOR BOTH. GRP-7 logged a permanent failure
  // on 2026-08-24 and the line did not say what died - so telling "a message the user wrote is gone
  // for ever" from "a read receipt lost a race to a deletion" meant going and finding the entry by
  // hand. The code already knew: the very next statement exempts `control` from marking the
  // conversation deleted. It just was not saying so.
  it('names the entry kind on a permanent failure, and spares the conversation for a control one', async () => {
    const control: OutboxEntry = {
      id: 'c1',
      conversationId: 'g1',
      sentAt: 100,
      kind: 'control',
      controlProto: new Uint8Array([1, 2, 3]),
      status: 'pending',
      attempts: 0,
      createdAt: 100,
    };
    const storage = makeStorage([control]);
    const mlsService = makeMls({
      send: async () => {
        throw new GroupDeletedError('g1');
      },
    });
    const markDeletedRemotely = vi.fn();
    const lines: string[] = [];
    const outbox = createOutbox(
      makeDeps({
        mlsService,
        storage,
        markDeletedRemotely,
        log: (m: string) => lines.push(m),
        isGroupHealthy: () => true,
      })
    );

    await outbox.flush();

    // A reader must be able to classify this line WITHOUT the entry: kind, group, cause.
    const line = lines.find((l) => l.includes('permanent failure'));
    expect(line).toContain('control entry');
    expect(line).toContain('group-deleted');
    expect(line).toContain('nothing the user wrote is lost');
    // And the exemption is the point of the distinction, not a detail of it: a receipt dying must
    // not retire the conversation the way a lost message does.
    expect(markDeletedRemotely).not.toHaveBeenCalled();
    expect(storage._map.has('c1')).toBe(false);
  });

  it('and says "text entry" for the one that really is a loss', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls({
      send: async () => {
        throw new GroupDeletedError('g1');
      },
    });
    const lines: string[] = [];
    const outbox = createOutbox(
      makeDeps({
        mlsService,
        storage,
        log: (m: string) => lines.push(m),
        isGroupHealthy: () => true,
      })
    );

    await outbox.flush();

    const line = lines.find((l) => l.includes('permanent failure'));
    expect(line).toContain('text entry');
    expect(line).not.toContain('nothing the user wrote is lost');
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
    // AN EVICTION IS RECORDED, NOT MERELY BANNERED. `markDeletedRemotely` is the group-DELETION
    // backstop and it was carrying this too, which is why the row read as live again after a
    // reload and the user was never told why their message died. The disposition is one function
    // now (`recordEviction`), and the row is its durable half.
    expect(markDeletedRemotely).not.toHaveBeenCalled();
    expect(conversations.get('g1')!.lifecycle).toBe('removed');
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

  /**
   * THE RE-ADMISSION WINDOW (review, 2026-10-31; #2804 F1). A re-admission is a Remove and then an
   * Add, about three seconds apart. The Remove half drops the evicted state and writes the row
   * `pending` (`retireIfEvicted`), so a message sent in that window meets an UNSENDABLE group: it is
   * held and the re-add asked - never failed as `evicted`, which retired the row and lost the message
   * the Welcome would have let through. Both ends of the wait are answers, and neither is a clock.
   */
  it('HOLDS a message sent while the row awaits re-admission, then sends it the moment the Welcome lands, with no timer', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    let healthy = false;
    const mlsService = makeMls();
    const requestReAdd = vi.fn().mockResolvedValue(undefined);
    const addMessageToChat = vi.fn().mockResolvedValue(undefined);
    const conversations = new SvelteMap<string, Conversation>([
      ['g1', convoWith('g1', ['m1'], 'pending')],
    ]);
    const outbox = createOutbox(
      makeDeps({
        mlsService,
        storage,
        conversations,
        requestReAdd,
        addMessageToChat,
        isGroupHealthy: () => healthy,
      })
    );

    await outbox.flush();

    // Held: nothing on the wire, the entry kept with a clock, the row NOT retired, no notice.
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(requestReAdd).toHaveBeenCalledWith('g1');
    expect(storage._map.get('m1')!.attempts).toBe(1);
    expect(storage._map.get('m1')!.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(conversations.get('g1')!.lifecycle).toBe('pending');
    expect(conversations.get('g1')!.messages[0].status).toBe('pending');
    expect(addMessageToChat).not.toHaveBeenCalled();

    // A plain flush respects the backoff - which is why the Welcome must RESUME, not flush.
    await outbox.flush();
    expect(mlsService.sendMessage).not.toHaveBeenCalled();

    // The Welcome: the group installs, the row goes active (`upsertConversation`), and the group is
    // announced ready - which resumes this entry at once, whatever its clock says.
    healthy = true;
    conversations.set('g1', { ...conversations.get('g1')!, lifecycle: 'active' });
    await outbox.resumeGroup('g1');

    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    expect(storage._map.has('m1')).toBe(false);
    expect(conversations.get('g1')!.messages[0].status).toBe('sent');
    outbox.dispose();
  });

  it('a re-admission whose Welcome never comes FAILS the held message visibly once the server proves no seat', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls();
    const conversations = new SvelteMap<string, Conversation>([
      ['g1', convoWith('g1', ['m1'], 'pending')],
    ]);
    // The first pass finds a Welcome still owed; a later one reads no seat for this account and
    // retires the row, as `stopRecovering` does on that proof.
    let seat = true;
    const requestReAdd = vi.fn(async () => {
      if (!seat) conversations.set('g1', { ...conversations.get('g1')!, lifecycle: 'removed' });
    });
    const lines: string[] = [];
    const outbox = createOutbox(
      makeDeps({
        mlsService,
        storage,
        conversations,
        requestReAdd,
        isGroupHealthy: () => false,
        log: (l: string) => lines.push(l),
      })
    );

    await outbox.flush();
    expect(storage._map.has('m1')).toBe(true);
    expect(conversations.get('g1')!.messages[0].status).toBe('pending');

    // The entry's own clock comes due (set, not waited for) and the next attempt asks again.
    seat = false;
    storage._map.get('m1')!.nextAttemptAt = 0;
    await outbox.flush();

    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(storage._map.has('m1')).toBe(false);
    expect(conversations.get('g1')!.messages[0].status).toBe('error');
    expect(conversations.get('g1')!.lifecycle).toBe('removed');
    expect(lines).toContainEqual(expect.stringContaining('removed - permanent failure'));
    outbox.dispose();
  });

  it("a group becoming ready resumes only ITS held entries, and leaves another group's on their clock", async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100), textEntry('m2', 'g2', 101)]);
    let healthy = false;
    const mlsService = makeMls();
    const outbox = createOutbox(makeDeps({ mlsService, storage, isGroupHealthy: () => healthy }));

    await outbox.flush();
    expect(mlsService.sendMessage).not.toHaveBeenCalled();

    healthy = true;
    await outbox.resumeGroup('g1');

    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    expect(mlsService.sendMessage.mock.calls[0][0]).toBe('g1');
    expect(storage._map.has('m2')).toBe(true);
    outbox.dispose();
  });

  it('a group that becomes ready DURING the attempt that holds it (an external join inside the re-add) is sent in the same drain', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    let healthy = false;
    const mlsService = makeMls();
    let outbox!: ReturnType<typeof createOutbox>;
    // `requestReAdd` lands an external join, which raises the group-ready seam before it returns -
    // before this attempt has written its hold, so the announcement finds nothing to resume.
    const requestReAdd = vi.fn(async () => {
      healthy = true;
      void outbox.resumeGroup('g1');
    });
    outbox = createOutbox(
      makeDeps({ mlsService, storage, requestReAdd, isGroupHealthy: () => healthy })
    );

    await outbox.flush();
    await outboxIdle();

    expect(requestReAdd).toHaveBeenCalledTimes(1);
    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    expect(storage._map.has('m1')).toBe(false);
    outbox.dispose();
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
    expect(markDeletedRemotely).not.toHaveBeenCalled();
    expect(conversations.get('g1')!.lifecycle).toBe('removed');
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

  it("carries a reel message's declared intent, length and expiry hint onto the wire and the stored message", async () => {
    const mediaEntry: OutboxEntry = {
      id: 'mr',
      conversationId: 'g1',
      sentAt: 100,
      kind: 'media',
      media: {
        kind: MediaKind.MEDIA_KIND_VIDEO,
        mimeType: 'video/mp4',
        size: 3,
        intent: 'reel-message',
        durationMs: 42_000,
        expiresAtMs: 1_790_000_000_000,
        fileBytes: new Uint8Array([1, 2, 3]),
      },
      status: 'pending',
      attempts: 0,
      createdAt: 100,
    };
    const storage = makeStorage([mediaEntry]);
    const mlsService = makeMls();
    const uploadMedia = vi.fn().mockResolvedValue({ mediaId: 'mid-2', key: 'aa', iv: 'bb' });
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['mr'])]]);
    const outbox = createOutbox(
      makeDeps({ mlsService, storage, conversations, uploadMedia, isGroupHealthy: () => true })
    );

    await outbox.flush();

    const sent = decodeAppMessage(mlsService.sendMessage.mock.calls[0][1] as Uint8Array);
    expect(mediaReelFromProto(sent!.media!)).toEqual({
      intent: 'reel-message',
      durationMs: 42_000,
      expiresAtMs: 1_790_000_000_000,
    });
    expect(conversations.get('g1')!.messages[0].content).toContain('"intent":"reel-message"');
  });

  it('publishes the uploaded media before a slow MLS send completes', async () => {
    const mediaEntry: OutboxEntry = {
      id: 'mm',
      conversationId: 'g1',
      sentAt: 100,
      kind: 'media',
      media: {
        kind: MediaKind.MEDIA_KIND_VIDEO,
        mimeType: 'video/mp4',
        size: 3,
        fileName: 'clip.mp4',
        fileBytes: new Uint8Array([1, 2, 3]),
      },
      status: 'pending',
      attempts: 0,
      createdAt: 100,
    };
    const storage = makeStorage([mediaEntry]);
    let releaseSend!: () => void;
    const sendBlocked = new Promise<void>((resolve) => (releaseSend = resolve));
    const mlsService = makeMls({ send: () => sendBlocked });
    const uploadMedia = vi.fn().mockResolvedValue({
      type: 'video',
      mediaId: 'mid-1',
      key: 'aa',
      iv: 'bb',
      mimeType: 'video/mp4',
      size: 3,
      fileName: 'clip.mp4',
    });
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['mm'])]]);
    const outbox = createOutbox(
      makeDeps({ conversations, mlsService, storage, uploadMedia, isGroupHealthy: () => true })
    );

    const flush = outbox.flush();
    await vi.waitFor(() => expect(conversations.get('g1')!.messages[0].content).toContain('mid-1'));
    expect(conversations.get('g1')!.messages[0].status).toBe('sending');

    releaseSend();
    await flush;
  });

  /**
   * A 413 is the edge's ANSWER about the body (Cloudflare Free refuses above exactly 1 MiB): the
   * same upload re-posted once a minute reached attempt 806 in production. Classified from the
   * typed throw, so the entry leaves the queue after ONE attempt, the bubble errors, the author is
   * told in the thread, and the log accuses.
   */
  it('gives up on a 413 after one attempt: typed, removed, noticed, logged as an error', async () => {
    const mediaEntry: OutboxEntry = {
      id: 'big',
      conversationId: 'g1',
      sentAt: 100,
      kind: 'media',
      media: {
        kind: MediaKind.MEDIA_KIND_VIDEO,
        mimeType: 'video/mp4',
        size: 5_000_000,
        fileName: 'clip.mp4',
        fileBytes: new Uint8Array([1, 2, 3]),
      },
      status: 'pending',
      attempts: 0,
      createdAt: 100,
    };
    const storage = makeStorage([mediaEntry]);
    const mlsService = makeMls();
    // Message text is deliberately unrelated to "413": only the type may decide.
    const uploadMedia = vi.fn().mockRejectedValue(new MediaUploadError(413, 'refused'));
    const addMessageToChat = vi.fn().mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['big'])]]);
    const outbox = createOutbox(
      makeDeps({
        mlsService,
        storage,
        conversations,
        uploadMedia,
        addMessageToChat,
        isGroupHealthy: () => true,
      })
    );

    await outbox.flush();
    await outbox.flush();

    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(storage._map.has('big')).toBe(false);
    expect(conversations.get('g1')!.messages[0].status).toBe('error');
    expect(addMessageToChat).toHaveBeenCalledWith(
      'system',
      expect.any(String),
      'g1',
      expect.objectContaining({ isSystem: true })
    );
    expect(
      errorSpy.mock.calls.some((c) => String(c[0]).includes('upload REFUSED (too-large'))
    ).toBe(true);
    errorSpy.mockRestore();
  });

  /**
   * A 403 is an ANSWER about the caller (a token naming another account than the frame's sender):
   * the same six entries were re-posted 23 times on a bench phone. Classified from the TYPE, the
   * entry is KEPT but parked after ONE attempt, and the log accuses.
   */
  it('parks an entry after a 403 instead of re-posting it for ever', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const send = vi.fn(async () => {
      throw new SendForbiddenError('g1');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outbox = createOutbox(
      makeDeps({ mlsService: makeMls({ send }), storage, isGroupHealthy: () => true })
    );

    await outbox.flush();
    await outbox.flush();
    await outbox.flush();

    expect(send).toHaveBeenCalledTimes(1);
    // Nothing the user wrote is lost: the row stays, pending, for after a sign-in.
    expect(storage._map.has('m1')).toBe(true);
    expect(storage._map.get('m1')?.status).toBe('pending');
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('REFUSED with 403'))).toBe(true);
    errorSpy.mockRestore();
  });

  it('does not park an edge 403: it retries on the ladder, accuses and tells the user once', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100), textEntry('m2', 'g1', 101)]);
    const send = vi.fn(async () => {
      throw new SendEdgeRefusedError('g1', 403);
    });
    const addMessageToChat = vi.fn(async () => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outbox = createOutbox(
      makeDeps({
        mlsService: makeMls({ send }),
        storage,
        isGroupHealthy: () => true,
        addMessageToChat,
      })
    );

    await outbox.flush();

    expect(storage._map.get('m1')?.attempts).toBe(1);
    expect(storage._map.get('m1')?.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(addMessageToChat).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('by the EDGE'))).toBe(true);
    errorSpy.mockRestore();
  });

  it('does not treat a 5xx as the 403 answer: it still climbs the ladder', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: makeMls({
          send: async () => {
            throw new SendServerError('g1', 503, 'gateway');
          },
        }),
        storage,
        isGroupHealthy: () => true,
      })
    );

    await outbox.flush();

    expect(storage._map.get('m1')?.attempts).toBe(1);
    expect(storage._map.get('m1')?.serverErrors).toBe(1);
  });

  it('still retries a 5xx upload refusal: only a 4xx answer is permanent', async () => {
    const mediaEntry: OutboxEntry = {
      id: 'srv',
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
    const uploadMedia = vi.fn().mockRejectedValue(new MediaUploadError(503, 'unavailable'));
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['srv'])]]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: makeMls(),
        storage,
        conversations,
        uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    await outbox.flush();

    expect(storage._map.get('srv')!.attempts).toBe(1);
    expect(conversations.get('g1')!.messages[0].status).toBe('pending');
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

  it('REJECTS an enqueue whose durable write failed, so the caller can withdraw its placeholder', async () => {
    const storage = makeStorage();
    storage.saveOutboxEntry.mockRejectedValueOnce(new Error('quota'));
    const outbox = createOutbox(makeDeps({ mlsService: makeMls(), storage }));

    await expect(outbox.enqueue(textEntry('m1', 'g1', 100))).rejects.toMatchObject({
      name: 'OutboxEnqueueError',
    });
    expect(storage._map.has('m1')).toBe(false);
  });

  it('REJECTS an enqueue with no storage layer, and the module entry point with no controller', async () => {
    const outbox = createOutbox(makeDeps({ mlsService: makeMls(), storage: null }));
    await expect(outbox.enqueue(textEntry('m1', 'g1', 100))).rejects.toMatchObject({
      name: 'OutboxEnqueueError',
    });
    unregisterOutbox();
    await expect(enqueueOutboxMessage(textEntry('m2', 'g1', 100))).rejects.toMatchObject({
      name: 'OutboxEnqueueError',
    });
    await expect(isOutboxEntryQueued('m2')).resolves.toBeNull();
  });

  it('registers even when the orphan blob sweep throws SYNCHRONOUSLY, and logs the failure', async () => {
    const storage = makeStorage();
    storage.sweepOutboxBlobs = vi.fn(() => {
      throw new Error('handle not open');
    });
    const log = vi.fn();
    const controller = registerOutbox(makeDeps({ mlsService: makeMls(), storage, log }));
    expect(controller).toBeTruthy();
    await outboxIdle();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('orphan blob sweep failed'));
    unregisterOutbox();
  });

  it('answers hasEntry from the durable queue: true, false, and null when it cannot be read', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const outbox = createOutbox(makeDeps({ mlsService: makeMls(), storage }));
    await expect(outbox.hasEntry('m1')).resolves.toBe(true);
    await expect(outbox.hasEntry('nope')).resolves.toBe(false);
    storage.getOutboxQueue.mockRejectedValueOnce(new Error('locked'));
    await expect(outbox.hasEntry('m1')).resolves.toBeNull();
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

    // With the server's receive time, so the follower's echo is ordered like every other copy.
    expect(tabOutboxMock.publishOutboxEntrySent).toHaveBeenCalledWith(
      'm1',
      undefined,
      1_700_000_000_000
    );
  });

  it('a sent reply takes its place by the receivedAt the send answered (server-clock order)', async () => {
    // The owner's case (2026-10-31): the reply's `sentAt` (1 000) is OLDER than the peer message
    // that came in while it was typed. Pending, it sits below every dated row; sent, it is placed
    // by the server's receive time - here after the peer's, so below it, on every device.
    const convo = convoWith('g1', ['m1']);
    const peer = {
      id: 'peer',
      senderId: 'p',
      content: 'x',
      timestamp: new Date(2_000),
      isOwn: false,
      serverTimestamp: 1_699_999_999_000,
    };
    convo.messages = [peer, ...convo.messages];
    const conversations = new SvelteMap<string, Conversation>([['g1', convo]]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: makeMls(),
        storage: makeStorage([textEntry('m1', 'g1', 100)]),
        conversations,
      })
    );

    await outbox.flush();

    const after = conversations.get('g1')!.messages;
    expect(after.map((m) => m.id)).toEqual(['peer', 'm1']);
    expect(after[1]).toMatchObject({ status: 'sent', serverTimestamp: 1_700_000_000_000 });
    outbox.dispose();
  });

  it('a follower places its echo by the receivedAt the leader reports', () => {
    isTabLeaderMock.mockReturnValue(false);
    const convo = convoWith('g1', ['t1']);
    const later = {
      id: 'later',
      senderId: 'p',
      content: 'x',
      timestamp: new Date(5_000),
      isOwn: false,
      serverTimestamp: 5_000,
    };
    convo.messages = [later, ...convo.messages];
    const conversations = new SvelteMap<string, Conversation>([['g1', convo]]);
    const outbox = createOutbox(
      makeDeps({ mlsService: makeMls(), storage: makeStorage([]), conversations })
    );
    const handler = tabOutboxMock.subscribeTabOutboxEvents.mock.calls.at(-1)![0];
    handler({ type: 'outbox_entry_sent', messageId: 't1', receivedAt: 4_000 });
    expect(conversations.get('g1')!.messages.map((m) => m.id)).toEqual(['t1', 'later']);
    expect(conversations.get('g1')!.messages[0]).toMatchObject({
      status: 'sent',
      serverTimestamp: 4_000,
    });
    outbox.dispose();
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
    // A few microtask turns, not one: the enqueue reads the owed group exits before its write.
    await outboxIdle();

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

  /**
   * ONE ELECTION IS ONE EVENT. Twenty flushes landing in the boot gap used to await the election
   * twenty times over and log twenty resolutions - measured on HEAL-REVOKE-5, 2026-08-29, inside a
   * single second. Every waiter still resumed, so this asserts the LOG and not the outcome: the
   * noise was the whole defect, and a reader who learns to skip a line is how the next one hides.
   */
  it('logs one deferral and one decision however many flushes land in the boot gap', async () => {
    let decide!: (side: 'leader' | 'follower') => void;
    decidedMock.promise = new Promise((r) => {
      decide = r;
    });
    leadershipMock.mockImplementation(() => 'undecided');

    const lines: string[] = [];
    const storage = makeStorage();
    const mlsService = makeMls();
    const outbox = createOutbox(
      makeDeps({ mlsService, storage, log: (m: string) => lines.push(m) })
    );

    const inFlight = [];
    for (let i = 0; i < 20; i++) inFlight.push(outbox.enqueue(textEntry(`m${i}`, 'g1', 100 + i)));
    await outboxIdle();

    expect(lines.filter((l) => l.includes('Flush deferred'))).toHaveLength(1);

    leadershipMock.mockImplementation(() => 'leader');
    decide('leader');
    await Promise.all(inFlight);
    await outboxIdle();

    // The number the twenty lines differed by was the wait, which is why none of them deduped.
    expect(lines.filter((l) => l.includes('Leadership decided as'))).toHaveLength(1);
    // ...and every entry still went out, so the shared wait released all of them rather than
    // leaving nineteen behind the one that won the race to `flushing`.
    await vi.waitFor(() => expect(storage._map.size).toBe(0));
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

/**
 * A GROUP EXIT SETTLES THE GROUP'S QUEUE BEFORE ITS SERVER STEP (GRP-6, 2026-10-22).
 *
 * The leaver's read watermark was queued as the conversation closed, flushed 54 ms after the leave
 * ended the membership, refused 403 and parked "until the next sign-in". The exit now drains the
 * group's lane while the membership still exists, awaits what is on the wire, withdraws only what
 * cannot go, and every later enqueue for the group refuses itself on the durable owed exit.
 */
describe('outbox - settling a group before its exit', () => {
  beforeEach(() => {
    connectivity.reset();
    isTabLeaderMock.mockReturnValue(true);
    tabOutboxMock.subscribeTabOutboxEvents.mockImplementation(() => () => {});
  });

  it('SENDS a text written just before leaving, before it resolves, and touches no other group', async () => {
    const storage = makeStorage([textEntry('m1', 'left', 100), textEntry('m2', 'kept', 101)]);
    const mlsService = makeMls();
    const lines: string[] = [];
    const outbox = createOutbox(makeDeps({ mlsService, storage, log: (m) => lines.push(m) }));

    expect(await outbox.drainForExit('left', 'leave')).toBe(0);

    const sentIds = mlsService.sendMessage.mock.calls.map((c: unknown[]) => c[2]);
    expect(sentIds).toEqual(['m1']);
    expect(storage._map.has('m1')).toBe(false);
    expect(storage._map.has('m2')).toBe(true);
    expect(lines).toContainEqual(
      'leave of left…: 1 of 1 queued entry sent before the server step, 0 lost'.replace(
        /^/,
        '[OUTBOX] '
      )
    );
  });

  it('withdraws only what cannot be sent, and names what was lost by kind', async () => {
    const storage = makeStorage([
      textEntry('m1', 'left', 100),
      {
        ...textEntry('c1', 'left', 101),
        kind: 'control',
        text: undefined,
        controlProto: new Uint8Array([1]),
      },
      textEntry('m2', 'kept', 102),
    ]);
    const mlsService = makeMls();
    const lines: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    connectivity.notifyServerUnreachable();
    const outbox = createOutbox(makeDeps({ mlsService, storage, log: (m) => lines.push(m) }));

    expect(await outbox.drainForExit('left', 'delete')).toBe(2);

    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect([...storage._map.keys()]).toEqual(['m2']);
    expect(lines).toContainEqual(
      expect.stringMatching(
        /delete of left…: 0 of 2 queued entries sent before the server step, 2 lost \(1 text, 1 control\)/
      )
    );
    expect(lines).toContainEqual(expect.stringContaining('(text) withdrawn by the group exit'));
    // The author's-delete wording would be false here: nothing travels as an event on an exit.
    expect(lines.some((l) => l.includes('has to travel as an event'))).toBe(false);
    warn.mockRestore();
  });

  it('awaits a send already on the wire before it resolves, instead of racing it', async () => {
    let release!: () => void;
    const onTheWire = new Promise<void>((r) => {
      release = r;
    });
    const storage = makeStorage([textEntry('m1', 'left', 100)]);
    const mlsService = makeMls({ send: () => onTheWire });
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    void outbox.flush();
    await outboxIdle();
    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);

    let settled = false;
    const exit = outbox.drainForExit('left', 'leave').then(() => {
      settled = true;
    });
    await outboxIdle();
    // The POST has not answered: the server step must not start yet.
    expect(settled).toBe(false);

    release();
    await exit;
    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    expect(storage._map.size).toBe(0);
  });

  it('refuses an enqueue into a group whose exit is owed, and deletes a row written beside its echo', async () => {
    const storage = makeStorage([textEntry('m1', 'left', 100)]);
    storage._exits.push({ groupId: 'left', kind: 'leave', requestedAt: 1 });
    const mlsService = makeMls();
    const lines: string[] = [];
    connectivity.notifyServerUnreachable();
    const outbox = createOutbox(makeDeps({ mlsService, storage, log: (m) => lines.push(m) }));

    await outbox.enqueue(textEntry('m9', 'left', 200));
    await outbox.enqueue(textEntry('m1', 'left', 100), { alreadyDurable: true });

    expect(storage.saveOutboxEntry).not.toHaveBeenCalled();
    expect(storage._map.size).toBe(0);
    expect(lines).toContainEqual(
      expect.stringContaining('not queued: this device owes the leave of left…')
    );
  });

  it('withdraws its own row when the exit was recorded while it was being written', async () => {
    const storage = makeStorage([]);
    const save = storage.saveOutboxEntry.getMockImplementation();
    storage.saveOutboxEntry.mockImplementation(async (e: OutboxEntry) => {
      await save(e);
      // The exit lands between the gate's first look and the write's end.
      storage._exits.push({ groupId: 'left', kind: 'delete', requestedAt: 1 });
    });
    const mlsService = makeMls();
    connectivity.notifyServerUnreachable();
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    await outbox.enqueue(textEntry('m1', 'left', 100));

    expect(storage._map.size).toBe(0);
  });

  it('a kill between the recorded exit and its drain: the relaunch sends nothing of the group into the 403, and the leave still proceeds', async () => {
    // The leave died after `recordPendingGroupExit` and before `drainForExit`: the rows it would
    // have settled are still queued, and the owed exit is on disk. A fresh controller is the relaunch.
    const base = makeStorage([
      textEntry('m1', 'left', 100),
      {
        ...textEntry('c1', 'left', 101),
        kind: 'control' as const,
        text: undefined,
        controlProto: new Uint8Array([1]),
      },
      textEntry('m2', 'kept', 102),
    ]);
    const exits = base._exits;
    const storage = Object.assign(base, {
      deletePendingGroupExit: vi.fn(async (groupId: string) => {
        exits.splice(
          exits.findIndex((x: { groupId: string }) => x.groupId === groupId),
          1
        );
      }),
    });
    exits.push({ groupId: 'left', kind: 'leave', requestedAt: Date.now() });
    const mlsService = makeMls();
    const lines: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outbox = createOutbox(makeDeps({ mlsService, storage, log: (m) => lines.push(m) }));

    await outbox.flush();

    // Only the other group's text went; the exited group's rows are withdrawn, never posted.
    expect(mlsService.sendMessage.mock.calls.map((c: unknown[]) => c[2])).toEqual(['m2']);
    expect(storage._map.size).toBe(0);
    expect(lines).toContainEqual(
      expect.stringMatching(
        /lane left…: this device owes the leave of the group .* 2 queued entries withdrawn, never sent into the refusal \(1 text, 1 control\)/
      )
    );

    // The owed exit is untouched by the withdrawal, so the replay still ends the membership.
    const server = {
      removeMemberFromServer: vi.fn(async () => {}),
      deleteGroupOnServer: vi.fn(async () => true),
      dismissGroup: vi.fn(async () => {}),
    };
    const outcomes = await drainPendingGroupExits({
      storage: storage as any,
      mlsService: server as any,
      userId: 'me',
      log: () => {},
    });
    expect(server.removeMemberFromServer).toHaveBeenCalledWith('left', 'me');
    expect(outcomes).toEqual([{ groupId: 'left', kind: 'leave', result: 'answered' }]);
    expect(exits).toEqual([]);
    warn.mockRestore();
  });

  it('the exit drain itself still SENDS what can go, although its exit is owed by then', async () => {
    const storage = makeStorage([textEntry('m1', 'left', 100)]);
    storage._exits.push({ groupId: 'left', kind: 'leave', requestedAt: 1 });
    const mlsService = makeMls();
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    expect(await outbox.drainForExit('left', 'leave')).toBe(0);
    expect(mlsService.sendMessage.mock.calls.map((c: unknown[]) => c[2])).toEqual(['m1']);
  });

  it('lets the owed read-mark ledger drop a mark of an exited group, so a sign-in re-queues nothing', async () => {
    const storage = makeStorage([]);
    storage._exits.push({ groupId: 'left', kind: 'leave', requestedAt: 1 });
    const outbox = createOutbox(makeDeps({ mlsService: makeMls(), storage }));
    recordDmReadMark('u-exit', 'left', 4242);

    await flushDmReadMarks('u-exit', (conversationId) =>
      outbox.enqueue({
        id: `rm-${conversationId}`,
        conversationId,
        sentAt: 1,
        kind: 'control',
        controlProto: new Uint8Array([1]),
        status: 'pending',
        attempts: 0,
        createdAt: 1,
      })
    );

    expect(owedDmReadMarks('u-exit')['left']).toBeUndefined();
    expect(storage._map.size).toBe(0);
  });

  it("drops an author's delete that was on the wire when the send then failed, and says so", async () => {
    let refuse!: () => void;
    const onTheWire = new Promise<void>((_, reject) => {
      refuse = () => reject(new SendForbiddenError('g1'));
    });
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls({ send: () => onTheWire });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lines: string[] = [];
    const outbox = createOutbox(makeDeps({ mlsService, storage, log: (m) => lines.push(m) }));

    const flushing = outbox.flush();
    await outboxIdle();
    // The author deletes it mid-send: answered "maybe sent", so the delete goes as an event.
    expect(await outbox.cancelPending('m1')).toBe(false);
    refuse();
    await flushing;

    expect(storage._map.size).toBe(0);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('REFUSED with 403'))).toBe(false);
    expect(lines).toContainEqual(
      expect.stringContaining('deleted by its author while on the wire, and the send failed')
    );
    errorSpy.mockRestore();
  });
});

/**
 * R-D8 - THE TRIGGER TABLE, PINNED, BECAUSE THE COUNT THAT RAISED IT IS ACCURATE.
 *
 * Eight sites raise a flush and there is ONE flusher. That was flagged as a duplicate path and
 * refuted on every axis: all eight reach `runFlush`, which is where all the gates live, so "is
 * there a second flusher" is a question this block answers instead of a claim in a comment. The
 * reasoning, and why folding the three external sites in would be a regression, is on
 * `flushOutbox`'s docblock - whoever counts call sites next lands on one or the other before they
 * find eight things to fuse.
 *
 * Each row raises its trigger THE WAY ITS SITE DOES and nothing else - no `outbox.flush()` standing
 * in for an event - because a table that pokes the shared function proves only that the shared
 * function works, which was never in doubt. What each row asserts twice is that the SAME gate
 * decides: shut, the trigger sends nothing and costs the entry no attempt; open, that same trigger
 * drains. The backoff timer is the one trigger that cannot be a row - raising it needs a send that
 * has already failed, which needs the gate open - so it gets both halves in its own two cases.
 */
describe('outbox flush triggers - one flusher, and one gate for all of them (R-D8)', () => {
  interface TriggerSite {
    name: string;
    /** Raise the flush exactly the way this site does, and do nothing else. */
    run: (outbox: ReturnType<typeof createOutbox>) => Promise<void>;
  }

  /** The handler `createOutbox` registered on the cross-tab channel, for the follower's request. */
  function tabHandler(): (event: TabOutboxEvent) => void {
    const call = tabOutboxMock.subscribeTabOutboxEvents.mock.calls.at(-1);
    if (!call) throw new Error('the outbox registered no cross-tab subscriber');
    return call[0];
  }

  const SITES: TriggerSite[] = [
    {
      name: 'connectivity.onReconnect',
      run: async () => {
        connectivity.notifyServerUnreachable();
        connectivity.notifyServerReachable();
        await outboxIdle();
      },
    },
    {
      name: 'visibilitychange, the tab coming back',
      run: async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await outboxIdle();
      },
    },
    {
      name: "a follower tab's outbox_flush_request",
      run: async () => {
        tabHandler()({ type: 'outbox_flush_request' });
        await outboxIdle();
      },
    },
    {
      name: 'enqueue - the send that is being made right now',
      run: async (outbox) => {
        await outbox.enqueue(textEntry('m1', 'g1', 100));
        await outboxIdle();
      },
    },
    {
      name: 'flushOutbox() - the three external sites, which share this one door',
      run: async (outbox) => {
        await outbox.flush();
      },
    },
    {
      name: "resumeGroup - one group became ready (sessionAuth's onGroupReady)",
      run: async (outbox) => {
        await outbox.resumeGroup('g1');
      },
    },
  ];

  beforeEach(() => {
    connectivity.reset();
    isTabLeaderMock.mockReturnValue(true);
    tabOutboxMock.subscribeTabOutboxEvents.mockClear();
    tabOutboxMock.requestLeaderOutboxFlush.mockClear();
  });

  it('drives six distinct triggers, not one of them written six times', () => {
    expect(new Set(SITES.map((s) => s.run.toString())).size).toBe(SITES.length);
  });

  for (const site of SITES) {
    it(`${site.name} reaches the one flusher, and is refused by the one gate`, async () => {
      let ready = false;
      const storage = makeStorage([textEntry('m1', 'g1', 100)]);
      const mlsService = makeMls();
      const outbox = createOutbox(makeDeps({ mlsService, storage, canFlush: () => ready }));

      await site.run(outbox);
      // Not merely "nothing was sent": the entry must come out of a refused trigger untouched, or
      // a trigger that fires while the session cannot send makes the queue slower rather than
      // faster - which is the whole reason the gate exists.
      expect(mlsService.sendMessage).not.toHaveBeenCalled();
      expect(storage._map.get('m1')!.attempts).toBe(0);

      ready = true;
      await site.run(outbox);
      expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
      expect(storage._map.size).toBe(0);

      outbox.dispose();
    });
  }

  it('a visibilitychange to HIDDEN raises nothing - the trigger is the tab coming BACK', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls();
    const outbox = createOutbox(makeDeps({ mlsService, storage }));
    const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      await outboxIdle();
      expect(mlsService.sendMessage).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(document, 'visibilityState', original);
      outbox.dispose();
    }
  });

  it('a follower receiving outbox_flush_request drops it instead of bouncing it back', async () => {
    isTabLeaderMock.mockReturnValue(false);
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls();
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    tabHandler()({ type: 'outbox_flush_request' });
    await outboxIdle();

    // The request is the leader's to serve. A follower that answered it by re-broadcasting would
    // put two tabs in a loop that ends only when one of them wins an election.
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(tabOutboxMock.requestLeaderOutboxFlush).not.toHaveBeenCalled();
    outbox.dispose();
  });

  it('the backoff timer re-attempts on its own, with no other event', async () => {
    vi.useFakeTimers();
    let failing = true;
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls({
      send: async () => {
        if (failing) throw new Error('transient');
      },
    });
    const outbox = createOutbox(makeDeps({ mlsService, storage }));
    try {
      await outbox.flush();
      expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
      expect(storage._map.get('m1')!.attempts).toBe(1);

      failing = false;
      // The first backoff step is 2 s. Nothing else happens: no reconnect, no visibility change,
      // no enqueue - the timer is a trigger in its own right and has to reach `runFlush` alone.
      await vi.advanceTimersByTimeAsync(2_500);

      expect(mlsService.sendMessage).toHaveBeenCalledTimes(2);
      expect(storage._map.size).toBe(0);
    } finally {
      outbox.dispose();
      vi.useRealTimers();
    }
  });

  it('and the backoff timer is refused by the same gate as every other trigger', async () => {
    vi.useFakeTimers();
    let ready = true;
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls({
      send: async () => {
        throw new Error('transient');
      },
    });
    const outbox = createOutbox(makeDeps({ mlsService, storage, canFlush: () => ready }));
    try {
      await outbox.flush();
      expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);

      // The session stops being able to send between the failure and the retry - exactly what a
      // logout-then-offline-unlock does. The timer must not be the one trigger that gets through.
      ready = false;
      await vi.advanceTimersByTimeAsync(2_500);

      expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
      expect(storage._map.get('m1')!.attempts).toBe(1);
    } finally {
      outbox.dispose();
      vi.useRealTimers();
    }
  });

  it('exactly three sites outside this module raise a flush, and they are the three named ones', async () => {
    const { relativeTo, sourceFiles } = await import('../../../test/sourceTree');
    const found: Record<string, number> = {};
    for (const { path, text } of sourceFiles({
      under: 'src',
      extensions: ['ts', 'svelte'],
      tests: 'exclude',
      skipDirs: ['proto'],
    })) {
      const rel = relativeTo(path, 'src');
      if (rel === 'lib/utils/chat/outbox.ts') continue;
      // The parentheses matter: bare `flushOutbox` matches the import line too. The second arm
      // is the other door into the same flush, which a new site would reach for once the first
      // one started failing here. `resumeOutboxGroup(id)` is the same door for ONE group.
      const calls =
        text.match(
          /\bflushOutbox\(\)|\bresumeOutboxGroup\([^)]|getOutbox\(\)[^\n]*\.(flush|resumeGroup)\(/g
        ) ?? [];
      if (calls.length) found[rel] = calls.length;
    }

    // A fourth external trigger is not forbidden; it has to be ARGUED FOR, which is what failing
    // here asks of whoever adds one - name the moment nothing inside the outbox can observe, or
    // bind it to the condition inside the outbox that already means it.
    expect(found, 'a new site raises a flush from outside the outbox').toEqual({
      'lib/composables/session/promoteOfflineSession.ts': 1,
      'lib/composables/session/sessionAuth.ts': 2,
    });
  });
});

describe('outbox flusher - the device key is read at each access', () => {
  beforeEach(() => {
    connectivity.reset();
  });

  // The controller lives for the whole login, and a PIN change moves the session's key while it
  // does. A key captured at creation kept reading the queue under the abandoned one.
  it('reads the queue under the key as it is NOW, not as it was at creation', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls();
    let key = 'old-key';
    const outbox = createOutbox(
      makeDeps({ mlsService, storage, isGroupHealthy: () => true, deviceKey: () => key })
    );
    key = 'new-key';

    await outbox.flush();

    const keys = storage.getOutboxQueue.mock.calls.map((c: unknown[]) => c[0]);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k: unknown) => k === 'new-key')).toBe(true);
  });
});

// WP-OFF-5: one lane per conversation. Measured 2026-10-09: no deadline on the send POST and one
// flush loop awaiting its entries one by one, so a single stalled POST held every queued message
// behind it, in every conversation.
describe('outbox lanes - a stalled send freezes its own conversation and nothing else', () => {
  beforeEach(() => {
    connectivity.reset();
    isTabLeaderMock.mockReturnValue(true);
  });

  /** A send whose promise the test settles by hand, per message id. */
  function gatedSend() {
    const gates = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
    const started: string[] = [];
    const send = vi.fn(async (_g: string, _p: Uint8Array, id: string) => {
      started.push(id);
      await new Promise<void>((resolve, reject) => gates.set(id, { resolve, reject }));
      return accepted();
    });
    return { gates, started, send };
  }

  it('a stalled first entry does not delay an entry of another conversation', async () => {
    const storage = makeStorage([textEntry('a1', 'gA', 100), textEntry('b1', 'gB', 200)]);
    const g = gatedSend();
    const mlsService = makeMls();
    mlsService.sendMessage = g.send;
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    void outbox.flush();
    await outboxIdle();
    // BOTH are on the wire at once: a1 is stalled, and b1 did not wait for it.
    expect(g.started).toEqual(['a1', 'b1']);
    g.gates.get('b1')!.resolve();
    await outboxIdle();
    expect(storage._map.has('b1')).toBe(false);
    expect(storage._map.has('a1')).toBe(true);

    g.gates.get('a1')!.resolve();
    await outboxIdle();
    expect(storage._map.size).toBe(0);
    outbox.dispose();
  });

  it('an entry enqueued WHILE another conversation is stalled goes out at once', async () => {
    const storage = makeStorage([textEntry('a1', 'gA', 100)]);
    const g = gatedSend();
    const mlsService = makeMls();
    mlsService.sendMessage = g.send;
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    void outbox.flush();
    await outboxIdle();
    expect(g.started).toEqual(['a1']);

    await outbox.enqueue(textEntry('b1', 'gB', 300));
    await outboxIdle();
    expect(g.started).toEqual(['a1', 'b1']);
    outbox.dispose();
  });

  it('inside one conversation the order is kept: a failed head holds its successors', async () => {
    const storage = makeStorage([textEntry('a1', 'gA', 100), textEntry('a2', 'gA', 200)]);
    const sent: string[] = [];
    const mlsService = makeMls();
    mlsService.sendMessage = vi.fn(async (_g: string, _p: Uint8Array, id: string) => {
      sent.push(id);
      throw new Error('transient');
    });
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    await outbox.flush();
    // a2 was never attempted: it would have overtaken a1.
    expect(sent).toEqual(['a1']);
    expect(storage._map.get('a2')!.attempts).toBe(0);
    outbox.dispose();
  });

  it('a conversation drains its queue in order when every send succeeds', async () => {
    const storage = makeStorage([
      textEntry('a2', 'gA', 200),
      textEntry('a1', 'gA', 100),
      textEntry('a3', 'gA', 300),
    ]);
    const sent: string[] = [];
    const mlsService = makeMls();
    mlsService.sendMessage = vi.fn(async (_g: string, _p: Uint8Array, id: string) => {
      sent.push(id);
      return accepted();
    });
    const outbox = createOutbox(makeDeps({ mlsService, storage }));
    await outbox.flush();
    expect(sent).toEqual(['a1', 'a2', 'a3']);
    expect(storage._map.size).toBe(0);
    outbox.dispose();
  });

  it('two wake-ups landing together start ONE lane, so an entry is sent once', async () => {
    const storage = makeStorage([textEntry('a1', 'gA', 100)]);
    const g = gatedSend();
    const mlsService = makeMls();
    mlsService.sendMessage = g.send;
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    void outbox.flush();
    void outbox.flush();
    void outbox.flush();
    await outboxIdle();
    expect(g.started).toEqual(['a1']);
    g.gates.get('a1')!.resolve();
    await outboxIdle();
    expect(g.started).toEqual(['a1']);
    outbox.dispose();
  });

  it('never has more than MAX_CONCURRENT_SENDS frames on the wire', async () => {
    const entries = ['a', 'b', 'c', 'd', 'e'].map((c, i) => textEntry(`${c}1`, `g${c}`, 100 + i));
    const storage = makeStorage(entries);
    const g = gatedSend();
    const mlsService = makeMls();
    mlsService.sendMessage = g.send;
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    void outbox.flush();
    await outboxIdle();
    expect(g.started).toHaveLength(MAX_CONCURRENT_SENDS);
    g.gates.get(g.started[0])!.resolve();
    await outboxIdle();
    expect(g.started).toHaveLength(MAX_CONCURRENT_SENDS + 1);
    outbox.dispose();
  });
});

// WP-OFF-6: a resume is prompt. Measured 2026-10-09: 3.8-5.3 s from "link back" to the first resent
// frame, all of it spent waiting for some UNRELATED request to prove the server reachable, and then
// for a backoff the dead link had earned and the live one had not.
describe('outbox resume - prompt, and exactly once in effect', () => {
  beforeEach(() => {
    connectivity.reset();
    isTabLeaderMock.mockReturnValue(true);
  });

  it('a transport failure skips its backoff when the link comes back, a refusal does not', async () => {
    const storage = makeStorage([textEntry('t1', 'gT', 100), textEntry('r1', 'gR', 200)]);
    const sent: string[] = [];
    let healed = false;
    const mlsService = makeMls();
    mlsService.sendMessage = vi.fn(async (g: string, _p: Uint8Array, id: string) => {
      sent.push(id);
      if (healed && g === 'gT') return accepted();
      if (g === 'gT') throw new DeliveryUnreachableError(new TypeError('Failed to fetch'));
      throw new SenderNotActiveError(g, 'pending');
    });
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    await outbox.flush();
    expect(sent).toEqual(['t1', 'r1']);
    // Both are now backing off 2 s. The link blips and returns, with no timer elapsed.
    healed = true;
    connectivity.notifyServerUnreachable();
    connectivity.notifyServerReachable();
    await outboxIdle();

    // t1 (no answer) went at once; r1 (the server REFUSED it) kept its clock.
    expect(sent).toEqual(['t1', 'r1', 't1']);
    expect(storage._map.has('t1')).toBe(false);
    expect(storage._map.get('r1')!.attempts).toBe(1);
    outbox.dispose();
  });

  it('skips the backoff once: a second reconnect with nothing new held does not re-send', async () => {
    const storage = makeStorage([textEntry('t1', 'gT', 100)]);
    const mlsService = makeMls();
    mlsService.sendMessage = vi.fn(async () => {
      throw new DeliveryUnreachableError(new TypeError('Failed to fetch'));
    });
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    await outbox.flush();
    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    connectivity.notifyServerUnreachable();
    connectivity.notifyServerReachable();
    await outboxIdle();
    // The resume attempt failed again and re-armed the ladder: one more attempt, not a loop.
    expect(mlsService.sendMessage).toHaveBeenCalledTimes(2);
    expect(storage._map.get('t1')!.attempts).toBe(2);
    outbox.dispose();
  });

  it('a frame whose answer was lost is sent again with the SAME id after a reload, and is delivered once in effect', async () => {
    vi.useFakeTimers();
    try {
      const storage = makeStorage([textEntry('m1', 'gA', 100)]);
      // The "server": a set keyed by the inner messageId, exactly what a receiver deduplicates on.
      const received = new Set<string>();
      const frames: string[] = [];
      let lostAnswer = true;
      const mkMls = () => {
        const mls = makeMls();
        mls.sendMessage = vi.fn(async (_g: string, _p: Uint8Array, id: string) => {
          frames.push(id);
          received.add(id);
          if (lostAnswer) {
            lostAnswer = false;
            // The POST REACHED the server; the link died with the answer.
            throw new DeliveryUnreachableError(new TypeError('Failed to fetch'));
          }
          return accepted();
        });
        return mls;
      };

      const first = createOutbox(makeDeps({ mlsService: mkMls(), storage }));
      await first.flush();
      expect(storage._map.has('m1')).toBe(true);
      first.dispose();

      // RELOAD: a new controller, no in-memory state, the same durable queue.
      const second = createOutbox(makeDeps({ mlsService: mkMls(), storage }));
      await vi.advanceTimersByTimeAsync(2_500);
      second.flush();
      await vi.advanceTimersByTimeAsync(100);

      expect(frames).toEqual(['m1', 'm1']);
      expect(received.size).toBe(1);
      expect(storage._map.size).toBe(0);

      // And nothing is ever sent for it again.
      await second.flush();
      await vi.advanceTimersByTimeAsync(70_000);
      expect(frames).toEqual(['m1', 'm1']);
      second.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A REMOVE HOLDS AGAINST A LATER RE-ADD (user, 2026-10-14). A reply carries the quoted message's text
 * to every current member live, so a quote of something sent while one of them was out carries the
 * id only. Decided HERE, at the send, against the windows in force then - and never on a failure,
 * because a blank is permanent (second review of #1878).
 */
describe('outbox - a reply decides its quote text at the send', () => {
  beforeEach(() => {
    connectivity.reset();
  });

  const QUOTED_AT = 1_700_000_050_000;
  /** Bob was out around the quoted message. */
  const bobsWindow = async () => new Map([['bob', [{ from: QUOTED_AT - 1, until: null }]]]);

  function replyEntry(): OutboxEntry {
    return {
      id: 'r1',
      conversationId: 'g1',
      sentAt: 100,
      kind: 'reply',
      text: 'answer',
      replyTo: { id: 'q1', senderId: 'carol', preview: 'the quoted words' },
      status: 'pending',
      attempts: 0,
      createdAt: 100,
    };
  }

  function convo(): Conversation {
    return {
      ...convoWith('g1', []),
      messages: [
        {
          id: 'q1',
          senderId: 'carol',
          content: 'x',
          timestamp: new Date(QUOTED_AT),
          serverTimestamp: QUOTED_AT,
          isOwn: false,
        },
        {
          id: 'r1',
          senderId: 'u',
          content: serializeEnvelope(
            mkTextEnvelope('answer', { id: 'q1', senderId: 'carol', content: 'the quoted words' })
          ),
          replyTo: { id: 'q1', senderId: 'carol', content: 'the quoted words' },
          timestamp: new Date(100),
          isOwn: true,
          status: 'pending' as const,
        },
      ],
    };
  }

  const sentPreview = (mls: any): string | null | undefined =>
    decodeAppMessage(mls.sendMessage.mock.calls[0][1] as Uint8Array)?.reply?.replyTo?.preview;

  it('quotes by id only when the quoted message falls in a member window - frame, entry and echo', async () => {
    const storage = makeStorage([replyEntry()]);
    const mlsService = makeMls({ exclusions: bobsWindow });
    const conversations = new SvelteMap<string, Conversation>([['g1', convo()]]);
    const outbox = createOutbox(makeDeps({ mlsService, storage, conversations }));

    await outbox.flush();

    expect(sentPreview(mlsService)).toBe('');
    expect(storage.saveOutboxEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r1', replyTo: expect.objectContaining({ preview: '' }) }),
      'device-key'
    );
    const echo = conversations.get('g1')!.messages.find((m) => m.id === 'r1')!;
    expect(echo.replyTo?.content).toBe('');
    const env = parseEnvelope(echo.content);
    expect(env.kind === 'text' && env.replyTo?.content).toBe('');
  });

  it('keeps the quote text when nobody is out around it', async () => {
    const storage = makeStorage([replyEntry()]);
    const mlsService = makeMls();
    const conversations = new SvelteMap<string, Conversation>([['g1', convo()]]);
    const outbox = createOutbox(makeDeps({ mlsService, storage, conversations }));

    await outbox.flush();

    expect(sentPreview(mlsService)).toBe('the quoted words');
  });

  it('sends nothing and blanks nothing when the windows cannot be read - the reply waits', async () => {
    const storage = makeStorage([replyEntry()]);
    const mlsService = makeMls({
      exclusions: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const conversations = new SvelteMap<string, Conversation>([['g1', convo()]]);
    const outbox = createOutbox(makeDeps({ mlsService, storage, conversations }));

    await outbox.flush();

    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(storage._map.get('r1')!.replyTo!.preview).toBe('the quoted words');
    expect(storage._map.get('r1')!.status).not.toBe('failed');
    outbox.dispose();
  });

  /**
   * A 403 ON THE WINDOWS IS AN ANSWER ABOUT THE ROSTER, NOT ABOUT THIS DEVICE (fourth review of
   * #1878). The route refuses on the roster alone; the send refuses on this device's row. So a device
   * `active` but roster-less must not lose its tree to the roster repair for quoting a message: the
   * reply goes out quoting by id only, and only the SEND's own refusal may repair.
   */
  it('an active, roster-less device sends its reply id-only and repairs NOTHING', async () => {
    const storage = makeStorage([replyEntry()]);
    const mlsService = makeMls({
      exclusions: async () => {
        throw new ExclusionsRefusedError('g1');
      },
    });
    const recoverRosterDisagreement = vi.fn().mockResolvedValue(undefined);
    const conversations = new SvelteMap<string, Conversation>([['g1', convo()]]);
    const outbox = createOutbox(
      makeDeps({ mlsService, storage, conversations, recoverRosterDisagreement })
    );

    await outbox.flush();

    expect(recoverRosterDisagreement).not.toHaveBeenCalled();
    expect(sentPreview(mlsService)).toBe('');
    const echo = conversations.get('g1')!.messages.find((m) => m.id === 'r1')!;
    expect(echo.replyTo?.content).toBe('');
    outbox.dispose();
  });

  it('the repair runs only on the SEND refusing this device, and the quote survives the failure', async () => {
    const storage = makeStorage([replyEntry()]);
    const mlsService = makeMls({
      exclusions: async () => {
        throw new ExclusionsRefusedError('g1');
      },
      send: async () => {
        throw new SenderNotActiveError('g1', 'pending');
      },
    });
    const recoverRosterDisagreement = vi.fn().mockResolvedValue(undefined);
    const conversations = new SvelteMap<string, Conversation>([['g1', convo()]]);
    const outbox = createOutbox(
      makeDeps({ mlsService, storage, conversations, recoverRosterDisagreement })
    );

    await outbox.flush();

    expect(recoverRosterDisagreement).toHaveBeenCalledWith('g1');
    // Refused, the blank was never made permanent: the next attempt decides again.
    expect(storage._map.get('r1')!.replyTo!.preview).toBe('the quoted words');
    const echo = conversations.get('g1')!.messages.find((m) => m.id === 'r1')!;
    expect(echo.replyTo?.content).toBe('the quoted words');
    outbox.dispose();
  });

  /**
   * THE QUOTE DECISION IS AN AWAIT BEFORE THE CLAIM, so #1887's last look must still come after it:
   * a withdrawal landing while the windows are read is answered "never sent" and must stay true.
   */
  it('a reply withdrawn while its quote is being decided is never sent and never re-queued', async () => {
    const storage = makeStorage([replyEntry()]);
    let outbox: ReturnType<typeof createOutbox> | null = null;
    let withdrawn: boolean | undefined;
    const mlsService = makeMls({
      exclusions: async () => {
        withdrawn = await outbox!.cancelPending('r1');
        return bobsWindow();
      },
    });
    const conversations = new SvelteMap<string, Conversation>([['g1', convo()]]);
    outbox = createOutbox(makeDeps({ mlsService, storage, conversations }));

    await outbox.flush();

    expect(withdrawn).toBe(true);
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(storage._map.has('r1')).toBe(false);
    expect(storage.saveOutboxEntry).not.toHaveBeenCalled();
    outbox.dispose();
  });

  /**
   * WITHDRAWN WHILE ITS FRAME IS ON THE WIRE: the peers have it, so the delete travels as an event
   * (#1887), and the row is gone. Making the blank permanent must not write that row back - a
   * deleted message in the queue is one a later flush, or a crash before the final delete, sends.
   */
  it('a reply withdrawn while its frame is on the wire: the blank is not saved back into the queue', async () => {
    const storage = makeStorage([replyEntry()]);
    let outbox: ReturnType<typeof createOutbox> | null = null;
    let withdrawn: boolean | undefined;
    const mlsService = makeMls({
      exclusions: bobsWindow,
      send: (async () => {
        withdrawn = await outbox!.cancelPending('r1');
      }) as any,
    });
    const conversations = new SvelteMap<string, Conversation>([['g1', convo()]]);
    outbox = createOutbox(makeDeps({ mlsService, storage, conversations }));

    await outbox.flush();

    expect(withdrawn).toBe(false);
    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    expect(storage.saveOutboxEntry).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r1' }),
      expect.anything()
    );
    expect(storage._map.has('r1')).toBe(false);
    outbox.dispose();
  });

  it('the native mirror quotes by id only - it cannot read the windows', () => {
    const mirror = toMirrorEntry(replyEntry())!;
    const decoded = decodeAppMessage(Uint8Array.from(atob(mirror.proto), (c) => c.charCodeAt(0)));
    expect(decoded?.reply?.replyTo?.preview).toBe('');
    expect(decoded?.reply?.replyTo?.id).toBe('q1');
  });
});

describe('outbox uploads - a queued attachment shows its real progress and can be ended (WP-OFF-8)', () => {
  type Ref = import('$lib/media').MediaRef;
  type Transport = import('$lib/utils/uploadXhr').XhrUploadOptions;

  function mediaEntry(id: string, over: Partial<OutboxEntry> = {}): OutboxEntry {
    return {
      id,
      conversationId: 'g1',
      sentAt: 100,
      kind: 'media',
      media: {
        kind: MediaKind.MEDIA_KIND_UNSPECIFIED,
        mimeType: 'application/pdf',
        size: 3,
        fileName: 'big.pdf',
        fileBytes: new Uint8Array([1, 2, 3]),
      },
      status: 'pending',
      attempts: 0,
      createdAt: 100,
      ...over,
    };
  }

  /** A transfer that stays open until the test settles it, and reacts to its abort signal. */
  function hangingUpload() {
    let release!: (ref: Ref) => void;
    let signal: AbortSignal | undefined;
    let onProgress: ((p: { loaded: number; total: number }) => void) | undefined;
    const uploadMedia = vi.fn(
      (_media: unknown, transport?: Transport) =>
        new Promise<Ref>((resolve, reject) => {
          signal = transport?.signal;
          onProgress = transport?.onProgress;
          release = resolve;
          transport?.signal?.addEventListener('abort', () =>
            reject(new UploadAbortedError(transport.signal?.reason))
          );
        })
    );
    return {
      uploadMedia,
      release: (ref: Ref) => release(ref),
      progress: (loaded: number, total: number) => onProgress?.({ loaded, total }),
      signal: () => signal,
    };
  }

  const REF: Ref = {
    type: 'file',
    mediaId: 'mid',
    key: 'aa',
    iv: 'bb',
    mimeType: 'application/pdf',
    size: 3,
  };

  afterEach(() => clearAllUploads());

  // A media entry still asks before the wire: its upload precedes the POST, and a deleted group
  // must not cost the file.
  it('retires a media entry of a deleted group before uploading anything', async () => {
    const storage = makeStorage([mediaEntry('p1')]);
    const mls = makeMls({
      meta: (id) => ({ groupId: id, name: '', isGroup: true, deletedAt: '2020-01-01' }),
    });
    const up = hangingUpload();
    const outbox = createOutbox(
      makeDeps({
        mlsService: mls,
        storage,
        uploadMedia: up.uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    await outbox.flush();

    expect(mls.getGroupMeta).toHaveBeenCalledWith('g1');
    expect(up.uploadMedia).not.toHaveBeenCalled();
    expect(mls.sendMessage).not.toHaveBeenCalled();
    expect(storage._map.has('p1')).toBe(false);
  });

  it('mirrors the bytes sent into the bubble, and forgets them once the message is out', async () => {
    const storage = makeStorage([mediaEntry('p1')]);
    const mls = makeMls();
    const up = hangingUpload();
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['p1'])]]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: mls,
        storage,
        conversations,
        uploadMedia: up.uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    const flushing = outbox.flush();
    await vi.waitFor(() => expect(up.uploadMedia).toHaveBeenCalled());
    expect(uploadViewOf('p1')).toMatchObject({ phase: 'preparing', loaded: 0 });

    up.progress(5_000, 20_000);
    expect(uploadViewOf('p1')).toMatchObject({ phase: 'uploading', loaded: 5_000, total: 20_000 });
    expect(uploadPercent(uploadViewOf('p1')!)).toBe(25);

    up.release(REF);
    await flushing;
    expect(uploadViewOf('p1')).toBeUndefined();
    expect(mls.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('shows the next attempt as waiting after a transport failure, restarting from zero', async () => {
    const storage = makeStorage([mediaEntry('w1')]);
    const uploadMedia = vi.fn().mockRejectedValue(new UploadNetworkError('/x'));
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['w1'])]]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: makeMls(),
        storage,
        conversations,
        uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    await outbox.flush();

    expect(uploadViewOf('w1')).toMatchObject({ phase: 'waiting', loaded: 0, attempt: 1 });
  });

  it('a group that is not sendable says it is repairing, never that the connection is down', async () => {
    const storage = makeStorage([mediaEntry('r1')]);
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['r1'])]]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: makeMls(),
        storage,
        conversations,
        uploadMedia: vi.fn(),
        isGroupHealthy: () => false,
      })
    );

    await outbox.flush();

    expect(uploadViewOf('r1')).toMatchObject({ phase: 'repairing', loaded: 0, attempt: 1 });
  });

  it('a failure that is not the network says retrying, not waiting for a connection', async () => {
    const storage = makeStorage([mediaEntry('t1')]);
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['t1'])]]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: makeMls(),
        storage,
        conversations,
        uploadMedia: vi.fn().mockRejectedValue(new Error('unreadable')),
        isGroupHealthy: () => true,
      })
    );

    await outbox.flush();

    expect(uploadViewOf('t1')).toMatchObject({ phase: 'retrying', loaded: 0, attempt: 1 });
  });

  it('the return of the link clears the stale waiting view at once', async () => {
    const storage = makeStorage([mediaEntry('q1')]);
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['q1'])]]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: makeMls(),
        storage,
        conversations,
        uploadMedia: vi.fn().mockRejectedValue(new UploadNetworkError('/x')),
        isGroupHealthy: () => true,
      })
    );
    await outbox.flush();
    expect(uploadViewOf('q1')?.phase).toBe('waiting');

    connectivity.notifyServerUnreachable();
    connectivity.notifyServerReachable();

    expect(uploadViewOf('q1')?.phase).toBe('queued');
  });

  it('a withdrawn message ABORTS its transfer and is never sent', async () => {
    const storage = makeStorage([mediaEntry('c1')]);
    const mls = makeMls();
    const up = hangingUpload();
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['c1'])]]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: mls,
        storage,
        conversations,
        uploadMedia: up.uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    const flushing = outbox.flush();
    await vi.waitFor(() => expect(up.uploadMedia).toHaveBeenCalled());
    const withdrawn = await outbox.cancelPending('c1');
    await flushing;

    expect(withdrawn).toBe(true);
    expect(up.signal()?.aborted).toBe(true);
    expect(mls.sendMessage).not.toHaveBeenCalled();
    expect(storage._map.has('c1')).toBe(false);
    expect(uploadViewOf('c1')).toBeUndefined();
  });

  it('a retry abandons a stalled transfer and starts the next one at once, with no backoff', async () => {
    const storage = makeStorage([mediaEntry('r1')]);
    const mls = makeMls();
    const signals: Array<AbortSignal | undefined> = [];
    let finish!: (ref: Ref) => void;
    const uploadMedia = vi.fn(
      (_m: unknown, transport?: Transport) =>
        new Promise<Ref>((resolve, reject) => {
          signals.push(transport?.signal);
          if (signals.length === 1) {
            transport?.signal?.addEventListener('abort', () =>
              reject(new UploadAbortedError(transport.signal?.reason))
            );
          } else finish = resolve;
        })
    );
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['r1'])]]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: mls,
        storage,
        conversations,
        uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    const flushing = outbox.flush();
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalled());
    outbox.retryUpload('r1');
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(2));
    finish(REF);
    await flushing;

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(mls.sendMessage).toHaveBeenCalledTimes(1);
    expect(storage._map.has('r1')).toBe(false);
  });

  it.each([
    ['an application 403', new MediaUploadError(403, 'nope'), 'refused'],
    ['a 422', new MediaUploadError(422, 'bad'), 'refused'],
  ])(
    '%s ends the entry at once: no retry loop, an error bubble, a notice',
    async (_n, error, _c) => {
      const storage = makeStorage([mediaEntry('x1')]);
      const mls = makeMls();
      const uploadMedia = vi.fn().mockRejectedValue(error);
      const addMessageToChat = vi.fn().mockResolvedValue(undefined);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['x1'])]]);
      const outbox = createOutbox(
        makeDeps({
          mlsService: mls,
          storage,
          conversations,
          uploadMedia,
          addMessageToChat,
          isGroupHealthy: () => true,
        })
      );

      await outbox.flush();
      await outbox.flush();

      expect(uploadMedia).toHaveBeenCalledTimes(1);
      expect(storage._map.has('x1')).toBe(false);
      expect(conversations.get('g1')!.messages[0].status).toBe('error');
      expect(uploadViewOf('x1')).toBeUndefined();
      expect(addMessageToChat).toHaveBeenCalledOnce();
      errorSpy.mockRestore();
    }
  );

  it('an upload that stalls on three attempts in a row ENDS as failed: kept, parked, retry offered', async () => {
    const storage = makeStorage([mediaEntry('s1')]);
    const uploadMedia = vi
      .fn()
      .mockRejectedValue(new UploadStalledError(45_000, '/api/media/upload', 2_100_000));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['s1'])]]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: makeMls(),
        storage,
        conversations,
        uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    for (let i = 0; i < 3; i++) {
      // The ladder's own clock is not under test: let the backoff pass.
      const row = storage._map.get('s1');
      if (row) row.nextAttemptAt = 0;
      await outbox.flush();
    }
    expect(uploadMedia).toHaveBeenCalledTimes(3);
    expect(storage._map.has('s1')).toBe(true); // nothing the member wrote is lost
    expect(uploadViewOf('s1')?.phase).toBe('failed');

    // Terminal: the ladder no longer touches it.
    await outbox.flush();
    await outbox.flush();
    expect(uploadMedia).toHaveBeenCalledTimes(3);

    // A manual retry starts a NEW count, and a success clears the entry.
    uploadMedia.mockResolvedValue(REF);
    outbox.retryUpload('s1');
    await vi.waitFor(() => expect(storage._map.has('s1')).toBe(false));
    expect(uploadMedia).toHaveBeenCalledTimes(4);
    errorSpy.mockRestore();
  });

  it('a success between two stalls resets the count: two stalls, a success, two stalls is not terminal', async () => {
    const s3 = mediaEntry('s3', { sentAt: 200 });
    s3.media = { ...s3.media!, fileName: 's3.pdf' };
    const storage = makeStorage([mediaEntry('s2'), s3]);
    const stall = () => new UploadStalledError(45_000, '/api/media/upload', 1);
    // ONE SCRIPT PER FILE: since WP-OFF-9 an upload no longer holds its lane, so s3's transfer runs
    // while s2 backs off and a single shared script would hand s2's outcomes to s3.
    const scripts: Record<string, Array<() => Promise<Ref>>> = {
      'big.pdf': [() => Promise.reject(stall()), () => Promise.reject(stall()), async () => REF],
      's3.pdf': [() => Promise.reject(stall()), () => Promise.reject(stall())],
    };
    const uploadMedia = vi.fn((media: { fileName?: string }) => {
      const next = scripts[media.fileName ?? '']?.shift();
      return next ? next() : Promise.reject(new Error('a server error, not a no-answer'));
    });
    const conversations = new SvelteMap<string, Conversation>([
      ['g1', convoWith('g1', ['s2', 's3'])],
    ]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: makeMls(),
        storage,
        conversations,
        uploadMedia,
        isGroupHealthy: () => true,
      })
    );
    for (let i = 0; i < 6; i++) {
      for (const row of storage._map.values()) row.nextAttemptAt = 0;
      await outbox.flush();
    }
    expect(storage._map.has('s2')).toBe(false);
    expect(uploadViewOf('s3')?.phase).not.toBe('failed');
  });

  /** Runs `n` flushes of one media entry whose attempts each report `loaded` then throw `fail()`. */
  async function runAttempts(id: string, loadedPerAttempt: number[], fail: () => Error) {
    const storage = makeStorage([mediaEntry(id)]);
    let call = 0;
    const uploadMedia = vi.fn(async (_m: unknown, transport?: Transport) => {
      const loaded = loadedPerAttempt[Math.min(call++, loadedPerAttempt.length - 1)];
      if (loaded > 0) transport?.onProgress?.({ loaded, total: 2_000_000 });
      throw fail();
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', [id])]]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: makeMls(),
        storage,
        conversations,
        uploadMedia: uploadMedia as never,
        isGroupHealthy: () => true,
      })
    );
    for (let i = 0; i < loadedPerAttempt.length; i++) {
      const row = storage._map.get(id);
      if (row) row.nextAttemptAt = 0;
      await outbox.flush();
    }
    return { storage, uploadMedia, outbox, errorSpy };
  }

  it('attempts that each get further than the last are progress, never a verdict', async () => {
    const r = await runAttempts(
      'p1',
      [400_000, 900_000, 1_400_000, 1_900_000],
      () => new UploadStalledError(45_000, '/x', 1)
    );
    expect(uploadViewOf('p1')?.phase).not.toBe('failed');
    r.errorSpy.mockRestore();
  });

  it('attempts that fail at the same point (a relay body limit) end as failed after three', async () => {
    const r = await runAttempts(
      'p2',
      [1_400_000, 1_400_000, 1_400_000, 1_400_000],
      () => new UploadStalledError(45_000, '/x', 1)
    );
    expect(r.uploadMedia).toHaveBeenCalledTimes(4);
    expect(uploadViewOf('p2')?.phase).toBe('failed');
    r.errorSpy.mockRestore();
  });

  it('a failed upload stays failed across a reconnect: only the member restarts it', async () => {
    const r = await runAttempts('p3', [0, 0, 0], () => new UploadNetworkError('/x'));
    expect(uploadViewOf('p3')?.phase).toBe('failed');
    connectivity.notifyServerUnreachable();
    connectivity.notifyServerReachable();
    await outboxIdle();
    await r.outbox.flush();
    expect(r.uploadMedia).toHaveBeenCalledTimes(3);
    expect(uploadViewOf('p3')?.phase).toBe('failed');
    r.errorSpy.mockRestore();
  });

  it('a TypeError from preparation or an unanswered-but-delivered body is not a give-up', async () => {
    const a = await runAttempts('p4', [0, 0, 0, 0], () => new TypeError('bad bytes'));
    expect(uploadViewOf('p4')?.phase).not.toBe('failed');
    a.errorSpy.mockRestore();
    const b = await runAttempts(
      'p5',
      [0, 0, 0, 0],
      () => new UploadAnswerTimeoutError(300_000, '/x', 1)
    );
    expect(uploadViewOf('p5')?.phase).not.toBe('failed');
    b.errorSpy.mockRestore();
  });

  it('a reply to a parked attachment waits behind it, an independent text passes', async () => {
    const reply: OutboxEntry = {
      id: 'r1',
      conversationId: 'g1',
      sentAt: 150,
      kind: 'reply',
      text: 'about it',
      replyTo: { id: 'h1', senderId: 'u', preview: 'x' },
      status: 'pending',
      attempts: 0,
      createdAt: 150,
    };
    const storage = makeStorage([mediaEntry('h1'), reply, textEntry('h2', 'g1', 200)]);
    const mls = makeMls();
    const uploadMedia = vi.fn().mockRejectedValue(new MediaUploadError(403, 'ban', 'edge'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const conversations = new SvelteMap<string, Conversation>([
      ['g1', convoWith('g1', ['h1', 'r1', 'h2'])],
    ]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: mls,
        storage,
        conversations,
        uploadMedia,
        isGroupHealthy: () => true,
      })
    );
    await outbox.flush();
    await outbox.flush();
    expect(storage._map.has('r1')).toBe(true); // the reply waits
    expect(storage._map.has('h2')).toBe(false); // the independent text went
    errorSpy.mockRestore();
  });

  it('a parked upload does not hold back the messages written after it', async () => {
    const storage = makeStorage([mediaEntry('h1'), textEntry('h2', 'g1', 200)]);
    const mls = makeMls();
    const uploadMedia = vi.fn().mockRejectedValue(new MediaUploadError(403, 'ban', 'edge'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const conversations = new SvelteMap<string, Conversation>([
      ['g1', convoWith('g1', ['h1', 'h2'])],
    ]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: mls,
        storage,
        conversations,
        uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    await outbox.flush();
    await outbox.flush();

    expect(uploadViewOf('h1')?.phase).toBe('blocked');
    expect(storage._map.has('h1')).toBe(true);
    expect(storage._map.has('h2')).toBe(false); // the text went out
    expect(mls.sendMessage).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('a gateway 403 PARKS the entry: kept, no auto-retry, retry offered, then it goes up', async () => {
    const storage = makeStorage([mediaEntry('k1')]);
    const uploadMedia = vi
      .fn()
      .mockRejectedValueOnce(new MediaUploadError(403, 'ban', 'edge'))
      .mockResolvedValue(REF);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['k1'])]]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: makeMls(),
        storage,
        conversations,
        uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    await outbox.flush();
    await outbox.flush();
    await outbox.flush();

    expect(uploadMedia).toHaveBeenCalledTimes(1); // parked: not retried by the ladder
    expect(storage._map.has('k1')).toBe(true); // kept, not deleted
    expect(uploadViewOf('k1')?.phase).toBe('blocked');

    outbox.retryUpload('k1');
    await vi.waitFor(() => expect(storage._map.has('k1')).toBe(false));
    expect(uploadMedia).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });

  it('a parked entry can still be deleted', async () => {
    const storage = makeStorage([mediaEntry('k2')]);
    const uploadMedia = vi.fn().mockRejectedValue(new MediaUploadError(403, 'ban', 'edge'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['k2'])]]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: makeMls(),
        storage,
        conversations,
        uploadMedia,
        isGroupHealthy: () => true,
      })
    );
    await outbox.flush();
    expect(await outbox.cancelPending('k2')).toBe(true);
    expect(storage._map.has('k2')).toBe(false);
    errorSpy.mockRestore();
  });

  it('a 429 and a 503 are still retried: they say later, not no', async () => {
    for (const status of [429, 503]) {
      const storage = makeStorage([mediaEntry('t' + status)]);
      const uploadMedia = vi.fn().mockRejectedValue(new MediaUploadError(status, 'later'));
      const conversations = new SvelteMap<string, Conversation>([
        ['g1', convoWith('g1', ['t' + status])],
      ]);
      const outbox = createOutbox(
        makeDeps({
          mlsService: makeMls(),
          storage,
          conversations,
          uploadMedia,
          isGroupHealthy: () => true,
        })
      );
      await outbox.flush();
      expect(storage._map.get('t' + status)!.attempts).toBe(1);
    }
  });

  it('a retry on an entry that is backing off runs it now', async () => {
    const backing = mediaEntry('b1', { attempts: 3, nextAttemptAt: Date.now() + 60_000 });
    const storage = makeStorage([backing]);
    const mls = makeMls();
    const uploadMedia = vi.fn().mockResolvedValue(REF);
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['b1'])]]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: mls,
        storage,
        conversations,
        uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    await outbox.flush();
    expect(uploadMedia).not.toHaveBeenCalled();

    outbox.retryUpload('b1');
    await vi.waitFor(() => expect(mls.sendMessage).toHaveBeenCalledTimes(1));
    expect(uploadMedia).toHaveBeenCalledTimes(1);
  });

  describe('a queued attachment is decoded only when it is about to be sent, and never retried for ever', () => {
    beforeEach(() => connectivity.reset());
    afterEach(() => connectivity.reset());

    function build(id: string, over: Partial<OutboxEntry>, uploadMedia: OutboxDeps['uploadMedia']) {
      const storage = makeStorage([mediaEntry(id, over)]);
      const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', [id])]]);
      const outbox = createOutbox(
        makeDeps({
          mlsService: makeMls(),
          storage,
          conversations,
          uploadMedia,
          isGroupHealthy: () => true,
        })
      );
      return { storage, outbox };
    }

    it('an entry that is not due is never decoded: the queue read carries no payload', async () => {
      const uploadMedia = vi.fn().mockResolvedValue(REF);
      const { storage, outbox } = build(
        'd1',
        { attempts: 2, nextAttemptAt: Date.now() + 60_000 },
        uploadMedia
      );
      await outbox.flush();
      expect(storage.getOutboxEntry).not.toHaveBeenCalled();
      expect(uploadMedia).not.toHaveBeenCalled();
    });

    it('a due entry is decoded exactly once for the whole flush', async () => {
      const uploadMedia = vi.fn().mockResolvedValue(REF);
      const { storage, outbox } = build('d2', {}, uploadMedia);
      await outbox.flush();
      expect(storage.getOutboxEntry).toHaveBeenCalledTimes(1);
      expect(uploadMedia).toHaveBeenCalledTimes(1);
      expect(storage._map.has('d2')).toBe(false);
    });

    it('an entry whose payload cannot be decrypted is parked as an error, kept, and not retried', async () => {
      const uploadMedia = vi.fn().mockResolvedValue(REF);
      const { storage, outbox } = build('d3', {}, uploadMedia);
      storage.getOutboxEntry.mockRejectedValue(new OutboxPayloadUnreadableError('d3', 'bad key'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await outbox.flush();
      await outbox.flush();
      expect(storage.getOutboxEntry).toHaveBeenCalledTimes(1);
      expect(uploadMedia).not.toHaveBeenCalled();
      expect(storage._map.has('d3')).toBe(true);
      expect(uploadViewOf('d3')?.phase).toBe('error');
      expect(await outbox.cancelPending('d3')).toBe(true);
      errorSpy.mockRestore();
    });

    it('an attachment that keeps failing for a local reason is parked after MAX_UNEXPECTED_ATTEMPTS, then a retry runs it again', async () => {
      const uploadMedia = vi
        .fn()
        .mockRejectedValue(new DOMException('unreadable', 'NotReadableError'));
      const { storage, outbox } = build('d4', {}, uploadMedia);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      for (let i = 0; i < MAX_UNEXPECTED_ATTEMPTS + 3; i++) {
        for (const row of storage._map.values()) row.nextAttemptAt = 0;
        await outbox.flush();
      }
      expect(uploadMedia).toHaveBeenCalledTimes(MAX_UNEXPECTED_ATTEMPTS);
      expect(uploadViewOf('d4')?.phase).toBe('error');
      expect(storage._map.has('d4')).toBe(true);

      outbox.retryUpload('d4');
      await vi.waitFor(() =>
        expect(uploadMedia).toHaveBeenCalledTimes(MAX_UNEXPECTED_ATTEMPTS + 1)
      );
      errorSpy.mockRestore();
    });

    async function runN(
      id: string,
      uploadMedia: OutboxDeps['uploadMedia'],
      n: number,
      mls = makeMls()
    ) {
      const storage = makeStorage([mediaEntry(id)]);
      const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', [id])]]);
      const outbox = createOutbox(
        makeDeps({
          mlsService: mls,
          storage,
          conversations,
          uploadMedia,
          isGroupHealthy: () => true,
        })
      );
      for (let i = 0; i < n; i++) {
        for (const row of storage._map.values()) row.nextAttemptAt = 0;
        await outbox.flush();
      }
      return { storage, outbox };
    }

    it.each([
      ['a transport failure', () => new TransportFailureError(new TypeError('Failed to fetch'))],
      ['a 5xx', () => new MediaUploadError(503, 'later')],
      ['an unexpected non-local throw', () => new Error('boom')],
    ])(
      '%s never counts toward the limit: the network and the server are waited out',
      async (_n, mk) => {
        const uploadMedia = vi.fn(async () => {
          throw mk();
        });
        const { storage } = await runN('n1', uploadMedia, MAX_UNEXPECTED_ATTEMPTS + 4);
        expect(uploadMedia).toHaveBeenCalledTimes(MAX_UNEXPECTED_ATTEMPTS + 4);
        expect(uploadViewOf('n1')?.phase).not.toBe('error');
        expect(storage._map.has('n1')).toBe(true);
      }
    );

    it('sender-not-active (a roster repair wait) never counts toward the limit', async () => {
      const send = vi.fn(async () => {
        throw new SenderNotActiveError('g1', 'pending');
      });
      const uploadMedia = vi.fn().mockResolvedValue(REF);
      const { storage } = await runN(
        'n2',
        uploadMedia,
        MAX_UNEXPECTED_ATTEMPTS + 4,
        makeMls({ send })
      );
      expect(send).toHaveBeenCalledTimes(MAX_UNEXPECTED_ATTEMPTS + 4);
      expect(uploadViewOf('n2')?.phase).not.toBe('error');
      expect(storage._map.has('n2')).toBe(true);
    });

    it('the count is of CONSECUTIVE local failures: a network failure in between starts it again', async () => {
      let call = 0;
      const uploadMedia = vi.fn(async () => {
        call++;
        throw call === MAX_UNEXPECTED_ATTEMPTS - 1
          ? new MediaUploadError(503, 'later')
          : new DOMException('unreadable', 'NotReadableError');
      });
      const { storage } = await runN('n3', uploadMedia, MAX_UNEXPECTED_ATTEMPTS + 2);
      // Without the reset the Nth call would have parked it; with it, the run restarted at call N-1.
      expect(uploadMedia).toHaveBeenCalledTimes(MAX_UNEXPECTED_ATTEMPTS + 2);
      expect(uploadViewOf('n3')?.phase).not.toBe('error');
      expect(storage._map.has('n3')).toBe(true);
    });

    it('an attachment that holds no bytes while owing an upload is a local failure, typed', async () => {
      const uploadMedia = vi.fn().mockResolvedValue(REF);
      const base = mediaEntry('n4');
      const storage = makeStorage([
        { ...base, media: { ...base.media!, fileBytes: new Uint8Array(0) } },
      ]);
      const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['n4'])]]);
      const outbox = createOutbox(
        makeDeps({
          mlsService: makeMls(),
          storage,
          conversations,
          uploadMedia,
          isGroupHealthy: () => true,
        })
      );
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      for (let i = 0; i < MAX_UNEXPECTED_ATTEMPTS; i++) {
        for (const row of storage._map.values()) row.nextAttemptAt = 0;
        await outbox.flush();
      }
      expect(uploadMedia).not.toHaveBeenCalled();
      expect(uploadViewOf('n4')?.phase).toBe('error');
      errorSpy.mockRestore();
    });

    it('a cancel landing between the snapshot and the payload read is consumed, not leaked', async () => {
      const uploadMedia = vi.fn().mockResolvedValue(REF);
      const { storage, outbox } = build('n5', {}, uploadMedia);
      storage.getOutboxEntry.mockImplementationOnce(async () => {
        await outbox.cancelPending('n5');
        return null;
      });
      await outbox.flush();
      expect(uploadMedia).not.toHaveBeenCalled();
      expect(uploadViewOf('n5')).toBeUndefined();
    });

    it('a row that cannot be loaded is held without telling the bubble it is waiting for an upload', async () => {
      const uploadMedia = vi.fn().mockResolvedValue(REF);
      const { storage, outbox } = build('n6', {}, uploadMedia);
      storage.getOutboxEntry.mockRejectedValue(new Error('SQL busy'));
      await outbox.flush();
      expect(uploadMedia).not.toHaveBeenCalled();
      expect(uploadViewOf('n6')).toBeUndefined();
      expect(storage._map.get('n6')!.attempts).toBe(1);
    });

    it('the retry button un-parks a 403-parked entry, which it used to leave parked for the whole session', async () => {
      const storage = makeStorage([textEntry('d6', 'g1', 100)]);
      const send = vi.fn(async () => {
        throw new SendForbiddenError('g1');
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const outbox = createOutbox(
        makeDeps({ mlsService: makeMls({ send }), storage, isGroupHealthy: () => true })
      );
      await outbox.flush();
      await outbox.flush();
      expect(send).toHaveBeenCalledTimes(1);
      outbox.retryUpload('d6');
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      errorSpy.mockRestore();
    });
  });
});

/**
 * A READ WATERMARK IS LATEST-WINS, SO THE QUEUE KEEPS ONE PER CONVERSATION. Every frame costs every
 * member a decrypt and a full MLS checkpoint, and only the newest says anything. See
 * history-reconciliation, "The sender says only what is new". Each case drives the real
 * `sendReadWatermark` into a registered controller, so the supersede is asserted the way the app
 * reaches it.
 */
describe('outbox - a read watermark supersedes the unsent one of its conversation', () => {
  function watermarkEntry(id: string, conversationId: string, at: number): OutboxEntry {
    return {
      id,
      conversationId,
      sentAt: at,
      kind: 'control',
      // The shape this build queues: the server-clock mark under both names.
      controlProto: encodeAppMessage(
        mkSystem('read_watermark', JSON.stringify({ at, serverAt: at }))
      ),
      status: 'pending',
      attempts: 0,
      createdAt: at,
    };
  }
  const queuedAts = (storage: ReturnType<typeof makeStorage>, conversationId = 'g1') =>
    [...storage._map.values()]
      .filter((e: OutboxEntry) => e.conversationId === conversationId)
      .map((e: OutboxEntry) => queuedReadWatermarkAt(e));
  const sentAts = (mlsService: ReturnType<typeof makeMls>) =>
    mlsService.sendMessage.mock.calls.map(
      (call: unknown[]) =>
        JSON.parse(decodeAppMessage(call[1] as Uint8Array)?.system?.data ?? '{}').at as number
    );
  const read = (at: number, conversationId = 'g1') =>
    sendReadWatermark(at, { conversation: { id: conversationId } } as any);

  beforeEach(() => {
    connectivity.reset();
    isTabLeaderMock.mockReturnValue(true);
    tabOutboxMock.subscribeTabOutboxEvents.mockImplementation(() => () => {});
  });
  afterEach(() => {
    unregisterOutbox();
  });

  it('two watermarks queued while offline: one row, and only the newest is sent', async () => {
    const storage = makeStorage();
    const mlsService = makeMls();
    connectivity.notifyServerUnreachable();
    const outbox = registerOutbox(makeDeps({ mlsService, storage }));

    await read(100);
    await read(200);
    expect(queuedAts(storage)).toEqual([200]);

    connectivity.notifyServerReachable();
    await outboxIdle();
    await outbox.flush();
    expect(sentAts(mlsService)).toEqual([200]);
    expect(storage._map.size).toBe(0);
  });

  it('supersedes a watermark queued by an earlier session, across a restart', async () => {
    // Written offline before the app was killed: the new controller finds it on disk.
    const storage = makeStorage([watermarkEntry('old', 'g1', 100)]);
    const mlsService = makeMls();
    connectivity.notifyServerUnreachable();
    const outbox = registerOutbox(makeDeps({ mlsService, storage }));

    await read(250);
    expect(storage._map.has('old')).toBe(false);
    expect(queuedAts(storage)).toEqual([250]);

    connectivity.notifyServerReachable();
    await outboxIdle();
    await outbox.flush();
    expect(sentAts(mlsService)).toEqual([250]);
  });

  // A PROCESS KILLED INSIDE THE 2 s DEBOUNCE: the mark was decided and written down, the debounce
  // never fired. The next life's outbox registration is what hands it over - nothing else would.
  it('a DM mark owed by a killed process is queued when the next outbox is registered', async () => {
    localStorage.clear();
    recordDmReadMark('u', 'g1', 400);
    const stop = drainOwedDmReadMarksOnOutbox(() => null);
    try {
      const storage = makeStorage();
      const mlsService = makeMls();
      connectivity.notifyServerUnreachable();
      registerOutbox(makeDeps({ mlsService, storage }));

      await vi.waitFor(() => expect(queuedAts(storage)).toEqual([400]));
      await vi.waitFor(() => expect(owedDmReadMarks('u')).toEqual({}));
    } finally {
      stop();
      localStorage.clear();
    }
  });

  // OWED BEFORE 2026-10-31 MEANS OWED ON THE AUTHORS' CLOCK: the old ledger's number is a `sentAt`,
  // and stated as `serverAt` it would compare against every reader's server times.
  it('a DM mark owed before the server clock leaves as the stamped {at} frame, never as serverAt', async () => {
    localStorage.clear();
    localStorage.setItem(ACCOUNT_KEY.dmReadMarks('u'), JSON.stringify({ g1: { at: 600 } }));
    const storage = makeStorage();
    const mlsService = makeMls();
    connectivity.notifyServerUnreachable();
    registerOutbox(makeDeps({ mlsService, storage }));

    expect(await flushOwedDmReadMarks('u')).toBe(1);
    const frames = [...storage._map.values()]
      .filter((e: OutboxEntry) => e.conversationId === 'g1')
      .map((e: OutboxEntry) => JSON.parse(decodeAppMessage(e.controlProto!)?.system?.data ?? '{}'));
    expect(frames).toEqual([{ at: 600 }]);
    expect(owedStampedDmReadMarks('u')).toEqual({});
    localStorage.clear();
  });

  it('a DM mark the outbox could not take stays owed', async () => {
    localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    unregisterOutbox();
    recordDmReadMark('u', 'g1', 500);

    expect(await flushOwedDmReadMarks('u')).toBe(0);
    expect(owedDmReadMarks('u')).toEqual({ g1: { at: 500 } });
    localStorage.clear();
  });

  it('never moves a mark backwards: a watermark an unsent one covers is not queued at all', async () => {
    const storage = makeStorage([watermarkEntry('high', 'g1', 300)]);
    connectivity.notifyServerUnreachable();
    registerOutbox(makeDeps({ mlsService: makeMls(), storage }));

    await read(200);
    await read(300);
    expect(queuedAts(storage)).toEqual([300]);
    expect(storage.saveOutboxEntry).not.toHaveBeenCalled();
  });

  it('writes the new row BEFORE withdrawing the old one, so a crash between keeps both and loses none', async () => {
    const storage = makeStorage([watermarkEntry('old', 'g1', 100)]);
    const mlsService = makeMls();
    let oldStillQueuedAtWrite: boolean | null = null;
    let deletesBeforeWrite: number | null = null;
    const save = storage.saveOutboxEntry.getMockImplementation();
    storage.saveOutboxEntry.mockImplementation(async (e: OutboxEntry) => {
      // The ORDER is the claim: no delete may have been ISSUED by the time the new row is written.
      // The map alone cannot tell, because the crash below makes that delete fail either way.
      deletesBeforeWrite = storage.deleteOutboxEntry.mock.calls.length;
      oldStillQueuedAtWrite = storage._map.has('old');
      await save(e);
    });
    // The process dies before the withdrawal lands: the delete never happens.
    storage.deleteOutboxEntry.mockRejectedValueOnce(new Error('process killed'));
    connectivity.notifyServerUnreachable();
    const outbox = registerOutbox(makeDeps({ mlsService, storage }));

    await read(200);
    expect(deletesBeforeWrite).toBe(0);
    expect(oldStillQueuedAtWrite).toBe(true);
    expect(queuedAts(storage).sort()).toEqual([100, 200]);

    // Both go, oldest first, and `max` on every receiver makes the spare one harmless.
    connectivity.notifyServerReachable();
    await outboxIdle();
    await outbox.flush();
    expect(sentAts(mlsService)).toEqual([100, 200]);
  });

  it('touches nothing but read watermarks of the same conversation', async () => {
    const reaction: OutboxEntry = {
      ...watermarkEntry('reaction', 'g1', 90),
      controlProto: encodeAppMessage(mkReaction('m1', 'x', 90)),
    };
    const storage = makeStorage([
      textEntry('text', 'g1', 80),
      reaction,
      watermarkEntry('other-convo', 'g2', 100),
    ]);
    connectivity.notifyServerUnreachable();
    registerOutbox(makeDeps({ mlsService: makeMls(), storage }));

    await read(200);
    expect(storage._map.has('text')).toBe(true);
    expect(storage._map.has('reaction')).toBe(true);
    expect(queuedAts(storage, 'g2')).toEqual([100]);
    expect(queuedAts(storage)).toEqual([null, null, 200]);
  });

  it('does not count a watermark already on the wire as withdrawn: the newer one follows it', async () => {
    let release!: () => void;
    const onTheWire = new Promise<void>((r) => {
      release = r;
    });
    const storage = makeStorage([watermarkEntry('old', 'g1', 100)]);
    const mlsService = makeMls({ send: () => onTheWire });
    const outbox = registerOutbox(makeDeps({ mlsService, storage }));

    void outbox.flush();
    await outboxIdle();
    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);

    await read(200);
    release();
    await outboxIdle();
    await outbox.flush();
    await outboxIdle();
    expect(sentAts(mlsService)).toEqual([100, 200]);
    expect(storage._map.size).toBe(0);
  });

  it('reads the queue ONCE per enqueue, however many rows it supersedes, and logs per tab', async () => {
    // Two leftovers of a crash between write and withdraw: both are superseded by one read.
    const storage = makeStorage([watermarkEntry('a', 'g1', 100), watermarkEntry('b', 'g1', 150)]);
    const log = vi.fn();
    connectivity.notifyServerUnreachable();
    registerOutbox(makeDeps({ mlsService: makeMls(), storage, log }));
    await outboxIdle();
    storage.getOutboxQueue.mockClear();

    await read(200);
    expect(storage.getOutboxQueue).toHaveBeenCalledTimes(1);
    expect(queuedAts(storage)).toEqual([200]);
    // A follower cannot see a leader's wire, so the line says what THIS tab knows.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('before this tab sent it'));
  });

  it('forgets a superseded id once its row is gone and no lane holds it', async () => {
    const storage = makeStorage();
    const log = vi.fn();
    connectivity.notifyServerUnreachable();
    const outbox = registerOutbox(makeDeps({ mlsService: makeMls(), storage, log }));
    await read(100);
    await read(200);

    connectivity.notifyServerReachable();
    await outboxIdle();
    await outbox.flush();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('forgot 1 withdrawn id(s)'));
  });
});

describe('outbox - every lane on the wire is known to a cancellation (review of #1887)', () => {
  beforeEach(() => {
    connectivity.reset();
    isTabLeaderMock.mockReturnValue(true);
    tabOutboxMock.subscribeTabOutboxEvents.mockImplementation(() => () => {});
  });

  it('answers "already sent" for a message on the wire in ANY lane, not only the last to start', async () => {
    let release!: () => void;
    const onTheWire = new Promise<void>((r) => {
      release = r;
    });
    const storage = makeStorage([textEntry('m1', 'g1', 100), textEntry('m2', 'g2', 100)]);
    const mlsService = makeMls({ send: () => onTheWire });
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    void outbox.flush();
    await outboxIdle();
    expect(mlsService.sendMessage).toHaveBeenCalledTimes(2);

    // Both frames are leaving. Answering `true` for either would skip its `delete_message` event
    // and the peers would keep a message the user deleted - which one lane's id overwriting the
    // other's did.
    expect(await outbox.cancelPending('m1')).toBe(false);
    expect(await outbox.cancelPending('m2')).toBe(false);

    release();
    await outboxIdle();
  });

  it('a withdrawal landing while the flush waits on the membership read keeps the frame off the wire', async () => {
    let answer!: (v: boolean) => void;
    const membership = new Promise<boolean>((r) => {
      answer = r;
    });
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const mlsService = makeMls({ active: () => membership });
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    void outbox.flush();
    await outboxIdle();
    expect(mlsService.isGroupActive).toHaveBeenCalled();
    // Past the check at the top of flushOne, not yet on the wire.
    expect(await outbox.cancelPending('m1')).toBe(true);

    answer(true);
    await outboxIdle();
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the mark while the withdrawal delete is pending, so a second lane pass cannot send it', async () => {
    let finishDelete!: () => void;
    const deleteHeld = new Promise<void>((r) => {
      finishDelete = r;
    });
    const storage = makeStorage([textEntry('m1', 'g1', 100), textEntry('m2', 'g1', 200)]);
    const realDelete = storage.deleteOutboxEntry.getMockImplementation();
    storage.deleteOutboxEntry.mockImplementation(async (id: string) => {
      if (id === 'm2') await deleteHeld;
      await realDelete(id);
    });
    let outbox: ReturnType<typeof createOutbox> | null = null;
    const mlsService = makeMls({
      // The user deletes m2 while m1 is being sent; the delete of its row is slow.
      send: (async (_g: string, _p: Uint8Array, id: string) => {
        if (id === 'm1') {
          void outbox!.cancelPending('m2');
          await outboxIdle();
        }
      }) as any,
    });
    outbox = createOutbox(makeDeps({ mlsService, storage }));

    // m1 sent -> m2 dropped from this pass -> a second pass re-reads m2's row, still there.
    await outbox.flush();
    finishDelete();
    await outboxIdle();
    expect(mlsService.sendMessage.mock.calls.map((c: unknown[]) => c[2])).toEqual(['m1']);
  });

  it('does not forget a mark while a lane still holds the row in its snapshot', async () => {
    let release!: () => void;
    const onTheWire = new Promise<void>((r) => {
      release = r;
    });
    const storage = makeStorage([textEntry('m1', 'g1', 100), textEntry('m2', 'g1', 200)]);
    const mlsService = makeMls({
      send: (async (_g: string, _p: Uint8Array, id: string) => {
        if (id === 'm1') await onTheWire;
      }) as any,
    });
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    void outbox.flush();
    await outboxIdle();
    // m2 is in the running lane's snapshot, behind m1 which is on the wire.
    expect(await outbox.cancelPending('m2')).toBe(true);
    // A second flush reads a queue without m2; pruning its mark now would let the lane send it.
    await outbox.flush();
    release();
    await outboxIdle();
    expect(mlsService.sendMessage.mock.calls.map((c: unknown[]) => c[2])).toEqual(['m1']);
  });

  it('answers "already sent" for a frame sent whose row is not deleted yet', async () => {
    let finishDelete!: () => void;
    const deleteHeld = new Promise<void>((r) => {
      finishDelete = r;
    });
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const realDelete = storage.deleteOutboxEntry.getMockImplementation();
    let flusherDeleteStarted = false;
    storage.deleteOutboxEntry.mockImplementation(async (id: string) => {
      if (!flusherDeleteStarted) {
        flusherDeleteStarted = true;
        await deleteHeld;
      }
      await realDelete(id);
    });
    const mlsService = makeMls();
    const outbox = createOutbox(makeDeps({ mlsService, storage }));

    void outbox.flush();
    await outboxIdle();
    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    expect(flusherDeleteStarted).toBe(true);
    // The peers have it; "never sent" would skip the delete_message event.
    expect(await outbox.cancelPending('m1')).toBe(false);
    finishDelete();
    await outboxIdle();
  });

  it("a follower's own withdrawal leaves no mark behind it", async () => {
    isTabLeaderMock.mockReturnValue(false);
    const storage = makeStorage([textEntry('m1', 'g1', 100), textEntry('m2', 'g1', 200)]);
    const log = vi.fn();
    const outbox = createOutbox(makeDeps({ mlsService: makeMls(), storage, log }));

    expect(await outbox.cancelPending('m1')).toBe(true);

    // Had the follower kept it, the first leader flush would find it and forget it.
    isTabLeaderMock.mockReturnValue(true);
    await outbox.flush();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('forgot'));
  });

  it('a follower tab keeps no cancellation it will never consume', async () => {
    let onTabEvent!: (e: TabOutboxEvent) => void;
    tabOutboxMock.subscribeTabOutboxEvents.mockImplementation(((h: (e: TabOutboxEvent) => void) => {
      onTabEvent = h;
      return () => {};
    }) as any);
    isTabLeaderMock.mockReturnValue(false);
    const log = vi.fn();
    createOutbox(makeDeps({ mlsService: makeMls(), storage: makeStorage(), log }));

    onTabEvent({ type: 'outbox_entry_cancelled', messageId: 'm1' });

    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('cancelled by another tab'));
  });
});

describe('outbox uploads run OUTSIDE the lane - a text written after a big file does not wait for it (WP-OFF-9)', () => {
  type Ref = import('$lib/media').MediaRef;
  type Transport = import('$lib/utils/uploadXhr').XhrUploadOptions;

  /** The 13 MB attachment of the 2026-10-10 audit, queued at compose time 100. */
  const BIG = 13 * 1024 * 1024;

  function bigMedia(id: string, sentAt = 100): OutboxEntry {
    return {
      id,
      conversationId: 'g1',
      sentAt,
      kind: 'media',
      media: {
        kind: MediaKind.MEDIA_KIND_UNSPECIFIED,
        mimeType: 'application/pdf',
        size: BIG,
        fileName: 'big.pdf',
        fileBytes: new Uint8Array(BIG),
      },
      status: 'pending',
      attempts: 0,
      createdAt: sentAt,
    };
  }

  const REF: Ref = {
    type: 'file',
    mediaId: 'mid-big',
    key: 'aa',
    iv: 'bb',
    mimeType: 'application/pdf',
    size: BIG,
  };

  /** A transfer the test settles by hand (a deferred promise), and that honours its abort signal. */
  function deferredUpload() {
    let release!: (ref: Ref) => void;
    let signal: AbortSignal | undefined;
    const uploadMedia = vi.fn(
      (_media: unknown, transport?: Transport) =>
        new Promise<Ref>((resolve, reject) => {
          signal = transport?.signal;
          release = resolve;
          transport?.signal?.addEventListener('abort', () =>
            reject(new UploadAbortedError(transport.signal?.reason))
          );
        })
    );
    return { uploadMedia, release: (ref: Ref) => release(ref), signal: () => signal };
  }

  function sentIds(mls: { sendMessage: { mock: { calls: unknown[][] } } }): unknown[] {
    return mls.sendMessage.mock.calls.map((c) => c[2]);
  }

  beforeEach(() => {
    connectivity.reset();
    isTabLeaderMock.mockReturnValue(true);
  });
  afterEach(() => clearAllUploads());

  it('a text enqueued behind a 13 MB attachment whose upload is pending is SENT before the upload ends', async () => {
    const storage = makeStorage();
    const mls = makeMls();
    const up = deferredUpload();
    const conversations = new SvelteMap<string, Conversation>([
      ['g1', convoWith('g1', ['file', 'text'])],
    ]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: mls,
        storage,
        conversations,
        uploadMedia: up.uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    await outbox.enqueue(bigMedia('file', 100));
    await vi.waitFor(() => expect(up.uploadMedia).toHaveBeenCalledTimes(1));
    await outbox.enqueue(textEntry('text', 'g1', 200));

    // The upload has not ended, and the text written after it is already out.
    await vi.waitFor(() => expect(sentIds(mls)).toEqual(['text']));
    expect(storage._map.has('text')).toBe(false);
    expect(storage._map.has('file')).toBe(true);
    expect(conversations.get('g1')!.messages.find((x) => x.id === 'file')!.status).not.toBe('sent');

    // The file's own small MLS send follows its upload, under its compose time: display order is
    // `sentAt`, so it still sorts ABOVE the text on every device.
    up.release(REF);
    await vi.waitFor(() => expect(sentIds(mls)).toEqual(['text', 'file']));
    const fileProto = decodeAppMessage(mls.sendMessage.mock.calls[1][1] as Uint8Array);
    expect(Number(fileProto!.sentAt)).toBe(100);
    expect(up.uploadMedia).toHaveBeenCalledTimes(1);
    expect(storage._map.size).toBe(0);
  });

  it('a reply QUOTING the attachment still waits for it: only what does not depend on it goes', async () => {
    const storage = makeStorage();
    const mls = makeMls();
    const up = deferredUpload();
    const outbox = createOutbox(
      makeDeps({
        mlsService: mls,
        storage,
        uploadMedia: up.uploadMedia,
        isGroupHealthy: () => true,
      })
    );
    const reply: OutboxEntry = {
      ...textEntry('reply', 'g1', 200),
      kind: 'reply',
      replyTo: { id: 'file', senderId: 'u', preview: '' },
    };

    await outbox.enqueue(bigMedia('file', 100));
    await vi.waitFor(() => expect(up.uploadMedia).toHaveBeenCalledTimes(1));
    await outbox.enqueue(reply);
    await outbox.enqueue(textEntry('text', 'g1', 300));

    await vi.waitFor(() => expect(sentIds(mls)).toEqual(['text']));
    up.release(REF);
    await vi.waitFor(() => expect(sentIds(mls)).toEqual(['text', 'file', 'reply']));
  });

  it('a cancel during the decoupled upload aborts the transfer, sends nothing for it, and lets the text go', async () => {
    const storage = makeStorage();
    const mls = makeMls();
    const up = deferredUpload();
    const conversations = new SvelteMap<string, Conversation>([
      ['g1', convoWith('g1', ['file', 'text'])],
    ]);
    const outbox = createOutbox(
      makeDeps({
        mlsService: mls,
        storage,
        conversations,
        uploadMedia: up.uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    await outbox.enqueue(bigMedia('file', 100));
    await vi.waitFor(() => expect(up.uploadMedia).toHaveBeenCalledTimes(1));
    await outbox.enqueue(textEntry('text', 'g1', 200));
    await vi.waitFor(() => expect(sentIds(mls)).toEqual(['text']));

    expect(await outbox.cancelPending('file')).toBe(true);
    expect(up.signal()?.aborted).toBe(true);
    await outbox.flush();

    expect(sentIds(mls)).toEqual(['text']);
    expect(storage._map.size).toBe(0);
    expect(uploadViewOf('file')).toBeUndefined();
    expect(up.uploadMedia).toHaveBeenCalledTimes(1);
  });

  it('a kill between the upload end and the send does not upload the file twice', async () => {
    const storage = makeStorage();
    const up = deferredUpload();
    // First life: the upload completes, then the MLS send gets no answer and the app is killed.
    const deadMls = makeMls({
      send: async () => {
        throw new DeliveryUnreachableError(new TypeError('Failed to fetch'));
      },
    });
    const first = createOutbox(
      makeDeps({
        mlsService: deadMls,
        storage,
        uploadMedia: up.uploadMedia,
        isGroupHealthy: () => true,
      })
    );
    await first.enqueue(bigMedia('file', 100));
    await vi.waitFor(() => expect(up.uploadMedia).toHaveBeenCalledTimes(1));
    up.release(REF);
    await vi.waitFor(() => expect(deadMls.sendMessage).toHaveBeenCalledTimes(1));
    await outboxIdle();
    first.dispose();

    // The ref reached the row BEFORE the send was tried; the bytes left it.
    const row = storage._map.get('file') as OutboxEntry;
    expect(row.media?.uploadedRef?.mediaId).toBe('mid-big');
    expect(row.media?.fileBytes).toBeUndefined();

    // Second life: the same row and a fresh controller; its backoff cleared, as a reload finds it due.
    storage._map.set('file', { ...row, nextAttemptAt: undefined });
    const mls = makeMls();
    const again = vi.fn();
    const second = createOutbox(
      makeDeps({ mlsService: mls, storage, uploadMedia: again, isGroupHealthy: () => true })
    );
    await second.flush();

    expect(again).not.toHaveBeenCalled();
    expect(sentIds(mls)).toEqual(['file']);
    expect(storage._map.has('file')).toBe(false);
    second.dispose();
  });

  /** Several transfers, each settled by hand, in the order `uploadMedia` was called. */
  function deferredUploads() {
    const calls: Array<{
      fileName?: string;
      signal?: AbortSignal;
      release: (ref: Ref) => void;
      fail: (e: unknown) => void;
    }> = [];
    const uploadMedia = vi.fn(
      (media: { fileName?: string }, transport?: Transport) =>
        new Promise<Ref>((resolve, reject) => {
          calls.push({
            fileName: media.fileName,
            signal: transport?.signal,
            release: resolve,
            fail: reject,
          });
          transport?.signal?.addEventListener('abort', () =>
            reject(new UploadAbortedError(transport.signal?.reason))
          );
        })
    );
    return { uploadMedia, calls };
  }

  function smallMedia(id: string, conversationId: string, sentAt = 100): OutboxEntry {
    const e = bigMedia(id, sentAt);
    return {
      ...e,
      conversationId,
      media: { ...e.media!, size: 3, fileName: `${id}.pdf`, fileBytes: new Uint8Array([1, 2, 3]) },
    };
  }

  it('an MLS send that fails AFTER the upload takes the ladder: a later flush does not re-post it', async () => {
    const storage = makeStorage();
    const up = deferredUpload();
    let refuse = true;
    const mls = makeMls({
      send: async () => {
        if (refuse) throw new Error('503 from the delivery service');
      },
    });
    const outbox = createOutbox(
      makeDeps({
        mlsService: mls,
        storage,
        uploadMedia: up.uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    await outbox.enqueue(smallMedia('file', 'g1'));
    await vi.waitFor(() => expect(up.uploadMedia).toHaveBeenCalledTimes(1));
    up.release(REF);
    await vi.waitFor(() => expect(mls.sendMessage).toHaveBeenCalledTimes(1));
    await outboxIdle();
    expect((storage._map.get('file') as OutboxEntry).nextAttemptAt).toBeGreaterThan(Date.now());

    // Every later wake-up (an enqueue, a visibility change, another upload ending) is a flush.
    refuse = false;
    await outbox.flush();
    await outbox.flush();

    expect(mls.sendMessage).toHaveBeenCalledTimes(1);
    expect(up.uploadMedia).toHaveBeenCalledTimes(1);
    outbox.dispose();
  });

  it('a text held on a 5xx behind a running upload is retried on its own ladder, not after the upload', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    try {
      const storage = makeStorage();
      const up = deferredUpload();
      let textAttempts = 0;
      const mls = makeMls({
        send: async (...args: unknown[]) => {
          if (args[2] === 'text' && ++textAttempts === 1)
            throw new Error('503 from the delivery service');
        },
      });
      const outbox = createOutbox(
        makeDeps({
          mlsService: mls,
          storage,
          uploadMedia: up.uploadMedia,
          isGroupHealthy: () => true,
        })
      );

      await outbox.enqueue(smallMedia('file', 'g1', 100));
      await outbox.enqueue(textEntry('text', 'g1', 200));
      await outboxIdle();
      expect(up.uploadMedia).toHaveBeenCalledTimes(1);
      expect(textAttempts).toBe(1);

      // The ladder's first step (2 s), with the upload still on the wire.
      await vi.advanceTimersByTimeAsync(2_000);
      await outboxIdle();

      expect(textAttempts).toBe(2);
      expect(storage._map.has('text')).toBe(false);
      expect(storage._map.has('file')).toBe(true);
      outbox.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it(`a third attachment waits for one of ${MAX_CONCURRENT_UPLOADS} upload slots, and a cancel reaches it at once`, async () => {
    const storage = makeStorage();
    const up = deferredUploads();
    const log = vi.fn();
    const mls = makeMls();
    const outbox = createOutbox(
      makeDeps({
        mlsService: mls,
        storage,
        log,
        uploadMedia: up.uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    await outbox.enqueue(smallMedia('a', 'g1'));
    await outbox.enqueue(smallMedia('b', 'g2'));
    await outbox.enqueue(smallMedia('c', 'g3'));
    await outboxIdle();
    expect(up.calls.map((c) => c.fileName)).toEqual(['a.pdf', 'b.pdf']);

    expect(await outbox.cancelPending('c')).toBe(true);
    await outboxIdle();
    // Settled now, not when an unrelated transfer frees a slot.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('upload cancelled'));
    expect(uploadViewOf('c')).toBeUndefined();

    up.calls[0].release(REF);
    up.calls[1].release(REF);
    await vi.waitFor(() => expect(sentIds(mls).sort()).toEqual(['a', 'b']));
    expect(up.uploadMedia).toHaveBeenCalledTimes(2);
    outbox.dispose();
  });

  it('a retry on an attachment still waiting for a slot keeps its place: nothing to restart', async () => {
    const storage = makeStorage();
    const up = deferredUploads();
    const log = vi.fn();
    const mls = makeMls();
    const outbox = createOutbox(
      makeDeps({
        mlsService: mls,
        storage,
        log,
        uploadMedia: up.uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    await outbox.enqueue(smallMedia('a', 'g1'));
    await outbox.enqueue(smallMedia('b', 'g2'));
    await outbox.enqueue(smallMedia('c', 'g3'));
    await outboxIdle();
    outbox.retryUpload('c');
    up.calls[0].release(REF);
    await vi.waitFor(() => expect(up.calls.map((c) => c.fileName)).toContain('c.pdf'));

    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('upload restarted on request'));
    expect(up.calls.find((c) => c.fileName === 'c.pdf')!.signal?.aborted).toBe(false);
    up.calls[1].release(REF);
    up.calls[2].release(REF);
    await vi.waitFor(() => expect(sentIds(mls).sort()).toEqual(['a', 'b', 'c']));
    outbox.dispose();
  });

  it('a dispose during a decoupled upload aborts it, ends the flush and sends nothing', async () => {
    const storage = makeStorage([smallMedia('file', 'g1')]);
    const up = deferredUpload();
    const mls = makeMls();
    const outbox = createOutbox(
      makeDeps({
        mlsService: mls,
        storage,
        uploadMedia: up.uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    const flushing = outbox.flush();
    await vi.waitFor(() => expect(up.uploadMedia).toHaveBeenCalledTimes(1));
    outbox.dispose();
    await flushing;

    expect(up.signal()?.aborted).toBe(true);
    expect(mls.sendMessage).not.toHaveBeenCalled();
    expect(storage._map.has('file')).toBe(true);
  });

  it('a refusal the task brings back is classified in the lane: the entry ends, the text behind it already went', async () => {
    const storage = makeStorage();
    const up = deferredUploads();
    const addMessageToChat = vi.fn().mockResolvedValue(undefined);
    const mls = makeMls();
    const outbox = createOutbox(
      makeDeps({
        mlsService: mls,
        storage,
        addMessageToChat,
        uploadMedia: up.uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    await outbox.enqueue(smallMedia('file', 'g1', 100));
    await outbox.enqueue(textEntry('text', 'g1', 200));
    await vi.waitFor(() => expect(sentIds(mls)).toEqual(['text']));
    up.calls[0].fail(new MediaUploadError(413, 'too large'));
    await vi.waitFor(() => expect(storage._map.has('file')).toBe(false));

    expect(sentIds(mls)).toEqual(['text']);
    expect(addMessageToChat).toHaveBeenCalledWith('system', expect.any(String), 'g1', {
      isSystem: true,
    });
    outbox.dispose();
  });

  it('a withdrawal landing while the ref is written leaves no task behind and sends nothing', async () => {
    const storage = makeStorage();
    let writeRef!: () => void;
    const realUpdate = storage.updateOutboxEntry;
    storage.updateOutboxEntry = vi.fn(async (id: string, patch: Partial<OutboxEntry>) => {
      if (patch.media?.uploadedRef) await new Promise<void>((r) => (writeRef = r));
      return realUpdate(id, patch);
    });
    const up = deferredUpload();
    const log = vi.fn();
    const mls = makeMls();
    const outbox = createOutbox(
      makeDeps({
        mlsService: mls,
        storage,
        log,
        uploadMedia: up.uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    await outbox.enqueue(smallMedia('file', 'g1'));
    await vi.waitFor(() => expect(up.uploadMedia).toHaveBeenCalledTimes(1));
    up.release(REF);
    await vi.waitFor(() => expect(writeRef).toBeDefined());
    expect(await outbox.cancelPending('file')).toBe(true);
    writeRef();
    await outbox.flush();
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('upload ended after its message was withdrawn')
      )
    );
    expect(mls.sendMessage).not.toHaveBeenCalled();
    outbox.dispose();
  });

  it('a dispose during the queue read that feeds the backoff arms no timer on the dead controller', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    try {
      const storage = makeStorage([textEntry('text', 'g1', 100)]);
      const mls = makeMls({
        send: async () => {
          throw new Error('503 from the delivery service');
        },
      });
      const realRead = storage.getOutboxQueue;
      let releaseRead: (() => void) | null = null;
      storage.getOutboxQueue = vi.fn(async (...args: unknown[]) => {
        // The read after the failed send is the one `runFlush` arms its backoff from.
        if (mls.sendMessage.mock.calls.length > 0 && !releaseRead) {
          await new Promise<void>((r) => (releaseRead = r));
        }
        return realRead(...args);
      });
      const outbox = createOutbox(
        makeDeps({ mlsService: mls, storage, isGroupHealthy: () => true })
      );

      const flushing = outbox.flush();
      await outboxIdle();
      expect(releaseRead).not.toBeNull();
      outbox.dispose();
      releaseRead!();
      await flushing;
      // No timer at all: one left armed would raise a flush on a controller nobody owns.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      await outboxIdle();

      expect(mls.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a retry during a slot wait leaves no arming behind: the upload that then fails keeps its fresh backoff', async () => {
    const storage = makeStorage();
    const up = deferredUploads();
    const mls = makeMls();
    const outbox = createOutbox(
      makeDeps({
        mlsService: mls,
        storage,
        uploadMedia: up.uploadMedia,
        isGroupHealthy: () => true,
      })
    );

    await outbox.enqueue(smallMedia('a', 'g1'));
    await outbox.enqueue(smallMedia('b', 'g2'));
    await outbox.enqueue(smallMedia('c', 'g3'));
    await outboxIdle();
    outbox.retryUpload('c');
    up.calls[0].release(REF);
    await vi.waitFor(() => expect(up.calls.map((c) => c.fileName)).toContain('c.pdf'));
    up.calls
      .find((c) => c.fileName === 'c.pdf')!
      .fail(new UploadStalledError(45_000, '/api/media/upload', 1));
    await vi.waitFor(() =>
      expect((storage._map.get('c') as OutboxEntry).nextAttemptAt).toBeGreaterThan(Date.now())
    );

    void outbox.flush();
    await outboxIdle();

    expect(up.calls.filter((c) => c.fileName === 'c.pdf')).toHaveLength(1);
    outbox.dispose();
  });
});

describe('a text the server keeps failing (5xx) - terminal after N in a row (user, 2026-10-18)', () => {
  /**
   * A send stub answering from a script, one outcome per attempt: 'ok', '5xx', '4xx', 'transport'.
   * Attempts are made due by hand (`dueNow`), never by a clock.
   */
  function scripted(outcomes: Array<'ok' | '5xx' | '4xx' | 'transport'>) {
    let i = 0;
    return makeMls({
      send: async () => {
        const next = outcomes[i++] ?? 'ok';
        if (next === '5xx') throw new SendServerError('g1', 503, 'gateway');
        if (next === '4xx') throw new ApiRefusalError(400, null, 'Message send HTTP error: 400');
        if (next === 'transport')
          throw new DeliveryUnreachableError(new TypeError('Failed to fetch'));
      },
    });
  }

  /** Clears the backoff the last attempt wrote, so the next flush attempts the entry. */
  function dueNow(storage: any, id: string): void {
    const e = storage._map.get(id);
    if (e) storage._map.set(id, { ...e, nextAttemptAt: 0 });
  }

  async function attempt(outbox: { flush: () => Promise<void> }, storage: any, id: string, n = 1) {
    for (let k = 0; k < n; k++) {
      dueNow(storage, id);
      await outbox.flush();
    }
  }

  function setup(seed: OutboxEntry[], mlsService: any) {
    const conversations = new SvelteMap<string, Conversation>([
      [
        'g1',
        convoWith(
          'g1',
          seed.map((e) => e.id)
        ),
      ],
    ]);
    const storage = makeStorage(seed);
    const outbox = createOutbox(makeDeps({ mlsService, storage, conversations }));
    const status = (id: string) =>
      conversations.get('g1')!.messages.find((m) => m.id === id)!.status;
    return { conversations, storage, outbox, status };
  }

  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clearAllUploads();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  it('is one named constant, 5', () => {
    expect(MAX_CONSECUTIVE_SERVER_ERRORS).toBe(5);
  });

  it('parks a text as FAILED on the 5th 5xx in a row, keeps it, offers the retry and sends no more', async () => {
    const mls = scripted(['5xx', '5xx', '5xx', '5xx', '5xx']);
    const { storage, outbox, status } = setup([textEntry('t1', 'g1', 100)], mls);

    await attempt(outbox, storage, 't1', 4);
    expect(status('t1')).toBe('pending');
    expect(storage._map.get('t1').serverErrors).toBe(4);

    await attempt(outbox, storage, 't1');
    expect(status('t1')).toBe('error');
    expect(uploadViewOf('t1')?.phase).toBe('failed');
    expect(storage._map.get('t1').serverErrors).toBe(5);
    expect(storage._map.has('t1')).toBe(true);
    // Terminal: further flushes send nothing, and the background mirror does not carry it.
    await attempt(outbox, storage, 't1', 2);
    expect(mls.sendMessage).toHaveBeenCalledTimes(5);
    expect(toMirrorEntry(storage._map.get('t1'))).toBeNull();
    outbox.dispose();
  });

  it('applies to a reply as well', async () => {
    const reply: OutboxEntry = {
      ...textEntry('r1', 'g1', 100),
      kind: 'reply',
      replyTo: { id: 'x', senderId: 'u', preview: '' },
    };
    const { storage, outbox, status } = setup([reply], scripted(Array(5).fill('5xx')));
    await attempt(outbox, storage, 'r1', 5);
    expect(status('r1')).toBe('error');
    outbox.dispose();
  });

  it('4 x 5xx then a success: sent, never failed', async () => {
    const mls = scripted(['5xx', '5xx', '5xx', '5xx', 'ok']);
    const { storage, outbox, status } = setup([textEntry('t1', 'g1', 100)], mls);
    await attempt(outbox, storage, 't1', 5);
    expect(status('t1')).toBe('sent');
    expect(storage._map.has('t1')).toBe(false);
    outbox.dispose();
  });

  it('any other ANSWER resets the run: 4 x 5xx, a 4xx, 4 x 5xx is not terminal', async () => {
    const mls = scripted(['5xx', '5xx', '5xx', '5xx', '4xx', '5xx', '5xx', '5xx', '5xx']);
    const { storage, outbox, status } = setup([textEntry('t1', 'g1', 100)], mls);
    await attempt(outbox, storage, 't1', 5);
    expect(storage._map.get('t1').serverErrors).toBe(0);
    await attempt(outbox, storage, 't1', 4);
    expect(storage._map.get('t1').serverErrors).toBe(4);
    expect(status('t1')).toBe('pending');
    outbox.dispose();
  });

  it('a transport failure never counts and never resets: 4 x 5xx, 3 x no answer, 1 x 5xx is terminal', async () => {
    const mls = scripted([
      '5xx',
      '5xx',
      '5xx',
      '5xx',
      'transport',
      'transport',
      'transport',
      '5xx',
    ]);
    const { storage, outbox, status } = setup([textEntry('t1', 'g1', 100)], mls);
    await attempt(outbox, storage, 't1', 7);
    expect(storage._map.get('t1').serverErrors).toBe(4);
    expect(status('t1')).toBe('pending');
    await attempt(outbox, storage, 't1');
    expect(status('t1')).toBe('error');
    outbox.dispose();
  });

  it('only transport failures, however many, never park a text', async () => {
    const mls = scripted(Array(12).fill('transport'));
    const { storage, outbox, status } = setup([textEntry('t1', 'g1', 100)], mls);
    await attempt(outbox, storage, 't1', 12);
    expect(storage._map.get('t1').serverErrors ?? 0).toBe(0);
    expect(status('t1')).toBe('pending');
    outbox.dispose();
  });

  it('a reload keeps the count: 4 before it, 1 after it is terminal', async () => {
    const mls = scripted(Array(5).fill('5xx'));
    const first = setup([textEntry('t1', 'g1', 100)], mls);
    await attempt(first.outbox, first.storage, 't1', 4);
    first.outbox.dispose();

    // A new page life on the same durable rows.
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['t1'])]]);
    const outbox = createOutbox(
      makeDeps({ mlsService: mls, storage: first.storage, conversations })
    );
    await attempt(outbox, first.storage, 't1');
    expect(conversations.get('g1')!.messages[0].status).toBe('error');
    outbox.dispose();
  });

  it('a reload of a FAILED text shows it failed and sends nothing', async () => {
    const mls = makeMls();
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['t1'])]]);
    const storage = makeStorage([
      { ...textEntry('t1', 'g1', 100), serverErrors: MAX_CONSECUTIVE_SERVER_ERRORS },
    ]);
    const outbox = createOutbox(makeDeps({ mlsService: mls, storage, conversations }));

    await outbox.applyPendingStatuses();
    expect(conversations.get('g1')!.messages[0].status).toBe('error');
    expect(uploadViewOf('t1')?.phase).toBe('failed');
    await attempt(outbox, storage, 't1');
    expect(mls.sendMessage).not.toHaveBeenCalled();
    expect(conversations.get('g1')!.messages[0].status).toBe('error');
    outbox.dispose();
  });

  it('a reload puts back a queued or failed own message older than the page held (review of #2824, P2-3)', async () => {
    // The page held is one newer row; both queued sends are older than it, so no page read them.
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', [])]]);
    conversations.get('g1')!.messages.push({
      id: 'newer',
      senderId: 'peer',
      content: 'x',
      timestamp: new Date(9_000),
      serverTimestamp: 9_000,
      isOwn: false,
    });
    const storage = makeStorage([
      textEntry('queued', 'g1', 100),
      { ...textEntry('failed', 'g1', 200), serverErrors: MAX_CONSECUTIVE_SERVER_ERRORS },
    ]);
    for (const [id, timestamp] of [
      ['queued', 100],
      ['failed', 200],
    ] as const) {
      storage._messages.set(id, {
        id,
        conversationId: 'g1',
        senderId: 'u',
        content: id,
        timestamp,
      });
    }
    const outbox = createOutbox(makeDeps({ mlsService: makeMls(), storage, conversations }));

    await outbox.applyPendingStatuses();

    const shown = conversations.get('g1')!.messages;
    // Unsent, so ordered below every dated row, and shown with the state the queue holds.
    expect(shown.map((m) => [m.id, m.status])).toEqual([
      ['newer', undefined],
      ['queued', 'pending'],
      ['failed', 'error'],
    ]);
    // Applied again (a second history load), nothing is added twice.
    await outbox.applyPendingStatuses();
    expect(conversations.get('g1')!.messages).toHaveLength(3);
    outbox.dispose();
  });

  it('the retry resets the count durably and sends again', async () => {
    const mls = scripted(['5xx', '5xx', '5xx', '5xx', '5xx', 'ok']);
    const { storage, outbox, status } = setup([textEntry('t1', 'g1', 100)], mls);
    await attempt(outbox, storage, 't1', 5);
    expect(status('t1')).toBe('error');

    outbox.retryUpload('t1');
    await outboxIdle();
    expect(status('t1')).toBe('sent');
    expect(storage._map.has('t1')).toBe(false);
    expect(uploadViewOf('t1')).toBeUndefined();
    outbox.dispose();
  });

  it('after a retry, the next 5xx starts a NEW run (1, not 6)', async () => {
    const mls = scripted(Array(6).fill('5xx'));
    const { storage, outbox, status } = setup([textEntry('t1', 'g1', 100)], mls);
    await attempt(outbox, storage, 't1', 5);
    outbox.retryUpload('t1');
    await outboxIdle();
    expect(storage._map.get('t1').serverErrors).toBe(1);
    expect(status('t1')).toBe('pending');
    outbox.dispose();
  });

  it('a 4xx refusal keeps its own path: 5 x 400 is held on the ladder, never failed', async () => {
    const mls = scripted(Array(5).fill('4xx'));
    const { storage, outbox, status } = setup([textEntry('t1', 'g1', 100)], mls);
    await attempt(outbox, storage, 't1', 5);
    expect(status('t1')).toBe('pending');
    expect(storage._map.get('t1').attempts).toBe(5);
    expect(storage._map.get('t1').serverErrors ?? 0).toBe(0);
    outbox.dispose();
  });

  it('a 403 keeps its own parking, unchanged', async () => {
    const mls = makeMls({
      send: async () => {
        throw new SendForbiddenError('g1');
      },
    });
    const { storage, outbox, status } = setup([textEntry('t1', 'g1', 100)], mls);
    await attempt(outbox, storage, 't1', 2);
    expect(mls.sendMessage).toHaveBeenCalledTimes(1);
    expect(status('t1')).toBe('pending');
    outbox.dispose();
  });

  it('controls and attachments are not bounded: 6 x 5xx leaves them pending, uncounted', async () => {
    const control: OutboxEntry = {
      id: 'c1',
      conversationId: 'g1',
      sentAt: 90,
      kind: 'control',
      controlProto: encodeAppMessage(mkReaction('m0', 'x', 90)),
      status: 'pending',
      attempts: 0,
      createdAt: 90,
    };
    const media: OutboxEntry = {
      id: 'mm',
      conversationId: 'g2',
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
    const mls = makeMls({
      send: async (groupId: unknown) => {
        throw new SendServerError(String(groupId), 502, 'edge');
      },
    });
    const conversations = new SvelteMap<string, Conversation>([
      ['g1', convoWith('g1', ['c1'])],
      ['g2', convoWith('g2', ['mm'])],
    ]);
    const storage = makeStorage([control, media]);
    const outbox = createOutbox(
      makeDeps({ mlsService: mls, storage, conversations, uploadMedia: vi.fn() })
    );
    for (let k = 0; k < 6; k++) {
      dueNow(storage, 'c1');
      dueNow(storage, 'mm');
      await outbox.flush();
    }
    expect(storage._map.get('c1').attempts).toBe(6);
    expect(storage._map.get('mm').attempts).toBe(6);
    expect(storage._map.get('c1').serverErrors ?? 0).toBe(0);
    expect(storage._map.get('mm').serverErrors ?? 0).toBe(0);
    expect(conversations.get('g2')!.messages[0].status).toBe('pending');
    outbox.dispose();
  });
});

describe('5xx terminal state - review of #2076 (follower Retry, the hold, the delete)', () => {
  function always5xx(retryAfterMs: number | null = null) {
    return makeMls({
      send: async () => {
        throw new SendServerError('g1', 502, 'edge', retryAfterMs);
      },
    });
  }

  async function failFiveTimes(outbox: { flush: () => Promise<void> }, storage: any, id: string) {
    for (let k = 0; k < MAX_CONSECUTIVE_SERVER_ERRORS; k++) {
      const e = storage._map.get(id);
      storage._map.set(id, { ...e, nextAttemptAt: 0 });
      await outbox.flush();
    }
  }

  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clearAllUploads();
    isTabLeaderMock.mockReturnValue(true);
    tabOutboxMock.requestLeaderOutboxFlush.mockClear();
    tabOutboxMock.publishOutboxEntryFailed.mockClear();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    isTabLeaderMock.mockReturnValue(true);
    errorSpy.mockRestore();
  });

  it('holds each counted 5xx on the top step at least: five span 4 minutes, not 52 s', () => {
    expect([1, 2, 3, 4, 5].map((a) => serverErrorHoldMs(a, null))).toEqual([
      60_000, 60_000, 60_000, 60_000, 60_000,
    ]);
    expect(SERVER_ERROR_HOLD_MS * (MAX_CONSECUTIVE_SERVER_ERRORS - 1)).toBe(240_000);
  });

  it("honours the server's Retry-After, capped", () => {
    expect(serverErrorHoldMs(1, 120_000)).toBe(120_000);
    expect(serverErrorHoldMs(1, 5_000)).toBe(SERVER_ERROR_HOLD_MS);
    expect(serverErrorHoldMs(1, 3_600_000)).toBe(MAX_RETRY_AFTER_MS);
  });

  it('writes that hold as the entry clock (Date.now pinned, never read as a wall clock)', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const storage = makeStorage([textEntry('t1', 'g1', 100)]);
    const outbox = createOutbox(makeDeps({ mlsService: always5xx(180_000), storage }));
    await outbox.flush();
    expect(storage._map.get('t1').nextAttemptAt).toBe(1_000_000 + 180_000);
    now.mockRestore();
    outbox.dispose();
  });

  it('a Retry clicked in a FOLLOWER tab resets the stored count, and the leader then sends it', async () => {
    // The leader parks the text.
    const leaderMls = makeMls({
      send: (() => {
        let i = 0;
        return async () => {
          if (i++ < MAX_CONSECUTIVE_SERVER_ERRORS) throw new SendServerError('g1', 503, 'gateway');
        };
      })(),
    });
    const storage = makeStorage([textEntry('t1', 'g1', 100)]);
    const leaderConvos = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['t1'])]]);
    const leader = createOutbox(
      makeDeps({ mlsService: leaderMls, storage, conversations: leaderConvos })
    );
    await failFiveTimes(leader, storage, 't1');
    expect(leaderConvos.get('g1')!.messages[0].status).toBe('error');
    expect(tabOutboxMock.publishOutboxEntryFailed).toHaveBeenCalledWith('t1', 5);

    // A follower tab, opened on the same durable queue, shows it failed and its member retries.
    isTabLeaderMock.mockReturnValue(false);
    const followerConvos = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['t1'])]]);
    const follower = createOutbox(
      makeDeps({ mlsService: makeMls(), storage, conversations: followerConvos })
    );
    await follower.applyPendingStatuses();
    expect(followerConvos.get('g1')!.messages[0].status).toBe('error');
    follower.retryUpload('t1');
    await outboxIdle();
    expect(storage._map.get('t1').serverErrors).toBe(0);
    expect(followerConvos.get('g1')!.messages[0].status).toBe('pending');
    expect(tabOutboxMock.requestLeaderOutboxFlush).toHaveBeenCalled();

    // The leader drains on that request: its memory says failed, the row says otherwise - the row wins.
    isTabLeaderMock.mockReturnValue(true);
    await leader.flush();
    expect(leaderMls.sendMessage).toHaveBeenCalledTimes(MAX_CONSECUTIVE_SERVER_ERRORS + 1);
    expect(storage._map.has('t1')).toBe(false);
    expect(leaderConvos.get('g1')!.messages[0].status).toBe('sent');
    leader.dispose();
    follower.dispose();
  });

  it('a follower already open when the leader parks it is told, and draws the failed bubble', async () => {
    isTabLeaderMock.mockReturnValue(false);
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['t1'])]]);
    const outbox = createOutbox(
      makeDeps({ mlsService: makeMls(), storage: makeStorage([]), conversations })
    );
    const handler = tabOutboxMock.subscribeTabOutboxEvents.mock.calls.at(-1)![0];
    handler({ type: 'outbox_entry_failed', messageId: 't1', serverErrors: 5 });
    expect(conversations.get('g1')!.messages[0].status).toBe('error');
    expect(uploadViewOf('t1')?.phase).toBe('failed');
    // Sent later (retried elsewhere): the failed view goes with it.
    handler({ type: 'outbox_entry_sent', messageId: 't1' });
    expect(conversations.get('g1')!.messages[0].status).toBe('sent');
    expect(uploadViewOf('t1')).toBeUndefined();
    outbox.dispose();
  });

  it('deleting a text answered 5xx is NOT a silent withdrawal: the delete must travel (it may be stored)', async () => {
    const storage = makeStorage([{ ...textEntry('t1', 'g1', 100), serverErrors: 2 }]);
    const outbox = createOutbox(makeDeps({ mlsService: makeMls(), storage }));
    expect(await outbox.cancelPending('t1')).toBe(false);
    expect(storage._map.has('t1')).toBe(false);
    outbox.dispose();
  });

  it('a text never answered 5xx is still withdrawn silently', async () => {
    const storage = makeStorage([textEntry('t2', 'g1', 100)]);
    const outbox = createOutbox(makeDeps({ mlsService: makeMls(), storage }));
    expect(await outbox.cancelPending('t2')).toBe(true);
    outbox.dispose();
  });

  it('a FAILED text lets a later independent text go, and a reply quoting it waits', async () => {
    const sent: string[] = [];
    const mls = makeMls({
      send: async (_g: unknown, _p: unknown, id: unknown) => {
        if (id === 't1') throw new SendServerError('g1', 500, 'gateway');
        sent.push(String(id));
      },
    });
    const reply: OutboxEntry = {
      ...textEntry('r1', 'g1', 300),
      kind: 'reply',
      replyTo: { id: 't1', senderId: 'u', preview: '' },
    };
    const storage = makeStorage([
      { ...textEntry('t1', 'g1', 100), serverErrors: MAX_CONSECUTIVE_SERVER_ERRORS },
      textEntry('t2', 'g1', 200),
      reply,
    ]);
    const outbox = createOutbox(makeDeps({ mlsService: mls, storage }));
    await outbox.flush();
    expect(sent).toEqual(['t2']);
    expect(storage._map.has('r1')).toBe(true);
    outbox.dispose();
  });
});

describe('a 2xx a captive portal answered is no answer (cross-client rig, 1.4.1-alpha.3)', () => {
  /** What a portal answers ANY request with: a login page, `200 text/html`. */
  const portal = () =>
    new Response('<html><body>Sign in to use this network</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

  /**
   * The outbox over the REAL send path (`postApplicationMessage`), its `fetch` answering in turn
   * from `answers`. `received` is what reached the "server": a frame only counts when the delivery
   * service itself answered, keyed by the inner messageId every receiver deduplicates on.
   */
  function wired(answers: Array<() => Response>) {
    const received: string[] = [];
    const fetchImpl = vi.fn(async () => answers.shift()!());
    const api = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const mlsService = makeMls();
    mlsService.sendMessage = vi.fn(
      async (groupId: string, _proto: Uint8Array, id: string): Promise<SentFrame> => {
        const receivedAt = await api.postApplicationMessage(groupId, 'AAAA');
        received.push(id);
        return { sealed: new Uint8Array(), authorProof: new Uint8Array(), receivedAt };
      }
    );
    return { mlsService, received, fetchImpl };
  }

  it('keeps the entry pending on a portal 200, and the retry after the portal delivers it exactly once', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['m1'])]]);
    const { mlsService, received, fetchImpl } = wired([
      portal,
      () => Response.json({ status: 'sent', queued: 1, sent: 1, receivedAt: 1_700_000_000_123 }),
    ]);
    const logs: string[] = [];
    const outbox = createOutbox(
      makeDeps({ mlsService, storage, conversations, log: (line: string) => logs.push(line) })
    );

    await outbox.flush();

    // Not sent, not dropped: the request never reached the server.
    expect(received).toEqual([]);
    expect(storage._map.has('m1')).toBe(true);
    expect(conversations.get('g1')!.messages[0].status).toBe('pending');
    expect(logs.some((l) => l.includes('sent, the server answered no receive time'))).toBe(false);

    // The portal ends. In production the kept entry goes on its backoff ladder (connectivity never
    // left "reachable", backlog P3); a reconnect transition stands in for that retry here.
    connectivity.notifyServerUnreachable();
    connectivity.notifyServerReachable();
    await outboxIdle();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(received).toEqual(['m1']);
    expect(storage._map.size).toBe(0);
    expect(conversations.get('g1')!.messages[0].status).toBe('sent');
    expect(conversations.get('g1')!.messages[0].serverTimestamp).toBe(1_700_000_000_123);

    // And nothing is ever sent for it again.
    await outbox.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('still counts as sent the JSON answer of a server predating `receivedAt` - the copy stays undated', async () => {
    const storage = makeStorage([textEntry('m1', 'g1', 100)]);
    const conversations = new SvelteMap<string, Conversation>([['g1', convoWith('g1', ['m1'])]]);
    const { mlsService, received } = wired([
      () => Response.json({ status: 'sent', queued: 1, sent: 1 }),
    ]);
    const logs: string[] = [];
    const outbox = createOutbox(
      makeDeps({ mlsService, storage, conversations, log: (line: string) => logs.push(line) })
    );

    await outbox.flush();

    expect(received).toEqual(['m1']);
    expect(storage._map.size).toBe(0);
    expect(conversations.get('g1')!.messages[0].status).toBe('sent');
    expect(conversations.get('g1')!.messages[0].serverTimestamp).toBeUndefined();
    expect(logs.some((l) => l.includes('sent, the server answered no receive time'))).toBe(true);
  });
});
