import { applyPostPollVote } from './pollVote';
import type { Poll, PostEntity } from '$lib/posts/api';

/**
 * WHAT A VOTE MUST DO TO A POLL BEFORE THE SERVER HAS SEEN IT.
 *
 * This is what makes the optimistic paint safe to keep: the tally the reader sees on the tap has to
 * be the tally the server would have sent back, or the row corrects itself a second later and the
 * whole point is lost. PURITY is asserted too, because the caller's rollback is nothing more than
 * the object it came in with.
 */
const poll = (options: Array<[string, string[]]>, votesByUser: Record<string, string[]>): Poll => ({
  id: 'p1',
  question: 'q',
  multipleChoice: true,
  options: options.map(([id, votes]) => ({ id, label: id, votes })),
  votesByUser,
});

const post = (polls: Poll[]): PostEntity => ({ id: 'post1', polls }) as PostEntity;

const optionVotes = (result: PostEntity, optionId: string): string[] =>
  result.polls[0].options.find((o) => o.id === optionId)?.votes ?? [];

describe('applyPostPollVote', () => {
  it('adds the voter to the chosen option and records the choice', () => {
    const result = applyPostPollVote(
      post([
        poll(
          [
            ['a', []],
            ['b', []],
          ],
          {}
        ),
      ]),
      'p1',
      'u1',
      ['a']
    );
    expect(optionVotes(result, 'a')).toEqual(['u1']);
    expect(optionVotes(result, 'b')).toEqual([]);
    expect(result.polls[0].votesByUser.u1).toEqual(['a']);
  });

  it('moves the voter when the choice changes', () => {
    const result = applyPostPollVote(
      post([
        poll(
          [
            ['a', ['u1', 'u2']],
            ['b', []],
          ],
          { u1: ['a'], u2: ['a'] }
        ),
      ]),
      'p1',
      'u1',
      ['b']
    );
    expect(optionVotes(result, 'a')).toEqual(['u2']);
    expect(optionVotes(result, 'b')).toEqual(['u1']);
    expect(result.polls[0].votesByUser.u1).toEqual(['b']);
  });

  it('retires the vote entirely when nothing is selected', () => {
    const result = applyPostPollVote(post([poll([['a', ['u1']]], { u1: ['a'] })]), 'p1', 'u1', []);
    expect(optionVotes(result, 'a')).toEqual([]);
    // ABSENT, not an empty array: `votesByUser[userId]` is what "has this reader voted" reads.
    expect('u1' in result.polls[0].votesByUser).toBe(false);
  });

  it('keeps every other voter and every other poll untouched', () => {
    const other = { ...poll([['x', ['u2']]], { u2: ['x'] }), id: 'p2' };
    const input = post([
      poll(
        [
          ['a', ['u2']],
          ['b', []],
        ],
        { u2: ['a'] }
      ),
      other,
    ]);
    const result = applyPostPollVote(input, 'p1', 'u1', ['b']);
    expect(optionVotes(result, 'a')).toEqual(['u2']);
    expect(result.polls[1]).toBe(other);
  });

  it('carries several options for a multiple-choice poll', () => {
    const result = applyPostPollVote(
      post([
        poll(
          [
            ['a', []],
            ['b', []],
            ['c', []],
          ],
          {}
        ),
      ]),
      'p1',
      'u1',
      ['a', 'c']
    );
    expect(result.polls[0].votesByUser.u1).toEqual(['a', 'c']);
    expect(optionVotes(result, 'b')).toEqual([]);
  });

  it('leaves the post it was given untouched, which is what the rollback relies on', () => {
    const input = post([poll([['a', []]], {})]);
    const before = JSON.stringify(input);
    const result = applyPostPollVote(input, 'p1', 'u1', ['a']);
    expect(JSON.stringify(input)).toBe(before);
    expect(result).not.toBe(input);
  });

  it('returns a post with the same polls when the id matches nothing', () => {
    const input = post([poll([['a', []]], {})]);
    const result = applyPostPollVote(input, 'absent', 'u1', ['a']);
    expect(result.polls[0]).toBe(input.polls[0]);
  });
});
