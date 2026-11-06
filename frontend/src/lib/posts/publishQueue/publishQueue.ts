/**
 * THE BACKGROUND PUBLISH QUEUE (owner, 2026-11-06): the composer closes the moment "Publier" is
 * pressed, and the post is sent from here - its media ONE AT A TIME, each in resumable parts - with a
 * discreet progress line, a Retry when it stops for good, and the post never lost.
 * `docs/wiki/frontend/modules/posts.md#the-background-publish-queue`.
 *
 * WHAT MAKES A RESEND HARMLESS IS DURABLE STATE, NEVER A CLOCK:
 *  - every step's result is written to the queued record before the next step starts
 *    (`PublishQueueStore`): a prepared file is never prepared again, an uploaded media never uploaded
 *    again, and the resumable session's id and key are written before its first part leaves;
 *  - a media in progress resumes from the SERVER's list of the parts it holds (`uploadResumable`),
 *    so a cut, a suspended app or a kill costs at most one part (1 MiB) again;
 *  - the post's id is minted at the press and the server stores the post under it
 *    (`post-client-id.ts`), so a create whose answer was lost and is sent again is ONE post.
 *
 * WHEN THE PHONE SUSPENDS THE APP (decided 2026-11-06: automatic resume, no native code in this
 * step). Nothing here outlives the WebView: the transfer simply stops. On the shell's foreground event
 * the transfer in flight - dead or not, nothing can tell from inside - is aborted and the queue goes
 * again at once, from the server's fact. A native upload service (Android) and a background
 * `URLSession` (iOS) are the LATER step that would keep it running.
 *
 * WHAT STOPS IT, AND HOW IT RESTARTS. A failure with no answer (a transport failure, a 5xx, a 429)
 * WAITS - for a reconnect, the app returning to the screen, the `online` event, the member's Retry,
 * or the next rung of a backoff ladder, whichever comes first; the ladder is a cadence only, every
 * correctness property above holds whatever it does. An ANSWER that refuses (a 4xx, moderation, a
 * video the device cannot prepare) stops the post with its sentence and a Retry; it is never
 * deleted but by the member.
 *
 * ONE RUNNER PER ACCOUNT ACROSS TABS: a pass holds a Web Lock where the engine has one, so two tabs
 * never upload the same media; a tab whose pass waits behind another's runs it after, from the store.
 */
import type { CreatePostPayload, PostMediaRef } from '$lib/posts/api';
import type { ImageDimensions, MediaRef } from '$lib/media';
import type { OutboxResumableUpload } from '$lib/db/types';
import type { ResumableBlobEncoding } from '$lib/utils/resumableUpload';
import { UploadAbortedError, type XhrUploadOptions } from '$lib/utils/uploadXhr';
import { MediaUploadError, uploadRefusalCause } from '$lib/utils/mediaErrors';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { isTransportFailure } from '$lib/utils/transportFailure';
import type {
  PublishQueueStore,
  QueuedFile,
  QueuedPost,
  QueuedPostFailure,
} from './publishQueueStore';

/** The rungs of the wait after a failure with no answer, in ms; the last one repeats. */
export const PUBLISH_RETRY_LADDER_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/** What the progress line shows for one queued post. */
export interface PublishView {
  id: string;
  phase: 'queued' | 'preparing' | 'uploading' | 'publishing' | 'waiting' | 'failed';
  /** The media being worked on (0-based) and how many the post has. */
  index: number;
  count: number;
  /** The whole post's progress from 0 to 1: the media sent, plus the share of the one on the wire. */
  fraction: number;
  /** The current step's own progress from 0 to 1 (a video being prepared, a media being sent). */
  step: number;
  /** The sentence of a post that stopped for good. */
  failure?: string;
}

/** The arguments of one media upload, as the queue hands them to the transport. */
export interface PublishUploadArgs {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  dims?: Partial<ImageDimensions>;
  encoding: ResumableBlobEncoding;
  state?: OutboxResumableUpload;
  persist: (state: OutboxResumableUpload) => Promise<void>;
  transport: XhrUploadOptions;
}

