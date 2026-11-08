/// <reference types="jest" />

import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';
import { CALENDAR_NEUTRAL_ERROR_CODES } from '../associations/event-presentation';

/**
 * A POST'S AGENDA LINK IS RESOLVED UNDER THE EVENT'S LOCK, IN THE TRANSACTION THAT WRITES THE POST
 * (`saveWithEventLink`).
 *
 * The defect this pins (adversarial review of the neutral campus events, 2026-11-08): the link was
 * checked BEFORE the insert, outside any transaction. A presentation switch landing between the two
 * asked "does a post link this event?", saw no post (not committed yet), turned the event neutral -
 * and the post then committed, naming the BDE under an event that hides it. Resolving inside the
 * post's transaction, the event read `FOR SHARE` against the switch's `FOR NO KEY UPDATE`, makes the
 * two exclusive: whichever commits second sees the first and is refused.
 */
describe('PostsService: a post links an agenda event under the event lock', () => {
  const ASSO = 'asso-1';

  function makeService(resolve: jest.Mock) {
    const txRepo = {
      save: jest.fn((post: Partial<Post>) => Promise.resolve({ id: 'p1', ...post })),
    };
    const txManager = { getRepository: jest.fn(() => txRepo) };
    const postRepo = {
      create: jest.fn((data: Partial<Post>) => ({ ...data })),
      save: jest.fn((post: Partial<Post>) => Promise.resolve({ id: 'p1', ...post })),
      manager: {
        transaction: jest.fn((work: (m: unknown) => unknown) => work(txManager)),
        query: jest.fn(() => Promise.resolve([])),
      },
    };
    const associations = {
      mayActOnAny: jest.fn(() => Promise.resolve(new Set<string>())),
      isContentModerator: jest.fn(() => Promise.resolve(false)),
      moderatedPostIds: () => Promise.resolve(new Set<string>()),
      mayModeratePost: () => Promise.resolve(false),
      resolvePostCalendarEventLink: resolve,
      findValidatedCalendarEventSummary: jest.fn(() => Promise.resolve(null)),
    };
    const service = new PostsService(
      postRepo as unknown as Repository<Post>,
      {
        del: jest.fn(),
        setex: jest.fn(),
        get: jest.fn(),
        incr: jest.fn(() => Promise.resolve(1)),
        deleteByPattern: jest.fn(() => Promise.resolve(0)),
      } as unknown as RedisService,
      {} as FollowsService,
      associations as unknown as AssociationsService,
      { resolveMentionedUserIds: () => [] } as unknown as PostNotificationsService,
      { release: jest.fn() } as unknown as PostMediaRetentionService
    );
    return { service, postRepo, txRepo, txManager };
  }

  const linked = {
    markdown: 'Soiree',
    associationId: ASSO,
    authorId: 'officer',
    linkedCalendarEventId: ' ev-1 ',
  };

  it('resolves the link with the write transaction and saves through it', async () => {
    const resolve = jest.fn(() => Promise.resolve('ev-1'));
    const { service, postRepo, txRepo, txManager } = makeService(resolve);
    await service.createPost({ ...linked }, false);
    expect(resolve).toHaveBeenCalledWith(ASSO, ' ev-1 ', txManager);
    expect(txRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ linkedCalendarEventId: 'ev-1' })
    );
    expect(postRepo.save).not.toHaveBeenCalled();
  });

  it('writes nothing when the event turned neutral first', async () => {
    const refusal = new BadRequestException({ code: CALENDAR_NEUTRAL_ERROR_CODES.LINKED_POST });
    const resolve = jest.fn(() => Promise.reject(refusal));
    const { service, postRepo, txRepo } = makeService(resolve);
    await expect(service.createPost({ ...linked }, false)).rejects.toBe(refusal);
    expect(txRepo.save).not.toHaveBeenCalled();
    expect(postRepo.save).not.toHaveBeenCalled();
  });

  it('opens no transaction for a post that links nothing', async () => {
    const resolve = jest.fn();
    const { service, postRepo } = makeService(resolve);
    await service.createPost({ markdown: 'Rien', associationId: ASSO, authorId: 'officer' }, false);
    expect(resolve).not.toHaveBeenCalled();
    expect(postRepo.manager.transaction).not.toHaveBeenCalled();
    expect(postRepo.save).toHaveBeenCalled();
  });
});
