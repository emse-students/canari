/// <reference types="jest" />

import {
  RESTORE_CHALLENGE_TTL_MS,
  checkRestoreChallenge,
  deriveRestoreChallengeKey,
  mintRestoreChallenge,
} from './restore-challenge';

// A fixed instant: no test here reads the wall clock.
const T0 = new Date('2026-10-18T12:00:00.000Z');
const KEY = deriveRestoreChallengeKey('test-secret-not-the-production-one');
const NONCE = Buffer.alloc(16, 7);

describe('restore challenge', () => {
  it('verifies for the purpose and binding it was minted for, and names its nonce and expiry', () => {
    const c = mintRestoreChallenge(KEY, 'register', 'sid-1', T0, NONCE);
    const r = checkRestoreChallenge(KEY, c, 'register', 'sid-1', T0);
    expect(r).toEqual({
      ok: true,
      challenge: {
        nonce: NONCE.toString('base64url'),
        expiresAt: new Date(T0.getTime() + RESTORE_CHALLENGE_TTL_MS),
      },
    });
  });

  it('refuses a registration challenge presented as an assertion one, and the reverse', () => {
    const reg = mintRestoreChallenge(KEY, 'register', '', T0, NONCE);
    const asr = mintRestoreChallenge(KEY, 'assert', '', T0, NONCE);
    expect(checkRestoreChallenge(KEY, reg, 'assert', '', T0)).toEqual({
      ok: false,
      refusal: 'forged',
    });
    expect(checkRestoreChallenge(KEY, asr, 'register', '', T0)).toEqual({
      ok: false,
      refusal: 'forged',
    });
  });

  it("refuses another session's registration challenge", () => {
    const c = mintRestoreChallenge(KEY, 'register', 'sid-1', T0, NONCE);
    expect(checkRestoreChallenge(KEY, c, 'register', 'sid-2', T0)).toEqual({
      ok: false,
      refusal: 'forged',
    });
  });

  it('refuses a challenge minted under another secret', () => {
    const other = deriveRestoreChallengeKey('another-secret');
    const c = mintRestoreChallenge(other, 'assert', '', T0, NONCE);
    expect(checkRestoreChallenge(KEY, c, 'assert', '', T0)).toEqual({
      ok: false,
      refusal: 'forged',
    });
  });

  it('is believed until its expiry and refused from the expiry on', () => {
    const c = mintRestoreChallenge(KEY, 'assert', '', T0, NONCE);
    const last = new Date(T0.getTime() + RESTORE_CHALLENGE_TTL_MS - 1);
    const at = new Date(T0.getTime() + RESTORE_CHALLENGE_TTL_MS);
    expect(checkRestoreChallenge(KEY, c, 'assert', '', last).ok).toBe(true);
    expect(checkRestoreChallenge(KEY, c, 'assert', '', at)).toEqual({
      ok: false,
      refusal: 'expired',
    });
  });

  it('refuses a tampered expiry as a forgery, not as a fresh challenge', () => {
    const c = Buffer.from(mintRestoreChallenge(KEY, 'assert', '', T0, NONCE), 'base64url');
    c.writeBigUInt64BE(BigInt(T0.getTime() + 10 * RESTORE_CHALLENGE_TTL_MS), 16);
    expect(checkRestoreChallenge(KEY, c.toString('base64url'), 'assert', '', T0)).toEqual({
      ok: false,
      refusal: 'forged',
    });
  });

  it('refuses what is not a challenge at all', () => {
    for (const junk of ['', 'abc', 'not base64url !!', Buffer.alloc(56).toString('base64')]) {
      expect(checkRestoreChallenge(KEY, junk, 'assert', '', T0)).toEqual({
        ok: false,
        refusal: 'malformed',
      });
    }
  });

  it('cannot derive a key from an empty secret', () => {
    expect(() => deriveRestoreChallengeKey('')).toThrow(/empty/);
  });

  it('mints a different challenge each time when the nonce is drawn', () => {
    const a = mintRestoreChallenge(KEY, 'assert', '', T0);
    const b = mintRestoreChallenge(KEY, 'assert', '', T0);
    expect(a).not.toEqual(b);
  });
});
