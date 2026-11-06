/**
 * The publish queue of the signed-in account, wired to the real world: the store, `MediaService`'s
 * resumable upload, the post API, and the events that end a wait (a reconnect, `online`, the app on
 * screen again). The mechanism and its reasons are in `publishQueue.ts`; this file only connects it.
 *
 * ONE QUEUE, FOR THE ACCOUNT THAT IS SIGNED IN. Started by the root layout once the session is up,
 * stopped at sign-out (the store stays on the device: the next sign-in of that account resumes it).
 */
import { SvelteSet } from 'svelte/reactivity';
import { m } from '$lib/paraglide/messages';
import { createPost } from '$lib/posts/api';
import { MediaService, preparePostMedia } from '$lib/media';
import { SEGMENTED_MEDIA_ENCODING, writesSegmented } from '$lib/mediaSegmented';
import { assertNotMuted } from '$lib/moderation/muteCheck';
import { publishFailureMessage } from '$lib/posts/publishFailure';
import { getToken } from '$lib/stores/auth';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { showToast } from '$lib/stores/toast.svelte';
import { onAppForegroundChange } from '$lib/utils/appForeground';
import { appendLog } from '$lib/utils/sessionLog';
import { PublishQueue, type PublishView } from './publishQueue';
import { PublishQueueStore, type QueuedPost } from './publishQueueStore';

class PublishQueueViews {
  /** One line per queued post, oldest first: what the progress line draws. */
  views = $state<PublishView[]>([]);
}

/** The reactive state of the progress line. */
export const publishQueueState = new PublishQueueViews();

interface Running {
  userId: string;
  store: PublishQueueStore;
  queue: PublishQueue;
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

/** One pass per account across tabs, through the Web Locks API where the engine has it. */
function lockFor(userId: string) {
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks) return fn();
    return locks.request(`canari-publish-queue-${userId}`, fn) as Promise<T>;
  };
}

/** Starts the queue of `userId` (a no-op when it already runs) and drains what it holds. */
export function startPublishQueue(userId: string): void {
  if (running?.userId === userId) return;
  stopPublishQueue();
  const store = new PublishQueueStore(userId);
  const media = new MediaService();
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
        getToken,
        a.dims,
        'archive',
        { state: a.state, persist: a.persist, encoding: a.encoding },
        a.transport
      ),
    release: (uploadId) =>
      media.releaseResumableUpload(uploadId, getToken, 'post deleted from the publish queue'),
    createPost: (payload) => createPost(payload),
    assertNotMuted,
    failureMessage: (error) => publishFailureMessage(error, m.post_create_publish_error()),
    lock: lockFor(userId),
    sleep,
    onViews: (views) => {
      publishQueueState.views = views;
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
  running = {
    userId,
    store,
    queue,
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
  appendLog(`[PUBLISH-QUEUE] started`);
  void queue.drain();
}

/** Stops the running queue (sign-out). What it holds stays on the device for the next sign-in. */
export function stopPublishQueue(): void {
  if (!running) return;
  const { queue, store, unsubscribe } = running;
  running = null;
  queue.stop();
  for (const off of unsubscribe) off();
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
  void running!.queue.drain();
}

/** The member's Retry on a post that stopped. */
export function retryQueuedPost(postId: string): Promise<void> {
  return running?.queue.retry(postId) ?? Promise.resolve();
}

/** The member's Delete on a queued post. */
export function deleteQueuedPost(postId: string): Promise<void> {
  return running?.queue.remove(postId) ?? Promise.resolve();
}

/** Calls `listener` each time a queued post is published; returns the unsubscribe. */
export function onPostPublished(listener: (post: QueuedPost) => void): () => void {
  publishedListeners.add(listener);
  return () => publishedListeners.delete(listener);
}
