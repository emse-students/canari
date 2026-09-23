/**
 * The two deletions that have to release feed media, and what each one owes.
 *
 * Archiving a post's media takes them out of the idle sweep, so the sweep is no longer what
 * reclaims them. Deleting the row is - and only if the delete says so. These cases pin the exact
 * set each one hands over, because the interesting failures are all partial: a post that releases
 * its own pictures but not its comments', or a comment that releases its own but not its replies'.
 */
import { PostsService } from './posts.service';
import { PostInteractionsService } from './post-interactions.service';
import type { Repository } from 'typeorm';
import type { Post } from './entities/post.entity';
import type { RedisService } from '../common/redis/redis.service';
import type { FollowsService } from '../follows/follows.service';
import type { AssociationsService } from '../associations/associations.service';
import type { PostNotificationsService } from './post-notifications.service';
import type { PostMediaRetentionService } from './post-media-retention.service';
import type { PushService } from '../push/push.service';

const POST_MEDIA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMMENT_MEDIA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REPLY_MEDIA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_MEDIA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const AUTHOR = 'author-1';

describe('PostsService.deletePost', () => {
  function makeService(post: Partial<Post>) {
    const release = jest.fn(() => Promise.resolve());
    const postRepo = {
      findOne: jest.fn(() => Promise.resolve(post)),
      remove: jest.fn(() => Promise.resolve(post)),
    };
    const service = new PostsService(
      postRepo as unknown as Repository<Post>,
      { del: jest.fn(), setex: jest.fn(), get: jest.fn() } as unknown as RedisService,
      {} as FollowsService,
      {
        isContentModerator: () => Promise.resolve(false),
      } as unknown as AssociationsService,
      {} as PostNotificationsService,
      { release } as unknown as PostMediaRetentionService
    );
    return { service, postRepo, release };
  }

  it('releases the post media AND its comments media, in one call', async () => {
    const { service, release } = makeService({
      id: 'post-1',
      authorId: AUTHOR,
      media: [{ mediaId: POST_MEDIA }],
      comments: [{ id: 'c1', media: { mediaId: COMMENT_MEDIA } }],
    } as Partial<Post>);

    await service.deletePost('post-1', AUTHOR, false);

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith([POST_MEDIA, COMMENT_MEDIA]);
  });

  it('releases AFTER the row is gone, never as a precondition of deleting it', async () => {
    const order: string[] = [];
    const post = { id: 'post-1', authorId: AUTHOR, media: [{ mediaId: POST_MEDIA }], comments: [] };
    const release = jest.fn(() => {
      order.push('release');
      return Promise.resolve();
    });
    const postRepo = {
      findOne: jest.fn(() => Promise.resolve(post)),
      remove: jest.fn(() => {
        order.push('remove');
        return Promise.resolve(post);
      }),
    };
    const service = new PostsService(
      postRepo as unknown as Repository<Post>,
      { del: jest.fn(), setex: jest.fn(), get: jest.fn() } as unknown as RedisService,
      {} as FollowsService,
      { isContentModerator: () => Promise.resolve(false) } as unknown as AssociationsService,
      {} as PostNotificationsService,
      { release } as unknown as PostMediaRetentionService
    );

    await service.deletePost('post-1', AUTHOR, false);

    // The post is deleted whatever the media service says; the retention call cannot hold it back.
    expect(order).toEqual(['remove', 'release']);
  });

  it('asks for no release when the post carried nothing', async () => {
    const { service, release } = makeService({
      id: 'post-1',
      authorId: AUTHOR,
      media: [],
      comments: [],
    } as Partial<Post>);

    await service.deletePost('post-1', AUTHOR, false);

    expect(release).toHaveBeenCalledWith([]);
  });
});

describe('PostInteractionsService.deleteComment', () => {
  function makeService(comments: unknown[]) {
    const post = { id: 'post-1', comments } as unknown as Post;
    const release = jest.fn(() => Promise.resolve());
    const postRepo = {
      findOne: jest.fn(() => Promise.resolve(post)),
      save: jest.fn(() => Promise.resolve(post)),
    };
    const service = new PostInteractionsService(
      postRepo as unknown as Repository<Post>,
      {} as PostNotificationsService,
      {} as PushService,
      { release } as unknown as PostMediaRetentionService
    );
    return { service, post, release };
  }

  it("releases the comment's media and every reply's, because the replies go too", async () => {
    const { service, post, release } = makeService([
      { id: 'c1', userId: AUTHOR, media: { mediaId: COMMENT_MEDIA } },
      { id: 'r1', userId: 'someone-else', parentId: 'c1', media: { mediaId: REPLY_MEDIA } },
      { id: 'c2', userId: AUTHOR, media: { mediaId: OTHER_MEDIA } },
    ]);

    await service.deleteComment('post-1', 'c1', AUTHOR);

    // c2 survives on screen, so its media must NOT be released.
    expect(release).toHaveBeenCalledWith([COMMENT_MEDIA, REPLY_MEDIA]);
    expect((post.comments as { id: string }[]).map((c) => c.id)).toEqual(['c2']);
  });

  it('releases nothing when the deleted comment held no media', async () => {
    const { service, release } = makeService([
      { id: 'c1', userId: AUTHOR, text: 'plain' },
      { id: 'c2', userId: AUTHOR, media: { mediaId: OTHER_MEDIA } },
    ]);

    await service.deleteComment('post-1', 'c1', AUTHOR);

    expect(release).toHaveBeenCalledWith([]);
  });

  it('releases nothing when the caller is refused', async () => {
    const { service, release } = makeService([
      { id: 'c1', userId: 'somebody-else', media: { mediaId: COMMENT_MEDIA } },
    ]);

    await expect(service.deleteComment('post-1', 'c1', AUTHOR)).rejects.toThrow('Not your comment');
    expect(release).not.toHaveBeenCalled();
  });
});
