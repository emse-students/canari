/**
 * THE BACKGROUND PUBLISH QUEUE, driven over fakes (no clock: a wait ends only when the test wakes it).
 *
 * What is pinned, each because its opposite is the plausible mistake:
 *  - media go ONE AT A TIME, in the post's order, and the post is created once, under the id minted
 *    at the press, with the refs in that order;
 *  - every step's result is durable before the next: after a cut, nothing prepared is prepared again,
 *    nothing uploaded is uploaded again, and the media in progress resumes from its recorded session;
 *  - a create whose answer was lost is sent again under the SAME id (the server's idempotence key);
 *  - an ANSWER that refuses stops the post with its sentence, kept until the member's Retry;
 *  - the app back on screen restarts the transfer at once; a deleted post stops, gives its session
 *    back, and is never created;
 *  - a new queue over the same store (a reload, a kill) picks the post up where it was;
 *  - nothing is ever sent while the session is another account's, and a sign-out between two steps
 *    sends nothing more;
 *  - a Delete takes the post back EVERYWHERE: the uploaded blobs no post will cite, the server's
 *    post when a create may have landed - and a Delete during the create wins over it;
 *  - a Pause keeps the post and stops it; another tab sees the rows from the store.
 */
import { describe, expect, it } from 'vitest';
import {
  PUBLISH_RETRY_LADDER_MS,
  PublishAccountMismatchError,
  PublishQueue,
  classifyPublishFailure,
  retryCannotCure,
  type ChatTakeAdoption,
  type PublishUploadArgs,
  type PublishView,
} from './publishQueue';
import { MediaUploadError } from '$lib/utils/mediaErrors';
import { TokenAccountChangedError } from '$lib/utils/renewOn401';
import {
  markedPost,
  runnerWrite,
  type MemberMarks,
  type QueuedFile,
  type QueuedPost,
  type QueuedTakePreparation,
} from './publishQueueStore';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { UploadAbortedError } from '$lib/utils/uploadXhr';
import type { MediaRef } from '$lib/media';
import { REEL_MEDIA_EXPIRED } from '$lib/reels/reelMediaExpired';
import { VideoPrepareError } from '$lib/video/prepareVideoForUpload';

/** An in-memory stand-in for `PublishQueueStore`, cloning like IndexedDB does. */
function memoryStore() {
  const posts = new Map<string, QueuedPost>();
  const files = new Map<string, QueuedFile>();
  return {
    posts,
    files,
    async list() {
      return [...posts.values()]
        .map((p) => structuredClone(p))
        .sort((a, b) => a.queuedAt - b.queuedAt);
    },
    async get(id: string) {
      const p = posts.get(id);
      return p ? structuredClone(p) : null;
    },
    async readFile(id: string, i: number) {
      const f = files.get(`${id}/${i}`);
      if (!f) throw new Error('missing');
      return f;
    },
    /** The store's own merge (`runnerWrite`): a runner's copy never erases the member's marks. */
    async update(post: QueuedPost, bytes?: { index: number; file: QueuedFile }) {
      const stored = posts.get(post.id);
      if (!stored) return false;
      posts.set(post.id, structuredClone(runnerWrite(stored, post)));
      if (bytes) files.set(`${post.id}/${bytes.index}`, bytes.file);
      return true;
    },
    async mark(id: string, marks: MemberMarks) {
      const stored = posts.get(id);
      if (!stored) return null;
      const next = markedPost(stored, marks);
      posts.set(id, next);
      return structuredClone(next);
    },
    async remove(id: string) {
      posts.delete(id);
      for (const k of files.keys()) if (k.startsWith(`${id}/`)) files.delete(k);
    },
  };
}

function queuePost(store: ReturnType<typeof memoryStore>, id: string, n: number, queuedAt = 1) {
  store.posts.set(id, {
    id,
    queuedAt,
    payload: { markdown: `post ${id}` },
    media: Array.from({ length: n }, (_, i) => ({
      name: `p${i}.jpg`,
      type: 'image/jpeg',
      size: 100 + i,
      ...(i === 0 ? { caption: 'first' } : {}),
    })),
    landing: 'all',
  });
  for (let i = 0; i < n; i++) {
    store.files.set(`${id}/${i}`, {
      bytes: new Uint8Array([i, i, i]).buffer,
      name: `p${i}.jpg`,
      type: 'image/jpeg',
    });
  }
}

interface Rig {
  store: ReturnType<typeof memoryStore>;
  queue: PublishQueue;
  calls: string[];
  uploads: PublishUploadArgs[];
  created: Array<{ id: string; media: MediaRef[] }>;
  released: string[];
  published: string[];
  /** Per-call behaviour of the upload: return a ref, or throw. */
  uploadPlan: Array<(a: PublishUploadArgs) => Promise<MediaRef>>;
  createPlan: Array<() => Promise<unknown>>;
  /** Each withdrawal the server was asked, with the media ids it named. */
  withdrawals: Array<{ id: string; mediaIds: string[] }>;
  withdrawn: string[];
  /** What the next withdrawals do instead of answering: throw, per call. */
  withdrawPlan: Array<() => Promise<void>>;
  /** What `/api/version` says about the queue's routes. */
  serverReady: boolean | null;
  /** Every `onViews` call's `fromRunner`. */
  viewSources: boolean[];
  /** What the server's withdrawal answers: whether a post was there. */
  withdrawLanded: boolean;
  /** The account the session would carry the next request as. */
  sessionUser: string;
  /** Every create payload, whole: what the server was told the post IS. */
  payloads: Array<Record<string, unknown>>;
  /** The served reel rule (`null`: an estate older than it). */
  rule: { maxDurationMs: number; maxAspectRatio: number } | null;
  /** What preparing a video yields: its frame and length. */
  video: { width: number; height: number; durationMs: number };
  /** Called at every account check, before the check - a test's hook between two steps. */
  onCheckpoint: (() => void) | null;
  views: PublishView[];
  /** The `take` each prepare was handed (`undefined`: an ordinary post media). */
  takes: Array<QueuedTakePreparation | undefined>;
  /** Every adoption the chat take was handed: the take, the file, the declared length. */
  adopted: Array<{ takeId: string; mediaId: string; durationMs: number }>;
  /** Every end of the chat take's wait, in order. */
  waitEnded: string[];
  /** What the next adoptions do instead of succeeding: throw, per call. */
  adoptPlan: Array<() => Promise<void>>;
  /** What an adoption that does not throw answers. */
  adoptAnswer: ChatTakeAdoption;
  /** Per-call behaviour of the preparation: throw instead of preparing. */
  preparePlan: Array<() => Promise<void>>;
  /** Whether the app is in view (`isAppInView`). */
  inView: boolean;
  /** How many times a pass ended (`passEnded`). */
  passesEnded: number;
  /** Every line the queue logged. */
  logs: string[];
}

