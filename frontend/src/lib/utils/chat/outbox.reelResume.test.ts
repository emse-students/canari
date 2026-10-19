/**
 * A CHAT REEL THROUGH THE OUTBOX, KILLED AT EVERY STAGE (reels-in-chat RC-5).
 *
 * The raw take is queued at once; the outbox prepares it inside the upload task, stores the prepared
 * file IN PLACE of the take (the other blob slot, then the row), and uploads it through a resumable
 * session whose state is recorded before the first part leaves. Each case below kills the app at
 * one point of that path and starts a second life on the same disk, and asserts the two promises:
 * NO TAKE IS LOST, and NO BYTE IS UPLOADED TWICE BEYOND THE PART THAT WAS CUT.
 *
 * Everything real that can be: `SqliteStorage` (its codec, its blob slots, its write order) over a
 * Map-backed SQL fake and fake-IndexedDB; the real `uploadResumable` against a faithful fake of
 * media-service's sessions. A "kill" stops a life cold: every storage call, server request and MLS
 * send it makes afterwards never settles, exactly what a dead process does. No clock is asserted
 * and nothing sleeps: `vi.waitFor` polls an outcome.
 */
import 'fake-indexeddb/auto';
import { SvelteMap } from 'svelte/reactivity';

const tabOutboxMock = vi.hoisted(() => ({
  requestLeaderOutboxFlush: vi.fn(),
  publishOutboxEntrySent: vi.fn(),
  publishOutboxEntryCancelled: vi.fn(),
  publishOutboxEntryFailed: vi.fn(),
  subscribeTabOutboxEvents: vi.fn(() => () => {}),
}));
vi.mock('$lib/mls-client/tabLeader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/tabLeader')>()),
  getIsTabLeader: () => true,
  getTabLeadership: () => 'leader',
  whenTabLeadershipDecided: () => Promise.resolve('leader'),
}));
vi.mock('$lib/mls-client/tabMessageSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/tabMessageSync')>()),
  ...tabOutboxMock,
}));

import { createOutbox, type OutboxDeps, type PreparedOutboxMedia } from './outbox';
import { clearAllUploads, uploadViewOf } from './uploadProgress.svelte';
import { uploadCaption } from './uploadLabel';
import { MediaKind, decodeAppMessage, mediaReelFromProto } from '$lib/proto/codec';
import { uploadResumable } from '$lib/utils/resumableUpload';
import { UploadAbortedError } from '$lib/utils/uploadXhr';
import { decryptSegmentedMediaBuffer } from '$lib/mediaSegmented';
import { hexEncode } from '$lib/mediaCrypto';
import { connectivity } from '$lib/stores/connectivity.svelte';
import type { OutboxBlobStore } from '$lib/db/outboxBlob';
import type { OutboxEntry } from '$lib/db';
import type { MediaRef } from '$lib/media';
import type { Conversation } from '$lib/types';
import { SqliteStorage } from '$lib/db/sqlite';
import { attachFakeOutboxSql } from '../../../test/outboxSqlFake';
import { FakeSessionServer } from '../../../test/fakeUploadSessionServer';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
/** Small parts, so a small prepared file is several of them. */
const PART = 8 * 1024;
const ID = '11111111-2222-4333-8444-555555555555';
const NEVER = <T>(): Promise<T> => new Promise<T>(() => undefined);

function pattern(size: number, salt = 0): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + 7 + salt) & 0xff;
  return out;
}

/** The camera's take: 48 kB of "raw" video. */
const RAW = pattern(48_000);
/** What the encoder makes of it - deterministic, 4 parts of {@link PART}. */
const PREPARED = pattern(30_000, 99);

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function rawTakeEntry(): OutboxEntry {
  return {
    id: ID,
    conversationId: 'g1',
    sentAt: 100,
    kind: 'media',
    media: {
      kind: MediaKind.MEDIA_KIND_VIDEO,
      mimeType: 'video/webm',
      size: RAW.length,
      fileName: 'take.webm',
      intent: 'reel-message',
      expiresAtMs: 1_790_000_000_000,
      prepare: 'chat-reel',
      fileBytes: RAW,
    },
    status: 'pending',
    attempts: 0,
    createdAt: 100,
  };
}

