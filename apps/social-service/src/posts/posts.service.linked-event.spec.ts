import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';

/**
 * A LINKED EVENT DISAPPEARED ON REFRESH BECAUSE THE FEED NEVER ASKED FOR IT.
 *
 * Reported by a user: an association post showed its linked agenda event right after creating or
 * editing it (that path runs through `toPublicPostFromEntity`, which loads the full TypeORM
 * entity and separately attaches `linkedCalendarEvent`), but the field vanished the moment the
 * page was reloaded - because `listPosts` and `searchPosts` build their rows from a raw SQL
 * `selectBody` that never named `linkedCalendarEventId` at all. The column simply never reached
 * the row, so there was never anything to attach a summary to.
 *
 * Same shape as the `anonymous` column bug this file's sibling (`anonymous-list.spec.ts`) already
 * pins, and the same reason these assert on the SQL text and not just on a hand-built fixture.
 */
describe("PostsService feed queries carry a post's linked calendar event", () => {
  const LINKED_POST = {
    id: 'p1',
    authorId: 'officer-1',
    anonymous: false,
    associationId: 'asso-1',
    linkedCalendarEventId: 'event-1',
    markdown: 'Le bureau des eleves organise...',
    mentions: [],
    links: null,
    attachedFormId: null,
    images: [],
    polls: [],
    forms: [],
    reactions: [],
    pinned: false,
    scheduledAt: null,
    hiddenByModeration: false,
    commentCount: 0,
    comments: [],
    assocJoinId: 'asso-1',
    assocName: 'BDE',
    assocSlug: 'bde',
    assocLogoUrl: null,
  };

  const EVENT_SUMMARY = { id: 'event-1', title: 'Soiree de rentree', associationSlug: 'bde' };

  function makeQueryMock() {
    const calls: string[] = [];
    const query = jest.fn((sql: string) => {
      calls.push(sql);
      if (sql.includes('FROM posts')) return Promise.resolve([{ ...LINKED_POST }]);
      if (sql.includes('SELECT promo FROM users')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    return { query, calls };
  }

  function makeService(query: jest.Mock, summary: unknown = EVENT_SUMMARY) {
    const postRepo = { manager: { query } };
    const findValidatedCalendarEventSummary = jest.fn(() => Promise.resolve(summary));
    const associations = {
      mayActOnAny: jest.fn(() => Promise.resolve(new Set<string>())),
      isContentModerator: jest.fn(() => Promise.resolve(false)),
      findValidatedCalendarEventSummary,
    };
    const service = new PostsService(
      postRepo as unknown as Repository<Post>,
      { get: jest.fn(), setex: jest.fn() } as unknown as RedisService,
      {} as FollowsService,
      associations as unknown as AssociationsService,
      {} as PostNotificationsService
    );
    return { service, findValidatedCalendarEventSummary };
  }

  it('selects linkedCalendarEventId, so a refresh has something to attach a summary to', async () => {
    const { query, calls } = makeQueryMock();
    const { service } = makeService(query);

    await service.listPosts({ limit: 10, offset: 0, feed: 'all' });

    const feedQuery = calls.find((sql) => sql.includes('FROM posts'));
    expect(feedQuery).toMatch(/"linkedCalendarEventId"/);
  });

  it('attaches the event summary onto the post row', async () => {
    const { query } = makeQueryMock();
    const { service, findValidatedCalendarEventSummary } = makeService(query);

    const [row] = await service.listPosts({ limit: 10, offset: 0, feed: 'all' });

    expect(findValidatedCalendarEventSummary).toHaveBeenCalledWith('event-1');
    expect(row.linkedCalendarEvent).toEqual(EVENT_SUMMARY);
  });

  it('fetches one summary per distinct event, not once per post', async () => {
    const { calls } = makeQueryMock();
    const twoPostsSameEvent = jest.fn((sql: string) => {
      calls.push(sql);
      if (sql.includes('FROM posts')) {
        return Promise.resolve([
          { ...LINKED_POST, id: 'p1' },
          { ...LINKED_POST, id: 'p2' },
        ]);
      }
      return Promise.resolve([]);
    });
    const { service, findValidatedCalendarEventSummary } = makeService(twoPostsSameEvent);

    const rows = await service.listPosts({ limit: 10, offset: 0, feed: 'all' });

    expect(findValidatedCalendarEventSummary).toHaveBeenCalledTimes(1);
    expect(rows.map((r: { linkedCalendarEvent: unknown }) => r.linkedCalendarEvent)).toEqual([
      EVENT_SUMMARY,
      EVENT_SUMMARY,
    ]);
  });

  it('carries null rather than a stale summary when the event no longer validates', async () => {
    const { query } = makeQueryMock();
    const { service } = makeService(query, null);

    const [row] = await service.listPosts({ limit: 10, offset: 0, feed: 'all' });

    expect(row.linkedCalendarEvent).toBeNull();
  });

  it('searchPosts selects linkedCalendarEventId and attaches the summary too', async () => {
    const { query, calls } = makeQueryMock();
    const { service } = makeService(query);

    const [row] = await service.searchPosts('rentree', 20, 0);

    const searchQuery = calls.find((sql) => sql.includes('FROM posts'));
    expect(searchQuery).toMatch(/"linkedCalendarEventId"/);
    expect(row.linkedCalendarEvent).toEqual(EVENT_SUMMARY);
  });
});
