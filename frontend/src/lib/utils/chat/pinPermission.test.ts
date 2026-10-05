import { describe, expect, it } from 'vitest';
import { mayPinMessage } from './pinPermission';

describe('mayPinMessage - the one rule every pin surface follows', () => {
  const MEMBER = { inChannel: true, canModerate: false };
  const MODERATOR = { inChannel: true, canModerate: true };

  it("refuses a plain salon member someone else's message - the reported defect", () => {
    expect(mayPinMessage(MEMBER, { isOwn: false })).toBe(false);
  });

  it('lets a plain salon member pin their own message, as the server does', () => {
    expect(mayPinMessage(MEMBER, { isOwn: true })).toBe(true);
  });

  it("lets a moderator pin anybody's message in a salon", () => {
    expect(mayPinMessage(MODERATOR, { isOwn: false })).toBe(true);
    expect(mayPinMessage(MODERATOR, { isOwn: true })).toBe(true);
  });

  it('lets anybody pin anything in a DM or a group, which have no ranks', () => {
    expect(mayPinMessage({ inChannel: false, canModerate: false }, { isOwn: false })).toBe(true);
  });
});
