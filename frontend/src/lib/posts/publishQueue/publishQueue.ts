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
 * WHAT STOPS IT, AND HOW IT RESTARTS ({@link classifyPublishFailure}). No answer (the link, an edge
 * page) WAITS - for a reconnect, the app returning to the screen, `online`, the member's Retry, or the
 * next rung of a backoff ladder; the ladder is a cadence only. The server's "not now" (an app-origin
 * 5xx, 408, 425, 429, a session it lost) is asked again over the ladder ONCE, then stops with a
 * Retry. A session that ended, or a token naming another account, ENDS THE PASS with nothing
 * recorded: the post waits for its own account's next session, and is never sent as anybody else.
 * An ANSWER that refuses (a 4xx, moderation, a video the device cannot prepare, a deleted id) stops
 * the post with its sentence and a Retry.
 *
 * WHAT THE MEMBER CAN DO TO A POST. Pause it (the transfer stops, the post stays, "Reprendre" goes
 * on), Retry it, or Delete it. DELETE MEANS THE POST EXISTS NOWHERE: it is marked `withdrawn` and
 * the pass takes it back - ONE server withdrawal (the id is retired, so a create still on its way is
 * refused; the post deleted if it landed; the uploaded media no live row cites deleted by
 * social-service), the open sessions given back - and only then does the record go. A Delete pressed
 * while the create is on the wire wins: no "published" toast, and the post is taken down. A Pause
 * pressed then does not: a landed post cannot be paused, so it is published. The member's marks
 * are written by `PublishQueueStore.mark` alone, so no runner write ever erases them.
 *
 * AN ESTATE THAT CANNOT TAKE IT IS WAITED FOR, never sent to. A stable reaches both stores before
 * production deploys, so a new phone build meets the old services for days: they would drop the
 * client id (a lost answer then duplicates the post), refuse `single-block`, and answer the
 * withdrawal `404`. The queue sends nothing until `/api/version` says `publishQueue`
 * (`serverReady`): its rows wait, and the answer that says so starts the pass.
 *
 * ONE RUNNER PER ACCOUNT ACROSS TABS: a pass holds a Web Lock where the engine has one, so two tabs
 * never upload the same media; a tab whose pass waits behind another's runs it after, from the store.
 * The other tabs draw the rows from the store ({@link PublishQueue.refreshViews}) and the runner's
 * broadcast, and hand their Retry, Pause and Delete to it ({@link PublishQueue.nudge}).
 */
