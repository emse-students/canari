import { describe, expect, it } from 'vitest';
import { mayPinMessage } from './pinPermission';

describe('mayPinMessage - the one rule every pin surface follows', () => {
  it('refuses a plain salon member, whoever wrote the message (user, 2026-10-05)', () => {
    expect(mayPinMessage({ inChannel: true, canModerate: false })).toBe(false);
  });

  it('lets a salon moderator pin', () => {
    expect(mayPinMessage({ inChannel: true, canModerate: true })).toBe(true);
  });

  it('lets anybody pin in a DM or a group, which have no ranks', () => {
    expect(mayPinMessage({ inChannel: false, canModerate: false })).toBe(true);
  });
});
