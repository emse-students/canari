import { isAnonymousPoll, recordAnonymousVote, servePolls } from './anonymous-poll';

const poll = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  anonymous: true,
  multipleChoice: false,
  options: [
    { id: 'a', label: 'A', votes: 0 },
    { id: 'b', label: 'B', votes: 0 },
  ],
  voters: [] as string[],
  votesByUser: {},
  ...over,
});

describe('anonymous polls', () => {
  it('counts a vote without naming the voter anywhere in an option', () => {
    const p = poll();
    recordAnonymousVote(p, 'u-alice', ['a']);
    expect(p.options.map((o) => o.votes)).toEqual([1, 0]);
    expect(JSON.stringify(p.options)).not.toContain('u-alice');
  });

  it('refuses a second vote, which would need the first to be known', () => {
    const p = poll();
    recordAnonymousVote(p, 'u-alice', ['a']);
    expect(() => recordAnonymousVote(p, 'u-alice', ['b'])).toThrow('already voted');
    expect(p.options.map((o) => o.votes)).toEqual([1, 0]);
  });

  it('refuses an empty selection: there is nothing to retract', () => {
    expect(() => recordAnonymousVote(poll(), 'u-alice', [])).toThrow('empty');
  });

  it('keeps the voters sorted, so the list does not replay the order of arrival', () => {
    const p = poll();
    recordAnonymousVote(p, 'u-zoe', ['a']);
    recordAnonymousVote(p, 'u-alice', ['b']);
    expect(p.voters).toEqual(['u-alice', 'u-zoe']);
  });

  it('never serves the voter list, and tells each reader only whether THEY voted', () => {
    const p = poll({ voters: ['u-alice'] });
    const [mine] = servePolls([p], 'u-alice') as Record<string, unknown>[];
    const [theirs] = servePolls([p], 'u-bob') as Record<string, unknown>[];
    const [nobody] = servePolls([p], undefined) as Record<string, unknown>[];
    expect(mine.voted).toBe(true);
    expect(theirs.voted).toBe(false);
    expect(nobody.voted).toBe(false);
    for (const served of [mine, theirs, nobody]) {
      expect('voters' in served).toBe(false);
      expect(JSON.stringify(served)).not.toContain('u-alice');
    }
  });

  it('passes a named poll through untouched', () => {
    const named = { id: 'p2', options: [{ id: 'a', votes: ['u-alice'] }], votesByUser: {} };
    expect(servePolls([named], 'u-bob')).toEqual([named]);
    expect(isAnonymousPoll(named)).toBe(false);
  });
});