import type { CreatePostPayload, PostMediaRef } from '$lib/posts/api';
import { reelDeclarationFor, type ReelRule } from '$lib/reels/reelRule';
import type { ImageDimensions, MediaRef } from '$lib/media';
import type { MediaLoudness } from '$lib/video/loudnessMeter';
import type { OutboxResumableUpload } from '$lib/db/types';
import type { ResumableBlobEncoding } from '$lib/utils/resumableUpload';
import { UploadAbortedError, type XhrUploadOptions } from '$lib/utils/uploadXhr';
import { MediaUploadError, uploadRefusalCause } from '$lib/utils/mediaErrors';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { isTransportFailure } from '$lib/utils/transportFailure';
import { TokenAccountChangedError } from '$lib/utils/renewOn401';
import { IdentitySplitError } from '$lib/stores/tokenIdentity.svelte';
import {
  INSTITUTION_REACH_INVALID,
  INSTITUTION_REACH_NOT_OFFERED,
  INSTITUTION_REACH_OUTSIDE_AUDIENCE,
  INSTITUTION_REACH_REQUIRED,
} from '$lib/posts/institutionReach';
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
  phase:
    | 'queued'
    | 'preparing'
    | 'uploading'
    | 'publishing'
    | 'waiting'
    | 'paused'
    | 'withdrawing'
    | 'failed';
  /** The media being worked on (0-based) and how many the post has. */
  index: number;
  count: number;
  /** The whole post's progress from 0 to 1: the media sent, plus the share of the one on the wire. */
  fraction: number;
  /** The current step's own progress from 0 to 1 (a video being prepared, a media being sent). */
  step: number;
  /** The sentence of a post that stopped for good. */
  failure?: string;
  /** Its refusal is one a Retry cannot cure (`retryCannotCure`): only Delete is offered. */
  final?: true;
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
  store: Pick<PublishQueueStore, 'list' | 'get' | 'readFile' | 'update' | 'mark' | 'remove'>;
  /** Prepares one media as the composer used to (`preparePostMedia`). */
  prepare: (
    file: File,
    onProgress: (fraction: number) => void,
    signal: AbortSignal
  ) => Promise<{
    file: File;
    dims?: ImageDimensions;
    durationMs?: number;
    placeholder?: string;
    loudness?: MediaLoudness;
  }>;
  /**
   * The served CanaReel rule (`reelRuleOf` of `GET /api/posts/reel-limits`), or `null` from an estate
   * older than it - then no post becomes a reel, as there. A failure to ask is a failure of the
   * create step (waited out or retried like any), never a post published without the rule.
   */
  reelRule: () => Promise<ReelRule | null>;
  /** The blob format of a prepared file (`writesSegmented`: a video, when the writer is on). */
  encodingFor: (mimeType: string) => ResumableBlobEncoding;
  upload: (args: PublishUploadArgs) => Promise<MediaRef>;
  /** Gives a resumable session back to the server, best effort (a deleted post). */
  release: (uploadId: string) => Promise<unknown>;
  createPost: (payload: CreatePostPayload & { id: string }) => Promise<unknown>;
  /**
   * Retires the id, deletes the post if it landed, and deletes the named uploaded media that no
   * live row cites (`POST /api/posts/:id/withdraw`).
   */
  withdrawPost: (postId: string, mediaIds: string[]) => Promise<{ deleted: boolean }>;
  /**
   * Whether the estate serves what the queue sends (`publishQueue` in `/api/version`): `true`, or
   * `false`/`null` (an older estate, or not known yet) - then nothing is sent and the rows wait.
   */
  serverReady: () => boolean | null;
  /**
   * Throws unless the session that would carry the next request is the queue's own account: a
   * {@link PublishAccountMismatchError}, or what the session throws when there is none.
   */
  assertAccount: () => Promise<void>;
  /** Whether `error` says the session ENDED (a dead refresh credential) - never a transport failure. */
  sessionEnded: (error: unknown) => boolean;
  assertNotMuted: () => Promise<void>;
  /** The member's sentence for a refusal (`publishFailureMessage`). */
  failureMessage: (error: unknown) => string;
  /** Runs `fn` as the only pass of this account's queue across tabs. */
  lock: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Waits `ms` or until `signal` aborts - the ladder's cadence. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * The rows changed. `fromRunner`: drawn by the pass that works on them, so other tabs may adopt
   * them; `false` when they were read from the store alone ({@link PublishQueue.refreshViews}) and
   * must not overwrite a runner's progress elsewhere.
   */
  onViews: (views: PublishView[], fromRunner: boolean) => void;
  onPublished: (post: QueuedPost) => void;
  log: (line: string) => void;
}

/** How one pass over a post ended. `halt`: the session is not the queue's account - the pass ends. */
type Outcome = 'published' | 'failed' | 'wait' | 'again' | 'gone' | 'halt';

/** Why the queue aborted the transfer it was running. */
type AbortReason = 'resume' | 'deleted' | 'paused' | 'stopped';

/** What another tab asks of the runner (`nudge`). */
export type PublishNudge = 'retry' | 'paused' | 'deleted';

/**
 * The session that would carry the queue's next request is ANOTHER ACCOUNT than the queue's. Nothing
 * is sent: a post is never published, uploaded or withdrawn as somebody else.
 */
export class PublishAccountMismatchError extends Error {
  constructor(queueUserId: string) {
    super(
      `the session is not the publish queue's account (${queueUserId.slice(0, 8)}) - nothing sent`
    );
    this.name = 'PublishAccountMismatchError';
  }
}

/** The queue's own check between two steps found the pass must stop (`abort`, `stop`). */
class StepAbortedError extends Error {
  constructor() {
    super('publish queue step aborted');
    this.name = 'StepAbortedError';
  }
}

/** The `ApiRefusalError` statuses that are no answer about the post: asked again, never a failure. */
const RETRIED_STATUSES = new Set([408, 425, 429]);

/**
 * The refusal codes about the post's own PAYLOAD that a Retry cannot cure: the queue re-sends the
 * payload it stored, so the server would refuse it again identically. An institution's reach (owner,
 * 2026-11-10): a build older than the reach queues an institution post without one, and every Retry
 * would meet `institution_reach_required` again (review of #3314).
 */
const FINAL_REFUSAL_CODES: ReadonlySet<string> = new Set([
  INSTITUTION_REACH_REQUIRED,
  INSTITUTION_REACH_NOT_OFFERED,
  INSTITUTION_REACH_INVALID,
  INSTITUTION_REACH_OUTSIDE_AUDIENCE,
]);

