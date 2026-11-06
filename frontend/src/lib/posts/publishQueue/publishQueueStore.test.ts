/**
 * The publish queue's durable store over a real IndexedDB implementation (fake-indexeddb).
 *
 * Pinned: a post and its files land together; a record written after the member deleted the post
 * resurrects nothing; the prepared bytes replace the original in the same write as the record;
 * removing a post removes its files and no other post's; the device wipe's `deleteDatabase` is never
 * blocked by an open connection.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { PublishQueueStore, QueuedFileMissingError, type QueuedPost } from './publishQueueStore';

let n = 0;
const user = () => `user-${++n}`;

function post(id: string, media = 2): QueuedPost {
  return {
    id,
    queuedAt: n,
    payload: { markdown: id },
    media: Array.from({ length: media }, (_, i) => ({ name: `f${i}`, type: 'image/png', size: 3 })),
    landing: 'all',
  };
}
const file = (b: number) => new File([new Uint8Array([b, b, b])], `f${b}`, { type: 'image/png' });

describe('PublishQueueStore', () => {
  it('queues a post with its files, and lists the posts oldest first', async () => {
    const store = new PublishQueueStore(user());
    await store.enqueue({ ...post('b'), queuedAt: 2 }, [file(1), file(2)]);
    await store.enqueue({ ...post('a'), queuedAt: 1 }, [file(3), file(4)]);
    expect((await store.list()).map((p) => p.id)).toEqual(['a', 'b']);
    expect(new Uint8Array((await store.readFile('b', 1)).bytes)).toEqual(new Uint8Array([2, 2, 2]));
  });

  it('writes nothing for a post the member deleted meanwhile, and says so', async () => {
    const store = new PublishQueueStore(user());
    const p = post('gone');
    await store.enqueue(p, [file(1), file(2)]);
    await store.remove('gone');
    p.media[0].ref = {
      type: 'image',
      mediaId: 'm',
      key: 'k',
      iv: 'i',
      mimeType: 'image/png',
      size: 3,
    };
    expect(
      await store.update(p, { index: 0, file: { bytes: new ArrayBuffer(1), name: 'x', type: 'x' } })
    ).toBe(false);
    expect(await store.get('gone')).toBeNull();
    await expect(store.readFile('gone', 0)).rejects.toThrow(QueuedFileMissingError);
  });

  it("a runner's stale copy never erases the member's Delete or Pause, and learns them", async () => {
    const store = new PublishQueueStore(user());
    const p = post('marked', 1);
    await store.enqueue(p, [file(1)]);
    const stale = (await store.get('marked'))!;
    await store.mark('marked', { withdrawn: true, paused: true });
    stale.createSent = true;
    expect(await store.update(stale)).toBe(true);
    const stored = (await store.get('marked'))!;
    expect(stored.withdrawn).toBe(true);
    expect(stored.paused).toBe(true);
    expect(stored.createSent).toBe(true);
    expect(stale.withdrawn).toBe(true);
    // Only the member's own mark clears them.
    await store.mark('marked', { paused: false, clearFailure: true });
    expect((await store.get('marked'))!.paused).toBeUndefined();
    expect(await store.mark('nobody', { paused: true })).toBeNull();
  });

  it('replaces the original by the prepared file in the same write as the record', async () => {
    const store = new PublishQueueStore(user());
    const p = post('p');
    await store.enqueue(p, [file(1), file(2)]);
    p.media[1].prepared = { name: 'f2.webp', type: 'image/webp', size: 1 };
    const ok = await store.update(p, {
      index: 1,
      file: { bytes: new Uint8Array([7]).buffer, name: 'f2.webp', type: 'image/webp' },
    });
    expect(ok).toBe(true);
    expect((await store.get('p'))!.media[1].prepared?.type).toBe('image/webp');
    const prepared = await store.readFile('p', 1);
    expect(prepared.type).toBe('image/webp');
    expect(new Uint8Array(prepared.bytes)).toEqual(new Uint8Array([7]));
  });

  it("removes a post's files and no other post's", async () => {
    const store = new PublishQueueStore(user());
    await store.enqueue(post('p1'), [file(1), file(2)]);
    await store.enqueue(post('p10'), [file(3), file(4)]);
    await store.remove('p1');
    await expect(store.readFile('p1', 0)).rejects.toThrow(QueuedFileMissingError);
    expect(new Uint8Array((await store.readFile('p10', 0)).bytes)).toEqual(
      new Uint8Array([3, 3, 3])
    );
  });

  it('closes itself for the device wipe: deleteDatabase completes with the store open', async () => {
    const id = user();
    const store = new PublishQueueStore(id);
    await store.enqueue(post('p'), [file(1), file(2)]);
    const deleted = await new Promise<string>((resolve) => {
      const req = indexedDB.deleteDatabase(`CanariDBPublish_${id}`);
      req.onsuccess = () => resolve('deleted');
      req.onblocked = () => resolve('blocked');
    });
    expect(deleted).toBe('deleted');
    // And the next use opens a fresh, empty database.
    expect(await store.list()).toEqual([]);
  });
});
