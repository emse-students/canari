import { describe, it, expect } from 'vitest';
import { groupDraftFrom, respondentGroupOffered } from './respondentGroup';

describe('respondentGroupOffered', () => {
  it('is offered on a named, internal form only', () => {
    expect(respondentGroupOffered({})).toBe(true);
    expect(respondentGroupOffered({ anonymous: false, isPublic: false })).toBe(true);
    expect(respondentGroupOffered({ anonymous: true })).toBe(false);
    expect(respondentGroupOffered({ isPublic: true })).toBe(false);
  });
});

describe('groupDraftFrom', () => {
  it('names the people, leaves the signed-in account out, and carries the departed count', () => {
    const draft = groupDraftFrom(
      {
        respondents: [
          { id: 'u1', firstName: 'Ada', lastName: 'Lovelace' },
          { id: 'ME', firstName: 'Me', lastName: null },
          { id: 'u2', firstName: null, lastName: null },
        ],
        departed: 2,
      },
      'me'
    );
    expect(draft.members.map((p) => p.id)).toEqual(['u1', 'u2']);
    expect(draft.members[0].name).toBe('Ada Lovelace');
    expect(draft.members[1].name).not.toBe('');
    expect(draft.departed).toBe(2);
  });
});