/** One disk and one server, shared by every life of a case. */
function world() {
  const storage = new SqliteStorage(`reel-${crypto.randomUUID()}`);
  const sql = attachFakeOutboxSql(storage);
  const server = new FakeSessionServer();
  const blobs = (storage as unknown as { blobs: OutboxBlobStore }).blobs;
  return { storage, sql, server, blobs, prepares: [] as Uint8Array[], uploads: 0, settled: 0 };
}
type World = ReturnType<typeof world>;

interface LifeOptions {
  /** The encoder of this life; the default prepares {@link PREPARED} at once. */
  prepare?: (signal: AbortSignal) => Promise<PreparedOutboxMedia>;
  /** The MLS send of this life; the default accepts. */
  send?: () => Promise<void>;
}

const ACCEPT = async () => undefined;

/** One run of the app on the world's disk. `kill()` stops it cold. */
function life(w: World, opts: LifeOptions = {}) {
  let alive = true;
  const live = <T>(fn: () => Promise<T>): Promise<T> => (alive ? fn() : NEVER<T>());
  const s = w.storage;
  const storage = {
    saveMessage: vi.fn(async () => undefined),
    getMessage: vi.fn(async () => null),
    saveOutboxEntry: (e: OutboxEntry, k: string) => live(() => s.saveOutboxEntry(e, k)),
    getOutboxQueue: (k: string) => live(() => s.getOutboxQueue(k)),
    getOutboxEntry: (id: string, k: string) => live(() => s.getOutboxEntry(id, k)),
    updateOutboxEntry: (id: string, p: Partial<OutboxEntry>, k: string) =>
      live(() => s.updateOutboxEntry(id, p, k)),
    deleteOutboxEntry: (id: string) => live(() => s.deleteOutboxEntry(id)),
    sweepOutboxBlobs: () => live(() => s.sweepOutboxBlobs()),
  };
  const port = w.server.port();
  const mls = {
    getLocalGroups: vi.fn(() => []),
    getGroupMeta: vi.fn(async (id: string) => ({ groupId: id, deletedAt: null })),
    isGroupActive: vi.fn(async () => true),
    getGroupExclusions: vi.fn(async () => new Map()),
    waitForMessageQueueIdle: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => {
      if (!alive) return NEVER();
      await (opts.send ?? ACCEPT)();
      return { sealed: new Uint8Array(), receivedAt: 1_700_000_000_000 };
    }),
  };
  const uploadMedia: OutboxDeps['uploadMedia'] = async (media, transport, resume) => {
    w.uploads++;
    const done = await uploadResumable({
      plaintext: media.fileBytes!,
      retentionClass: 'chat-reel',
      state: media.upload,
      persist: resume!.persist,
      port: {
        // A dead process sends nothing more; a cancel still ends its pending request.
        request: (method, path, body, t) =>
          alive
            ? port.request(method, path, body, t)
            : new Promise((_, reject) =>
                t?.signal?.addEventListener('abort', () =>
                  reject(new UploadAbortedError(t.signal!.reason))
                )
              ),
      },
      transport,
      partBytes: PART,
      log: () => undefined,
    }).finally(() => w.settled++);
    return {
      type: 'video',
      mediaId: done.mediaId,
      key: done.keyHex,
      iv: done.ivHex,
      mimeType: media.mimeType,
      size: media.size,
      encoding: done.encoding,
    } satisfies MediaRef;
  };
  const prepareMedia: OutboxDeps['prepareMedia'] = (media, o) =>
    live(async () => {
      w.prepares.push(media.fileBytes!);
      if (opts.prepare) return opts.prepare(o.signal);
      o.onProgress(0.5);
      return {
        bytes: PREPARED,
        mimeType: 'video/mp4',
        fileName: 'reel.mp4',
        width: 720,
        height: 1280,
        durationMs: 4200,
      };
    });
  const conversations = new SvelteMap<string, Conversation>([
    [
      'g1',
      {
        id: 'g1',
        name: 'g1',
        contactName: 'g1',
        lifecycle: 'active',
        mlsStateHex: null,
        messages: [
          {
            id: ID,
            senderId: 'u',
            content: '',
            timestamp: new Date(100),
            isOwn: true,
            status: 'pending',
          },
        ],
      } as Conversation,
    ],
  ]);
  const outbox = createOutbox({
    mlsService: mls as never,
    storage: storage as never,
    userId: 'u',
    deviceKey: () => KEY,
    conversations,
    log: () => undefined,
    requestReAdd: vi.fn(async () => undefined),
    recoverRosterDisagreement: vi.fn(async () => undefined),
    isGroupHealthy: () => true,
    markDeletedRemotely: vi.fn(),
    uploadMedia,
    prepareMedia,
  });
  return {
    outbox,
    mls,
    conversations,
    kill() {
      alive = false;
      // Its timers and transfers end with it; nothing it does reaches the disk or the server.
      outbox.dispose();
    },
  };
}

