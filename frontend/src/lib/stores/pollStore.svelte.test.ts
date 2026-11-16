import {
  applyLocalVote,
  getPollMeta,
  pollWriteMark,
  setPollMeta,
  setPollMetaFromPage,
} from './pollStore.svelte';

const tally = (votes: Record<string, string[]>) => ({
  optionIds: ['a', 'b'],
  multipleChoice: false,
  endsAt: null,
  closed: false,
  votesByUser: votes,
});

describe('a page never writes over a tally written after its request left', () => {
  it('keeps a live vote over an older page, and takes a page asked after it', () => {
    const before = pollWriteMark();
    setPollMeta('p1', tally({ peer: ['a'] }));
    setPollMetaFromPage('p1', tally({}), before);
    expect(getPollMeta('p1')).toEqual(tally({ peer: ['a'] }));

    setPollMetaFromPage('p1', tally({ peer: ['b'] }), pollWriteMark());
    expect(getPollMeta('p1')).toEqual(tally({ peer: ['b'] }));
  });

  it('an optimistic vote is a live write too', () => {
    setPollMetaFromPage('p2', tally({}), pollWriteMark());
    const before = pollWriteMark();
    applyLocalVote('p2', 'me', ['a']);
    setPollMetaFromPage('p2', tally({}), before);
    expect(getPollMeta('p2')).toEqual(tally({ me: ['a'] }));
  });

  it('of two pages, the one asked later wins whichever lands last', () => {
    const older = pollWriteMark();
    setPollMeta('other', tally({}));
    const newer = pollWriteMark();
    setPollMetaFromPage('p3', tally({ peer: ['b'] }), newer);
    setPollMetaFromPage('p3', tally({}), older);
    expect(getPollMeta('p3')).toEqual(tally({ peer: ['b'] }));
  });
});