function rig(store = memoryStore()): Rig {
  const r = {
    store,
    calls: [] as string[],
    uploads: [] as PublishUploadArgs[],
    created: [] as Array<{ id: string; media: MediaRef[] }>,
    released: [] as string[],
    published: [] as string[],
    uploadPlan: [] as Rig['uploadPlan'],
    createPlan: [] as Rig['createPlan'],
    withdrawals: [] as Rig['withdrawals'],
    withdrawn: [] as string[],
    withdrawPlan: [] as Rig['withdrawPlan'],
    serverReady: true,
    viewSources: [] as boolean[],
    withdrawLanded: false,
    sessionUser: 'alice',
    payloads: [] as Array<Record<string, unknown>>,
    rule: { maxDurationMs: 90_000, maxAspectRatio: 0.8 },
    video: { width: 720, height: 1280, durationMs: 41_250 },
    onCheckpoint: null,
    views: [] as PublishView[],
    takes: [] as Rig['takes'],
    adopted: [] as Rig['adopted'],
    waitEnded: [] as string[],
    adoptPlan: [] as Rig['adoptPlan'],
    adoptAnswer: 'adopted',
    preparePlan: [] as Rig['preparePlan'],
    inView: true,
    passesEnded: 0,
    logs: [] as string[],
  } as Rig;
  let n = 0;
  r.queue = new PublishQueue({
    store,
    prepare: async (file, _onProgress, _signal, take) => {
      r.calls.push(`prepare:${file.name}`);
      r.takes.push(take);
      const step = r.preparePlan.shift();
      if (step) await step();
      if (file.type.startsWith('video/')) {
        return {
          file: new File([await file.arrayBuffer()], file.name.replace(/\.\w+$/, '.mp4'), {
            type: 'video/mp4',
          }),
          dims: { width: r.video.width, height: r.video.height },
          durationMs: r.video.durationMs,
          placeholder: 'AAAA',
        };
      }
      return {
        file: new File(
          [await file.arrayBuffer(), new Uint8Array([9])],
          file.name.replace('.jpg', '.webp'),
          {
            type: 'image/webp',
          }
        ),
        dims: { width: 40, height: 30 },
      };
    },
    reelRule: async () => r.rule,
    encodingFor: () => 'single-block',
    upload: async (a) => {
      r.uploads.push(a);
      r.calls.push(`upload:${a.fileName}`);
      const step = r.uploadPlan.shift();
      if (step) return step(a);
      await a.persist({
        keyHex: 'k',
        ivHex: 'i',
        plaintextSha256: 's',
        plaintextBytes: a.bytes.length,
        uploadId: `u-${a.fileName}`,
      });
      return {
        type: 'image',
        mediaId: `m-${a.fileName}-${++n}`,
        key: 'k',
        iv: 'i',
        mimeType: a.mimeType,
        size: a.bytes.length,
      };
    },
    release: async (id) => {
      r.released.push(id);
    },
    adoptChatTake: async (takeId, uploaded) => {
      r.calls.push(`adopt:${takeId}`);
      const step = r.adoptPlan.shift();
      if (step) await step();
      r.adopted.push({ takeId, mediaId: uploaded.ref.mediaId, durationMs: uploaded.durationMs });
      return r.adoptAnswer;
    },
    endChatTakeWait: (takeId) => {
      r.calls.push(`end-wait:${takeId}`);
      r.waitEnded.push(takeId);
    },
    withdrawPost: async (id, mediaIds) => {
      r.calls.push(`withdraw:${id}`);
      r.withdrawals.push({ id, mediaIds });
      const step = r.withdrawPlan.shift();
      if (step) await step();
      r.withdrawn.push(id);
      return { deleted: r.withdrawLanded };
    },
    serverReady: () => r.serverReady,
    assertAccount: async () => {
      r.onCheckpoint?.();
      if (r.sessionUser !== 'alice') throw new PublishAccountMismatchError('alice');
    },
    sessionEnded: (e) => e instanceof Error && e.name === 'SessionExpiredError',
    createPost: async (p) => {
      r.calls.push(`create:${p.id}`);
      const step = r.createPlan.shift();
      if (step) await step();
      r.created.push({ id: p.id, media: p.media! });
      r.payloads.push({ ...p });
    },
    assertNotMuted: async () => undefined,
    inView: () => r.inView,
    failureMessage: (e) => `refused: ${(e as Error).message}`,
    lock: (fn) => fn(),
    // NO CLOCK: a wait ends only when the queue is woken.
    sleep: (_ms, signal) =>
      new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    onViews: (v, fromRunner) => {
      r.views = v;
      r.viewSources.push(fromRunner);
    },
    onPublished: (p) => r.published.push(p.id),
    passEnded: () => {
      r.passesEnded += 1;
    },
    log: (line) => r.logs.push(line),
  });
  return r;
}

