const leadership = vi.hoisted(() => ({ role: 'undecided' as 'leader' | 'follower' | 'undecided' }));
vi.mock('$lib/mls-client/tabLeader', () => ({ getTabLeadership: () => leadership.role }));

import {
  answersFollowerCommits,
  noteMlsStateLoaded,
  refusesCommitsHere,
  resetStateAuthorityForTests,
  servesFollowerCommits,
} from './stateAuthority';

/**
 * WHOSE COPY IS CURRENT is a fact of the LOAD, not of the election: a follower promoted in place
 * leads at once, but its copy is a follower's until its promotion reload - it commits nothing,
 * serves nothing and answers nothing; its reloaded successor does all three.
 */
describe('stateAuthority', () => {
  beforeEach(() => {
    resetStateAuthorityForTests();
    leadership.role = 'undecided';
  });

  it('a document that loaded its state as the leader commits, serves and answers', () => {
    leadership.role = 'leader';
    noteMlsStateLoaded(true);
    expect(refusesCommitsHere()).toBe(false);
    expect(servesFollowerCommits()).toBe(true);
    expect(answersFollowerCommits()).toBe(true);
  });

  it('a follower PROMOTED IN PLACE leads, and still commits, serves and answers nothing', () => {
    noteMlsStateLoaded(false);
    leadership.role = 'leader';
    expect(refusesCommitsHere()).toBe(true);
    expect(servesFollowerCommits()).toBe(false);
    expect(answersFollowerCommits()).toBe(false);
  });

  it('its reloaded successor, loading as the leader, serves', () => {
    resetStateAuthorityForTests();
    leadership.role = 'leader';
    noteMlsStateLoaded(true);
    expect(servesFollowerCommits()).toBe(true);
  });

  it('a leader whose login has loaded nothing yet may answer, never run', () => {
    leadership.role = 'leader';
    expect(servesFollowerCommits()).toBe(false);
    expect(answersFollowerCommits()).toBe(true);
    expect(refusesCommitsHere()).toBe(false);
  });

  it('a follower refuses commits whatever it loaded', () => {
    noteMlsStateLoaded(true);
    leadership.role = 'follower';
    expect(refusesCommitsHere()).toBe(true);
    expect(servesFollowerCommits()).toBe(false);
    expect(answersFollowerCommits()).toBe(false);
  });
});