/** Everything the queue touches outside itself - injected, so a test drives it with fakes. */
export interface PublishQueueDeps {
  store: Pick<PublishQueueStore, 'list' | 'get' | 'readFile' | 'update' | 'remove'>;
  /** Prepares one media as the composer used to (`preparePostMedia`). */
  prepare: (
    file: File,
    onProgress: (fraction: number) => void,
    signal: AbortSignal
  ) => Promise<{ file: File; dims?: ImageDimensions }>;
  /** The blob format of a prepared file (`writesSegmented`: a video, when the writer is on). */
  encodingFor: (mimeType: string) => ResumableBlobEncoding;
  upload: (args: PublishUploadArgs) => Promise<MediaRef>;
  /** Gives a resumable session back to the server, best effort (a deleted post). */
  release: (uploadId: string) => Promise<unknown>;
  createPost: (payload: CreatePostPayload & { id: string }) => Promise<unknown>;
  assertNotMuted: () => Promise<void>;
  /** The member's sentence for a refusal (`publishFailureMessage`). */
  failureMessage: (error: unknown) => string;
  /** Runs `fn` as the only pass of this account's queue across tabs. */
  lock: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Waits `ms` or until `signal` aborts - the ladder's cadence. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  onViews: (views: PublishView[]) => void;
  onPublished: (post: QueuedPost) => void;
  log: (line: string) => void;
}

/** How one pass over a post ended. */
type Outcome = 'published' | 'failed' | 'wait' | 'again' | 'gone';

/** Why the queue aborted the transfer it was running. */
type AbortReason = 'resume' | 'deleted' | 'stopped';

/** The `ApiRefusalError` statuses that are no answer about the post: asked again, never a failure. */
const RETRIED_STATUSES = new Set([408, 425, 429]);

/**
 * What a failure says about this post. `wait`: no answer reached us (the link) - waited out, ended by
 * any wake. `busy`: the server answered "not now" (a `5xx`, `408`, `425`, `429`) - waited out over
 * the ladder ONCE, then a failure with its Retry, so a server that keeps refusing is never asked for
 * ever. `failed`: an answer about the post - kept until the member acts.
 */
export function classifyPublishFailure(error: unknown): 'wait' | 'busy' | 'failed' {
  if (isTransportFailure(error)) return 'wait';
  if (error instanceof MediaUploadError) return uploadRefusalCause(error) ? 'failed' : 'wait';
  if (error instanceof ApiRefusalError) {
    return error.status >= 500 || RETRIED_STATUSES.has(error.status) ? 'busy' : 'failed';
  }
  return 'failed';
}

export class PublishQueue {
  private views = new Map<string, PublishView>();
  private current: { id: string; abort: AbortController } | null = null;
  private wakeWait: AbortController | null = null;
  private draining: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  /** Consecutive waits of the post at the head, for the ladder; reset by any step that lands. */
  private waits = 0;
  /**
   * Consecutive "not now" answers of the server for the post at the head. Unlike `waits`, a wake
   * does NOT reset it - a reconnect says nothing about a server that keeps refusing - only a step
   * that lands, a Retry, or the post stopping.
   */
  private busy = 0;

  constructor(private readonly deps: PublishQueueDeps) {}