/** Lets every pending microtask and macrotask of the queue run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PublishQueue', () => {
  it('sends the media one at a time, in order, then creates the post ONCE under its own id', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 3);
    await r.queue.drain();
    expect(r.calls).toEqual([
      'prepare:p0.jpg',
      'upload:p0.webp',
      'prepare:p1.jpg',
      'upload:p1.webp',
      'prepare:p2.jpg',
      'upload:p2.webp',
      'create:post-1',
    ]);
    expect(r.created).toHaveLength(1);
    expect(r.created[0].media.map((m) => m.mediaId)).toEqual([
      'm-p0.webp-1',
      'm-p1.webp-2',
      'm-p2.webp-3',
    ]);
    expect(r.created[0].media[0]).toMatchObject({ caption: 'first' });
    expect(r.store.posts.size).toBe(0);
    expect(r.store.files.size).toBe(0);
    expect(r.published).toEqual(['post-1']);
  });

  it('a cut on media 2 waits, then resumes it from its session: nothing prepared or uploaded twice', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 3);
    r.uploadPlan.push(
      async (a) => {
        await a.persist({
          keyHex: 'k',
          ivHex: 'i',
          plaintextSha256: 's',
          plaintextBytes: 4,
          uploadId: 'u0',
        });
        return { type: 'image', mediaId: 'm0', key: 'k', iv: 'i', mimeType: a.mimeType, size: 4 };
      },
      async (a) => {
        await a.persist({
          keyHex: 'k1',
          ivHex: 'i1',
          plaintextSha256: 's1',
          plaintextBytes: 4,
          uploadId: 'u1',
        });
        throw new TransportFailureError('link cut');
      }
    );
    const running = r.queue.drain();
    await settle();
    // Waiting: the post is still queued, media 1 recorded as sent, media 2's session recorded.
    const held = r.store.posts.get('post-1')!;
    expect(held.media[0].ref?.mediaId).toBe('m0');
    expect(held.media[1].upload?.uploadId).toBe('u1');
    expect(held.media[1].prepared).toBeDefined();
    expect(r.created).toHaveLength(0);

    r.queue.wake('test: the link is back');
    await running;
    expect(r.calls.filter((c) => c === 'prepare:p1.jpg')).toHaveLength(1);
    expect(r.calls.filter((c) => c.startsWith('upload:p0'))).toHaveLength(1);
    // The resumed attempt of media 2 was handed the session the cut one recorded.
    expect(r.uploads[2].state?.uploadId).toBe('u1');
    expect(r.created).toHaveLength(1);
  });

  it('a create whose answer was lost is sent again under the SAME id', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 1);
    r.createPlan.push(async () => {
      throw new TransportFailureError('answer lost');
    });
    const running = r.queue.drain();
    await settle();
    r.queue.wake('test');
    await running;
    expect(r.calls.filter((c) => c.startsWith('create:'))).toEqual([
      'create:post-1',
      'create:post-1',
    ]);
    expect(r.calls.filter((c) => c.startsWith('upload:'))).toHaveLength(1);
    expect(r.created).toHaveLength(1);
  });

  it('a server that keeps answering 503 is asked over the ladder ONCE, then the post stops with its Retry', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 0);
    for (let i = 0; i < 20; i++) {
      r.createPlan.push(async () => {
        throw new ApiRefusalError(503, null, 'busy');
      });
    }
    let finished = false;
    const running = r.queue.drain().then(() => (finished = true));
    // Each wake ends one wait; a wake with no wait pending is a no-op, so wake until the pass ends.
    for (let i = 0; i < 100 && !finished; i++) {
      await settle();
      r.queue.wake('test');
    }
    await running;
    expect(r.calls.filter((c) => c.startsWith('create:'))).toHaveLength(
      PUBLISH_RETRY_LADDER_MS.length + 1
    );
    expect(r.store.posts.get('post-1')!.failure).toEqual({
      stage: 'createPost',
      message: 'refused: busy',
    });
  });

  it('a refusal stops the post with its sentence, kept until Retry; the next post is not held behind it', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 1, 1);
    queuePost(r.store, 'post-2', 0, 2);
    r.createPlan.push(async () => {
      throw new ApiRefusalError(400, null, 'bad poll');
    });
    await r.queue.drain();
    expect(r.store.posts.get('post-1')!.failure).toEqual({
      stage: 'createPost',
      message: 'refused: bad poll',
    });
    expect(r.published).toEqual(['post-2']);

    await r.queue.retry('post-1');
    expect(r.published).toEqual(['post-2', 'post-1']);
    // The retry did not upload the media again: its ref was durable.
    expect(r.calls.filter((c) => c.startsWith('upload:'))).toHaveLength(1);
  });

  it('a refusal a Retry cannot cure (an institution post with no reach) is FINAL: Delete alone, no endless Retry', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 0, 1);
    r.createPlan.push(async () => {
      throw new ApiRefusalError(400, 'institution_reach_required', 'no reach');
    });
    await r.queue.drain();
    expect(r.store.posts.get('post-1')!.failure).toEqual({
      stage: 'createPost',
      message: 'refused: no reach',
      final: true,
    });
    expect(r.views.find((v) => v.id === 'post-1')).toMatchObject({
      phase: 'failed',
      final: true,
    });
    // A Retry pressed anyway (another tab, an old banner) sends nothing and keeps the failure.
    await r.queue.retry('post-1');
    expect(r.published).toEqual([]);
    expect(r.store.posts.get('post-1')!.failure?.final).toBe(true);
    // An ordinary refusal stays curable.
    expect(retryCannotCure(new ApiRefusalError(400, null, 'bad poll'))).toBe(false);
    expect(retryCannotCure(new ApiRefusalError(503, 'institution_reach_required', 'x'))).toBe(
      false
    );
  });

  it('back on screen after a suspension: the transfer in flight is aborted and restarted at once', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 1);
    let started!: () => void;
    const onWire = new Promise<void>((resolve) => (started = resolve));
    r.uploadPlan.push(
      (a) =>
        new Promise((_, reject) => {
          started();
          a.transport.signal!.addEventListener('abort', () =>
            reject(new UploadAbortedError('test'))
          );
        })
    );
    const running = r.queue.drain();
    await onWire;
    r.queue.resumeAfterSuspension();
    await running;
    expect(r.calls.filter((c) => c.startsWith('upload:'))).toHaveLength(2);
    expect(r.created).toHaveLength(1);
  });

  it('a post deleted during its upload stops, gives its session back, and is never created', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 1);
    let started!: () => void;
    const onWire = new Promise<void>((resolve) => (started = resolve));
    r.uploadPlan.push(
      (a) =>
        new Promise((_, reject) => {
          void a
            .persist({
              keyHex: 'k',
              ivHex: 'i',
              plaintextSha256: 's',
              plaintextBytes: 4,
              uploadId: 'u-del',
            })
            .then(started);
          a.transport.signal!.addEventListener('abort', () =>
            reject(new UploadAbortedError('test'))
          );
        })
    );
    const running = r.queue.drain();
    await onWire;
    await r.queue.remove('post-1');
    await running;
    expect(r.store.posts.size).toBe(0);
    expect(r.store.files.size).toBe(0);
    expect(r.released).toEqual(['u-del']);
    expect(r.created).toHaveLength(0);
  });

  it('a NEW queue over the same store (a reload, a kill) resumes the post where it was', async () => {
    const store = memoryStore();
    queuePost(store, 'post-1', 2);
    const first = rig(store);
    first.uploadPlan.push(async (a) => {
      await a.persist({
        keyHex: 'k',
        ivHex: 'i',
        plaintextSha256: 's',
        plaintextBytes: 4,
        uploadId: 'u0',
      });
      throw new TransportFailureError('killed');
    });
    void first.queue.drain();
    await settle();
    first.queue.stop();

    const second = rig(store);
    await second.queue.drain();
    expect(second.calls[0]).toBe('upload:p0.webp'); // prepared before the kill: not prepared again
    expect(second.uploads[0].state?.uploadId).toBe('u0');
    expect(second.created).toHaveLength(1);
  });
});

describe('classifyPublishFailure', () => {
  it('waits out what is no answer, and stops on what is one', () => {
    expect(classifyPublishFailure(new TransportFailureError('x'))).toBe('wait');
    expect(classifyPublishFailure(new ApiRefusalError(503, null, 'x'))).toBe('busy');
    // A refusal that answers about the post - a deleted id is one.
    expect(classifyPublishFailure(new ApiRefusalError(410, null, 'x'))).toBe('failed');
    expect(classifyPublishFailure(new ApiRefusalError(429, null, 'x'))).toBe('busy');
    expect(classifyPublishFailure(new ApiRefusalError(400, null, 'x'))).toBe('failed');
    expect(classifyPublishFailure(new ApiRefusalError(403, null, 'x'))).toBe('failed');
    expect(classifyPublishFailure(new Error('local'))).toBe('failed');
  });
});

describe('classifyPublishFailure - who answered decides', () => {
  it('an EDGE page with no cause is no answer: waited out', () => {
    expect(classifyPublishFailure(new MediaUploadError(502, 'x', 'edge'))).toBe('wait');
  });

  it("the app's own 5xx and a lost session are a counted 'not now', never an endless wait", () => {
    expect(classifyPublishFailure(new MediaUploadError(503, 'x', 'gateway'))).toBe('busy');
    expect(classifyPublishFailure(new MediaUploadError(404, 'x', 'gateway', true))).toBe('busy');
    expect(classifyPublishFailure(new MediaUploadError(429, 'x', 'gateway'))).toBe('busy');
  });

  it('a 401, a session that ended, or a token of another account halt the pass', () => {
    expect(classifyPublishFailure(new MediaUploadError(401, 'x', 'gateway'))).toBe('halt');
    expect(classifyPublishFailure(new ApiRefusalError(401, null, 'x'))).toBe('halt');
    expect(classifyPublishFailure(new TokenAccountChangedError('x'))).toBe('halt');
    expect(classifyPublishFailure(new PublishAccountMismatchError('alice'))).toBe('halt');
    const ended = Object.assign(new Error('x'), { name: 'SessionExpiredError' });
    expect(classifyPublishFailure(ended, (e) => e === ended)).toBe('halt');
  });
});

describe('PublishQueue - one account, and only while it is signed in', () => {
  it('sends NOTHING while the session is another account, and goes on once it is its own again', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 2);
    // Another tab signs in as bob after the first media is up.
    r.uploadPlan.push(async (a) => {
      r.sessionUser = 'bob';
      return {
        type: 'image',
        mediaId: `m-${a.fileName}`,
        key: 'k',
        iv: 'i',
        mimeType: a.mimeType,
        size: 1,
      };
    });
    await r.queue.drain();
    expect(r.calls.filter((c) => c.startsWith('upload:'))).toHaveLength(1);
    expect(r.created).toHaveLength(0);
    // Halted, not failed: no sentence, the post waits for its own account.
    expect(r.store.posts.get('post-1')!.failure).toBeUndefined();

    r.sessionUser = 'alice';
    await r.queue.drain();
    expect(r.calls.filter((c) => c.startsWith('upload:'))).toHaveLength(2);
    expect(r.created.map((c) => c.id)).toEqual(['post-1']);
  });

  it('a sign-out between the last media and the create sends no create', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 1);
    let checks = 0;
    // moderation, mediaPrepare, mediaUpload, then the create's own check: sign out there.
    r.onCheckpoint = () => {
      checks += 1;
      if (checks === 4) r.queue.stop();
    };
    await r.queue.drain();
    expect(r.calls.filter((c) => c.startsWith('upload:'))).toHaveLength(1);
    expect(r.created).toHaveLength(0);
    expect(r.store.posts.has('post-1')).toBe(true);
  });
});

describe('PublishQueue - Delete takes the post back everywhere', () => {
  it('a post whose media went up but whose create never left: ONE withdrawal names its media', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 2);
    // The session changes before the create's own check: the create never leaves.
    r.onCheckpoint = () => {
      if (r.calls.filter((c) => c.startsWith('upload:')).length === 2) r.sessionUser = 'bob';
    };
    await r.queue.drain();
    expect(r.created).toHaveLength(0);
    expect(r.store.posts.get('post-1')!.createSent).toBeUndefined();

    r.onCheckpoint = null;
    r.sessionUser = 'alice';
    await r.queue.remove('post-1');
    await r.queue.drain();
    expect(r.withdrawals).toEqual([{ id: 'post-1', mediaIds: ['m-p0.webp-1', 'm-p1.webp-2'] }]);
    expect(r.store.posts.size).toBe(0);
    expect(r.store.files.size).toBe(0);
  });

  it('a post whose create may have landed: withdrawn on the server, with its media', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 1);
    r.createPlan.push(async () => {
      throw new TransportFailureError('answer lost');
    });
    const running = r.queue.drain();
    await settle();
    expect(r.store.posts.get('post-1')!.createSent).toBe(true);
    r.withdrawLanded = true;
    await r.queue.remove('post-1');
    await running;
    expect(r.withdrawals).toEqual([{ id: 'post-1', mediaIds: ['m-p0.webp-1'] }]);
    expect(r.store.posts.size).toBe(0);
  });

  it('a REFUSED withdrawal stops the post: one request per Retry, never a hot loop', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 0);
    await r.queue.remove('post-1');
    r.withdrawPlan.push(async () => {
      throw new ApiRefusalError(403, null, 'refused');
    });
    await r.queue.drain();
    await r.queue.drain();
    expect(r.withdrawals).toHaveLength(1);
    expect(r.views.map((v) => v.phase)).toEqual(['failed']);
    expect(r.store.posts.get('post-1')!.withdrawn).toBe(true);
    // The member's Retry asks once more - and this time it goes through.
    await r.queue.retry('post-1');
    expect(r.withdrawals).toHaveLength(2);
    expect(r.store.posts.size).toBe(0);
  });

  it('a withdrawal the server keeps answering "not now" is asked a bounded number of times', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 0);
    await r.queue.remove('post-1');
    for (let i = 0; i < 20; i++) {
      r.withdrawPlan.push(async () => {
        throw new ApiRefusalError(503, null, 'busy');
      });
    }
    const running = r.queue.drain();
    for (let i = 0; i < 20; i++) {
      await settle();
      r.queue.wake('test');
    }
    await running;
    expect(r.withdrawals).toHaveLength(PUBLISH_RETRY_LADDER_MS.length + 1);
    expect(r.views.map((v) => v.phase)).toEqual(['failed']);
  });

  it('a Delete pressed while the create is on the wire wins: no "published", the post is taken down', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 0);
    r.createPlan.push(async () => {
      await r.queue.remove('post-1');
    });
    r.withdrawLanded = true;
    await r.queue.drain();
    expect(r.created.map((c) => c.id)).toEqual(['post-1']);
    expect(r.published).toEqual([]);
    expect(r.withdrawn).toEqual(['post-1']);
    expect(r.store.posts.size).toBe(0);
  });
});

describe("PublishQueue - the member's marks survive every runner write", () => {
  it("a Delete from another tab during an upload's persist is NOT erased: the post is never created", async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 1);
    r.uploadPlan.push(async (a) => {
      // Another tab's Delete lands in the store - no nudge reaches this runner - then the transfer
      // persists its session from the runner's stale copy.
      await r.store.mark('post-1', { withdrawn: true, clearFailure: true });
      await a.persist({
        keyHex: 'k',
        ivHex: 'i',
        plaintextSha256: 's',
        plaintextBytes: 1,
        uploadId: 'u-1',
      });
      return { type: 'image', mediaId: 'm-1', key: 'k', iv: 'i', mimeType: a.mimeType, size: 1 };
    });
    await r.queue.drain();
    expect(r.created).toEqual([]);
    expect(r.published).toEqual([]);
    expect(r.withdrawals).toEqual([{ id: 'post-1', mediaIds: ['m-1'] }]);
    expect(r.store.posts.size).toBe(0);
  });

  it('a Pause from another tab during an upload is kept, and the post waits for "Reprendre"', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 2);
    r.uploadPlan.push(async (a) => {
      await r.store.mark('post-1', { paused: true });
      return { type: 'image', mediaId: 'm-1', key: 'k', iv: 'i', mimeType: a.mimeType, size: 1 };
    });
    await r.queue.drain();
    expect(r.calls.filter((c) => c.startsWith('upload:'))).toHaveLength(1);
    expect(r.created).toEqual([]);
    expect(r.store.posts.get('post-1')!.paused).toBe(true);
  });

  it('a Pause pressed while the create is on the wire cannot unpublish it: published, no paused row', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 0);
    r.createPlan.push(async () => {
      await r.queue.pause('post-1');
    });
    await r.queue.drain();
    expect(r.published).toEqual(['post-1']);
    expect(r.store.posts.size).toBe(0);
    expect(r.views).toEqual([]);
  });
});

describe('PublishQueue - an estate that cannot take it', () => {
  it('sends nothing to an estate not known to serve it, ENDS the pass (no ladder), and goes on when it is', async () => {
    const r = rig();
    r.serverReady = null;
    queuePost(r.store, 'post-1', 1);
    // The pass ends by itself: no wait, so no wake is needed for it to resolve.
    await r.queue.drain();
    expect(r.calls).toEqual([]);
    expect(r.views.map((v) => v.phase)).toEqual(['waiting']);
    // What `/api/version`'s answer does in the wiring: the next pass.
    r.serverReady = true;
    await r.queue.drain();
    expect(r.published).toEqual(['post-1']);
  });

  it('a refusal of the send that lands as the member deletes the post does not stop the Delete', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 0);
    r.createPlan.push(async () => {
      await r.store.mark('post-1', { withdrawn: true, clearFailure: true });
      throw new ApiRefusalError(422, null, 'refused');
    });
    await r.queue.drain();
    expect(r.withdrawn).toEqual(['post-1']);
    expect(r.store.posts.size).toBe(0);
  });

  it('an EDGE page from the post API is no answer: waited out, never counted', () => {
    expect(classifyPublishFailure(new ApiRefusalError(502, null, 'x', { origin: 'edge' }))).toBe(
      'wait'
    );
    expect(classifyPublishFailure(new ApiRefusalError(502, null, 'x'))).toBe('busy');
  });
});

describe('PublishQueue - Pause, and the rows of another tab', () => {
  it('a paused post is kept and skipped; "Reprendre" sends it', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 1);
    await r.queue.pause('post-1');
    await r.queue.drain();
    expect(r.calls).toEqual([]);
    expect(r.views.map((v) => v.phase)).toEqual(['paused']);
    await r.queue.retry('post-1');
    expect(r.published).toEqual(['post-1']);
  });

  it('a Pause during the upload stops the transfer and keeps the post', async () => {
    const r = rig();
    queuePost(r.store, 'post-1', 1);
    r.uploadPlan.push(
      (a) =>
        new Promise((_, reject) => {
          a.transport.signal!.addEventListener('abort', () =>
            reject(new UploadAbortedError('test'))
          );
          void r.queue.pause('post-1');
        })
    );
    await r.queue.drain();
    expect(r.created).toHaveLength(0);
    expect(r.store.posts.get('post-1')!.paused).toBe(true);
  });

  it('a tab that is not the runner draws every row from the store', async () => {
    const store = memoryStore();
    queuePost(store, 'post-1', 1, 1);
    queuePost(store, 'post-2', 2, 2);
    store.posts.get('post-2')!.failure = { stage: 'createPost', message: 'refused' };
    const other = rig(store);
    await other.queue.refreshViews();
    expect(other.views.map((v) => [v.id, v.phase])).toEqual([
      ['post-1', 'queued'],
      ['post-2', 'failed'],
    ]);
    expect(other.calls).toEqual([]);
    // Rows read from the store are never handed to the other tabs: they carry no progress.
    expect(other.viewSources.every((fromRunner) => !fromRunner)).toBe(true);
  });
});

/** One post holding the files named, each `name:type`, with `payload` added to its own. */
function queueFiles(
  store: ReturnType<typeof memoryStore>,
  id: string,
  files: Array<[string, string]>,
  payload: Record<string, unknown> = {}
) {
  store.posts.set(id, {
    id,
    queuedAt: 1,
    payload: { markdown: '', ...payload },
    media: files.map(([name, type]) => ({ name, type, size: 3 })),
    landing: 'all',
  });
  files.forEach(([name, type], i) =>
    store.files.set(`${id}/${i}`, { bytes: new Uint8Array([1, 2, 3]).buffer, name, type })
  );
}

