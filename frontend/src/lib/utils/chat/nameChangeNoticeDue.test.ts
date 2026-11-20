import { describe, expect, it } from 'vitest';
import { nameChangeNoticeDue } from './visibleNotices';

describe('nameChangeNoticeDue', () => {
  const before = { id: 'group-1', name: 'Team ', nameAt: undefined };

  it('draws nothing for an honest restatement of a name the Welcome wrote with a trailing space', () => {
    expect(nameChangeNoticeDue(before, { name: 'Team' })).toBe(false);
  });

  it('draws nothing when the name is unchanged', () => {
    expect(nameChangeNoticeDue(before, { name: 'Team ' })).toBe(false);
  });

  it('still draws a notice for a real change over an undated list name', () => {
    expect(nameChangeNoticeDue(before, { name: 'Other' })).toBe(true);
  });

  it("draws none over a newly invited member's placeholder", () => {
    expect(
      nameChangeNoticeDue({ id: 'group-1', name: 'group-1', nameAt: undefined }, { name: 'Team' })
    ).toBe(false);
  });
});