/** How many MLS sends a life made. */
const sends = (l: ReturnType<typeof life>) => l.mls.sendMessage.mock.calls.length;

/** The reel the server stored, decrypted with the key the sent message carries. */
async function sentReel(w: World, l: ReturnType<typeof life>) {
  const call = l.mls.sendMessage.mock.calls[0] as unknown as [string, Uint8Array, string];
  const app = decodeAppMessage(call[1])!;
  const media = app.media!;
  const mediaId = media.mediaId!;
  const keyHex = hexEncode(media.key!);
  const ivHex = hexEncode(media.iv!);
  const blob = w.server.stored.get(mediaId)!;
  const opened = new Uint8Array(
    await decryptSegmentedMediaBuffer(blob.slice().buffer, keyHex, ivHex)
  );
  return { app, media, opened };
}

/** Once the reel is out: one object stored, the prepared bytes in it, nothing left on the disk. */
async function expectDeliveredOnce(w: World, l: ReturnType<typeof life>) {
  await vi.waitFor(() => expect(sends(l)).toBe(1));
  await vi.waitFor(async () => expect(w.sql.rows.size).toBe(0));
  expect(w.server.stored.size).toBe(1);
  const { media, opened } = await sentReel(w, l);
  expect(sameBytes(opened, PREPARED)).toBe(true);
  expect(mediaReelFromProto(media)).toEqual({
    intent: 'reel-message',
    durationMs: 4200,
    expiresAtMs: 1_790_000_000_000,
  });
  expect(media.mimeType).toBe('video/mp4');
  await vi.waitFor(async () => expect(await w.blobs.list()).toEqual([]));
}

const PARTS = Math.ceil((20 + PREPARED.length + 16) / PART);

beforeEach(() => {
  connectivity.reset();
});
afterEach(() => clearAllUploads());