describe('PublishQueue - every vertical video of 90 s or less is a CanaReel (owner, 2026-11-09)', () => {
  it('publishes ONE vertical video within the cap as a reel, with its prepared length', async () => {
    const r = rig();
    queueFiles(r.store, 'v-1', [['IMG_1.mov', 'video/quicktime']]);
    await r.queue.drain();
    expect(r.payloads).toHaveLength(1);
    expect(r.payloads[0]).toMatchObject({ kind: 'reel', durationMs: 41_250, id: 'v-1' });
  });

  /** A reader's feed draws the first frame before a byte arrives (owner, 2026-11-10). */
  it("a video's first-frame placeholder travels with its media ref into the post", async () => {
    const r = rig();
    queueFiles(r.store, 'v-2', [['IMG_2.mov', 'video/quicktime']]);
    await r.queue.drain();
    const media = r.payloads[0].media as Array<{ placeholder?: string }>;
    expect(media[0].placeholder).toBe('AAAA');
  });

  it('reads the 4:5 boundary and the 90 s cap as the server does', async () => {
    const at = async (video: Rig['video']) => {
      const r = rig();
      r.video = video;
      queueFiles(r.store, 'v', [['v.mp4', 'video/mp4']]);
      await r.queue.drain();
      return r.payloads[0].kind;
    };
    expect(await at({ width: 1080, height: 1350, durationMs: 90_000 })).toBe('reel');
    expect(await at({ width: 1081, height: 1350, durationMs: 30_000 })).toBeUndefined();
    // The half-second grace is the camera's too (`reelDeclaredDurationMs`): 90.5 s is the cap, 90.501 s is not.
    expect(await at({ width: 720, height: 1280, durationMs: 90_500 })).toBe('reel');
    expect(await at({ width: 720, height: 1280, durationMs: 90_501 })).toBeUndefined();
  });

  it.each([
    ['landscape', { width: 1280, height: 720, durationMs: 20_000 }],
    ['square', { width: 1080, height: 1080, durationMs: 20_000 }],
  ])('keeps a %s video an ordinary post', async (_label, video) => {
    const r = rig();
    r.video = video;
    queueFiles(r.store, 'v-2', [['clip.mp4', 'video/mp4']]);
    await r.queue.drain();
    expect(r.payloads[0].kind).toBeUndefined();
    expect(r.payloads[0].durationMs).toBeUndefined();
  });

  it.each([
    ['a poll', { polls: [{ question: 'q', options: [] }] }],
    ['an attached form', { attachedFormId: 'f-1' }],
    ['a linked event', { linkedCalendarEventId: 'e-1' }],
    ['a schedule', { scheduledAt: '2030-01-01T00:00:00Z' }],
  ])('keeps a vertical video carrying %s a post: a reel carries none', async (_label, payload) => {
    const r = rig();
    queueFiles(r.store, 'v-3', [['v.mp4', 'video/mp4']], payload);
    await r.queue.drain();
    expect(r.payloads[0].kind).toBeUndefined();
  });

  it('keeps a vertical video beside a photo a post: a reel is one video', async () => {
    const r = rig();
    queueFiles(r.store, 'v-4', [
      ['v.mp4', 'video/mp4'],
      ['p.jpg', 'image/jpeg'],
    ]);
    await r.queue.drain();
    expect(r.payloads[0].kind).toBeUndefined();
  });

  it('against an estate that serves no rule, a vertical video stays a post, as it was there', async () => {
    const r = rig();
    r.rule = null;
    queueFiles(r.store, 'v-5', [['v.mp4', 'video/mp4']]);
    await r.queue.drain();
    expect(r.payloads[0].kind).toBeUndefined();
  });
});

