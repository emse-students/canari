import {
  jsonStringLikePattern,
  mentionLikePattern,
  scrubComments,
  scrubPolls,
} from './account-erasure';
import { InternalController } from './internal.controller';
import {
  ERASURE_TIER_ORDER,
  ERASED_PINS_SQL,
  ERASURE_ASSOCIATION_LOCK_SQL,
  ERASURE_PROPOSAL_STATEMENTS,
  ERASURE_ROW_STATEMENTS,
  ERASURE_STATEMENTS,
  WRITE_SCRUBBED_POST_SQL,
} from './account-erasure';
import { PROPOSAL_VOIDED_BY } from '../proposals/proposal.entity';

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

  it('keeps a comment written as an association and lets go of the account only', () => {
    const asAsso = { ...comment('c1', ME), associationId: 'asso-1' };
    const { comments, changed } = scrubComments([asAsso, comment('c2', ME)], ME);
    expect(changed).toBe(true);
    expect(comments).toEqual([
      expect.objectContaining({ id: 'c1', userId: '', associationId: 'asso-1' }),
    ]);
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

describe('mentions of the erased account', () => {
  it('rewrites the token in somebody else comment text, any case, and leaves other mentions', () => {
    const { comments, changed } = scrubComments(
      [{ id: 'c', userId: 'x', text: 'hi @[ERASED] and @[other]', likes: [] }],
      'erased'
    ) as { comments: Array<{ text: string }>; changed: boolean };
    expect(changed).toBe(true);
    expect(comments[0].text).toBe('hi @[deleted] and @[other]');
  });

  it('escapes the id in the candidate pattern', () => {
    expect(mentionLikePattern('a_b')).toBe(String.raw`%@[a\_b]%`);
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

  it('writes no proposal before the last post lock: the scrub comes first (lockPostRow order)', async () => {
    const { controller, queries } = make({
      candidates: [{ id: 'touched', comments: [{ id: 'c', userId: 'erased' }], polls: [] }],
    });
    await controller.deleteUserData('erased', SECRET);
    const lastPostLock = queries.lastIndexOf(WRITE_SCRUBBED_POST_SQL);
    const firstProposalWrite = queries.findIndex((q) =>
      ERASURE_PROPOSAL_STATEMENTS.some((s) => s.sql === q)
    );
    expect(lastPostLock).toBeGreaterThan(-1);
    expect(firstProposalWrite).toBeGreaterThan(lastPostLock);
    // No statement of the head names the proposals table.
    expect(ERASURE_ROW_STATEMENTS.filter((s) => /\bproposals\b/.test(s.sql))).toEqual([]);
  });

  it('raises the access revision of every salon whose allowlist it drops the name from', () => {
    // An access write like any other: a settings panel still showing the name must be refused.
    const drop = ERASURE_ROW_STATEMENTS.find((s) => s.label === 'channel_allowed_users');
    expect(drop?.sql).toMatch(/"accessRevision"\s*=\s*"accessRevision"\s*\+\s*1/);
  });

  it('locks its associations before any other statement of the transaction (the remove order)', async () => {
    const { controller, queries } = make();
    await controller.deleteUserData('erased', SECRET);
    const lock = queries.indexOf(ERASURE_ASSOCIATION_LOCK_SQL);
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(queries.indexOf(ERASED_PINS_SQL));
    expect(lock).toBeLessThan(
      queries.findIndex((q) => ERASURE_STATEMENTS.some((s) => s.sql === q))
    );
    expect(ERASURE_ASSOCIATION_LOCK_SQL).toMatch(/ORDER BY a\.id\s+FOR NO KEY UPDATE OF a$/);
    // What hangs off a post or a form row the erasure deletes is a source too.
    expect(ERASURE_ASSOCIATION_LOCK_SQL).toMatch(/JOIN posts p ON p\.id = pr\."postId"/);
    expect(ERASURE_ASSOCIATION_LOCK_SQL).toMatch(/FROM form_respondents fr/);
  });

  it('voids with the decidedBy the proposals service writes', () => {
    const voided = ERASURE_PROPOSAL_STATEMENTS.find((s) => s.label === 'proposals_voided');
    expect(voided?.sql).toContain(`'${PROPOSAL_VOIDED_BY}'`);
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

describe('the erasure order against the tier paths', () => {
  const at = (label: string) => ERASURE_ROW_STATEMENTS.findIndex((st) => st.label === label);

  // A settlement locks its checkout row, inserts its purchase record, writes a tag; a closing locks
  // its record, writes a tag. The erasure must take them in THAT order: records before checkouts
  // would miss a record still uncommitted and leave it the real id; tags first would deadlock.
  it('rewrites product_checkouts, then purchase_records, then deletes user_tags - in that order', () => {
    const positions = ERASURE_TIER_ORDER.map(at);
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    expect(ERASURE_TIER_ORDER).toEqual(['product_checkouts', 'purchase_records', 'user_tags']);
  });

  it('names every table it orders exactly once', () => {
    for (const label of ERASURE_TIER_ORDER) {
      expect(ERASURE_ROW_STATEMENTS.filter((st) => st.label === label)).toHaveLength(1);
    }
  });
});
