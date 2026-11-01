// @vitest-environment happy-dom
/**
 * A CHAT REEL THROUGH THE OUTBOX, KILLED AT EVERY STAGE (reels-in-chat RC-5), AS A TAKE WITH ONE AND
 * WITH THREE SENDS (RC-13): the suite runs twice, and every promise below holds for both.
 *
 * The raw take is queued at once; the outbox prepares it in the upload task (before its slot), stores the prepared
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

/** This tab's role, and the outbox event handlers each life registered (a channel's receivers). */
const tab = vi.hoisted(() => ({
  role: 'leader' as 'leader' | 'follower',
  handlers: [] as Array<(event: TabOutboxEvent) => void>,
}));
const tabOutboxMock = vi.hoisted(() => ({
  requestLeaderOutboxFlush: vi.fn(),
  publishOutboxEntrySent: vi.fn(),
  publishOutboxEntryCancelled: vi.fn(),
  publishOutboxEntryFailed: vi.fn(),
  forwardReelTakeWrite: vi.fn(),
  acknowledgeReelTakeAdoption: vi.fn(),
  subscribeTabOutboxEvents: vi.fn((handler: (event: TabOutboxEvent) => void) => {
    tab.handlers.push(handler);
    return () => {};
  }),
}));
vi.mock('$lib/mls-client/tabLeader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/tabLeader')>()),
  getIsTabLeader: () => tab.role === 'leader',
  getTabLeadership: () => tab.role,
  whenTabLeadershipDecided: () => Promise.resolve(tab.role),
}));
vi.mock('$lib/mls-client/tabMessageSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/tabMessageSync')>()),
  ...tabOutboxMock,
}));

import {
  OutboxEnqueueError,
  OutboxPrepareRefusedError,
  ReelTakeTooManySendsError,
  createOutbox,
  type OutboxController,
  type OutboxDeps,
  type PreparedOutboxMedia,
} from './outbox';
import { clearAllUploads, uploadViewOf } from './uploadProgress.svelte';
import { uploadCaption } from './uploadLabel';
import { decodeAppMessage, mediaReelFromProto } from '$lib/proto/codec';
import { releaseUploadSession, uploadResumable } from '$lib/utils/resumableUpload';
import { UploadAbortedError } from '$lib/utils/uploadXhr';
import { prepareQueuedChatReel } from './prepareQueuedChatReel';
import { decryptSegmentedMediaBuffer } from '$lib/mediaSegmented';
import { hexEncode } from '$lib/mediaCrypto';
import { connectivity } from '$lib/stores/connectivity.svelte';
import type { OutboxBlobStore } from '$lib/db/outboxBlob';
import type { OutboxEntry } from '$lib/db';
import type { ChatReelHoldAnswer, MediaRef } from '$lib/media';
import type { SentFrame } from '$lib/mls-client/mlsDeliveryApi';
import type { Conversation } from '$lib/types';
import type { TabOutboxEvent } from '$lib/mls-client/tabMessageSync';
import { CHAT_REEL_OVER_BUDGET } from '$lib/utils/mediaErrors';
import { REEL_TAKE_MAX_SENDS } from '$lib/db/sqliteBatch';
import { acquireEncoderLease, withEncoderLease } from '$lib/video/encoderLease';
import { SqliteStorage } from '$lib/db/sqlite';
import { buildChatReelTake } from '$lib/reels/chatReelTake';
import { publishReel, ReelPublishError } from '$lib/reels/publishReel';
import type { PreparedVideo } from '$lib/video/prepareVideoForUpload';
import { m } from '$lib/paraglide/messages';
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

/** The conversations a take may be sent to, and the id of each send. */
const GROUPS = ['g1', 'g2', 'g3'];
const SEND_IDS = [
  'aaaaaaaa-2222-4333-8444-555555555551',
  'aaaaaaaa-2222-4333-8444-555555555552',
  'aaaaaaaa-2222-4333-8444-555555555553',
];
/** The bubble a take's progress is read on: its first send's. */
const VIEW = SEND_IDS[0];
const EXPIRES = 4_000_000_000_000;

/** The camera's take (id {@link ID}) for the first `n` conversations, as the composable builds it. */
function takeRows(n = 1) {
  const rows = buildChatReelTake({
    takeId: ID,
    sentAt: 100,
    senderId: 'u',
    bytes: RAW,
    mimeType: 'video/webm',
    fileName: 'take.webm',
    targets: GROUPS.slice(0, n).map((g, i) => ({
      messageId: SEND_IDS[i],
      groupId: g,
      conversationKey: g,
    })),
  });
  // A fixed hint, so the declaration the sends carry is asserted exactly.
  rows.take.media!.expiresAtMs = EXPIRES;
  for (const send of rows.sends) send.entry.media!.expiresAtMs = EXPIRES;
  return rows;
}

/** Queues the take for `n` conversations through `l`. */
async function enqueueTake(
  l: { outbox: OutboxController },
  n: number,
  opts?: { awaitsPublish?: boolean }
) {
  const rows = takeRows(n);
  await l.outbox.enqueueTake(rows.take, rows.sends, opts);
}

/** Withdraws every send of the take, one by one: each is answered "never sent". */
async function cancelAll(l: { outbox: OutboxController }, n: number) {
  for (const id of SEND_IDS.slice(0, n)) expect(await l.outbox.cancelPending(id)).toBe(true);
}

/** One disk and one server, shared by every life of a case. */
function world() {
  const storage = new SqliteStorage(`reel-${crypto.randomUUID()}`);
  const sql = attachFakeOutboxSql(storage);
  const server = new FakeSessionServer();
  const blobs = (storage as unknown as { blobs: OutboxBlobStore }).blobs;
  return {
    storage,
    sql,
    server,
    blobs,
    prepares: [] as Uint8Array[],
    uploads: 0,
    settled: 0,
    /** What reached the server and MLS, in order: `hold <id>`, `send <group>`, `release <id>`. */
    events: [] as string[],
  };
}
type World = ReturnType<typeof world>;

interface LifeOptions {
  /** The encoder of this life; the default prepares {@link PREPARED} at once. */
  prepare?: (signal: AbortSignal) => Promise<PreparedOutboxMedia>;
  /** The MLS send of this life; the default accepts. */
  send?: () => Promise<void>;
  /** Groups deleted on the server: a send into one fails for good (`group-deleted`). */
  deleted?: string[];
  /** The chat hold's answer on an adopted upload; the default holds it. */
  hold?: ChatReelHoldAnswer;
  /** The release of a take's file; the default is answered. */
  release?: () => Promise<'answered' | 'unanswered'>;
  /** Runs once the server stored the file, before the upload returns it (the body has left). */
  afterUpload?: () => Promise<void>;
  /** Runs right AFTER the take's full row (with its file) was read for its transfer. */
  afterFullRead?: () => Promise<void>;
  /** Messages TOMBSTONED on this device (deleted for everyone): their stored row says `isDeleted`. */
  tombstones?: string[];
}

