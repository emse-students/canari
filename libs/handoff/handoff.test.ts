/**
 * The source copies of the vendored handoff modules, run against the contract's vectors - the same
 * cases each site's copy runs in its own CI (`make test-ci-scripts`).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalJWKSet, type JSONWebKeySet } from 'jose';
import {
  HANDOFF_LEEWAY_SECONDS,
  HANDOFF_MAX_LIFETIME_SECONDS,
  verifyHandoff,
} from './handoff-verify';
import { redeemHandoff, stepOf, takeHandoffToken } from './handoff-landing';

const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'contracts', 'handoff-token.cases.json'), 'utf8')
) as {
  issuer: string;
  audience: string;
  leewaySeconds: number;
  maxLifetimeSeconds: number;
  jwks: JSONWebKeySet;
  cases: Array<{ name: string; token: string; now: number; expect: string; sub?: string }>;
  replay: { token: string; now: number; expect: string[] };
};

/** MiGallery-shaped: a same-origin path, never `//host` (the vectors' `bad_dest` is `//evil.example/x`). */
const redirectAllows = (dest: string) =>
  dest.startsWith('/') && !dest.startsWith('//') && !dest.includes('\\');

const verify = (token: string, now: number) =>
  verifyHandoff(token, {
    keys: createLocalJWKSet(vectors.jwks),
    issuer: vectors.issuer,
    audience: vectors.audience,
    redirectAllows,
    currentDate: new Date(now * 1000),
  });

describe('handoff-verify.ts against libs/contracts/handoff-token.cases.json', () => {
  it('states the bounds the vectors were written under', () => {
    expect(vectors.leewaySeconds).toBe(HANDOFF_LEEWAY_SECONDS);
    expect(vectors.maxLifetimeSeconds).toBe(HANDOFF_MAX_LIFETIME_SECONDS);
  });

  for (const c of vectors.cases) {
    it(`${c.name} -> ${c.expect}`, async () => {
      const result = await verify(c.token, c.now);
      expect(result.outcome).toBe(c.expect);
      if (result.outcome === 'ok' && c.sub) expect(result.claims.sub).toBe(c.sub);
    });
  }

  it('replay: steps 1-3 pass both times; the ledger (the site) is what answers replayed', async () => {
    const ledger = new Set<string>();
    const answers: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await verify(vectors.replay.token, vectors.replay.now);
      if (r.outcome !== 'ok') answers.push(r.outcome);
      else if (ledger.has(r.claims.jti)) answers.push('replayed');
      else {
        ledger.add(r.claims.jti);
        answers.push('ok');
      }
    }
    expect(answers).toEqual(vectors.replay.expect);
  });
});

describe('handoff-landing.ts', () => {
  it('takes the token and clears the address bar at once', () => {
    const calls: unknown[][] = [];
    const token = takeHandoffToken(
      { hash: '#abc.def.ghi', pathname: '/auth/handoff' },
      { replaceState: (...a: unknown[]) => void calls.push(a) }
    );
    expect(token).toBe('abc.def.ghi');
    expect(calls).toEqual([[null, '', '/auth/handoff']]);
  });

  it('an empty fragment is the ordinary login, and nothing is posted', async () => {
    let posted = false;
    const step = await redeemHandoff('', false, (async () => {
      posted = true;
      return new Response('{}');
    }) as unknown as typeof fetch);
    expect(step).toEqual({ kind: 'login', redirectTo: null });
    expect(posted).toBe(false);
  });

  it('posts JSON, same origin, confirm only after the click', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ outcome: 'ok', dest: '/mes-photos' }));
    }) as unknown as typeof fetch;
    expect(await redeemHandoff('t', false, fetchFn)).toEqual({ kind: 'go', to: '/mes-photos' });
    await redeemHandoff('t', true, fetchFn);
    expect(seen[0].url).toBe('/api/auth/handoff');
    expect(seen[0].init.credentials).toBe('same-origin');
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ token: 't' });
    expect(JSON.parse(String(seen[1].init.body))).toEqual({ token: 't', confirm: true });
  });

  it.each([
    [
      { outcome: 'confirm', current: 'A', next: { name: 'B', photo: '/p.jpg' } },
      {
        kind: 'confirm',
        interstitial: { current: 'A', next: { name: 'B', photo: '/p.jpg' } },
      },
    ],
    [
      { outcome: 'confirm', current: null, next: { name: 'B' } },
      {
        kind: 'confirm',
        interstitial: { current: null, next: { name: 'B', photo: null } },
      },
    ],
    [
      { outcome: 'unknown_user', dest: '/mes-photos' },
      { kind: 'login', redirectTo: '/mes-photos' },
    ],
    [
      { outcome: 'ok', dest: '//evil.example' },
      { kind: 'login', redirectTo: null },
    ],
    [
      { outcome: 'ok', dest: 'https://evil.example/' },
      { kind: 'login', redirectTo: null },
    ],
    [{ outcome: 'confirm' }, { kind: 'login', redirectTo: null }],
    [null, { kind: 'login', redirectTo: null }],
  ])('reads %j as %j', (body, step) => {
    expect(stepOf(body)).toEqual(step as never);
  });

  it('a refusal or no answer is the ordinary login without redirectTo', async () => {
    const refused = (async () =>
      new Response(JSON.stringify({ outcome: 'replayed' }), {
        status: 409,
      })) as unknown as typeof fetch;
    expect(await redeemHandoff('t', false, refused)).toEqual({ kind: 'login', redirectTo: null });
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await redeemHandoff('t', false, down)).toEqual({ kind: 'login', redirectTo: null });
  });
});