/** Whether `error` is an answer about the stored payload that a Retry would only repeat. */
export function retryCannotCure(error: unknown): boolean {
  return (
    error instanceof ApiRefusalError &&
    error.code !== null &&
    error.status < 500 &&
    FINAL_REFUSAL_CODES.has(error.code)
  );
}

/** What a failure says about this post, read by {@link classifyPublishFailure}. */
export type PublishFailureVerdict = 'wait' | 'busy' | 'halt' | 'failed';

/**
 * What a failure says about this post.
 *
 * - `wait`: NO ANSWER reached us - a transport failure, or an EDGE page (the host's proxy, never the
 *   app) with no cause, from an upload or from the post API alike. Waited out; any wake ends the wait.
 * - `busy`: the APP answered "not now" - a `5xx`, `408`, `425`, `429`, or a resumable session it lost
 *   and could not reopen (`sessionLost`). Asked again over the ladder ONCE, then a failure with its
 *   Retry: a server that keeps refusing is never asked for ever, and a lost session is never
 *   re-uploaded part by part every minute.
 * - `halt`: the SESSION is not this queue's - it ended (`sessionEnded`, the one authority on a 401),
 *   a token names another account (`apiFetch`'s `IdentitySplitError` guards the create and the
 *   withdrawal the same way), or a `401` reached us anyway. The pass ends, nothing recorded:
 *   the app's auth decides what a 401 means, and the queue never spins on one.
 * - `failed`: an answer about the post - kept until the member acts.
 */
export function classifyPublishFailure(
  error: unknown,
  sessionEnded: (error: unknown) => boolean = () => false
): PublishFailureVerdict {
  if (
    error instanceof PublishAccountMismatchError ||
    error instanceof TokenAccountChangedError ||
    error instanceof IdentitySplitError ||
    sessionEnded(error)
  ) {
    return 'halt';
  }
  if (isTransportFailure(error)) return 'wait';
  if (error instanceof MediaUploadError) {
    if (uploadRefusalCause(error)) return 'failed';
    if (error.origin === 'edge') return 'wait';
    if (error.sessionLost) return 'busy';
  }
  if (error instanceof ApiRefusalError) {
    if (error.status === 401) return 'halt';
    if (error.origin === 'edge') return 'wait';
    return error.status >= 500 || RETRIED_STATUSES.has(error.status) ? 'busy' : 'failed';
  }
  return 'failed';
}

