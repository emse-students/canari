/**
 * THE ALUMNI MERGE CALL, SENDER AGAINST VERIFIER: every token here is signed by core-service's own
 * `signAlumniMergeCallToken` (the function the site-jobs worker calls) and read by the verifier the
 * sites vendor, so the claims one writes are the claims the other accepts - a rename on either side
 * fails here, not in production.
 */
import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { createLocalJWKSet, type JWK } from 'jose';
import {
  ALUMNI_MERGE_TOKEN_TYPE as SENT_TYPE,
  HANDOFF_TOKEN_LIFETIME_SECONDS,
  signAlumniMergeCallToken,
  type AlumniMergeCallClaims,
} from '../../apps/core-service/src/auth/handoff/handoff-token';
import { ALUMNI_MERGE_TOKEN_TYPE, verifyAlumniMergeCall } from './alumni-merge-verify';
import { HANDOFF_MAX_LIFETIME_SECONDS } from './handoff-verify';

const ISSUER = 'https://canari.example';
const NOW = 1_800_000_000;
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as JWK), kid: 'k1', alg: 'ES256', use: 'sig' };
const keys = createLocalJWKSet({ keys: [jwk] });

/** A token core-service would send, with `over` bending one claim. */
const sent = (over: Partial<AlumniMergeCallClaims> & Record<string, unknown> = {}) =>
  signAlumniMergeCallToken(privateKey, 'k1', {
    iss: ISSUER,
    aud: 'sky',
    mode: 'transfer',
    dup: 'a'.repeat(64),
    target: 'b'.repeat(64),
    jti: '6144e2ac-f664-49a6-bd1c-485030a4019f',
    iat: NOW,
    exp: NOW + HANDOFF_TOKEN_LIFETIME_SECONDS,
    ...over,
  } as AlumniMergeCallClaims);

const verify = (token: string, audience = 'sky', now = NOW) =>
  verifyAlumniMergeCall(token, {
    keys,
    issuer: ISSUER,
    audience,
    currentDate: new Date(now * 1000),
  });

describe('alumni-merge-verify.ts against core-service signAlumniMergeCallToken', () => {
  it('shares the type and the lifetime with the sender', () => {
    expect(ALUMNI_MERGE_TOKEN_TYPE).toBe(SENT_TYPE);
    expect(HANDOFF_TOKEN_LIFETIME_SECONDS).toBeLessThanOrEqual(HANDOFF_MAX_LIFETIME_SECONDS);
  });

  it('accepts a transfer, its target named', async () => {
    expect(await verify(sent())).toEqual({
      outcome: 'ok',
      claims: {
        mode: 'transfer',
        dup: 'a'.repeat(64),
        target: 'b'.repeat(64),
        jti: '6144e2ac-f664-49a6-bd1c-485030a4019f',
      },
    });
  });

  it('accepts an erase, which names no target', async () => {
    const token = sent({ mode: 'erase', target: undefined });
    expect(await verify(token)).toEqual({
      outcome: 'ok',
      claims: { mode: 'erase', dup: 'a'.repeat(64), jti: '6144e2ac-f664-49a6-bd1c-485030a4019f' },
    });
  });

  it('reads a token with no mode as a transfer', async () => {
    const token = sent({ mode: undefined });
    expect(await verify(token)).toEqual(
      expect.objectContaining({ claims: expect.objectContaining({ mode: 'transfer' }) })
    );
  });

  it.each([
    ['a transfer without its target', { target: undefined }, 'invalid'],
    ['an erase that names a target', { mode: 'erase' }, 'invalid'],
    ['an unknown mode', { mode: 'move' }, 'invalid'],
    ['a malformed subject', { dup: 'not a subject' }, 'invalid'],
    ['a lifetime over 60 s', { exp: NOW + 61 }, 'too_long'],
    ['another issuer', { iss: 'https://elsewhere.example' }, 'wrong_issuer'],
  ] as const)('refuses %s', async (_name, over, outcome) => {
    expect(await verify(sent(over as Record<string, unknown>))).toEqual({ outcome });
  });

  it('refuses another audience, an expired token and one from the future', async () => {
    expect(await verify(sent(), 'migallery')).toEqual({ outcome: 'wrong_audience' });
    expect(await verify(sent(), 'sky', NOW + 120)).toEqual({ outcome: 'expired' });
    expect(await verify(sent({ iat: NOW + 120, exp: NOW + 150 }))).toEqual({
      outcome: 'not_yet_valid',
    });
  });

  it('keys that cannot be obtained are keys_unavailable, never the token`s fault', async () => {
    const outcome = await verifyAlumniMergeCall(sent(), {
      keys: async () => {
        throw new Error('ECONNREFUSED');
      },
      issuer: ISSUER,
      audience: 'sky',
      currentDate: new Date(NOW * 1000),
    });
    expect(outcome).toEqual({ outcome: 'keys_unavailable' });
  });
});
