/**
 * The cap on a post's attachments (owner, 2026-11-02), at the write funnel every controller goes
 * through: ten are accepted, eleven are refused with the typed code, on create and on edit - and a
 * legacy post already over the cap is never stranded.
 */
import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import type { Post } from './entities/post.entity';
import type { RedisService } from '../common/redis/redis.service';
import type { FollowsService } from '../follows/follows.service';
import type { AssociationsService } from '../associations/associations.service';
import type { PostNotificationsService } from './post-notifications.service';
import type { PostMediaRetentionService } from './post-media-retention.service';

function makeService(existing?: Partial<Post>) {
  const saved: Array<Record<string, unknown>> = [];
  const postRepo = {
    create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
    save: jest.fn((post: Record<string, unknown>) => {
      saved.push({ ...post });
      return Promise.resolve({ id: 'p1', ...post });
    }),
    findOne: jest.fn(() => Promise.resolve(existing)),
    manager: {
      query: jest.fn((sql: string) =>
        Promise.resolve(sql.includes('AS visible') ? [{ visible: true }] : [])
      ),
    },
  };
  const service = new PostsService(
    postRepo as unknown as Repository<Post>,
    {
      setex: jest.fn(),
      get: jest.fn(),
      deleteByPattern: jest.fn(() => Promise.resolve(0)),
    } as unknown as RedisService,
    {} as FollowsService,
    {
      isContentModerator: () => Promise.resolve(true),
      mayActOnAny: () => Promise.resolve(new Set()),
    } as unknown as AssociationsService,
    { resolveMentionedUserIds: () => [] } as unknown as PostNotificationsService,
    { release: jest.fn() } as unknown as PostMediaRetentionService
  );
  return { service, saved };
}

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    type: 'file',
    mediaId: `m${i}`,
    key: 'k',
    iv: 'i',
    mimeType: 'application/pdf',
    size: 1,
  }));

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e
  );

describe('createPost and the attachment cap', () => {
  it('accepts 10 attachments', async () => {
    const { service, saved } = makeService();
    await service.createPost({ markdown: 'x', authorId: 'a', media: items(10) }, false);
    expect(saved).toHaveLength(1);
  });

  it('refuses 11 with the typed code, from `media` and from the legacy `images`', async () => {
    const { service, saved } = makeService();
    for (const key of ['media', 'images']) {
      const e = await refusal(
        service.createPost({ markdown: 'x', authorId: 'a', [key]: items(11) }, false)
      );
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as BadRequestException).getResponse()).toMatchObject({
        code: 'POST_ATTACHMENTS_TOO_MANY',
      });
    }
    expect(saved).toHaveLength(0);
  });
});

describe('updatePost and the attachment cap', () => {
  const stored = (n: number): Partial<Post> => ({
    id: 'p1',
    authorId: 'a',
    markdown: 'x',
    media: items(n),
    createdAt: new Date(),
    publishedAt: new Date(),
  });

  it('accepts 10 and refuses 11 on an edit', async () => {
    const ok = makeService(stored(2));
    await ok.service.updatePost('p1', 'a', { markdown: 'x', media: items(10) });
    expect(ok.saved).toHaveLength(1);

    const over = makeService(stored(2));
    const e = await refusal(
      over.service.updatePost('p1', 'a', { markdown: 'x', media: items(11) })
    );
    expect((e as BadRequestException).getResponse()).toMatchObject({
      code: 'POST_ATTACHMENTS_TOO_MANY',
    });
    expect(over.saved).toHaveLength(0);
  });

  it('refuses 11 sent under the legacy `images` too', async () => {
    const { service } = makeService(stored(1));
    const e = await refusal(service.updatePost('p1', 'a', { markdown: 'x', images: items(11) }));
    expect(e).toBeInstanceOf(BadRequestException);
  });

  it('still edits a legacy post that holds 12, as long as it does not grow', async () => {
    const same = makeService(stored(12));
    await same.service.updatePost('p1', 'a', { markdown: 'edited', media: items(12) });
    expect(same.saved).toHaveLength(1);

    const grow = makeService(stored(12));
    await expect(
      grow.service.updatePost('p1', 'a', { markdown: 'x', media: items(13) })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