/** A take of the CanaReels camera, queued as `queueReelPublish` queues it. */
function queueTake(
  store: ReturnType<typeof memoryStore>,
  id: string,
  opts: { chatTakeId?: string; removeAudio?: true } = {}
) {
  store.posts.set(id, {
    id,
    queuedAt: 1,
    payload: { markdown: 'caption' },
    media: [
      {
        name: 'canareel.mp4',
        type: 'video/mp4',
        size: 3,
        take: { maxDurationMs: 90_000, ...(opts.removeAudio ? { removeAudio: true } : {}) },
      },
    ],
    landing: 'all',
    ...(opts.chatTakeId ? { chatTakeId: opts.chatTakeId } : {}),
  });
  store.files.set(`${id}/0`, {
    bytes: new Uint8Array([1, 2, 3]).buffer,
    name: 'canareel.mp4',
    type: 'video/mp4',
  });
}

describe('PublishQueue - a CanaReels camera take (2026-11-24: the publish survives leaving the app)', () => {
  it('prepares the take as the camera does - its cap and its removed sound - and creates ONE reel', async () => {
    const r = rig();
    queueTake(r.store, 'reel-1', { removeAudio: true });
    await r.queue.drain();
    expect(r.takes).toEqual([{ maxDurationMs: 90_000, removeAudio: true }]);
    expect(r.uploads[0].retentionClass).toBe('archive');
    expect(r.payloads).toHaveLength(1);
    expect(r.payloads[0]).toMatchObject({ id: 'reel-1', kind: 'reel', durationMs: 41_250 });
  });

  it.each([
    ['its first step', 'prepare'],
    ['the upload', 'upload'],
    ['the create', 'create'],
  ])(
    'an app stopped during %s (no answer) resumes on its return: ONE prepare, ONE upload, ONE post',
    async (_label, step) => {
      const r = rig();
      queueTake(r.store, 'reel-2');
      const cut = async () => {
        throw new TransportFailureError(new TypeError('Failed to fetch'));
      };
      if (step === 'upload') r.uploadPlan.push(cut);
      if (step === 'create') r.createPlan.push(cut);
      if (step === 'prepare') {
        // The page frozen mid-encode: the shell's return aborts the transfer it cannot trust.
        r.onCheckpoint = () => {
          r.onCheckpoint = null;
          r.queue.resumeAfterSuspension();
        };
      }
      const pass = r.queue.drain();
      await settle();
      r.queue.resumeAfterSuspension();
      await pass;
      await r.queue.drain();
      expect(r.created.map((c) => c.id)).toEqual(['reel-2']);
      expect(r.calls.filter((c) => c.startsWith('prepare:'))).toHaveLength(1);
      expect(r.store.posts.size).toBe(0);
      if (step === 'create') {
        // The create whose answer was lost is sent again under the SAME id: one post on the server.
        expect(r.calls.filter((c) => c === 'create:reel-2')).toHaveLength(2);
        expect(r.calls.filter((c) => c.startsWith('upload:'))).toHaveLength(1);
      }
    }
  );

  it('a queue re-opened over the same store (a kill after the upload) creates the reel without uploading again', async () => {
    const store = memoryStore();
    const first = rig(store);
    queueTake(store, 'reel-3');
    first.createPlan.push(async () => {
      throw new TransportFailureError(new TypeError('Failed to fetch'));
    });
    const pass = first.queue.drain();
    await settle();
    first.queue.stop();
    await pass;
    expect(store.posts.get('reel-3')?.media[0].ref).toBeDefined();
    const second = rig(store);
    await second.queue.drain();
    expect(second.calls).toEqual(['create:reel-3']);
    expect(second.payloads[0]).toMatchObject({ kind: 'reel', id: 'reel-3' });
  });

  it('CHATS TOO (15.5): uploaded reel-pending, adopted by the chat take BEFORE the post exists, the wait ended once', async () => {
    const r = rig();
    queueTake(r.store, 'reel-4', { chatTakeId: 'take-1' });
    await r.queue.drain();
    expect(r.uploads[0].retentionClass).toBe('reel-pending');
    expect(r.calls).toEqual([
      'prepare:canareel.mp4',
      'upload:canareel.mp4',
      'adopt:take-1',
      'end-wait:take-1',
      'create:reel-4',
    ]);
    expect(r.adopted).toEqual([
      { takeId: 'take-1', mediaId: r.created[0].media[0].mediaId, durationMs: 41_250 },
    ]);
  });

  it('CHATS TOO: a post refused after the upload leaves the chats their file, and tells the take nothing twice', async () => {
    const r = rig();
    queueTake(r.store, 'reel-5', { chatTakeId: 'take-2' });
    r.createPlan.push(async () => {
      throw new ApiRefusalError(422, null, 'refused');
    });
    await r.queue.drain();
    expect(r.adopted).toHaveLength(1);
    expect(r.waitEnded).toEqual(['take-2']);
    expect(r.store.posts.get('reel-5')?.failure?.stage).toBe('createPost');
    await r.queue.retry('reel-5');
    expect(r.adopted).toHaveLength(1);
    expect(r.waitEnded).toEqual(['take-2']);
  });

  it('CHATS TOO: a take outside the rule is a post uploaded archive, and the chat take uploads its own', async () => {
    const r = rig();
    r.video = { width: 1920, height: 1080, durationMs: 120_000 };
    queueTake(r.store, 'reel-6', { chatTakeId: 'take-3' });
    await r.queue.drain();
    expect(r.uploads[0].retentionClass).toBe('archive');
    expect(r.adopted).toEqual([]);
    expect(r.waitEnded).toEqual(['take-3']);
    expect(r.calls.indexOf('end-wait:take-3')).toBeLessThan(r.calls.indexOf('upload:canareel.mp4'));
    expect(r.payloads[0].kind).toBeUndefined();
  });

  it('CHATS TOO: an adoption that fails is accused, ends the wait, and never stops the reel', async () => {
    const r = rig();
    queueTake(r.store, 'reel-7', { chatTakeId: 'take-4' });
    r.adoptPlan.push(async () => {
      throw new Error('no messaging layer');
    });
    await r.queue.drain();
    expect(r.waitEnded).toEqual(['take-4']);
    expect(r.created.map((c) => c.id)).toEqual(['reel-7']);
  });

  it('CHATS TOO: a reel the member deletes ends the wait, and its reel-pending file is never named to the withdrawal', async () => {
    const r = rig();
    queueTake(r.store, 'reel-8', { chatTakeId: 'take-5' });
    r.createPlan.push(async () => {
      throw new TransportFailureError(new TypeError('Failed to fetch'));
    });
    const pass = r.queue.drain();
    await settle();
    await r.queue.remove('reel-8');
    await pass;
    await r.queue.drain();
    expect(r.withdrawals).toEqual([{ id: 'reel-8', mediaIds: [] }]);
    expect(r.waitEnded).toEqual(['take-5']);
    expect(r.created).toEqual([]);
  });

  it.each([
    ['declined', 'declined'],
    ['forwarded', 'is handed'],
    ['adopted', 'adopts'],
  ] as const)(
    'CHATS TOO: an adoption the take answers %s is logged as what it did, never as an adoption it was not',
    async (answer, said) => {
      const r = rig();
      r.adoptAnswer = answer;
      queueTake(r.store, 'reel-9', { chatTakeId: 'take-6' });
      await r.queue.drain();
      const line = r.logs.find((l) => l.includes('its chat take take-6'));
      expect(line).toContain(said);
      if (answer !== 'adopted') expect(line).not.toContain(' adopts ');
    }
  );

  it('CHATS TOO: a post a chat take waits on goes BEFORE an earlier, slower post', async () => {
    const r = rig();
    queuePost(r.store, 'slow', 2, 0);
    queueTake(r.store, 'reel-10', { chatTakeId: 'take-7' });
    await r.queue.drain();
    expect(r.created.map((c) => c.id)).toEqual(['reel-10', 'slow']);
    expect(r.calls.indexOf('end-wait:take-7')).toBeLessThan(r.calls.indexOf('prepare:p0.jpg'));
  });

  it('CHATS TOO: once handed over, the take no longer jumps the queue (oldest first again)', async () => {
    const r = rig();
    queuePost(r.store, 'slow', 1, 0);
    queueTake(r.store, 'reel-11', { chatTakeId: 'take-8' });
    r.store.posts.get('reel-11')!.takeHandedOver = true;
    await r.queue.drain();
    expect(r.created.map((c) => c.id)).toEqual(['slow', 'reel-11']);
  });

  it("CHATS TOO: an estate that does not serve the queue ends the take's wait at once, durably - and sends nothing", async () => {
    const r = rig();
    r.serverReady = false;
    queueTake(r.store, 'reel-12', { chatTakeId: 'take-9' });
    await r.queue.drain();
    expect(r.waitEnded).toEqual(['take-9']);
    expect(r.uploads).toEqual([]);
    expect(r.store.posts.get('reel-12')?.takeHandedOver).toBe(true);
    // Asked again (the version still says no): the take is not told twice.
    await r.queue.drain();
    expect(r.waitEnded).toEqual(['take-9']);
  });

  it('a create refused because its pending upload EXPIRED uploads the file again and publishes - never the same ref for ever', async () => {
    const r = rig();
    queueTake(r.store, 'reel-13', { chatTakeId: 'take-10' });
    r.createPlan.push(async () => {
      throw new ApiRefusalError(400, REEL_MEDIA_EXPIRED, 'upload it again');
    });
    await r.queue.drain();
    expect(r.calls.filter((c) => c === 'prepare:canareel.mp4')).toHaveLength(1);
    expect(r.uploads.map((u) => u.retentionClass)).toEqual(['reel-pending', 'reel-pending']);
    expect(r.calls.filter((c) => c === 'create:reel-13')).toHaveLength(2);
    expect(r.created).toHaveLength(1);
    expect(r.created[0].media[0].mediaId).toMatch(/-2$/);
    expect(r.published).toEqual(['reel-13']);
    // The take was handed over once, with the first file: the second upload tells it nothing.
    expect(r.waitEnded).toEqual(['take-10']);
  });

  it('the same refusal on a post that holds no pending upload is the failure it was answered', async () => {
    const r = rig();
    queueTake(r.store, 'reel-14');
    r.createPlan.push(async () => {
      throw new ApiRefusalError(400, REEL_MEDIA_EXPIRED, 'upload it again');
    });
    await r.queue.drain();
    expect(r.uploads).toHaveLength(1);
    expect(r.store.posts.get('reel-14')?.failure?.stage).toBe('createPost');
  });
});

