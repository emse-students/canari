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
} from './publishQueueStore';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { UploadAbortedError } from '$lib/utils/uploadXhr';
import type { MediaRef } from '$lib/media';

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
  /** Called at every account check, before the check - a test's hook between two steps. */
  onCheckpoint: (() => void) | null;
  views: PublishView[];
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
    onCheckpoint: null,
    views: [] as PublishView[],
  } as Rig;
  let n = 0;
  r.queue = new PublishQueue({
    store,
    prepare: async (file) => {
      r.calls.push(`prepare:${file.name}`);
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
    },
    assertNotMuted: async () => undefined,
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
    log: () => undefined,
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
