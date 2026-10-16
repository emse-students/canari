import { jsonStringLikePattern, scrubComments, scrubPolls } from './account-erasure';
import { InternalController } from './internal.controller';
import { ERASURE_STATEMENTS, WRITE_SCRUBBED_POST_SQL } from './account-erasure';

/**
 * WHAT AN ERASED ACCOUNT LEFT ON OTHER PEOPLE'S POSTS: its comments, its likes, its poll votes.
 *
 * These live inside `posts.comments` and `posts.polls` (JSONB), which no column-level statement can
 * reach - so they were simply never touched, and a deleted member's comments stayed on every post
 * they had commented, with their name copied into each one.
 */
describe('scrubComments', () => {
  const ME = 'erased';
  const comment = (
    id: string,
    userId: string,
    parentId: string | null = null,
    likes: string[] = []
  ) => ({
    id,
    userId,
    parentId,
    likes,
    displayName: `name-of-${userId}`,
    text: `text-${id}`,
  });

  it('removes the account comments, with the name each one carried', () => {
    const { comments, changed } = scrubComments([comment('c1', ME), comment('c2', 'other')], ME);
    expect(changed).toBe(true);
    expect(comments).toEqual([comment('c2', 'other')]);
    expect(JSON.stringify(comments)).not.toContain(`name-of-${ME}`);
  });

  it('keeps somebody else reply to a removed comment, re-parented to the nearest survivor', () => {
    const { comments } = scrubComments(
      [
        comment('top', 'other'),
        comment('mine', ME, 'top'),
        comment('mine-too', ME, 'mine'),
        comment('reply', 'third', 'mine-too'),
        comment('orphan', 'third', 'mine'),
      ],
      ME
    ) as { comments: Array<{ id: string; parentId: string | null }> };
    expect(comments.map((c) => [c.id, c.parentId])).toEqual([
      ['top', null],
      ['reply', 'top'],
      ['orphan', 'top'],
    ]);
  });

  it('moves a reply to the top level when every ancestor was the account', () => {
    const { comments } = scrubComments(
      [comment('mine', ME), comment('reply', 'x', 'mine')],
      ME
    ) as {
      comments: Array<{ parentId: string | null }>;
    };
    expect(comments[0].parentId).toBeNull();
  });

  it('removes the account like from somebody else comment', () => {
    const { comments } = scrubComments([comment('c', 'other', null, [ME, 'friend'])], ME) as {
      comments: Array<{ likes: string[] }>;
    };
    expect(comments[0].likes).toEqual(['friend']);
  });

  it('reports no change on a post the account never touched, so it is not rewritten', () => {
    expect(scrubComments([comment('c', 'other', null, ['friend'])], ME).changed).toBe(false);
    expect(scrubComments(null, ME).changed).toBe(false);
  });

  it('cannot loop on a cycle in stored data', () => {
    const { comments } = scrubComments(
      [comment('a', ME, 'b'), comment('b', ME, 'a'), comment('r', 'x', 'a')],
      ME
    ) as { comments: Array<{ parentId: string | null }> };
    expect(comments).toHaveLength(1);
    expect(comments[0].parentId).toBeNull();
  });
});

describe('scrubPolls', () => {
  const ME = 'erased';

  it('takes the account vote out of a NAMED poll: the tally drops by one', () => {
    const { polls, changed } = scrubPolls(
      [
        {
          id: 'p',
          options: [
            { id: 'a', votes: [ME, 'x'] },
            { id: 'b', votes: ['y'] },
          ],
          votesByUser: { [ME]: ['a'], x: ['a'], y: ['b'] },
        },
      ],
      ME
    ) as { polls: Array<Record<string, any>>; changed: boolean };
    expect(changed).toBe(true);
    expect(polls[0].options[0].votes).toEqual(['x']);
    expect(polls[0].options[1].votes).toEqual(['y']);
    expect(polls[0].votesByUser).toEqual({ x: ['a'], y: ['b'] });
  });

  it('keeps an ANONYMOUS tally - nothing says which option was theirs - and drops them from voters', () => {
    const { polls } = scrubPolls(
      [{ id: 'p', anonymous: true, options: [{ id: 'a', votes: 3 }], voters: ['x', ME, 'z'] }],
      ME
    ) as { polls: Array<Record<string, any>> };
    expect(polls[0].options[0].votes).toBe(3);
    expect(polls[0].voters).toEqual(['x', 'z']);
  });

  it('reports no change on a poll the account never voted on', () => {
    expect(
      scrubPolls([{ id: 'p', options: [{ id: 'a', votes: ['x'] }], votesByUser: { x: ['a'] } }], ME)
        .changed
    ).toBe(false);
  });
});