describe('PublishQueue - every way a pass ends is told (the screen it held goes with it)', () => {
  it('a queue that empties ends the pass', async () => {
    const r = rig();
    queuePost(r.store, 'post-e', 1);
    await r.queue.drain();
    expect(r.passesEnded).toBe(1);
  });

  it('a HALT (the session is another account) ends the pass', async () => {
    const r = rig();
    r.sessionUser = 'bob';
    queuePost(r.store, 'post-h', 1);
    await r.queue.drain();
    expect(r.created).toEqual([]);
    expect(r.passesEnded).toBe(1);
  });

  it('an UNEXPECTED error out of the pass ends it', async () => {
    const r = rig();
    queuePost(r.store, 'post-u', 1);
    r.store.list = async () => {
      throw new Error('the store broke');
    };
    await r.queue.drain();
    expect(r.passesEnded).toBe(1);
  });

  it('a LAST POST GONE mid-step, with no row drawn after it, ends the pass', async () => {
    const r = rig();
    queuePost(r.store, 'post-g', 1);
    // Deleted from the store (another tab's Delete landed) while it is being prepared.
    r.onCheckpoint = () => {
      if (r.views.some((v) => v.phase === 'preparing')) r.store.posts.delete('post-g');
    };
    await r.queue.drain();
    expect(r.created).toEqual([]);
    // The last row drawn still says it was being worked on: only the end of the pass says otherwise.
    expect(r.views.map((v) => v.phase)).toEqual(['uploading']);
    expect(r.passesEnded).toBe(1);
  });
});

