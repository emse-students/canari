/**
 * The CanaReels publish step's hand-over to the publish queue: what it writes on the device is what
 * the queue will send - the take with its camera preparation, the post's payload, an id minted
 * once, the chat take that adopts its upload. Sending it is the queue's (`publishQueue.test.ts`).
 */
import { describe, expect, it, vi } from 'vitest';
import { ANONYMOUS_POST_IDENTITY } from '$lib/posts/postComposerDraft';
import type { QueuedPost } from '$lib/posts/publishQueue/publishQueueStore';
import {
  queueReelPublish,
  ReelPublishNoAccountError,
  type PublishReelDeps,
  type PublishReelInput,
} from './publishReel';

function deps(userId: string | null = 'alice') {
  const queued: Array<{ userId: string; post: QueuedPost; files: File[] }> = [];
  const d: PublishReelDeps = {
    userId: () => userId,
    enqueue: vi.fn(async (u: string, post: QueuedPost, files: File[]) => {
      queued.push({ userId: u, post, files });
    }),
  };
  return { d, queued };
}

function input(over: Partial<PublishReelInput> = {}): PublishReelInput {
  return {
    clip: { blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }), source: 'camera' },
    caption: 'hello',
    identity: '',
    maxDurationMs: 90_000,
    ...over,
  };
}

describe('queueReelPublish', () => {
  it('queues the take with the camera preparation and the payload, under one minted id', async () => {
    const { d, queued } = deps();
    const id = await queueReelPublish(input(), d);
    expect(queued).toHaveLength(1);
    const { userId, post, files } = queued[0];
    expect(userId).toBe('alice');
    expect(post.id).toBe(id);
    expect(post.payload).toEqual({ markdown: 'hello' });
    expect(post.media).toEqual([
      { name: 'canareel.mp4', type: 'video/mp4', size: 3, take: { maxDurationMs: 90_000 } },
    ]);
    expect(post.landing).toBe('all');
    expect(post.chatTakeId).toBeUndefined();
    expect(files[0].size).toBe(3);
  });

  it('records the removed sound, so a resume prepares the take silent too', async () => {
    const { d, queued } = deps();
    await queueReelPublish(
      input({
        clip: {
          blob: new Blob([new Uint8Array([1])], { type: 'video/mp4' }),
          source: 'camera',
          soundRemoved: true,
        },
      }),
      d
    );
    expect(queued[0].post.media[0].take).toEqual({ maxDurationMs: 90_000, removeAudio: true });
  });

  it('carries the chat take that adopts its upload (15.5)', async () => {
    const { d, queued } = deps();
    await queueReelPublish(input({ chatTakeId: 'take-1' }), d);
    expect(queued[0].post.chatTakeId).toBe('take-1');
  });

  it('queues a camera PHOTO as an ordinary post: no take preparation, no chat take', async () => {
    const { d, queued } = deps();
    await queueReelPublish(
      input({
        clip: { blob: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }), source: 'camera' },
        chatTakeId: 'take-1',
      }),
      d
    );
    expect(queued[0].post.media).toEqual([
      { name: 'camera-photo.jpg', type: 'image/jpeg', size: 1 },
    ]);
    expect(queued[0].post.chatTakeId).toBeUndefined();
  });

  it('publishes as an association or anonymously, with "Entre étudiants" and a reach where set', async () => {
    const { d, queued } = deps();
    await queueReelPublish(
      input({
        identity: 'asso-1',
        studentsOnly: true,
        reach: { spaces: ['s-1'], public: 'members' } as unknown as PublishReelInput['reach'],
      }),
      d
    );
    expect(queued[0].post.payload).toMatchObject({
      associationId: 'asso-1',
      studentsOnly: true,
      reach: { spaces: ['s-1'], public: 'members' },
    });
    expect(queued[0].post.landing).toBe('associations');
    await queueReelPublish(input({ identity: ANONYMOUS_POST_IDENTITY }), d);
    expect(queued[1].post.payload).toMatchObject({ anonymous: true });
  });

  it('queues nothing without an account, and says so with a type', async () => {
    const { d } = deps(null);
    await expect(queueReelPublish(input(), d)).rejects.toBeInstanceOf(ReelPublishNoAccountError);
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it('a write the device refuses is thrown to the step, which keeps the take', async () => {
    const { d } = deps();
    d.enqueue = vi.fn(async () => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    await expect(queueReelPublish(input(), d)).rejects.toThrow('full');
  });
});
