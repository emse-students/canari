/**
 * The publish queue of the signed-in account, wired to the real world: the store, `MediaService`'s
 * resumable upload, the post API, and the events that end a wait (a reconnect, `online`, the app on
 * screen again). The mechanism and its reasons are in `publishQueue.ts`; this file only connects it.
 *
 * ONE QUEUE, FOR THE ACCOUNT THAT IS SIGNED IN. Started by the root layout once the session is up,
 * stopped at sign-out. A plain sign-out KEEPS the store on the device, as it keeps the message
 * database: the next sign-in of that account resumes it. The account's deletion or revocation wipes
 * it (`accountIndexedDbNames`). Every request it makes is checked to be THIS account's
 * (`assertAccount`): a tab signed in as somebody else never sends this account's post.
 *
 * SEVERAL TABS. One runs the pass (the Web Lock); it BROADCASTS its rows, and the others draw them
 * and pass their Retry, Pause and Delete back on the same channel (`nudge`), so a member acting in
 * any tab acts at once, not at the runner's next rung.
 */
import { SvelteSet } from 'svelte/reactivity';
import { m } from '$lib/paraglide/messages';
import { createPost, withdrawPost } from '$lib/posts/api';
import { MediaService, preparePostMedia } from '$lib/media';
import { SEGMENTED_MEDIA_ENCODING, writesSegmented } from '$lib/mediaSegmented';
import { assertNotMuted } from '$lib/moderation/muteCheck';
import { publishFailureMessage } from '$lib/posts/publishFailure';
import { getToken, SessionExpiredError } from '$lib/stores/auth';
import { serverPublishQueue } from '$lib/stores/appVersionCheck.svelte';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { showToast } from '$lib/stores/toast.svelte';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { onAppForegroundChange } from '$lib/utils/appForeground';
import { decodeTokenClaims } from '$lib/utils/jwtClaims';
import { appendLog } from '$lib/utils/sessionLog';
import {
  PublishAccountMismatchError,
  PublishQueue,
  type PublishNudge,
  type PublishView,
} from './publishQueue';
import { PublishQueueStore, type QueuedPost } from './publishQueueStore';
import { whenBecomesTrue } from './whenBecomesTrue.svelte';

class PublishQueueViews {
  /** One line per queued post, oldest first: what the progress line draws. */
  views = $state<PublishView[]>([]);
}

/** The reactive state of the progress line. */
export const publishQueueState = new PublishQueueViews();

/** What the tabs of one account say to each other about its queue. */
type ChannelMessage =
  | { type: 'views'; views: PublishView[] }
  | { type: 'nudge'; postId: string; what: PublishNudge };

interface Running {
  userId: string;
  store: PublishQueueStore;
  queue: PublishQueue;
  channel: BroadcastChannel | null;
  unsubscribe: Array<() => void>;
}

let running: Running | null = null;
const publishedListeners = new SvelteSet<(post: QueuedPost) => void>();

/** Waits `ms`, or less when `signal` aborts (a wake). The ladder's cadence, never a correctness bound. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/** One pass per account across tabs, through the Web Lock API where the engine has it. */
function lockFor(userId: string) {
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks) return fn();
    return locks.request(`canari-publish-queue-${userId}`, fn) as Promise<T>;
  };
}

/**
 * The access token for a request of `userId`'s queue, refused when it names anybody else: the token
 * is the session's, the queue is one account's, and a sign-in to another account in another tab
 * changes the first without the second.
 */
async function tokenOf(userId: string): Promise<string> {
  const token = await getToken();
  if (decodeTokenClaims(token)?.sub !== userId) throw new PublishAccountMismatchError(userId);
  return token;
}

/** The channel the tabs of `userId` share, or `null` where the engine has none. */
function channelFor(userId: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  return new BroadcastChannel(`canari-publish-queue-${userId}`);
}

/**
 * Starts the queue of `userId` and drains what it holds. Called again for the account already
 * running, it only drains: a pass that ended because the session was not yet this account's goes on.
 */