describe('a chat reel through the outbox (RC-5)', () => {
  it('is prepared in the upload task, its progress shown, then uploaded in parts and sent once', async () => {
    const w = world();
    let finish!: () => void;
    const l = life(w, {
      prepare: (signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new UploadAbortedError(signal.reason)));
          finish = () =>
            resolve({
              bytes: PREPARED,
              mimeType: 'video/mp4',
              fileName: 'reel.mp4',
              width: 720,
              height: 1280,
              durationMs: 4200,
            });
        }),
    });
    await l.outbox.enqueue(rawTakeEntry());
    await vi.waitFor(() => expect(w.prepares).toHaveLength(1));
    expect(sameBytes(w.prepares[0], RAW)).toBe(true);
    expect(uploadViewOf(ID)?.phase).toBe('preparing');
    expect(uploadViewOf(ID)?.prepared).toBe(0);
    finish();
    await expectDeliveredOnce(w, l);
    expect(w.server.partsReceived()).toBe(PARTS);
    expect(w.server.reservations).toBe(1);
  });

  it('the bubble names the preparation with its percent', () => {
    expect(
      uploadCaption({ phase: 'preparing', loaded: 0, total: 0, attempt: 1, prepared: 0.42 }, 1)
    ).toMatch(/42/);
  });

  it('KILL DURING THE PREPARATION: the next life prepares the RAW take again, nothing lost, one upload', async () => {
    const w = world();
    const first = life(w, { prepare: () => NEVER() });
    await first.outbox.enqueue(rawTakeEntry());
    await vi.waitFor(() => expect(w.prepares).toHaveLength(1));
    first.kill();

    const second = life(w);
    await second.outbox.flush();
    await expectDeliveredOnce(w, second);
    expect(w.prepares).toHaveLength(2);
    expect(sameBytes(w.prepares[1], RAW)).toBe(true);
    expect(w.uploads).toBe(1);
  });

  it('KILL AFTER THE PREPARED BLOB, BEFORE ITS ROW: the row still opens the RAW take, which is prepared again', async () => {
    const w = world();
    const first = life(w);
    // The kill: the prepared file's blob is committed, the row that would name it never is.
    const execute = w.sql.db.execute;
    let inserts = 0;
    w.sql.db.execute = async (q: string, p?: any[]) => {
      if (q.includes('INSERT OR REPLACE INTO outbox') && ++inserts === 2) {
        first.kill();
        return NEVER();
      }
      return execute(q, p);
    };
    await first.outbox.enqueue(rawTakeEntry());
    await vi.waitFor(() => expect(inserts).toBe(2));
    expect((await w.blobs.list()).map((b) => b.id).sort()).toEqual([ID, `${ID}#b`]);
    w.sql.db.execute = execute;

    const second = life(w);
    await second.outbox.flush();
    await expectDeliveredOnce(w, second);
    expect(w.prepares).toHaveLength(2);
    expect(sameBytes(w.prepares[1], RAW)).toBe(true);
  });

  it('KILL AFTER THE ROW, BEFORE THE RAW SLOT IS DELETED: the next life uploads the PREPARED file, never prepares again', async () => {
    const w = world();
    const first = life(w);
    const del = w.blobs.delete.bind(w.blobs);
    let killed = false;
    w.blobs.delete = async (id: string) => {
      if (!killed) {
        killed = true;
        first.kill();
        return NEVER();
      }
      return del(id);
    };
    await first.outbox.enqueue(rawTakeEntry());
    await vi.waitFor(() => expect(killed).toBe(true));
    expect(w.server.sent).toEqual([]);

    const second = life(w);
    await second.outbox.flush();
    await expectDeliveredOnce(w, second);
    expect(w.prepares).toHaveLength(1);
  });

  it('KILL MID-UPLOAD (part 3 of 4 in flight): the next life sends ONLY the parts the server lacks', async () => {
    const w = world();
    const first = life(w);
    w.server.fault = (method, path) => {
      if (method === 'PUT' && path.endsWith('/parts/2')) {
        first.kill();
        return 'hang';
      }
      return undefined;
    };
    await first.outbox.enqueue(rawTakeEntry());
    await vi.waitFor(() => expect(w.server.partsReceived()).toBe(2));
    w.server.fault = () => undefined;

    const second = life(w);
    await second.outbox.flush();
    await expectDeliveredOnce(w, second);
    expect(w.server.partsReceived()).toBe(PARTS);
    expect(w.server.reservations).toBe(1);
    expect(w.prepares).toHaveLength(1);
  });

  it('KILL AFTER `complete` WAS STORED, BEFORE ITS ANSWER: the next life uploads nothing and sends the same object', async () => {
    const w = world();
    const first = life(w);
    w.server.fault = (method, path) => {
      if (method === 'POST' && path.endsWith('/complete')) {
        first.kill();
        return 'hang-after';
      }
      return undefined;
    };
    await first.outbox.enqueue(rawTakeEntry());
    await vi.waitFor(() => expect(w.server.stored.size).toBe(1));
    w.server.fault = () => undefined;
    const putsBefore = w.server.partsReceived();

    const second = life(w);
    await second.outbox.flush();
    await expectDeliveredOnce(w, second);
    expect(w.server.partsReceived()).toBe(putsBefore);
    expect(w.server.reservations).toBe(1);
  });

  it('KILL AFTER THE REF IS RECORDED, BEFORE THE MLS SEND: the next life sends without touching the server', async () => {
    const w = world();
    let reached = false;
    const first = life(w, {
      send: () => {
        reached = true;
        first.kill();
        return NEVER();
      },
    });
    await first.outbox.enqueue(rawTakeEntry());
    await vi.waitFor(() => expect(reached).toBe(true));
    const requests = w.server.sent.length;

    const second = life(w);
    await second.outbox.flush();
    await expectDeliveredOnce(w, second);
    expect(w.server.sent.length).toBe(requests);
    expect(w.uploads).toBe(1);
  });

  it('a cancel DURING THE PREPARATION stops the encoder: nothing uploaded, the row and both slots gone', async () => {
    const w = world();
    let aborted = false;
    const l = life(w, {
      prepare: (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new UploadAbortedError(signal.reason));
          })
        ),
    });
    await l.outbox.enqueue(rawTakeEntry());
    await vi.waitFor(() => expect(w.prepares).toHaveLength(1));
    expect(await l.outbox.cancelPending(ID)).toBe(true);
    await vi.waitFor(() => expect(aborted).toBe(true));
    await vi.waitFor(async () => expect(await w.blobs.list()).toEqual([]));
    expect(w.sql.rows.size).toBe(0);
    expect(w.server.sent).toEqual([]);
    expect(sends(l)).toBe(0);
  });

  it('a cancel DURING THE UPLOAD releases the session on the server (its budget is given back)', async () => {
    const w = world();
    const l = life(w);
    w.server.fault = (method, path) =>
      method === 'PUT' && path.endsWith('/parts/1') ? 'hang' : undefined;
    await l.outbox.enqueue(rawTakeEntry());
    await vi.waitFor(() => expect(w.server.partsReceived()).toBe(1));
    expect(await l.outbox.cancelPending(ID)).toBe(true);
    await vi.waitFor(() => expect(w.server.seen.some((r) => r.method === 'DELETE')).toBe(true));
    expect([...w.server.sessions.values()][0].closed).toBe(true);
    await vi.waitFor(async () => expect(await w.blobs.list()).toEqual([]));
    expect(sends(l)).toBe(0);
  });

  it('a take the encoder REFUSES is parked as an error with the take KEPT; Retry prepares it again and sends it', async () => {
    const w = world();
    let refuse = true;
    const l = life(w, {
      prepare: async () => {
        if (refuse) throw new Error('unsupported codec');
        return {
          bytes: PREPARED,
          mimeType: 'video/mp4',
          fileName: 'reel.mp4',
          width: 720,
          height: 1280,
          durationMs: 4200,
        };
      },
    });
    await l.outbox.enqueue(rawTakeEntry());
    await vi.waitFor(() => expect(uploadViewOf(ID)?.phase).toBe('error'));
    expect(w.sql.rows.has(ID)).toBe(true);
    const kept = (await w.storage.getOutboxEntry(ID, KEY))!;
    expect(sameBytes(kept.media?.fileBytes, RAW)).toBe(true);
    expect(w.server.sent).toEqual([]);

    refuse = false;
    l.outbox.retryUpload(ID);
    await expectDeliveredOnce(w, l);
    expect(w.prepares).toHaveLength(2);
  });

  it('A FLAKY LINK (a seeded share of the parts lost): each retry resumes, one object is stored, no part is sent twice without cause', async () => {
    const w = world();
    const l = life(w);
    let seed = 0x5eed;
    const roll = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >> 16) % 3;
    };
    let drops = 0;
    w.server.fault = (method) => {
      if (method !== 'PUT') return undefined;
      if (roll() === 0) {
        drops++;
        return 'drop';
      }
      return undefined;
    };
    await l.outbox.enqueue(rawTakeEntry());
    for (let round = 0; round < 40 && sends(l) === 0; round++) {
      // Wait for THIS attempt to end, then the member's Retry (it skips the backoff, never a clock).
      const before = w.settled;
      await vi.waitFor(() => expect(w.settled > before || sends(l) > 0).toBe(true));
      await vi.waitFor(() =>
        expect(sends(l) > 0 || uploadViewOf(ID)?.phase === 'waiting').toBe(true)
      );
      if (sends(l) === 0) l.outbox.retryUpload(ID);
    }
    await expectDeliveredOnce(w, l);
    expect(drops).toBeGreaterThan(0);
    // Every part reached the server once, except a re-send after a drop never counts as received.
    expect(w.server.partsReceived()).toBe(PARTS);
    expect(w.server.reservations).toBe(1);
    expect(w.prepares).toHaveLength(1);
  });
});
