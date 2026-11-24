// @vitest-environment happy-dom
/**
 * `enqueuePost`: THE WRITE IS THE SUCCESS POINT. Once the post and its files are on the device it is
 * queued - a redraw that fails after it is logged, and the caller is told it succeeded, because a
 * composer kept open on a queued post would queue it a second time (review of #4055).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const enqueued: string[] = [];
let enqueueFails = false;
let refreshFails = false;
const drained = vi.fn();

vi.mock('./publishQueueStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./publishQueueStore')>()),
  PublishQueueStore: class {
    async enqueue(post: { id: string }) {
      if (enqueueFails) throw new Error('QuotaExceededError');
      enqueued.push(post.id);
    }
    async close() {}
  },
}));
vi.mock('./publishQueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./publishQueue')>()),
  PublishQueue: class {
    async refreshViews() {
      if (refreshFails) throw new Error('the store could not be listed');
    }
    drain() {
      drained();
      return Promise.resolve();
    }
    stop() {}
    wake() {}
  },
}));

import { enqueuePost, stopPublishQueue } from './publishQueue.svelte';
import type { QueuedPost } from './publishQueueStore';

const post = (id: string): QueuedPost => ({
  id,
  queuedAt: 1,
  payload: { markdown: 'x' },
  media: [],
  landing: 'all',
});

afterEach(() => {
  stopPublishQueue();
  enqueued.length = 0;
  enqueueFails = false;
  refreshFails = false;
  drained.mockReset();
});

describe('enqueuePost', () => {
  it('a redraw that fails AFTER the write still resolves - the post is queued and sent', async () => {
    refreshFails = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(enqueuePost('alice', post('p-1'), [])).resolves.toBeUndefined();
    expect(enqueued).toEqual(['p-1']);
    expect(drained).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('p-1 queued, but its row could not be drawn'),
      expect.any(Error)
    );
    error.mockRestore();
  });

  it('a write that fails rejects: nothing is queued, the composer keeps everything', async () => {
    enqueueFails = true;
    await expect(enqueuePost('alice', post('p-2'), [])).rejects.toThrow('QuotaExceededError');
    expect(enqueued).toEqual([]);
  });
});