export function startPublishQueue(userId: string): void {
  if (running?.userId === userId) {
    void running.queue.drain();
    return;
  }
  stopPublishQueue();
  const store = new PublishQueueStore(userId);
  const media = new MediaService();
  const channel = channelFor(userId);
  const token = () => tokenOf(userId);
  const queue = new PublishQueue({
    store,
    prepare: async (file, onProgress, signal) => {
      const limits = file.type.startsWith('video/') ? await media.uploadLimits() : null;
      return preparePostMedia(file, { maxBytes: limits?.maxPlaintextBytes, onProgress, signal });
    },
    encodingFor: (mimeType) =>
      writesSegmented(mimeType) ? SEGMENTED_MEDIA_ENCODING : 'single-block',
    upload: (a) =>
      media.uploadResumably(
        a.bytes,
        { mimeType: a.mimeType, fileName: a.fileName },
        token,
        a.dims,
        'archive',
        { state: a.state, persist: a.persist, encoding: a.encoding },
        a.transport
      ),
    release: (uploadId) =>
      media.releaseResumableUpload(uploadId, token, 'post deleted from the publish queue'),
    // The create and the withdrawal go through `apiFetch`, whose own guard refuses a token of
    // another account than the session's (`IdentitySplitError`, classified `halt`).
    createPost: (payload) => createPost(payload),
    withdrawPost: (postId, mediaIds) => withdrawPost(postId, mediaIds),
    serverReady: serverPublishQueue,
    assertNotMuted,
    assertAccount: async () => {
      await token();
    },
    sessionEnded: (error) => error instanceof SessionExpiredError,
    failureMessage: (error) =>
      error instanceof ApiRefusalError && error.status === 410
        ? m.publish_queue_gone()
        : publishFailureMessage(error, m.post_create_publish_error()),
    lock: lockFor(userId),
    sleep,
    onViews: (views, fromRunner) => {
      publishQueueState.views = views;
      // Only the runner's rows go to the other tabs: rows read from the store alone carry no
      // progress, and would overwrite the runner's in every tab that adopted them.
      if (fromRunner) channel?.postMessage({ type: 'views', views } satisfies ChannelMessage);
    },
    onPublished: (post) => {
      showToast(m.publish_queue_published(), 'info');
      for (const listener of publishedListeners) {
        try {
          listener(post);
        } catch (e) {
          appendLog(`[PUBLISH-QUEUE] a published listener threw: ${String(e)}`);
        }
      }
    },
    log: appendLog,
  });
  const onOnline = () => queue.wake('online');
  const onVisible = () => {
    if (document.visibilityState === 'visible') queue.wake('page visible');
  };
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);
  if (channel) {
    channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
      const message = event.data;
      if (message?.type === 'views') publishQueueState.views = message.views;
      else if (message?.type === 'nudge') {
        running?.queue.nudge(message.postId, message.what);
        void running?.queue.drain();
      } else appendLog('[PUBLISH-QUEUE] a channel message of no known type was ignored');
    };
  }
  running = {
    userId,
    store,
    queue,
    channel,
    unsubscribe: [
      connectivity.onReconnect(() => queue.wake('reconnect')),
      // Only the native shells emit it; on the web a background tab keeps uploading.
      onAppForegroundChange((foreground) => {
        if (foreground) queue.resumeAfterSuspension();
      }),
      () => window.removeEventListener('online', onOnline),
      () => document.removeEventListener('visibilitychange', onVisible),
    ],
  };
  // The estate's capability is read from `/api/version`, which may answer after the first pass:
  // that answer starts the pass the gate ended. Reactive, no timer, and only on a CHANGE.
  running.unsubscribe.push(
    whenBecomesTrue(
      () => serverPublishQueue() === true,
      () => {
        queue.wake('version answered');
        void queue.drain();
      }
    )
  );
  appendLog(`[PUBLISH-QUEUE] started`);
  void queue.refreshViews();
  void queue.drain();
}

/** Stops the running queue (sign-out). What it holds stays on the device for the next sign-in. */
export function stopPublishQueue(): void {
  if (!running) return;
  const { queue, store, unsubscribe, channel } = running;
  running = null;
  queue.stop();
  for (const off of unsubscribe) off();
  channel?.close();
  void store.close();
  publishQueueState.views = [];
  appendLog('[PUBLISH-QUEUE] stopped');
}

/**
 * Queues a post for `userId` and starts sending it. Resolves once the post and its files are ON THE
 * DEVICE - the composer closes only then; rejects (and the composer keeps everything) otherwise.
 */
export async function enqueuePost(userId: string, post: QueuedPost, files: File[]): Promise<void> {
  startPublishQueue(userId);
  await running!.store.enqueue(post, files);
  appendLog(`[PUBLISH-QUEUE] ${post.id} queued with ${files.length} media`);
  await running!.queue.refreshViews();
  void running!.queue.drain();
}

/** Tells the runner - in whichever tab it is - what the member did to `postId`. */
function tellTheRunner(postId: string, what: PublishNudge): void {
  running?.channel?.postMessage({ type: 'nudge', postId, what } satisfies ChannelMessage);
}

/** The member's Retry on a post that stopped, or "Reprendre" on one they paused. */
export async function retryQueuedPost(postId: string): Promise<void> {
  if (!running) return;
  const done = running.queue.retry(postId);
  tellTheRunner(postId, 'retry');
  await done;
}

/** The member stops a post being prepared or sent; it is kept, paused. */
export async function pauseQueuedPost(postId: string): Promise<void> {
  if (!running) return;
  await running.queue.pause(postId);
  tellTheRunner(postId, 'paused');
}

/** The member's Delete on a queued post: taken back everywhere, then forgotten. */
export async function deleteQueuedPost(postId: string): Promise<void> {
  if (!running) return;
  await running.queue.remove(postId);
  tellTheRunner(postId, 'deleted');
}

/** Calls `listener` each time a queued post is published; returns the unsubscribe. */
export function onPostPublished(listener: (post: QueuedPost) => void): () => void {
  publishedListeners.add(listener);
  return () => publishedListeners.delete(listener);
}
