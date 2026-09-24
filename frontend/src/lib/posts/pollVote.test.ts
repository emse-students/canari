import {
  applyPostPollVote,
  msUntilPollDeadline,
  nextPollSelection,
  pollDeadlinePassed,
  pollSelectionIsFull,
} from './pollVote';
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

/**
 * WHAT A TAP PRODUCES, including the edge no component can show: the tap that does nothing.
 *
 * The card held this inline as "single choice replaces, multiple choice toggles". A cap adds a
 * third behaviour to the same gesture, and the reason it is tested here rather than observed on a
 * screen is that a refused tap looks exactly like a tap that never registered.
 */
describe('nextPollSelection', () => {
  const single = { multipleChoice: false, maxSelections: null };
  const multi = { multipleChoice: true, maxSelections: null };
  const capped = { multipleChoice: true, maxSelections: 2 };

  it('replaces the answer on a single-choice poll', () => {
    expect(nextPollSelection(['a'], 'b', single)).toEqual(['b']);
  });

  it('withdraws from a single-choice poll when the chosen option is tapped again', () => {
    // The only way to take a vote back, and it has always worked this way.
    expect(nextPollSelection(['a'], 'a', single)).toEqual([]);
  });

  it('toggles on a multiple-choice poll', () => {
    expect(nextPollSelection(['a'], 'b', multi)).toEqual(['a', 'b']);
    expect(nextPollSelection(['a', 'b'], 'a', multi)).toEqual(['b']);
  });

  it('refuses one option past the cap, and never silently swaps one out', () => {
    expect(nextPollSelection(['a', 'b'], 'c', capped)).toEqual(['a', 'b']);
  });

  it('still lets a full selection be undone', () => {
    // Otherwise the cap becomes a trap: two chosen, nothing removable, no way to change your mind.
    expect(nextPollSelection(['a', 'b'], 'b', capped)).toEqual(['a']);
  });

  it('applies no cap to a single-choice poll, whatever the field says', () => {
    // `maxSelections` is only meaningful alongside `multipleChoice` - one rule, one source.
    expect(nextPollSelection([], 'a', { multipleChoice: false, maxSelections: 2 })).toEqual(['a']);
  });
});

describe('pollSelectionIsFull', () => {
  it('is false when there is no cap to reach', () => {
    expect(pollSelectionIsFull(['a', 'b'], { multipleChoice: true, maxSelections: null })).toBe(
      false
    );
    expect(pollSelectionIsFull(['a'], { multipleChoice: false, maxSelections: 1 })).toBe(false);
  });

  it('is true exactly when the cap is reached', () => {
    expect(pollSelectionIsFull(['a'], { multipleChoice: true, maxSelections: 2 })).toBe(false);
    expect(pollSelectionIsFull(['a', 'b'], { multipleChoice: true, maxSelections: 2 })).toBe(true);
  });
});

/**
 * A DEADLINE IS JUDGED AGAINST AN INSTANT THE CALLER NAMES, AND EVERY INSTANT HERE IS A LITERAL.
 *
 * Nothing below reads a wall clock, which is the point twice over: it is the campaign's standing
 * rule for tests, and it is also the defect being fixed - the old spelling took its instant from
 * `Date.now()` during render, so it answered once and never again.
 */
const T = Date.UTC(2026, 8, 24, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

describe('pollDeadlinePassed', () => {
  it('is false for a poll with no deadline, whatever the instant', () => {
    expect(pollDeadlinePassed(undefined, T)).toBe(false);
    expect(pollDeadlinePassed(null, T + 10 ** 9)).toBe(false);
  });

  it('is false before the deadline and true from the instant it lands', () => {
    const at = iso(T);
    expect(pollDeadlinePassed(at, T - 1)).toBe(false);
    expect(pollDeadlinePassed(at, T)).toBe(true);
    expect(pollDeadlinePassed(at, T + 1)).toBe(true);
  });

  it('treats an unparseable deadline as no deadline rather than as passed', () => {
    expect(pollDeadlinePassed('not a date', T)).toBe(false);
  });
});

describe('msUntilPollDeadline', () => {
  const withEnds = (...ends: Array<string | null | undefined>) =>
    ends.map((endsAt) => ({ endsAt }));

  it('schedules nothing when no poll carries a deadline', () => {
    expect(msUntilPollDeadline([], T)).toBeUndefined();
    expect(msUntilPollDeadline(withEnds(undefined, null), T)).toBeUndefined();
  });

  it('schedules nothing when every deadline is already behind the instant', () => {
    expect(msUntilPollDeadline(withEnds(iso(T - 1), iso(T)), T)).toBeUndefined();
  });

  it('returns the wait to the EARLIEST deadline still ahead - one timer, not one per poll', () => {
    expect(msUntilPollDeadline(withEnds(iso(T + 5000), iso(T + 1000), iso(T + 9000)), T)).toBe(
      1000
    );
  });

  it('ignores the ones behind it and takes the earliest of the rest', () => {
    expect(msUntilPollDeadline(withEnds(iso(T - 9000), iso(T + 7000), iso(T + 2000)), T)).toBe(
      2000
    );
  });

  it('ignores an unparseable deadline rather than returning NaN, which setTimeout spins on', () => {
    expect(msUntilPollDeadline(withEnds('nonsense'), T)).toBeUndefined();
    expect(msUntilPollDeadline(withEnds('nonsense', iso(T + 3000)), T)).toBe(3000);
  });
});