describe('jsonStringLikePattern', () => {
  it('matches the id as a whole JSON string and escapes LIKE metacharacters', () => {
    expect(jsonStringLikePattern('abc')).toBe('%"abc"%');
    expect(jsonStringLikePattern('a_b%c')).toBe('%"a\\_b\\%c"%');
  });
});

/**
 * The route as the erasure queue calls it: workspaces first (which may throw), then ONE transaction,
 * then the feed cache - and a failure before the transaction leaves the transaction unrun, so the
 * retry starts from a consistent state.
 */
describe('InternalController.deleteUserData', () => {
  const SECRET = 'erasure-secret';

  function make(opts: { workspacesFail?: boolean; candidates?: unknown[] } = {}) {
    process.env.INTERNAL_SECRET = SECRET;
    const queries: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        queries.push(sql);
        if (sql.trim().startsWith('SELECT')) return opts.candidates ?? [];
        return [[], 1];
      }),
    };
    const postRepo = {
      manager: {
        query: manager.query,
        transaction: jest.fn(async (cb: (m: typeof manager) => unknown) => cb(manager)),
      },
    };
    const postMediaRetention = { keepForAssociation: jest.fn(async () => undefined) };
    const channelService = {
      removeAccountFromWorkspaces: jest.fn(async () => {
        if (opts.workspacesFail) throw new Error('account removal incomplete: 1/1');
        return 2;
      }),
      announceErasedPins: jest.fn(async () => 0),
    };
    const redis = { deleteByPattern: jest.fn(async () => 0) };
    const controller = new InternalController(
      postRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      channelService as never,
      redis as never,
      postMediaRetention as never
    );
    return { controller, queries, postRepo, channelService, manager };
  }

  it('runs every statement and the reaction removal inside one transaction', async () => {
    const { controller, queries, postRepo } = make();
    await expect(controller.deleteUserData('erased', SECRET)).resolves.toEqual({ ok: true });

    expect(postRepo.manager.transaction).toHaveBeenCalledTimes(1);
    for (const s of ERASURE_STATEMENTS) expect(queries).toContain(s.sql);
  });

  it('rewrites only the posts the account actually touched', async () => {
    const { controller, manager } = make({
      candidates: [
        { id: 'touched', comments: [{ id: 'c', userId: 'erased' }], polls: [] },
        // The LIKE filter is a candidate filter: a mention in text is not a comment of theirs.
        { id: 'untouched', comments: [{ id: 'c', userId: 'x', text: '"erased"' }], polls: [] },
      ],
    });
    await controller.deleteUserData('erased', SECRET);

    const writes = manager.query.mock.calls.filter(
      ([sql]) => String(sql) === WRITE_SCRUBBED_POST_SQL
    );
    expect(writes).toHaveLength(1);
    expect(writes[0][1]?.[0]).toBe('touched');
  });

  it('throws before the transaction when a community could not be processed, so the queue retries', async () => {
    const { controller, postRepo } = make({ workspacesFail: true });
    await expect(controller.deleteUserData('erased', SECRET)).rejects.toThrow(/incomplete/);
    expect(postRepo.manager.transaction).not.toHaveBeenCalled();
  });
});
