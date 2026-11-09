import { describe, expect, it } from 'vitest';
import { mayNameMember } from './nicknamePermission';

describe('mayNameMember', () => {
  const group = { inCommunity: false, canModerate: false };
  const member = { inCommunity: true, canModerate: false };
  const moderator = { inCommunity: true, canModerate: true };

  it('lets anyone name anyone in a DM or a group', () => {
    expect(mayNameMember(group, { isSelf: false, isReset: false })).toBe(true);
    expect(mayNameMember(group, { isSelf: true, isReset: false })).toBe(true);
  });

  it('lets a community moderator name anyone', () => {
    expect(mayNameMember(moderator, { isSelf: false, isReset: false })).toBe(true);
    expect(mayNameMember(moderator, { isSelf: false, isReset: true })).toBe(true);
  });

  it('lets a community member only clear their own', () => {
    expect(mayNameMember(member, { isSelf: true, isReset: true })).toBe(true);
    expect(mayNameMember(member, { isSelf: true, isReset: false })).toBe(false);
    expect(mayNameMember(member, { isSelf: false, isReset: true })).toBe(false);
    expect(mayNameMember(member, { isSelf: false, isReset: false })).toBe(false);
  });
});
