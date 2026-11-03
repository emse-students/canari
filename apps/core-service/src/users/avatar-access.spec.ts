import { createHmac } from 'crypto';
import { avatarAccessOf } from './avatar-access';
import { avatarDayBucket, checkAvatarTokenSignature, mintAvatarToken } from '../auth/avatar-token';

/**
 * Who may ask `GET /users/:id/avatar` (`avatar-access.ts`, `avatar-token.ts`). Every instant is
 * PASSED IN - no wall clock is asserted - and the session store is a set of live ids, the durable
 * state the token's validity rests on.
 */
describe('avatar access', () => {
  const SECRET = 'a'.repeat(40);
  const INTERNAL = 'the-internal-secret';
  const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const OTHER_SID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const DAY = 86_400_000;
  /** Noon, UTC, on some day: the bucket boundaries below are whole days from it. */
  const NOON = 20_000 * DAY + DAY / 2;

  let saved: { avatar?: string; internal?: string };
  beforeEach(() => {
    saved = { avatar: process.env.AVATAR_TOKEN_SECRET, internal: process.env.INTERNAL_SECRET };
    process.env.AVATAR_TOKEN_SECRET = SECRET;
    process.env.INTERNAL_SECRET = INTERNAL;
  });
  afterEach(() => {
    for (const [key, value] of [
      ['AVATAR_TOKEN_SECRET', saved.avatar],
      ['INTERNAL_SECRET', saved.internal],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** A session store holding `live` ids, recording what it was asked. */
  function store(live: string[] = [SID]) {
    const asked: string[] = [];
    return {
      asked,
      isLiveSession: jest.fn(async (sid: string) => {
        asked.push(sid);
        return live.includes(sid);
      }),
    };
  }

  const request = (query: Record<string, unknown>, headers: Record<string, string> = {}) =>
    ({ headers, query }) as never;

  const access = (token: unknown, live = store(), now = NOON) =>
    avatarAccessOf(request(token === undefined ? {} : { t: token }), live, new Date(now));

  it('a token of the current bucket and a live session is signed', async () => {
    const token = mintAvatarToken(SID, NOON)!;
    await expect(access(token)).resolves.toEqual({ kind: 'signed' });
  });

  it('a token of the PREVIOUS bucket is still signed - a URL minted at 23:59 survives midnight', async () => {
    const token = mintAvatarToken(SID, NOON - DAY)!;
    await expect(access(token)).resolves.toEqual({ kind: 'signed' });
  });

  it('a token of the NEXT bucket is signed too - a clock a little ahead is not refused', async () => {
    const token = mintAvatarToken(SID, NOON + DAY)!;
    await expect(access(token)).resolves.toEqual({ kind: 'signed' });
  });

  it.each([
    ['two buckets old', -2],
    ['two buckets ahead', 2],
  ])(
    'a genuine token %s is STALE, told apart from a forgery, and no session is read',
    async (_l, days) => {
      const token = mintAvatarToken(SID, NOON + days * DAY)!;
      const live = store();
      await expect(access(token, live)).resolves.toEqual({ kind: 'refused', reason: 'stale' });
      expect(live.asked).toEqual([]);
    }
  );

  it('a genuine token with its day rewritten is a forgery, not a stale token', async () => {
    const [sid, bucket, mac] = mintAvatarToken(SID, NOON - 2 * DAY)!.split('.');
    const moved = `${sid}.${Number(bucket) + 2}.${mac}`;
    await expect(access(moved)).resolves.toEqual({ kind: 'refused', reason: 'bad-signature' });
  });

  it('a token of a session that has ended is refused, though perfectly signed', async () => {
    const token = mintAvatarToken(SID, NOON)!;
    await expect(access(token, store([]))).resolves.toEqual({
      kind: 'refused',
      reason: 'session-ended',
    });
  });

  it('a tampered token is refused', async () => {
    const token = mintAvatarToken(SID, NOON)!;
    // A character inside the mac, not the last one: the last base64url character of 32 bytes carries
    // two padding bits, and flipping one of those would decode to the same bytes.
    const at = token.length - 5;
    const tampered = token.slice(0, at) + (token[at] === 'A' ? 'B' : 'A') + token.slice(at + 1);
    await expect(access(tampered)).resolves.toEqual({
      kind: 'refused',
      reason: 'bad-signature',
    });
  });

  it("another session's mac under this session's id is refused (wrong session)", async () => {
    const theirs = mintAvatarToken(OTHER_SID, NOON)!;
    const [, bucket, mac] = theirs.split('.');
    const forged = `${SID}.${bucket}.${mac}`;
    const live = store([SID, OTHER_SID]);
    await expect(access(forged, live)).resolves.toEqual({
      kind: 'refused',
      reason: 'bad-signature',
    });
    expect(live.asked).toEqual([]);
  });

  it('a token signed under another secret is refused', async () => {
    const token = mintAvatarToken(SID, NOON)!;
    process.env.AVATAR_TOKEN_SECRET = 'b'.repeat(40);
    await expect(access(token)).resolves.toEqual({ kind: 'refused', reason: 'bad-signature' });
  });

  it.each([
    ['empty', ''],
    ['no bucket nor mac', SID],
    ['the bucketless shape', `${SID}.${'A'.repeat(43)}`],
    ['not a uuid', `not-a-session.20000.${'A'.repeat(43)}`],
    ['a short mac', `${SID}.20000.abc`],
    ['a bucket with a leading zero', `${SID}.020000.${'A'.repeat(43)}`],
    ['a signed bucket', `${SID}.-1.${'A'.repeat(43)}`],
    ['a fourth part', `${SID}.20000.${'A'.repeat(43)}.x`],
    ['repeated', ['x', 'y']],
  ])('a malformed token (%s) is refused before any session read', async (_label, token) => {
    const live = store();
    await expect(access(token, live)).resolves.toEqual({ kind: 'refused', reason: 'malformed' });
    expect(live.asked).toEqual([]);
  });

  it('with no secret on this process, nothing is minted and every token is refused', async () => {
    const token = mintAvatarToken(SID, NOON)!;
    delete process.env.AVATAR_TOKEN_SECRET;
    expect(mintAvatarToken(SID, NOON)).toBeNull();
    await expect(access(token)).resolves.toEqual({ kind: 'refused', reason: 'unconfigured' });
  });

  it('a secret shorter than 32 characters counts as none', () => {
    process.env.AVATAR_TOKEN_SECRET = 'x'.repeat(31);
    expect(mintAvatarToken(SID, NOON)).toBeNull();
    expect(checkAvatarTokenSignature(`${SID}.20000.${'A'.repeat(43)}`, NOON)).toEqual({
      ok: false,
      reason: 'unconfigured',
    });
  });

  it('the three other spellings of the last mac character are refused: one token, one form', async () => {
    const token = mintAvatarToken(SID, NOON)!;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(token[token.length - 1]);
    // 43 characters carry 258 bits for 256: the last character's two low bits are padding, so these
    // three decode to the very same bytes as the canonical one.
    const others = [0, 1, 2, 3]
      .map((low) => (last & ~3) | low)
      .filter((index) => index !== last)
      .map((index) => token.slice(0, -1) + alphabet[index]);
    expect(others).toHaveLength(3);
    for (const spelling of others) {
      await expect(access(spelling)).resolves.toEqual({ kind: 'refused', reason: 'malformed' });
    }
    await expect(access(token)).resolves.toEqual({ kind: 'signed' });
  });

  it('the MAC is bound to its use: it is the HMAC of `avatar-v1|<session>|<bucket>`, and of nothing shorter', async () => {
    const bucket = avatarDayBucket(NOON);
    const hmac = (input: string) => createHmac('sha256', SECRET).update(input).digest('base64url');
    expect(mintAvatarToken(SID, NOON)).toBe(
      `${SID}.${bucket}.${hmac(`avatar-v1|${SID}|${bucket}`)}`
    );
    // The same secret over the same session and day WITHOUT the domain prefix is another use's MAC.
    const undomained = `${SID}.${bucket}.${hmac(`${SID}|${bucket}`)}`;
    await expect(access(undomained)).resolves.toEqual({
      kind: 'refused',
      reason: 'bad-signature',
    });
  });

  it('PHASE 1: no token at all is unsigned (answered, counted by the controller)', async () => {
    await expect(access(undefined)).resolves.toEqual({ kind: 'unsigned' });
  });

  it('a service proving INTERNAL_SECRET is exempt, with or without a token', async () => {
    const live = store([]);
    await expect(
      avatarAccessOf(request({}, { 'x-internal-secret': INTERNAL }), live, new Date(NOON))
    ).resolves.toEqual({ kind: 'internal' });
    await expect(
      avatarAccessOf(
        request({ t: 'garbage' }, { 'x-internal-secret': INTERNAL }),
        live,
        new Date(NOON)
      )
    ).resolves.toEqual({ kind: 'internal' });
    expect(live.asked).toEqual([]);
  });

  it('a WRONG internal secret is refused, never read as unsigned', async () => {
    await expect(
      avatarAccessOf(request({}, { 'x-internal-secret': 'guess' }), store(), new Date(NOON))
    ).resolves.toEqual({ kind: 'refused', reason: 'bad-internal-secret' });
  });

  it('one URL per session per UTC day: the bucket, not the access token, decides the token', () => {
    const morning = 20_000 * DAY + 1;
    const evening = 20_001 * DAY - 1;
    expect(avatarDayBucket(morning)).toBe(avatarDayBucket(evening));
    expect(mintAvatarToken(SID, morning)).toBe(mintAvatarToken(SID, evening));
    expect(mintAvatarToken(SID, evening)).not.toBe(mintAvatarToken(SID, evening + 1));
    expect(mintAvatarToken(SID, NOON)).not.toBe(mintAvatarToken(OTHER_SID, NOON));
  });
});
