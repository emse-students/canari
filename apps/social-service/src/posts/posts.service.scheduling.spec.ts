import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';

/**
 * `getById` is the only read that serves a post outside a feed query, and every feed query
 * filters `scheduledAt`. Without the same filter here a queued post was readable - and
 * unfurlable - before its publication date.
 */
describe('PostsService.getById scheduling', () => {
  const HOUR = 3_600_000;

  function makeService(post: Partial<Post> | null) {
    const postRepo = {
      findOne: jest.fn(() => Promise.resolve(post)),
      manager: { query: jest.fn(() => Promise.resolve([])) },
    };
    const service = new PostsService(
      postRepo as unknown as Repository<Post>,
      {} as RedisService,
      {} as FollowsService,
      {} as AssociationsService,
      {} as PostNotificationsService
    );
    // getById shapes its result through the association-identity helper, which is not what
    // this spec is about: stub it so the assertions are only ever about the gate.
    jest
      .spyOn(
        service as unknown as { toPublicPostFromEntity: (p: Post) => Promise<unknown> },
        'toPublicPostFromEntity'
      )
      .mockImplementation((p: Post) => Promise.resolve({ ...p }));
    return service;
  }

  const scheduledAhead = {
    id: 'p1',
    authorId: 'author-1',
    markdown: 'Secret announcement',
    hiddenByModeration: false,
    scheduledAt: new Date(Date.now() + HOUR),
  } as Partial<Post>;

  it('hides a post scheduled for later from an unrelated reader', async () => {
    const service = makeService(scheduledAhead);
    await expect(service.getById('p1', { viewerId: 'someone-else' })).rejects.toThrow(
      NotFoundException
    );
  });

  it('hides it from an anonymous reader (no viewer id at all)', async () => {
    const service = makeService(scheduledAhead);
    await expect(service.getById('p1')).rejects.toThrow(NotFoundException);
  });

  it('still serves it to its author', async () => {
    const service = makeService(scheduledAhead);
    await expect(service.getById('p1', { viewerId: 'author-1' })).resolves.toMatchObject({
      id: 'p1',
    });
  });

  it('still serves it to a global admin', async () => {
    const service = makeService(scheduledAhead);
    await expect(service.getById('p1', { allowHidden: true })).resolves.toMatchObject({ id: 'p1' });
  });

  it('serves a post whose scheduled date has passed', async () => {
    const service = makeService({ ...scheduledAhead, scheduledAt: new Date(Date.now() - HOUR) });
    await expect(service.getById('p1', { viewerId: 'someone-else' })).resolves.toMatchObject({
      id: 'p1',
    });
  });

  it('serves an unscheduled post', async () => {
    const service = makeService({ ...scheduledAhead, scheduledAt: null });
    await expect(service.getById('p1', { viewerId: 'someone-else' })).resolves.toMatchObject({
      id: 'p1',
    });
  });
});