describe('a preparation the app leaving the view stopped (iPhone 12, 1.8.1-alpha.1)', () => {
  const interrupted = () =>
    Promise.reject(new VideoPrepareError('interrupted', 'video: the encoder stopped out of view'));

  it('is classified interrupted from its typed fault, never failed', () => {
    expect(classifyPublishFailure(new VideoPrepareError('interrupted', 'x'))).toBe('interrupted');
    expect(classifyPublishFailure(new VideoPrepareError('encode', 'x'))).toBe('failed');
  });

  it('keeps the post out of view, prepares it again once back in view, and publishes it once', async () => {
    const r = rig();
    queuePost(r.store, 'p1', 1);
    r.inView = false;
    r.preparePlan.push(interrupted);
    await r.queue.drain();

    // Kept as it was: no failure, nothing prepared recorded, nothing created, the pass ended.
    const kept = r.store.posts.get('p1')!;
    expect(kept.failure).toBeUndefined();
    expect(kept.media[0].prepared).toBeUndefined();
    expect(r.created).toEqual([]);
    expect(r.views.find((v) => v.id === 'p1')?.phase).toBe('waiting');
    expect(r.calls).toEqual(['prepare:p0.jpg']);

    // A wake (a reconnect, `online`) does not start it: only the app back in view does.
    r.queue.wake('online');
    await settle();
    expect(r.calls).toEqual(['prepare:p0.jpg']);

    r.inView = true;
    r.queue.backInView();
    await settle();
    await r.queue.drain();
    expect(r.calls.filter((c) => c.startsWith('prepare:'))).toHaveLength(2);
    expect(r.created.map((c) => c.id)).toEqual(['p1']);
    expect(r.published).toEqual(['p1']);
    expect(r.store.posts.has('p1')).toBe(false);
  });

  it('goes again at once when the app is already back in view as the interruption lands', async () => {
    const r = rig();
    queuePost(r.store, 'p1', 1);
    r.inView = true;
    r.preparePlan.push(interrupted);
    await r.queue.drain();
    expect(r.calls.filter((c) => c.startsWith('prepare:'))).toHaveLength(2);
    expect(r.published).toEqual(['p1']);
  });

  it('a back-in-view edge with nothing interrupted starts nothing', async () => {
    const r = rig();
    r.queue.backInView();
    await settle();
    expect(r.passesEnded).toBe(0);
  });

  it('an encoder failure with the app in view throughout stays a failure with its Retry', async () => {
    const r = rig();
    queuePost(r.store, 'p1', 1);
    r.preparePlan.push(() =>
      Promise.reject(new VideoPrepareError('encode', 'video: the encoder failed'))
    );
    await r.queue.drain();
    const stopped = r.store.posts.get('p1')!;
    expect(stopped.failure?.stage).toBe('mediaPrepare');
    expect(stopped.failure?.final).toBeUndefined();
    expect(r.created).toEqual([]);
    r.queue.backInView();
    await settle();
    expect(r.calls).toEqual(['prepare:p0.jpg']);
  });
});
