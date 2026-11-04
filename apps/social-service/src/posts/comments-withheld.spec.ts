import {
  commentsWithheldPostIds,
  otherReactionCounts,
  withheldPolls,
  withheldReactions,
  withholdCommentsAndPeople,
} from './comments-withheld';
import type { EntityManager } from 'typeorm';

/**
 * WHAT A NAMED READER WITH COMMENTS WITHHELD IS HANDED OF ONE POST (owner, 2026-11-04): no comment,
 * no count, the reactions and the votes as totals - never an id but their own. Who that reader is,
 * is proven against PostgreSQL in `spaces/read-grants.integration.spec.ts`.
 */
describe('comments withheld from a grant-only reader', () => {
  const ME = 'me';

  it('counts the reactions of everybody else, by type, and never the reader twice', () => {
    expect(otherReactionCounts({ a: 'like', b: 'like', c: 'love', [ME]: 'like' }, ME)).toEqual({
      like: 2,
      love: 1,
    });
    expect(otherReactionCounts(undefined, ME)).toEqual({});
  });

  it('keeps the reader own reaction under their id and no other id', () => {
    const shaped = withheldReactions({ a: 'like', [ME]: 'love' }, ME);
    expect(shaped).toEqual({ reactions: { [ME]: 'love' }, otherReactionCounts: { like: 1 } });
    expect(withheldReactions({ a: 'like' }, ME).reactions).toEqual({});
  });

  it('turns a named poll into tallies, keeps the reader choice, and passes an anonymous one', () => {
    const named = {
      id: 'p',
      options: [
        { id: 'o1', votes: ['a', 'b', 'a'] },
        { id: 'o2', votes: [ME] },
      ],
      votesByUser: { a: ['o1'], b: ['o1'], [ME]: ['o2'] },
    };
    const anonymous = { id: 'q', anonymous: true, options: [{ id: 'o', votes: 3 }], voted: true };
    const [poll, anon] = withheldPolls([named, anonymous], ME) as any[];
    expect(poll.options.map((o: { votes: unknown }) => o.votes)).toEqual([2, 1]);
    expect(poll.votesByUser).toEqual({ [ME]: ['o2'] });
    expect(JSON.stringify(poll)).not.toMatch(/"a"|"b"/);
    expect(anon).toBe(anonymous);
  });

  it('strips the comments and the count, and says so with canSeeComments', () => {
    const post: Record<string, any> = {
      id: 'p1',
      comments: [{ id: 'c', userId: 'student', text: 'mine' }],
      commentCount: 1,
      reactions: { student: 'like', [ME]: 'like' },
      polls: [],
    };
    withholdCommentsAndPeople(post, ME);
    expect(post).not.toHaveProperty('comments');
    expect(post).not.toHaveProperty('commentCount');
    expect(post.reactions).toEqual({ [ME]: 'like' });
    expect(post.otherReactionCounts).toEqual({ like: 1 });
    expect(post.canSeeComments).toBe(false);
    expect(JSON.stringify(post)).not.toContain('student');
  });

  it('asks the one predicate once for a page, and nothing for no reader or no post', async () => {
    const query = jest.fn(() => Promise.resolve([{ id: 'p1' }]));
    const manager = { query } as unknown as EntityManager;
    expect(await commentsWithheldPostIds(manager, ['p1', 'p2'], ME)).toEqual(new Set(['p1']));
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('read_grant_readers');
    expect(params).toEqual([['p1', 'p2'], ME]);
    expect(await commentsWithheldPostIds(manager, ['p1'], undefined)).toEqual(new Set());
    expect(await commentsWithheldPostIds(manager, [], ME)).toEqual(new Set());
    expect(query).toHaveBeenCalledTimes(1);
  });
});

/**
 * A KEY OFF A REQUEST NEVER REACHES A PROTOTYPE (CodeQL "remote property injection", #2998): a
 * reaction type is a string the client sent, a viewer id a header. Each map these helpers build is
 * prototype-less and written through `Map` / `withOwnEntry`, so `__proto__` is a skipped key - the
 * same refusal `sanitizeReactions` and `addReaction` make (`common/object-keys.ts`).
 */
describe('a __proto__ key in what a withheld reader is served', () => {
  const PROTO = '__proto__';

  /** Whether anything landed on the shared prototype. */
  const polluted = () =>
    ({} as Record<string, unknown>).polluted !== undefined || 'polluted' in Object.prototype;

  it('a reaction TYPE named __proto__ is left out of the tally, and pollutes nothing', () => {
    const reactions = JSON.parse('{"a": "__proto__", "b": "like", "c": "constructor"}');
    const counts = otherReactionCounts(reactions, 'me');
    expect(Object.getPrototypeOf(counts)).toBeNull();
    expect(Object.keys(counts)).toEqual(['like']);
    expect(counts.like).toBe(1);
    expect(polluted()).toBe(false);
  });

  it('a viewer id named __proto__ gets no own entry, as a map with no prototype', () => {
    const reactions = JSON.parse('{"__proto__": {"polluted": "yes"}, "b": "like"}');
    const served = withheldReactions(reactions, PROTO);
    expect(Object.getPrototypeOf(served.reactions)).toBeNull();
    expect(Object.keys(served.reactions)).toEqual([]);
    const polls = withheldPolls(
      [{ id: 'p', options: [], votesByUser: JSON.parse('{"__proto__": ["o1"]}') }],
      PROTO
    ) as { votesByUser: Record<string, unknown> }[];
    expect(Object.getPrototypeOf(polls[0].votesByUser)).toBeNull();
    expect(Object.keys(polls[0].votesByUser)).toEqual([]);
    expect(polluted()).toBe(false);
  });

  it("an ordinary reader's own entry is still served, as data on a prototype-less map", () => {
    const served = withheldReactions({ me: 'like', other: 'love' }, 'me');
    expect(Object.getPrototypeOf(served.reactions)).toBeNull();
    expect(JSON.parse(JSON.stringify(served))).toEqual({
      reactions: { me: 'like' },
      otherReactionCounts: { love: 1 },
    });
  });
});