const ACCEPT = async () => undefined;

/** One run of the app on the world's disk. `kill()` stops it cold. */
function life(w: World, opts: LifeOptions = {}) {
  let alive = true;
  const live = <T>(fn: () => Promise<T>): Promise<T> => (alive ? fn() : NEVER<T>());
  const s = w.storage;
  const storage = {
    saveMessage: vi.fn(async () => undefined),
    getMessage: vi.fn(async (id: string) =>
      opts.tombstones?.includes(id) ? { id, isDeleted: true } : null
    ),
    saveOutboxEntry: (e: OutboxEntry, k: string) => live(() => s.saveOutboxEntry(e, k)),
    saveReelTake: (
      t: OutboxEntry,
      sends: Parameters<SqliteStorage['saveReelTake']>[1],
      k: string
    ) => live(() => s.saveReelTake(t, sends, k)),
    getOutboxQueue: (k: string) => live(() => s.getOutboxQueue(k)),
    getReelTakeRecords: (k: string) => live(() => s.getReelTakeRecords(k)),
    getOutboxEntry: (id: string, k: string, o?: { withFile?: boolean }) =>
      live(async () => {
        const row = await s.getOutboxEntry(id, k, o);
        if (row?.kind === 'reel-take' && o?.withFile !== false && opts.afterFullRead) {
          const hook = opts.afterFullRead;
          opts.afterFullRead = undefined;
          await hook();
        }
        return row;
      }),
    updateOutboxEntry: (id: string, p: Partial<OutboxEntry>, k: string) =>
      live(() => s.updateOutboxEntry(id, p, k)),
    deleteOutboxEntry: (id: string) => live(() => s.deleteOutboxEntry(id)),
    sweepOutboxBlobs: () => live(() => s.sweepOutboxBlobs()),
  };
  const port = w.server.port();
  /** The system lines this life posted into the thread. */
  const notices: string[] = [];
  const mls = {
    getLocalGroups: vi.fn(() => []),
    getGroupMeta: vi.fn(async (id: string) => ({
      groupId: id,
      deletedAt: opts.deleted?.includes(id) ? 1 : null,
    })),
    isGroupActive: vi.fn(async () => true),
    getGroupExclusions: vi.fn(async () => new Map()),
    waitForMessageQueueIdle: vi.fn(async () => undefined),
    // Typed as the real answer: the service is cast `as never` below, so only this annotation
    // keeps the fake in step with `SentFrame` (it lacked `authorProof` after #2276).
    sendMessage: vi.fn(async (group: string): Promise<SentFrame> => {
      if (!alive) return NEVER();
      w.events.push(`send ${group}`);
      await (opts.send ?? ACCEPT)();
      return {
        sealed: new Uint8Array(),
        authorProof: new Uint8Array(),
        receivedAt: 1_700_000_000_000,
      };
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
    if (opts.afterUpload) await opts.afterUpload();
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
  const conversations = new SvelteMap<string, Conversation>(
    GROUPS.map((g, i) => [
      g,
      {
        id: g,
        name: g,
        contactName: g,
        lifecycle: 'active',
        mlsStateHex: null,
        messages: [
          {
            id: SEND_IDS[i],
            senderId: 'u',
            content: '',
            timestamp: new Date(100),
            isOwn: true,
            status: 'pending',
          },
        ],
      } as Conversation,
    ])
  );
  const outbox = createOutbox({
    mlsService: mls as never,
    storage: storage as never,
    userId: 'u',
    deviceKey: () => KEY,
    conversations,
    log: () => undefined,
    requestReAdd: vi.fn(async () => undefined),
    recoverRosterDisagreement: vi.fn(async () => undefined),
    isGroupHealthy: (id: string) => !opts.deleted?.includes(id),
    markDeletedRemotely: vi.fn(),
    uploadMedia,
    prepareMedia,
    releaseUpload: (uploadId, why) =>
      live(async () => {
        await releaseUploadSession(port, uploadId, why, () => undefined);
      }),
    addMessageToChat: async (_sender, content) => {
      notices.push(content);
    },
    holdChatReel: (mediaId) =>
      live(async () => {
        w.events.push(`hold ${mediaId}`);
        return opts.hold ?? 'held';
      }),
    releaseChatReel: (mediaId) =>
      live(async () => {
        w.events.push(`release ${mediaId}`);
        return opts.release ? opts.release() : ('answered' as const);
      }),
  });
  return {
    outbox,
    mls,
    conversations,
    notices,
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

/**
 * Once the reel is out in its `n` conversations: ONE object stored, the prepared bytes in it, every
 * send citing it, and nothing left on the disk but the take's small sent record (no file).
 */
async function expectDeliveredOnce(w: World, l: ReturnType<typeof life>, n: number) {
  await vi.waitFor(() => expect(sends(l)).toBe(n));
  await vi.waitFor(async () => expect([...w.sql.rows.keys()]).toEqual([ID]));
  expect(w.sql.rows.get(ID)!.kind).toBe('reel-take');
  const record = (await w.storage.getOutboxEntry(ID, KEY, { withFile: false }))!;
  expect(record.take?.state).toBe('sent');
  expect(record.take?.sends.every((s) => s.sent)).toBe(true);
  expect(w.server.stored.size).toBe(1);
  const { media, opened } = await sentReel(w, l);
  expect(sameBytes(opened, PREPARED)).toBe(true);
  expect(mediaReelFromProto(media)).toEqual({
    intent: 'reel-message',
    durationMs: 4200,
    expiresAtMs: EXPIRES,
  });
  expect(media.mimeType).toBe('video/mp4');
  const cited = l.mls.sendMessage.mock.calls.map(
    (c) => decodeAppMessage((c as unknown as [string, Uint8Array])[1])!.media!.mediaId
  );
  expect(new Set(cited)).toEqual(new Set([media.mediaId]));
  expect(new Set(l.mls.sendMessage.mock.calls.map((c) => c[0]))).toEqual(
    new Set(GROUPS.slice(0, n))
  );
  await vi.waitFor(async () => expect(await w.blobs.list()).toEqual([]));
}

const PARTS = Math.ceil((20 + PREPARED.length + 16) / PART);

/**
 * Makes the PUT of one part hang, and gives back what to wait for: the request HAS reached the
 * fault (`hit()`). The count of parts the server holds is NOT that signal: it reads N the moment part
 * N-1 lands, before the next PUT is even sent, so a test that waited on it went on (cleared the
 * fault, started a second life) while the first life was still uploading - two lives racing, and
 * `partsReceived()` landing on 3 or 4 instead of the 2 asserted (the intermittent 'KILL MID-UPLOAD').
 */
function hangPart(w: World, index: number, onHit: () => void = () => undefined) {
  let hit = false;
  w.server.fault = (method, path) => {
    if (method === 'PUT' && path.endsWith(`/parts/${index}`)) {
      hit = true;
      onHit();
      return 'hang';
    }
    return undefined;
  };
  return { hit: () => expect(hit).toBe(true) };
}

beforeEach(() => {
  tab.role = 'leader';
  tab.handlers.length = 0;
  connectivity.reset();
});
afterEach(() => clearAllUploads());

describe.each([1, 3])(
  'a chat reel through the outbox, a take with %i send(s) (RC-5, RC-13)',
  (N) => {
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
      await enqueueTake(l, N);
      await vi.waitFor(() => expect(w.prepares).toHaveLength(1));
      expect(sameBytes(w.prepares[0], RAW)).toBe(true);
      expect(uploadViewOf(VIEW)?.phase).toBe('preparing');
      expect(uploadViewOf(VIEW)?.prepared).toBe(0);
      finish();
      await expectDeliveredOnce(w, l, N);
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
      await enqueueTake(first, N);
      await vi.waitFor(() => expect(w.prepares).toHaveLength(1));
      first.kill();

      const second = life(w);
      await second.outbox.flush();
      await expectDeliveredOnce(w, second, N);
      expect(w.prepares).toHaveLength(2);
      expect(sameBytes(w.prepares[1], RAW)).toBe(true);
      expect(w.uploads).toBe(1);
    });

    it('KILL AFTER THE PREPARED BLOB, BEFORE ITS ROW: the row still opens the RAW take, which is prepared again', async () => {
      const w = world();
      const first = life(w);
      // The kill: the prepared file's blob is committed, the row that would name it never is (the
      // store's merge rewrites the row with ONE `UPDATE`, its first after the take is queued).
      const execute = w.sql.db.execute;
      let rewrites = 0;
      w.sql.db.execute = async (q: string, p?: any[]) => {
        if (q.includes('UPDATE outbox SET conversation_id') && ++rewrites === 1) {
          first.kill();
          return NEVER();
        }
        return execute(q, p);
      };
      await enqueueTake(first, N);
      await vi.waitFor(() => expect(rewrites).toBe(1));
      expect((await w.blobs.list()).map((b) => b.id).sort()).toEqual([ID, `${ID}#b`]);
      w.sql.db.execute = execute;

      const second = life(w);
      await second.outbox.flush();
      await expectDeliveredOnce(w, second, N);
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
      await enqueueTake(first, N);
      await vi.waitFor(() => expect(killed).toBe(true));
      expect(w.server.sent).toEqual([]);

      const second = life(w);
      await second.outbox.flush();
      await expectDeliveredOnce(w, second, N);
      expect(w.prepares).toHaveLength(1);
    });

    it('KILL MID-UPLOAD (part 3 of 4 in flight): the next life sends ONLY the parts the server lacks', async () => {
      const w = world();
      const first = life(w);
      const hung = hangPart(w, 2, () => first.kill());
      await enqueueTake(first, N);
      await vi.waitFor(hung.hit);
      expect(w.server.partsReceived()).toBe(2);
      w.server.fault = () => undefined;

      const second = life(w);
      await second.outbox.flush();
      await expectDeliveredOnce(w, second, N);
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
      await enqueueTake(first, N);
      await vi.waitFor(() => expect(w.server.stored.size).toBe(1));
      w.server.fault = () => undefined;
      const putsBefore = w.server.partsReceived();

      const second = life(w);
      await second.outbox.flush();
      await expectDeliveredOnce(w, second, N);
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
      await enqueueTake(first, N);
      await vi.waitFor(() => expect(reached).toBe(true));
      const requests = w.server.sent.length;

      const second = life(w);
      await second.outbox.flush();
      await expectDeliveredOnce(w, second, N);
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
      await enqueueTake(l, N);
      await vi.waitFor(() => expect(w.prepares).toHaveLength(1));
      await cancelAll(l, N);
      await vi.waitFor(() => expect(aborted).toBe(true));
      await vi.waitFor(async () => expect(await w.blobs.list()).toEqual([]));
      await vi.waitFor(() => expect(w.sql.rows.size).toBe(0));
      expect(w.server.sent).toEqual([]);
      expect(sends(l)).toBe(0);
    });

    it('a cancel DURING THE UPLOAD releases the session on the server (its budget is given back)', async () => {
      const w = world();
      const l = life(w);
      const hung = hangPart(w, 1);
      await enqueueTake(l, N);
      await vi.waitFor(hung.hit);
      await cancelAll(l, N);
      await vi.waitFor(() => expect(w.server.seen.some((r) => r.method === 'DELETE')).toBe(true));
      expect([...w.server.sessions.values()][0].closed).toBe(true);
      await vi.waitFor(async () => expect(await w.blobs.list()).toEqual([]));
      expect(sends(l)).toBe(0);
    });

    it('THE CHAT CAP CANNOT BE READ (offline): the real preparer parks the take as an error, KEPT, nothing encoded or sent', async () => {
      const w = world();
      const encoder = vi.fn();
      const l = life(w, {
        prepare: (signal) =>
          prepareQueuedChatReel(
            takeRows().take.media!,
            { signal, onProgress: () => undefined },
            {
              uploadLimits: async () => ({ maxPlaintextBytes: 50_000_000 }),
              reelLimits: () => Promise.reject(new TypeError('Failed to fetch')),
              prepare: encoder,
            }
          ),
      });
      await enqueueTake(l, N);
      await vi.waitFor(() => expect(uploadViewOf(VIEW)?.phase).toBe('error'));
      expect(w.sql.rows.has(ID)).toBe(true);
      const kept = (await w.storage.getOutboxEntry(ID, KEY))!;
      expect(sameBytes(kept.media?.fileBytes, RAW)).toBe(true);
      expect(encoder).not.toHaveBeenCalled();
      expect(w.server.sent).toEqual([]);
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
      await enqueueTake(l, N);
      await vi.waitFor(() => expect(uploadViewOf(VIEW)?.phase).toBe('error'));
      expect(w.sql.rows.has(ID)).toBe(true);
      const kept = (await w.storage.getOutboxEntry(ID, KEY))!;
      expect(sameBytes(kept.media?.fileBytes, RAW)).toBe(true);
      expect(w.server.sent).toEqual([]);

      refuse = false;
      l.outbox.retryUpload(VIEW);
      await expectDeliveredOnce(w, l, N);
      expect(w.prepares).toHaveLength(2);
    });

    it('a cancel WHILE IT WAITS IN BACKOFF (no transfer to abort) releases the session the row recorded', async () => {
      const w = world();
      const l = life(w);
      let puts = 0;
      w.server.fault = (method) => (method === 'PUT' && ++puts === 2 ? 'drop' : undefined);
      await enqueueTake(l, N);
      await vi.waitFor(() => expect(uploadViewOf(VIEW)?.phase).toBe('waiting'));
      const [session] = [...w.server.sessions.keys()];
      expect(w.server.sessions.get(session)!.closed).toBeUndefined();
      await cancelAll(l, N);
      await vi.waitFor(() => expect(w.server.sessions.get(session)!.closed).toBe(true));
      expect(w.sql.rows.size).toBe(0);
      await vi.waitFor(async () => expect(await w.blobs.list()).toEqual([]));
    });

    it('a cancel of an entry PARKED AS FAILED (no answer, three attempts) releases its session', async () => {
      // THE LADDER IS WHAT REACHES THE PARK (a member's Retry starts the no-answer count again), so its
      // timer is driven by hand - advanced, never waited for, and no time is asserted. Only the timer
      // and the clock it reads are faked; fake-IndexedDB keeps its own real scheduling.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        const w = world();
        const l = life(w);
        w.server.fault = (method, path) =>
          method === 'PUT' && path.endsWith('/parts/1') ? 'reset' : undefined;
        await enqueueTake(l, N);
        for (let attempt = 1; attempt <= 3; attempt++) {
          await vi.waitFor(() => expect(w.settled).toBeGreaterThanOrEqual(attempt));
          await vi.waitFor(() =>
            expect(['waiting', 'failed']).toContain(uploadViewOf(VIEW)?.phase)
          );
          // To the backoff timer and NEVER PAST IT: overshooting moved the faked clock under the next
          // attempt, whose stall hint then read a 60 s silence (a 'stalled' seen under load).
          const before = w.settled;
          for (let step = 0; step < 50; step++) {
            if (w.settled !== before || uploadViewOf(VIEW)?.phase !== 'waiting') break;
            await vi.advanceTimersToNextTimerAsync();
            // Fake-IndexedDB runs on the REAL setImmediate: let it move before the next look.
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
        await vi.waitFor(() => expect(uploadViewOf(VIEW)?.phase).toBe('failed'));
        const [session] = [...w.server.sessions.keys()];
        expect(w.server.sessions.size).toBe(1);
        expect(w.server.sessions.get(session)!.closed).toBeUndefined();
        await cancelAll(l, N);
        await vi.waitFor(() => expect(w.server.sessions.get(session)!.closed).toBe(true));
        l.kill();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a cancel AFTER A RELAUNCH, before any transfer restarted, releases the session the row recorded', async () => {
      const w = world();
      const first = life(w);
      const hung = hangPart(w, 2, () => first.kill());
      await enqueueTake(first, N);
      await vi.waitFor(hung.hit);
      // The second life may start its own flush as it is created: whatever it sends never lands, so
      // the parts and the object counted below are the first life's. Only the release is served.
      w.server.fault = (method) => (method === 'DELETE' ? undefined : 'hang');
      const [session] = [...w.server.sessions.keys()];

      const second = life(w);
      await cancelAll(second, N);
      await vi.waitFor(() => expect(w.server.sessions.get(session)!.closed).toBe(true));
      expect(w.server.partsReceived()).toBe(2);
      expect(w.sql.rows.size).toBe(0);
      await vi.waitFor(async () => expect(await w.blobs.list()).toEqual([]));
    });

    it('a TEARDOWN (the app killed mid-upload) never releases the session: the next life resumes it', async () => {
      const w = world();
      const first = life(w);
      const hung = hangPart(w, 2);
      await enqueueTake(first, N);
      await vi.waitFor(hung.hit);
      // dispose() aborts the transfer with the same reason a cancel uses.
      first.outbox.dispose();
      await vi.waitFor(() => expect(w.settled).toBe(1));
      expect(w.server.sent.some((r) => r.method === 'DELETE')).toBe(false);
      first.kill();
      w.server.fault = () => undefined;
      const second = life(w);
      await second.outbox.flush();
      await expectDeliveredOnce(w, second, N);
      expect(w.server.reservations).toBe(1);
    });

    it('the prepared file CANNOT BE STORED: no byte is uploaded, and the entry is parked as an error with the take kept', async () => {
      const w = world();
      const l = life(w);
      const execute = w.sql.db.execute;
      let rewrites = 0;
      // The INSERT queues the take; the first whole-row rewrite would name the prepared file.
      w.sql.db.execute = async (q: string, p?: any[]) => {
        if (q.includes('UPDATE outbox SET conversation_id') && ++rewrites === 1) {
          throw new Error('database or disk is full');
        }
        return execute(q, p);
      };
      await enqueueTake(l, N);
      await vi.waitFor(() => expect(uploadViewOf(VIEW)?.phase).toBe('error'));
      expect(w.server.sent).toEqual([]);
      w.sql.db.execute = execute;
      const kept = (await w.storage.getOutboxEntry(ID, KEY))!;
      expect(sameBytes(kept.media?.fileBytes, RAW)).toBe(true);
      expect(sends(l)).toBe(0);
    });

    it('a take its preparer REFUSES FOR GOOD fails for good: no retry offered, the row gone, the reason in the thread', async () => {
      const w = world();
      const l = life(w, {
        prepare: async () => {
          throw new OutboxPrepareRefusedError('too long to send', new Error('too-long'));
        },
      });
      await enqueueTake(l, N);
      await vi.waitFor(() => expect(w.sql.rows.size).toBe(0));
      expect(l.notices).toEqual(Array(N).fill('too long to send'));
      expect(uploadViewOf(VIEW)?.phase).not.toBe('error');
      expect(w.server.sent).toEqual([]);
      expect(sends(l)).toBe(0);
      expect(w.prepares).toHaveLength(1);
      await vi.waitFor(async () => expect(await w.blobs.list()).toEqual([]));
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
      await enqueueTake(l, N);
      for (let round = 0; round < 40 && sends(l) === 0; round++) {
        // Wait for THIS attempt to end, then the member's Retry (it skips the backoff, never a clock).
        const before = w.settled;
        await vi.waitFor(() => expect(w.settled > before || sends(l) > 0).toBe(true));
        await vi.waitFor(() =>
          expect(sends(l) > 0 || uploadViewOf(VIEW)?.phase === 'waiting').toBe(true)
        );
        if (sends(l) === 0) l.outbox.retryUpload(VIEW);
      }
      await expectDeliveredOnce(w, l, N);
      expect(drops).toBeGreaterThan(0);
      // Every part reached the server once, except a re-send after a drop never counts as received.
      expect(w.server.partsReceived()).toBe(PARTS);
      expect(w.server.reservations).toBe(1);
      expect(w.prepares).toHaveLength(1);
    });
  }
);

/** The CanaReels publish step's own upload of the prepared file, to the same server (15.5). */
async function publishStepUpload(w: World): Promise<MediaRef> {
  const done = await uploadResumable({
    plaintext: PREPARED,
    retentionClass: 'reel-pending',
    state: undefined,
    persist: async () => undefined,
    port: w.server.port(),
    partBytes: PART,
    log: () => undefined,
  });
  return {
    type: 'video',
    mediaId: done.mediaId,
    key: done.keyHex,
    iv: done.ivHex,
    mimeType: 'video/mp4',
    size: PREPARED.length,
    width: 720,
    height: 1280,
    encoding: done.encoding,
  };
}

/** The take row as it stands, without its file. */
const takeRow = (w: World) => w.storage.getOutboxEntry(ID, KEY, { withFile: false });

/** Which sends the take records as gone out. */
async function sentIds(w: World): Promise<string[]> {
  return ((await takeRow(w))?.take?.sends ?? []).filter((s) => s.sent).map((s) => s.id);
}

describe('one take, several conversations (RC-13)', () => {
  it('THE TAKE AND ITS SENDS ARE ONE STATEMENT: written together, and a write that fails leaves neither', async () => {
    const w = world();
    const l = life(w, { prepare: () => NEVER() });
    await enqueueTake(l, 3);
    const inserts = w.sql.executed.filter((e) => e.sql.includes('INSERT OR REPLACE INTO outbox'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params).toHaveLength(12 * 4);
    expect(new Set(w.sql.rows.keys())).toEqual(new Set([ID, ...SEND_IDS]));
    l.kill();

    // The kill at that one statement: there is no state in which the take exists without its sends.
    const v = world();
    const second = life(v);
    v.sql.db.execute = async () => {
      throw new Error('killed during the write');
    };
    await expect(enqueueTake(second, 3)).rejects.toBeInstanceOf(OutboxEnqueueError);
    expect(v.sql.rows.size).toBe(0);
  });

  it('one send refused for good (its group deleted) while the two others go: they are the record', async () => {
    const w = world();
    const l = life(w, { deleted: ['g2'] });
    await enqueueTake(l, 3);
    await vi.waitFor(async () => expect([...w.sql.rows.keys()]).toEqual([ID]));
    expect(new Set(l.mls.sendMessage.mock.calls.map((c) => c[0]))).toEqual(new Set(['g1', 'g3']));
    expect(await sentIds(w)).toEqual([SEND_IDS[0], SEND_IDS[2]]);
    expect((await takeRow(w))?.take?.state).toBe('sent');
    expect(w.uploads).toBe(1);
    expect(w.events.some((e) => e.startsWith('release'))).toBe(false);
    // THE RECORD IS NO QUEUED WORK: no flush reads, drives or counts it.
    expect(await w.storage.getOutboxQueue(KEY)).toEqual([]);
    expect((await w.storage.getReelTakeRecords(KEY)).map((r) => r.id)).toEqual([ID]);
  });

  it('a cancel of ONE send keeps the take: the encoder runs on, and the file goes to the other two', async () => {
    const w = world();
    let finish!: () => void;
    let aborted = false;
    const l = life(w, {
      prepare: (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => (aborted = true));
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
    await enqueueTake(l, 3);
    await vi.waitFor(() => expect(w.prepares).toHaveLength(1));
    expect(await l.outbox.cancelPending(SEND_IDS[1])).toBe(true);
    expect(w.sql.rows.has(ID)).toBe(true);
    expect(aborted).toBe(false);
    finish();
    await vi.waitFor(() => expect(sends(l)).toBe(2));
    await vi.waitFor(async () => expect([...w.sql.rows.keys()]).toEqual([ID]));
    expect(await sentIds(w)).toEqual([SEND_IDS[0], SEND_IDS[2]]);
  });

  it('"Annuler partout" withdraws every queued send, and the last withdrawal releases the take', async () => {
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
    await enqueueTake(l, 3);
    await vi.waitFor(() => expect(w.prepares).toHaveLength(1));
    expect(await l.outbox.cancelTakeEverywhere(SEND_IDS[2])).toBe(3);
    await vi.waitFor(() => expect(aborted).toBe(true));
    // KEPT `releasing` while its transfer ran, deleted once it ended with no file.
    await vi.waitFor(() => expect(w.sql.rows.size).toBe(0));
    await vi.waitFor(async () => expect(await w.blobs.list()).toEqual([]));
    expect(sends(l)).toBe(0);
  });

  it('a send held past its expiry hint fails for good, its sentence in its thread; the others go', async () => {
    const w = world();
    const l = life(w);
    const rows = takeRows(3);
    rows.sends[1].entry.media!.expiresAtMs = 1_000;
    await l.outbox.enqueueTake(rows.take, rows.sends);
    await vi.waitFor(() => expect(sends(l)).toBe(2));
    await vi.waitFor(async () => expect([...w.sql.rows.keys()]).toEqual([ID]));
    expect(l.notices).toEqual([m.outbox_reel_send_expired()]);
    expect(new Set(l.mls.sendMessage.mock.calls.map((c) => c[0]))).toEqual(new Set(['g1', 'g3']));
  });

  it("FEED + CHATS: the take adopts the publish step's upload - ONE upload on the server, the chat hold placed before the first send", async () => {
    const w = world();
    const l = life(w);
    await enqueueTake(l, 3, { awaitsPublish: true });
    const ref = await publishStepUpload(w);
    await l.outbox.adoptPublishedUpload(ID, { ref, durationMs: 4200 });
    l.outbox.endPublishWait(ID);
    await expectDeliveredOnce(w, l, 3);
    expect(w.server.reservations).toBe(1);
    expect(w.prepares).toHaveLength(0);
    expect(w.uploads).toBe(0);
    expect(w.events[0]).toBe(`hold ${ref.mediaId}`);
    expect(w.events.filter((e) => e.startsWith('hold'))).toHaveLength(1);
  });

  it('a post REFUSED after the upload still sends the chats, with the file it uploaded', async () => {
    const w = world();
    const l = life(w);
    await enqueueTake(l, 3, { awaitsPublish: true });
    const published = publishReel(
      {
        clip: { blob: new Blob([RAW.slice().buffer as ArrayBuffer]), source: 'camera' },
        caption: '',
        identity: '',
        maxDurationMs: 90_000,
        video: {},
        onUploaded: (uploaded) => l.outbox.adoptPublishedUpload(ID, uploaded),
      },
      {
        assertNotMuted: async () => undefined,
        getToken: async () => 'token',
        uploadLimits: async () => null,
        prepare: async () =>
          ({
            file: new File([PREPARED.slice().buffer as ArrayBuffer], 'reel.mp4', {
              type: 'video/mp4',
            }),
            width: 720,
            height: 1280,
            durationSeconds: 4.2,
          }) as PreparedVideo,
        upload: () => publishStepUpload(w),
        placeholder: async () => null,
        createPost: async () => {
          throw new Error('422: the post was refused');
        },
      }
    ).finally(() => l.outbox.endPublishWait(ID));
    await expect(published).rejects.toBeInstanceOf(ReelPublishError);
    await expectDeliveredOnce(w, l, 3);
    expect(w.uploads).toBe(0);
  });

  it('a publish step that ENDS BEFORE ITS UPLOAD makes the take prepare and upload its own', async () => {
    const w = world();
    const l = life(w);
    await enqueueTake(l, 3, { awaitsPublish: true });
    expect(w.prepares).toHaveLength(0);
    l.outbox.endPublishWait(ID);
    await expectDeliveredOnce(w, l, 3);
    expect(w.prepares).toHaveLength(1);
    expect(w.uploads).toBe(1);
  });

  it("a chat hold the server REFUSES makes the take upload its own; the chats never cite the post's file", async () => {
    const w = world();
    const l = life(w, { hold: 'refused' });
    await enqueueTake(l, 3, { awaitsPublish: true });
    const ref = await publishStepUpload(w);
    await l.outbox.adoptPublishedUpload(ID, { ref, durationMs: 4200 });
    l.outbox.endPublishWait(ID);
    await vi.waitFor(() => expect(sends(l)).toBe(3));
    const { media } = await sentReel(w, l);
    expect(media.mediaId).not.toBe(ref.mediaId);
    expect(w.uploads).toBe(1);
  });

  it('D-DELETE-ONE: the record lists what "Supprimer partout" deletes, and the last deletion releases the file', async () => {
    const w = world();
    const l = life(w);
    await enqueueTake(l, 3);
    await expectDeliveredOnce(w, l, 3);
    const { media } = await sentReel(w, l);
    expect((await l.outbox.sentTakeOf(SEND_IDS[1]))?.sends.map((s) => s.id)).toEqual(SEND_IDS);
    await l.outbox.reelSendDeleted(SEND_IDS[0]);
    await l.outbox.reelSendDeleted(SEND_IDS[1]);
    expect((await l.outbox.sentTakeOf(SEND_IDS[2]))?.sends.map((s) => s.id)).toEqual([SEND_IDS[2]]);
    expect(w.events.some((e) => e.startsWith('release'))).toBe(false);
    await l.outbox.reelSendDeleted(SEND_IDS[2]);
    expect(w.events).toContain(`release ${media.mediaId}`);
    expect(w.sql.rows.size).toBe(0);
    expect(await l.outbox.sentTakeOf(SEND_IDS[2])).toBeNull();
  });

  it("OVER TODAY'S BUDGET at the take's upload: media-service's own 429 fails each send for good, its sentence in each thread, never retried", async () => {
    const w = world();
    const l = life(w);
    w.server.fault = (method, path) =>
      method === 'POST' && path === ''
        ? {
            status: 429,
            body: { statusCode: 429, message: 'budget', code: CHAT_REEL_OVER_BUDGET },
          }
        : undefined;
    await enqueueTake(l, 3);
    await vi.waitFor(() => expect(w.sql.rows.size).toBe(0));
    expect(l.notices).toEqual(Array(3).fill(m.outbox_reel_over_budget()));
    expect(w.server.sent.filter((r) => r.method === 'POST' && r.path === '')).toHaveLength(1);
    expect(sends(l)).toBe(0);
  });

  it('a 429 WITHOUT the budget code (a session limit, the edge) stays transient: retried, then delivered', async () => {
    const w = world();
    const l = life(w);
    w.server.fault = (method, path, n) =>
      method === 'POST' && path === '' && n === 1 ? 429 : undefined;
    await enqueueTake(l, 3);
    await vi.waitFor(() => expect(['waiting', 'retrying']).toContain(uploadViewOf(VIEW)?.phase));
    l.outbox.retryUpload(VIEW);
    await expectDeliveredOnce(w, l, 3);
    expect(l.notices).toEqual([]);
  });

  it("OVER TODAY'S BUDGET at the chat hold on the publish step's file: each send fails for good, nothing uploaded", async () => {
    const w = world();
    const l = life(w, { hold: 'over-budget' });
    await enqueueTake(l, 3, { awaitsPublish: true });
    const ref = await publishStepUpload(w);
    await l.outbox.adoptPublishedUpload(ID, { ref, durationMs: 4200 });
    l.outbox.endPublishWait(ID);
    await vi.waitFor(() => expect(w.sql.rows.size).toBe(0));
    expect(l.notices).toEqual(Array(3).fill(m.outbox_reel_over_budget()));
    expect(w.uploads).toBe(0);
    expect(w.prepares).toHaveLength(0);
    expect(sends(l)).toBe(0);
  });

  it('A FILE THAT LANDS AFTER THE WITHDRAWAL is written on the `releasing` row and released from it, durably', async () => {
    const w = world();
    // The body has left and the server stored the object; the member cancels before the ref is written.
    const l: ReturnType<typeof life> = life(w, { afterUpload: () => cancelAll(l, 3) });
    await enqueueTake(l, 3);
    await vi.waitFor(() => expect(w.sql.rows.size).toBe(0));
    const [stored] = [...w.server.stored.keys()];
    expect(w.events).toEqual([`release ${stored}`]);
    await vi.waitFor(async () => expect(await w.blobs.list()).toEqual([]));
    expect(sends(l)).toBe(0);
  });

  it('A KILL WHILE RELEASING: the next life reads `releasing` from the row and releases the file, once', async () => {
    const w = world();
    let asked = false;
    const first: ReturnType<typeof life> = life(w, {
      afterUpload: () => cancelAll(first, 3),
      release: () => {
        asked = true;
        first.kill();
        return NEVER();
      },
    });
    await enqueueTake(first, 3);
    await vi.waitFor(() => expect(asked).toBe(true));
    const row = (await takeRow(w))!;
    expect(row.take?.state).toBe('releasing');
    const mediaId = row.media!.uploadedRef!.mediaId;

    const second = life(w);
    await second.outbox.flush();
    await vi.waitFor(() => expect(w.sql.rows.size).toBe(0));
    expect(w.events).toEqual([`release ${mediaId}`, `release ${mediaId}`]);
    expect(sends(second)).toBe(0);
  });

  it("A CANCEL DURING THE PREPARATION'S WRITE: the write lands first (the take's lock), the withdrawal after it - no row comes back", async () => {
    const w = world();
    let l!: ReturnType<typeof life>;
    const execute = w.sql.db.execute;
    let cancel: Promise<void> | null = null;
    w.sql.db.execute = async (q: string, p?: any[]) => {
      if (!cancel && q.includes('UPDATE outbox SET conversation_id') && p?.[0] === ID) {
        // Every send withdrawn while this write is held: the last one's settle then waits for the
        // take's lock, which the preparation's write holds.
        cancel = cancelAll(l, 3);
        await vi.waitFor(() => expect(SEND_IDS.some((id) => w.sql.rows.has(id))).toBe(false));
      }
      return execute(q, p);
    };
    l = life(w);
    await enqueueTake(l, 3);
    await vi.waitFor(() => expect(cancel).not.toBeNull());
    await cancel;
    await vi.waitFor(() => expect(w.sql.rows.size).toBe(0));
    await vi.waitFor(async () => expect(await w.blobs.list()).toEqual([]));
    expect(w.server.stored.size).toBe(0);
    expect(sends(l)).toBe(0);
  });

  it('a withdrawal WHILE THE DRIVE READS THE TAKE never starts its transfer (checked right before the claim)', async () => {
    const w = world();
    const l: ReturnType<typeof life> = life(w, { afterFullRead: () => cancelAll(l, 3) });
    await enqueueTake(l, 3);
    await vi.waitFor(() => expect(w.sql.rows.size).toBe(0));
    await l.outbox.flush();
    expect(w.prepares).toHaveLength(0);
    expect(w.uploads).toBe(0);
    expect(uploadViewOf(VIEW)).toBeUndefined();
  });

  it('TWO SENDS ENDING AT ONCE are marked one after the other: the record names both, nothing released', async () => {
    const w = world();
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const l = life(w, {
      send: async () => {
        if (++arrived === 3) open();
        await gate;
      },
    });
    await enqueueTake(l, 3);
    await expectDeliveredOnce(w, l, 3);
    expect(await sentIds(w)).toEqual(SEND_IDS);
    expect(w.events.some((e) => e.startsWith('release'))).toBe(false);
  });

  it('A KILL BETWEEN THE SENT MARK AND THE ROW DELETE: the next life sends that message again (same id), never loses it, and records the take', async () => {
    const w = world();
    let first!: ReturnType<typeof life>;
    const execute = w.sql.db.execute;
    let killed = false;
    w.sql.db.execute = async (q: string, p?: any[]) => {
      if (!killed && q.includes('DELETE FROM outbox WHERE id') && p?.[0] === SEND_IDS[0]) {
        killed = true;
        first.kill();
        return NEVER();
      }
      return execute(q, p);
    };
    first = life(w);
    await enqueueTake(first, 1);
    await vi.waitFor(() => expect(killed).toBe(true));
    expect(await sentIds(w)).toEqual([SEND_IDS[0]]);
    w.sql.db.execute = execute;

    const second = life(w);
    await second.outbox.flush();
    await vi.waitFor(async () => expect([...w.sql.rows.keys()]).toEqual([ID]));
    expect((await takeRow(w))?.take?.state).toBe('sent');
    expect(w.events.filter((e) => e === 'send g1').length).toBeLessThanOrEqual(2);
    expect(w.events.some((e) => e.startsWith('release'))).toBe(false);
    expect(w.uploads).toBe(1);
  });

  it('A FOLLOWER TAB WRITES NO TAKE ROW: its deletion and its adoption are forwarded, its last cancel leaves the settle to the leader', async () => {
    const w = world();
    const leader = life(w, {
      prepare: (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new UploadAbortedError(signal.reason)))
        ),
    });
    await enqueueTake(leader, 1);
    await vi.waitFor(() => expect(w.prepares).toHaveLength(1));
    tab.role = 'follower';
    const follower = life(w);
    const before = await takeRow(w);

    await follower.outbox.reelSendDeleted(SEND_IDS[0]);
    expect(tabOutboxMock.forwardReelTakeWrite).toHaveBeenCalledWith({
      type: 'outbox_reel_send_deleted',
      messageId: SEND_IDS[0],
    });
    const ref = await publishStepUpload(w);
    await follower.outbox.adoptPublishedUpload(ID, { ref, durationMs: 4200 });
    expect(tabOutboxMock.forwardReelTakeWrite).toHaveBeenCalledWith({
      type: 'outbox_reel_take_adopt',
      takeId: ID,
      uploaded: { ref, durationMs: 4200 },
    });
    expect(await takeRow(w)).toEqual(before);

    // The member's cancel in the follower deletes the send row; the TAKE is the leader's to settle.
    tabOutboxMock.requestLeaderOutboxFlush.mockClear();
    expect(await follower.outbox.cancelPending(SEND_IDS[0])).toBe(true);
    expect(tabOutboxMock.requestLeaderOutboxFlush).toHaveBeenCalled();
    expect((await takeRow(w))?.take?.state).toBeUndefined();

    tab.role = 'leader';
    await leader.outbox.flush();
    await vi.waitFor(() => expect(w.sql.rows.size).toBe(0));
  });

  it('L1: a `releasing` write that FAILS while the transfer runs is owed, written again by the drive, and the late file released in this page life', async () => {
    const w = world();
    const execute = w.sql.db.execute;
    let failNext = false;
    let failed = false;
    w.sql.db.execute = async (q: string, p?: any[]) => {
      if (failNext && q.includes('UPDATE outbox SET conversation_id') && p?.[0] === ID) {
        failNext = false;
        failed = true;
        throw new Error('database is locked');
      }
      return execute(q, p);
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const l: ReturnType<typeof life> = life(w, {
        afterUpload: async () => {
          failNext = true;
          await cancelAll(l, 3);
        },
      });
      await enqueueTake(l, 3);
      await vi.waitFor(() => expect(w.sql.rows.size).toBe(0));
      expect(failed).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('NOT recorded, owed'))).toBe(true);
      const [stored] = [...w.server.stored.keys()];
      expect(w.events).toEqual([`release ${stored}`]);
    } finally {
      warn.mockRestore();
    }
  });

  it('L2: a deletion whose forwarded event no leader took is RE-DERIVED from its tombstone by the next leader, and the last releases the file', async () => {
    const w = world();
    const first = life(w);
    await enqueueTake(first, 1);
    await expectDeliveredOnce(w, first, 1);
    const { media } = await sentReel(w, first);
    first.kill();

    // A follower meets the tombstone and leaves it: only the leader maintains the records (L3).
    tab.role = 'follower';
    const follower = life(w, { tombstones: [SEND_IDS[0]] });
    await follower.outbox.flush();
    expect([...w.sql.rows.keys()]).toEqual([ID]);
    follower.kill();

    tab.role = 'leader';
    await life(w, { tombstones: [SEND_IDS[0]] }).outbox.flush();
    await vi.waitFor(() => expect(w.sql.rows.size).toBe(0));
    expect(w.events.filter((e) => e.startsWith('release'))).toEqual([`release ${media.mediaId}`]);
  });

  it('L3: an expired record is swept by the leader only', async () => {
    const w = world();
    const rows = takeRows(1);
    rows.take.media!.expiresAtMs = 1_000;
    const first = life(w);
    await first.outbox.enqueueTake(rows.take, rows.sends);
    await vi.waitFor(() => expect(sends(first)).toBe(1));
    await vi.waitFor(async () => expect((await takeRow(w))?.take?.state).toBe('sent'));
    first.kill();

    tab.role = 'follower';
    const follower = life(w);
    await follower.outbox.flush();
    expect(w.sql.rows.has(ID)).toBe(true);
    follower.kill();

    tab.role = 'leader';
    await life(w).outbox.flush();
    await vi.waitFor(() => expect(w.sql.rows.size).toBe(0));
    expect(w.events.some((e) => e.startsWith('release'))).toBe(false);
  });

  it("L2: a follower's forwarded adoption the leader never acknowledged is SAID when its publish step ends, with its cost; an acknowledged one is not", async () => {
    tab.role = 'follower';
    const w = world();
    const l = life(w, { prepare: () => NEVER() });
    await enqueueTake(l, 1, { awaitsPublish: true });
    const ref = await publishStepUpload(w);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await l.outbox.adoptPublishedUpload(ID, { ref, durationMs: 4200 });
      l.outbox.endPublishWait(ID);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('NOT taken'))).toHaveLength(1);

      await l.outbox.adoptPublishedUpload(ID, { ref, durationMs: 4200 });
      tab.handlers.at(-1)!({ type: 'outbox_reel_take_adopt_ack', takeId: ID });
      l.outbox.endPublishWait(ID);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('NOT taken'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      l.kill();
    }
  });

  it('L2: the leader acknowledges an adoption a follower forwarded', async () => {
    const w = world();
    const l = life(w, { prepare: () => NEVER() });
    await enqueueTake(l, 1);
    const ref = await publishStepUpload(w);
    tabOutboxMock.acknowledgeReelTakeAdoption.mockClear();
    tab.handlers[0]({
      type: 'outbox_reel_take_adopt',
      takeId: ID,
      uploaded: { ref, durationMs: 4200 },
    });
    await vi.waitFor(() =>
      expect(tabOutboxMock.acknowledgeReelTakeAdoption).toHaveBeenCalledWith(ID)
    );
    l.kill();
  });

  it("THE LEADER DOES A FOLLOWER'S FORWARDED DELETION: the record marks it, and the last releases the file", async () => {
    const w = world();
    const l = life(w);
    await enqueueTake(l, 1);
    await expectDeliveredOnce(w, l, 1);
    const { media } = await sentReel(w, l);
    // The channel delivers it to the leader's handler (the one this life registered).
    tab.handlers[0]({ type: 'outbox_reel_send_deleted', messageId: SEND_IDS[0] });
    await vi.waitFor(() => expect(w.events).toContain(`release ${media.mediaId}`));
    await vi.waitFor(() => expect(w.sql.rows.size).toBe(0));
  });

  it('A TAKE PAST WHAT ONE TAKE MAY CARRY is refused, typed, before anything is written - on either engine', async () => {
    const w = world();
    const l = life(w);
    const rows = buildChatReelTake({
      takeId: ID,
      sentAt: 100,
      senderId: 'u',
      bytes: RAW,
      mimeType: 'video/webm',
      fileName: 'take.webm',
      targets: Array.from({ length: REEL_TAKE_MAX_SENDS + 1 }, (_, i) => ({
        messageId: `bbbbbbbb-2222-4333-8444-${String(i).padStart(12, '0')}`,
        groupId: `g${i}`,
        conversationKey: `g${i}`,
      })),
    });
    await expect(l.outbox.enqueueTake(rows.take, rows.sends)).rejects.toBeInstanceOf(
      ReelTakeTooManySendsError
    );
    expect(w.sql.rows.size).toBe(0);
    expect(REEL_TAKE_MAX_SENDS).toBe(82);
  });

  it('A TAKE WAITING FOR THE ENCODER HOLDS NO UPLOAD SLOT: a ready file uploads and goes meanwhile', async () => {
    const release = await acquireEncoderLease('publish (test)');
    try {
      const w = world();
      const l = life(w, {
        prepare: (signal) =>
          withEncoderLease('take (test)', signal, async () => ({
            bytes: PREPARED,
            mimeType: 'video/mp4',
            fileName: 'reel.mp4',
            width: 720,
            height: 1280,
            durationMs: 4200,
          })),
      });
      // Two RAW takes, as many as there are upload slots, both waiting for the encoder.
      for (const [i, takeId] of [
        'cccccccc-2222-4333-8444-555555555551',
        'cccccccc-2222-4333-8444-555555555552',
      ].entries()) {
        const rows = buildChatReelTake({
          takeId,
          sentAt: 100,
          senderId: 'u',
          bytes: RAW,
          mimeType: 'video/webm',
          fileName: 'take.webm',
          targets: [{ messageId: SEND_IDS[i], groupId: GROUPS[i], conversationKey: GROUPS[i] }],
        });
        rows.take.media!.expiresAtMs = EXPIRES;
        rows.sends[0].entry.media!.expiresAtMs = EXPIRES;
        await l.outbox.enqueueTake(rows.take, rows.sends);
      }
      await vi.waitFor(() => expect(w.prepares).toHaveLength(2));
      // A take whose file is READY (nothing to encode) goes straight to a slot.
      const ready = buildChatReelTake({
        takeId: ID,
        sentAt: 100,
        senderId: 'u',
        bytes: PREPARED,
        mimeType: 'video/mp4',
        fileName: 'reel.mp4',
        targets: [{ messageId: SEND_IDS[2], groupId: 'g3', conversationKey: 'g3' }],
      });
      ready.take.media!.prepare = undefined;
      ready.take.media!.expiresAtMs = EXPIRES;
      ready.sends[0].entry.media!.expiresAtMs = EXPIRES;
      await l.outbox.enqueueTake(ready.take, ready.sends);
      await vi.waitFor(() => expect(l.mls.sendMessage.mock.calls.map((c) => c[0])).toEqual(['g3']));
      l.kill();
    } finally {
      release();
    }
  });
});