/** The phases the store's marks decide: never carried over from a previous line. */
const STICKY_PHASES: ReadonlySet<PublishView['phase']> = new Set([
  'failed',
  'paused',
  'withdrawing',
]);

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

  /**
   * The member's Retry on a post that stopped, or "Reprendre" on one they paused: the mark is cleared
   * in the store and the runner - this tab's or another's (`nudge`) - goes on with it.
   */
  async retry(postId: string): Promise<void> {
    const post = await this.deps.store.get(postId);
    if (!post) return;
    if (post.failure?.final) {
      // ACCUSED: the banner offers no Retry on a final refusal, so reaching here is a caller's bug.
      console.warn(
        `[PUBLISH-QUEUE] ${postId} Retry refused: its refusal at ${post.failure.stage} is final`
      );
      return;
    }
    if (post.failure || post.paused) {
      this.deps.log(
        `[PUBLISH-QUEUE] ${postId} resumed by the member after: ${post.failure?.stage ?? 'a pause'}`
      );
      await this.deps.store.mark(postId, { paused: false, clearFailure: true });
    }
    await this.refreshViews();
    this.nudge(postId, 'retry');
    await this.drain();
  }

  /** The member stops a post that is being prepared or sent: the transfer ends, the post is kept. */
  async pause(postId: string): Promise<void> {
    const post = await this.deps.store.get(postId);
    if (!post || post.withdrawn) return;
    if (!(await this.deps.store.mark(postId, { paused: true }))) return;
    this.deps.log(`[PUBLISH-QUEUE] ${postId} paused by the member`);
    this.nudge(postId, 'paused');
    await this.refreshViews();
  }

  /**
   * The member deleted a queued post. It is marked `withdrawn` in the store, its transfer stops, and
   * the runner takes it back everywhere before the record goes (`withdraw`) - so a Delete is never
   * just a local forget of a post the server may hold, nor of blobs no post will ever cite.
   */
  async remove(postId: string): Promise<void> {
    const marked = await this.deps.store.mark(postId, {
      withdrawn: true,
      paused: false,
      clearFailure: true,
    });
    if (!marked) return;
    this.deps.log(`[PUBLISH-QUEUE] ${postId} deleted by the member: taking it back`);
    this.nudge(postId, 'deleted');
    await this.refreshViews();
    void this.drain();
  }

  /**
   * What a Retry, a Pause or a Delete asks of the RUNNER, from this tab or another: the transfer of
   * that post stops when it is the one in flight, and a wait ends at once instead of at its rung.
   */
  nudge(postId: string, what: PublishNudge): void {
    if (what !== 'retry' && this.current?.id === postId) {
      this.current.abort.abort(what satisfies AbortReason);
    }
    this.waits = 0;
    if (what === 'retry') this.busy = 0;
    this.wake(`${what} ${postId}`);
    if (this.draining) this.again = true;
  }

  /**
   * Redraws every row from the STORE, without the lock: what a tab that is not the runner shows, and
   * what any tab shows before its first pass. A row the runner is working on keeps its progress.
   */
  async refreshViews(): Promise<void> {
    const posts = await this.deps.store.list();
    for (const id of this.views.keys()) {
      if (!posts.some((p) => p.id === id)) this.views.delete(id);
    }
    for (const p of posts) this.setView(p, {}, false);
    this.emitViews(false);
  }

  /** Stops for good (sign-out): the transfer is aborted, nothing more starts. The store is kept. */
  stop(): void {
    this.stopped = true;
    this.current?.abort.abort('stopped' satisfies AbortReason);
    this.wakeWait?.abort();
  }

  private emitViews(fromRunner = true): void {
    this.deps.onViews([...this.views.values()], fromRunner);
  }

  /**
   * Redraws one post's line. A post that stopped says so whatever the patch; one that has not
   * keeps its last phase unless the patch names another - except a `failed` line left from before a
   * Retry, which is `queued` again.
   */
  private setView(post: QueuedPost, patch: Partial<PublishView> = {}, emit = true): void {
    const done = post.media.filter((m) => m.ref).length;
    const prev = this.views.get(post.id);
    const view: PublishView = {
      id: post.id,
      phase: prev && !STICKY_PHASES.has(prev.phase) ? prev.phase : 'queued',
      index: done,
      count: post.media.length,
      fraction: post.media.length === 0 ? 0 : done / post.media.length,
      step: 0,
      ...(prev && !STICKY_PHASES.has(prev.phase)
        ? { index: prev.index, fraction: prev.fraction, step: prev.step }
        : {}),
      ...patch,
    };
    // A withdrawal that was refused is a failure the member sees, with its Retry and Delete.
    if (post.failure) {
      view.phase = 'failed';
      view.failure = post.failure.message;
      if (post.failure.final) view.final = true;
    } else if (post.withdrawn) {
      view.phase = 'withdrawing';
    } else if (post.paused) {
      view.phase = 'paused';
    }
    if (!post.failure) delete view.failure;
    if (!post.failure?.final) delete view.final;
    this.views.set(post.id, view);
    if (emit) this.emitViews();
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
      // A post that STOPPED is left out whatever it was doing - a refused withdrawal included, which
      // was picked again at once and asked 51 times in a few ms (review of #3061). Only the member's
      // Retry or Delete clears the failure.
      const workable = posts.filter((p) => !p.failure);
      const next = workable.find((p) => p.withdrawn) ?? workable.find((p) => !p.paused);
      if (!next) return;
      if (!this.estateServes()) {
        // No ladder: nothing here would change by asking again. The answer of `/api/version` that
        // says so starts the next pass (`publishQueue.svelte.ts`).
        for (const p of workable) this.setView(p, { phase: 'waiting' });
        return;
      }
      const outcome: Outcome = next.withdrawn
        ? await this.withdraw(next)
        : await this.process(next);
      if (outcome === 'halt') return;
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

  /**
   * Whether the estate serves the queue's routes; when not, the pass ENDS and the rows wait for the
   * `/api/version` answer that says so - never a rung of the ladder, which would only re-read the same
   * local value. Nothing is sent to an estate that would drop the client id or answer the withdrawal
   * `404`.
   */
  private estateServes(): boolean {
    if (this.deps.serverReady() === true) return true;
    this.deps.log(
      '[PUBLISH-QUEUE] the estate does not say publishQueue (older, or not known yet): nothing sent'
    );
    return false;
  }

  /**
   * Between two steps: the pass goes on only if nothing stopped it (a Pause, a Delete - this tab's
   * abort, or the mark the store gave back on the runner's last write - a sign-out) and the session
   * is still the queue's account: checked before EVERY request, the create included.
   */
  private async checkpoint(abort: AbortController, post: QueuedPost): Promise<void> {
    const stoppedHere = () =>
      this.stopped || abort.signal.aborted || !!post.withdrawn || !!post.paused;
    if (stoppedHere()) throw new StepAbortedError();
    await this.deps.assertAccount();
    if (stoppedHere()) throw new StepAbortedError();
  }

  /**
   * `{ kind: 'reel', durationMs }` when the post is a CanaReel by the served rule, `null` when it is a
   * post. Logged either way for a single video, the one case the rule reads.
   */
  private async reelDeclaration(
    post: QueuedPost
  ): Promise<{ kind: 'reel'; durationMs: number } | null> {
    if (post.media.length !== 1 || !post.media[0].prepared?.type.startsWith('video/')) return null;
    const rule = await this.deps.reelRule();
    if (!rule) {
      this.deps.log(
        `[PUBLISH-QUEUE] ${post.id} one video, but the estate serves no reel rule: a post`
      );
      return null;
    }
    const prepared = post.media[0].prepared;
    const reel = reelDeclarationFor(
      post.payload,
      [
        {
          type: prepared.type,
          width: prepared.width,
          height: prepared.height,
          durationMs: prepared.durationMs,
        },
      ],
      rule
    );
    this.deps.log(
      `[PUBLISH-QUEUE] ${post.id} one video ${prepared.width ?? '?'}x${prepared.height ?? '?'}, ${prepared.durationMs ?? '?'} ms: ${reel ? 'a CanaReel' : 'a post'}`
    );
    return reel;
  }

  /** Takes one post as far as it can go. */
  private async process(post: QueuedPost): Promise<Outcome> {
    const abort = new AbortController();
    this.current = { id: post.id, abort };
    let stage: QueuedPostFailure['stage'] = 'moderation';
    try {
      await this.checkpoint(abort, post);
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
          await this.checkpoint(abort, post);
          this.setView(post, { phase: 'preparing', index: i, fraction: share(0), step: 0 });
          const original = await this.deps.store.readFile(post.id, i);
          // Durations are logged only: the measurement the weak-network page quotes, never a bound.
          const preparedAt = performance.now();
          const {
            file: prepared,
            dims,
            durationMs,
            placeholder,
            loudness,
          } = await this.deps.prepare(
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
            ...(durationMs ? { durationMs } : {}),
            ...(placeholder ? { placeholder } : {}),
            ...(loudness ? { loudness } : {}),
          };
          if (!(await this.deps.store.update(post, { index: i, file }))) return 'gone';
          this.deps.log(
            `[PUBLISH-QUEUE] ${post.id} media ${i + 1}/${post.media.length} prepared: ${media.type} ${media.size} -> ${file.type} ${file.bytes.byteLength} bytes in ${Math.round(performance.now() - preparedAt)} ms`
          );
        } else {
          file = await this.deps.store.readFile(post.id, i);
        }

        stage = 'mediaUpload';
        await this.checkpoint(abort, post);
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
          ...(prepared.placeholder ? { placeholder: prepared.placeholder } : {}),
          ...(prepared.loudness ? { loudness: prepared.loudness } : {}),
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
      // Re-read: a Pause or a Delete from another tab is in the store, not in this copy.
      const latest = await this.deps.store.get(post.id);
      if (!latest) return 'gone';
      if (latest.withdrawn) post.withdrawn = true;
      if (latest.paused) post.paused = true;
      await this.checkpoint(abort, post);
      // Durable BEFORE the request: from here a Delete must ask the server, the create may land.
      if (!post.createSent) {
        post.createSent = true;
        if (!(await this.deps.store.update(post))) return 'gone';
      }
      // EVERY VERTICAL VIDEO OF 90 S OR LESS IS A CANAREEL (owner, 2026-11-09): decided here, on the
      // PREPARED frame and length - what the server is told - for a post whose only content is it.
      const reel = await this.reelDeclaration(post);
      await this.deps.createPost({
        ...post.payload,
        ...reel,
        id: post.id,
        media: post.media.map((m) => m.ref!),
      });
      // A Delete pressed while the create was on the wire wins: no toast, the runner takes it down.
      // A Pause pressed then does NOT: a landed post cannot be paused, so it is published - the
      // record goes, and the mark with it. A sign-out leaves the record: the next session's create
      // is answered from the row (the client id), and only then is the post called published.
      if (this.stopped) return 'gone';
      const after = await this.deps.store.get(post.id);
      if (!after) return 'gone';
      if (after.withdrawn) {
        this.deps.log(`[PUBLISH-QUEUE] ${post.id} deleted while its create was on the wire`);
        return 'again';
      }
      await this.deps.store.remove(post.id);
      this.views.delete(post.id);
      this.emitViews();
      this.waits = 0;
      this.busy = 0;
      this.deps.log(`[PUBLISH-QUEUE] ${post.id} published (${post.media.length} media)`);
      this.deps.onPublished(post);
      return 'published';
    } catch (error) {
      if (
        error instanceof UploadAbortedError ||
        error instanceof StepAbortedError ||
        abort.signal.aborted ||
        this.stopped
      ) {
        const reason: AbortReason | undefined = this.stopped
          ? 'stopped'
          : ((abort.signal.reason as AbortReason | undefined) ??
            (post.withdrawn ? 'deleted' : post.paused ? 'paused' : undefined));
        this.deps.log(`[PUBLISH-QUEUE] ${post.id} stopped at ${stage}: ${reason ?? 'aborted'}`);
        // Paused and deleted posts are the store's to say: the pass reads them again.
        if (reason === 'resume' || reason === 'deleted' || reason === 'paused') return 'again';
        if (reason === 'stopped') return 'gone';
        // An abort nobody here asked for (a transport's own cancel): waited out like no answer.
        return 'wait';
      }
      return this.failed(post, stage, error);
    } finally {
      if (this.current?.abort === abort) this.current = null;
    }
  }

  /**
   * Takes back a post the member deleted, everywhere, then forgets it. Every step is idempotent, so
   * a cut or a kill half-way only repeats it: the withdrawal (a retired id stays retired), the blob
   * deletions (a gone object answers gone), the session releases.
   */
  private async withdraw(post: QueuedPost): Promise<Outcome> {
    const abort = new AbortController();
    this.current = { id: post.id, abort };
    const stage: QueuedPostFailure['stage'] = 'withdraw';
    try {
      this.setView(post);
      // Only the account and a sign-out are checked: the post's own marks are what brought it here.
      await this.checkpoint(abort, { ...post, withdrawn: undefined, paused: undefined });
      // ONE request, whether or not the create left: the id is retired, a landed post deleted, and
      // the uploaded media no live row cites deleted by social-service - the one place that can
      // tell a never-cited blob from a published post's (review of #3061).
      const mediaIds = post.media.flatMap((m) => (m.ref ? [m.ref.mediaId] : []));
      const landed = (await this.deps.withdrawPost(post.id, mediaIds)).deleted;
      for (const media of post.media) {
        if (!media.ref && media.upload?.uploadId) {
          // Best effort: the server's session sweep is the backstop, and `release` logs a failure.
          void this.deps.release(media.upload.uploadId);
        }
      }
      await this.deps.store.remove(post.id);
      this.views.delete(post.id);
      this.emitViews();
      this.waits = 0;
      this.busy = 0;
      this.deps.log(
        `[PUBLISH-QUEUE] ${post.id} taken back (${landed ? 'the post was online' : 'never online'})`
      );
      return 'gone';
    } catch (error) {
      if (error instanceof StepAbortedError || this.stopped) return 'gone';
      return this.failed(post, stage, error);
    } finally {
      if (this.current?.abort === abort) this.current = null;
    }
  }

  /** What a step's failure does to the post: wait, halt the pass, or stop it with its sentence. */
  private async failed(
    post: QueuedPost,
    stage: QueuedPostFailure['stage'],
    error: unknown
  ): Promise<Outcome> {
    {
      const verdict = classifyPublishFailure(error, this.deps.sessionEnded);
      if (verdict === 'halt') {
        // ACCUSED: a queue that cannot send as its account is the line a report needs.
        console.error(
          `[PUBLISH-QUEUE] ${post.id} not sent at ${stage}: the session is not its account`,
          error
        );
        return 'halt';
      }
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
      post.failure = {
        stage,
        message: this.deps.failureMessage(error),
        ...(retryCannotCure(error) ? { final: true as const } : {}),
      };
      const kept = await this.deps.store.update(post).catch((e) => {
        this.deps.log(`[PUBLISH-QUEUE] ${post.id} failure not recorded: ${String(e)}`);
        return true;
      });
      this.setView(post, { phase: 'failed' });
      return kept ? 'failed' : 'gone';
    }
  }
}