  /**
   * Runs the queue until it is empty or every post left has stopped for good. Safe to call at any
   * time and as often as wanted: a pass already running is asked to look again when it ends.
   */
  drain(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.draining) {
      this.again = true;
      this.wake('drain asked');
      return this.draining;
    }
    this.draining = this.deps
      .lock(async () => {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && !this.stopped);
      })
      .catch((e) =>
        this.deps.log(`[PUBLISH-QUEUE] pass ended on an unexpected error: ${String(e)}`)
      )
      .finally(() => {
        this.draining = null;
      });
    return this.draining;
  }

  /** Ends a wait at once (a reconnect, `online`, the member's Retry) - never a running transfer. */
  wake(why: string): void {
    if (!this.wakeWait) return;
    this.deps.log(`[PUBLISH-QUEUE] waking the wait: ${why}`);
    this.waits = 0;
    this.wakeWait.abort();
  }

  /**
   * The app is on screen again after the phone suspended it. The transfer in flight may be a dead
   * socket nothing will ever answer, and nothing can tell from inside: it is aborted, and the queue
   * goes again from the server's fact - at most one part is sent twice.
   */
  resumeAfterSuspension(): void {
    if (this.current) {
      this.deps.log(
        `[PUBLISH-QUEUE] back on screen: restarting ${this.current.id} from the server's fact`
      );
      this.current.abort.abort('resume' satisfies AbortReason);
    }
    this.wake('back on screen');
    void this.drain();
  }

  /** The member's Retry on a post that stopped: its failure is cleared and the queue runs it. */
  async retry(postId: string): Promise<void> {
    const post = await this.deps.store.get(postId);
    if (!post) return;
    if (post.failure) {
      this.deps.log(`[PUBLISH-QUEUE] ${postId} retried by the member after: ${post.failure.stage}`);
      delete post.failure;
      await this.deps.store.update(post);
    }
    this.waits = 0;
    this.busy = 0;
    this.wake('retry');
    await this.drain();
  }

  /**
   * The member deleted a queued post: its transfer stops, its record and bytes go, and its open
   * session is given back to the server (best effort; the server's sweep is the backstop).
   */
  async remove(postId: string): Promise<void> {
    const post = await this.deps.store.get(postId);
    if (this.current?.id === postId) this.current.abort.abort('deleted' satisfies AbortReason);
    await this.deps.store.remove(postId);
    this.deps.log(`[PUBLISH-QUEUE] ${postId} deleted by the member`);
    for (const m of post?.media ?? []) {
      if (m.upload?.uploadId && !m.ref) void this.deps.release(m.upload.uploadId);
    }
    this.views.delete(postId);
    this.emitViews();
    void this.drain();
  }

  /** Stops for good (sign-out): the transfer is aborted, nothing more starts. The store is kept. */
  stop(): void {
    this.stopped = true;
    this.current?.abort.abort('stopped' satisfies AbortReason);
    this.wakeWait?.abort();
  }

  private emitViews(): void {
    this.deps.onViews([...this.views.values()]);
  }

  /**
   * Redraws one post's line. A post that stopped says so whatever the patch; one that has not
   * keeps its last phase unless the patch names another - except a `failed` line left from before a
   * Retry, which is `queued` again.
   */
  private setView(post: QueuedPost, patch: Partial<PublishView> = {}): void {
    const done = post.media.filter((m) => m.ref).length;
    const prev = this.views.get(post.id);
    const view: PublishView = {
      id: post.id,
      phase: prev && prev.phase !== 'failed' ? prev.phase : 'queued',
      index: done,
      count: post.media.length,
      fraction: post.media.length === 0 ? 0 : done / post.media.length,
      step: 0,
      ...(prev && prev.phase !== 'failed'
        ? { index: prev.index, fraction: prev.fraction, step: prev.step }
        : {}),
      ...patch,
    };
    if (post.failure) {
      view.phase = 'failed';
      view.failure = post.failure.message;
    } else {
      delete view.failure;
    }
    this.views.set(post.id, view);
    this.emitViews();
  }

  /** One pass: the oldest post that has not stopped, until none is left or one must wait. */
  private async pass(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const posts = await this.deps.store.list();
      for (const id of this.views.keys()) {
        if (!posts.some((p) => p.id === id)) this.views.delete(id);
      }
      for (const p of posts) this.setView(p);
      const next = posts.find((p) => !p.failure);
      if (!next) return;
      const outcome = await this.process(next);
      if (outcome === 'wait') {
        const ms =
          PUBLISH_RETRY_LADDER_MS[Math.min(this.waits, PUBLISH_RETRY_LADDER_MS.length - 1)];
        this.waits += 1;
        this.setView(next, { phase: 'waiting' });
        this.deps.log(
          `[PUBLISH-QUEUE] ${next.id} waits for the link (wait ${this.waits}, at most ${ms} ms)`
        );
        const wait = new AbortController();
        this.wakeWait = wait;
        await this.deps.sleep(ms, wait.signal);
        this.wakeWait = null;
      }
    }
  }

  /** Takes one post as far as it can go. */
  private async process(post: QueuedPost): Promise<Outcome> {
    const abort = new AbortController();
    this.current = { id: post.id, abort };
    let stage: QueuedPostFailure['stage'] = 'moderation';
    try {
      // Before the first byte leaves, as the composer did: the server refuses a muted author's post
      // anyway, but only after every media went up a weak link for nothing.
      if (!post.media.some((m) => m.ref)) await this.deps.assertNotMuted();

      for (let i = 0; i < post.media.length; i++) {
        const media = post.media[i];
        if (media.ref) continue;
        const share = (f: number) => (i + f) / post.media.length;
        let file: QueuedFile;
        if (!media.prepared) {
          stage = 'mediaPrepare';
          this.setView(post, { phase: 'preparing', index: i, fraction: share(0), step: 0 });
          const original = await this.deps.store.readFile(post.id, i);
          // Durations are logged only: the measurement the weak-network page quotes, never a bound.
          const preparedAt = performance.now();
          const { file: prepared, dims } = await this.deps.prepare(
            new File([original.bytes], original.name, { type: original.type }),
            (f) => this.setView(post, { phase: 'preparing', index: i, step: f }),
            abort.signal
          );
          file = { bytes: await prepared.arrayBuffer(), name: prepared.name, type: prepared.type };
          media.prepared = {
            name: file.name,
            type: file.type,
            size: file.bytes.byteLength,
            ...(dims?.width ? { width: dims.width } : {}),
            ...(dims?.height ? { height: dims.height } : {}),
          };
          if (!(await this.deps.store.update(post, { index: i, file }))) return 'gone';
          this.deps.log(
            `[PUBLISH-QUEUE] ${post.id} media ${i + 1}/${post.media.length} prepared: ${media.type} ${media.size} -> ${file.type} ${file.bytes.byteLength} bytes in ${Math.round(performance.now() - preparedAt)} ms`
          );
        } else {
          file = await this.deps.store.readFile(post.id, i);
        }

        stage = 'mediaUpload';
        const prepared = media.prepared!;
        this.setView(post, { phase: 'uploading', index: i, fraction: share(0), step: 0 });
        const uploadedAt = performance.now();
        const ref = await this.deps.upload({
          bytes: new Uint8Array(file.bytes),
          mimeType: prepared.type,
          fileName: prepared.name,
          dims: { width: prepared.width, height: prepared.height },
          encoding: this.deps.encodingFor(prepared.type),
          state: media.upload,
          persist: async (state) => {
            media.upload = state;
            // A lost write costs one re-upload after a kill, never a wrong byte (the digest guard).
            await this.deps.store
              .update(post)
              .catch((e) =>
                this.deps.log(`[PUBLISH-QUEUE] ${post.id} session not recorded: ${String(e)}`)
              );
          },
          transport: {
            signal: abort.signal,
            onProgress: (p) => {
              const f = p.total > 0 ? Math.min(p.loaded / p.total, 0.99) : 0;
              this.setView(post, { phase: 'uploading', index: i, fraction: share(f), step: f });
            },
          },
        });
        media.ref = {
          ...ref,
          ...(media.caption ? { caption: media.caption } : {}),
        } as PostMediaRef;
        if (!(await this.deps.store.update(post))) return 'gone';
        this.waits = 0;
        this.busy = 0;
        this.deps.log(
          `[PUBLISH-QUEUE] ${post.id} media ${i + 1}/${post.media.length} uploaded -> ${ref.mediaId} in ${Math.round(performance.now() - uploadedAt)} ms`
        );
      }

      stage = 'createPost';
      this.setView(post, { phase: 'publishing', index: post.media.length, fraction: 1, step: 1 });
      if (!(await this.deps.store.get(post.id))) return 'gone';
      await this.deps.createPost({
        ...post.payload,
        id: post.id,
        media: post.media.map((m) => m.ref!),
      });
      await this.deps.store.remove(post.id);
      this.views.delete(post.id);
      this.emitViews();
      this.waits = 0;
      this.busy = 0;
      this.deps.log(`[PUBLISH-QUEUE] ${post.id} published (${post.media.length} media)`);
      this.deps.onPublished(post);
      return 'published';
    } catch (error) {
      if (error instanceof UploadAbortedError || abort.signal.aborted) {
        const reason = abort.signal.reason as AbortReason | undefined;
        this.deps.log(`[PUBLISH-QUEUE] ${post.id} stopped at ${stage}: ${reason ?? 'aborted'}`);
        if (reason === 'resume') return 'again';
        if (reason === 'deleted' || reason === 'stopped') return 'gone';
        // An abort nobody here asked for (a transport's own cancel): waited out like no answer.
        return 'wait';
      }
      const verdict = classifyPublishFailure(error);
      if (verdict === 'busy') this.busy += 1;
      if (
        verdict === 'wait' ||
        (verdict === 'busy' && this.busy <= PUBLISH_RETRY_LADDER_MS.length)
      ) {
        this.deps.log(
          `[PUBLISH-QUEUE] ${post.id} ${verdict === 'busy' ? `told not now (${this.busy}/${PUBLISH_RETRY_LADDER_MS.length})` : 'got no answer'} at ${stage} (${error instanceof Error ? error.name : typeof error}): kept, it resumes`
        );
        return 'wait';
      }
      // ACCUSED, not debug-logged: this is the one failure a member reports.
      console.error(`[PUBLISH-QUEUE] ${post.id} refused at ${stage}`, error);
      this.busy = 0;
      post.failure = { stage, message: this.deps.failureMessage(error) };
      const kept = await this.deps.store.update(post).catch((e) => {
        this.deps.log(`[PUBLISH-QUEUE] ${post.id} failure not recorded: ${String(e)}`);
        return true;
      });
      this.setView(post, { phase: 'failed' });
      return kept ? 'failed' : 'gone';
    } finally {
      if (this.current?.abort === abort) this.current = null;
    }
  }
}
