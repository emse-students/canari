/**
 * THE ALUMNI MERGE CALL, SENDER AGAINST VERIFIER: every token here is signed by core-service's own
 * `signAlumniMergeCallToken` (the function the site-jobs worker calls) and read by the verifier the
 * sites vendor, so the claims one writes are the claims the other accepts - a rename on either side
 * fails here, not in production.
 */
import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createLocalJWKSet, type JWK } from 'jose';
import {
  ALUMNI_MERGE_SUBJECT_MAX_LENGTH as CANARI_SUBJECT_MAX,
  ALUMNI_MERGE_SUBJECT_RE,
  ALUMNI_MERGE_TOKEN_TYPE as SENT_TYPE,
  HANDOFF_TOKEN_LIFETIME_SECONDS,
  signAlumniMergeCallToken,
  signHandoffToken,
  type AlumniMergeCallClaims,
} from '../../apps/core-service/src/auth/handoff/handoff-token';
import {
  ALUMNI_MERGE_SUBJECT_MAX_LENGTH,
  ALUMNI_MERGE_TOKEN_TYPE,
  verifyAlumniMergeCall,
} from './alumni-merge-verify';
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

  it('holds ONE subject bound with core-service: its hook, its constant and its columns', () => {
    expect(ALUMNI_MERGE_SUBJECT_MAX_LENGTH).toBe(CANARI_SUBJECT_MAX);
    expect(ALUMNI_MERGE_SUBJECT_RE.test('a'.repeat(CANARI_SUBJECT_MAX))).toBe(true);
    expect(ALUMNI_MERGE_SUBJECT_RE.test('a'.repeat(CANARI_SUBJECT_MAX + 1))).toBe(false);
    const sql = readFileSync(
      new URL(
        '../../apps/core-service/src/migrations/030_alumni_merge_extension.sql',
        import.meta.url
      ),
      'utf8'
    );
    const widths = [...sql.matchAll(/"(?:duplicate|target)Subject"\s+VARCHAR\((\d+)\)/g)].map(
      (m) => Number(m[1])
    );
    expect(widths).toHaveLength(4);
    expect(new Set(widths)).toEqual(new Set([CANARI_SUBJECT_MAX]));
  });

  it('accepts a subject at the bound', async () => {
    const dup = 'a'.repeat(ALUMNI_MERGE_SUBJECT_MAX_LENGTH);
    expect(await verify(sent({ dup }))).toEqual(
      expect.objectContaining({ outcome: 'ok', claims: expect.objectContaining({ dup }) })
    );
  });

  it('refuses a sign-in handoff token carrying the same claims (its type is not ours)', async () => {
    const claims = {
      iss: ISSUER,
      aud: 'sky',
      mode: 'transfer',
      dup: 'a'.repeat(64),
      target: 'b'.repeat(64),
      jti: '6144e2ac-f664-49a6-bd1c-485030a4019f',
      iat: NOW,
      exp: NOW + HANDOFF_TOKEN_LIFETIME_SECONDS,
    };
    expect(await verify(signHandoffToken(privateKey, 'k1', claims))).toEqual({
      outcome: 'invalid',
    });
  });

  it.each([
    ['a token with no mode (no default)', { mode: undefined }, 'invalid'],
    ['a transfer without its target', { target: undefined }, 'invalid'],
    ['an erase that names a target', { mode: 'erase' }, 'invalid'],
    ['an unknown mode', { mode: 'move' }, 'invalid'],
    ['a malformed subject', { dup: 'not a subject' }, 'invalid'],
    ['a subject over the bound', { dup: 'a'.repeat(ALUMNI_MERGE_SUBJECT_MAX_LENGTH + 1) }, 'invalid'],

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
