/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { RestoreCredentialsService } from './restore-credentials.service';
import { RESTORE_CHALLENGE_TTL_MS } from './restore-challenge';
import { RestoreCredential } from './restore-credential.entity';
import { QueryFailedError } from 'typeorm';
import { ROTATION_GRACE_SECONDS } from '../auth-sessions.service';

/**
 * The server half of WP-RESTORE-1 against a SOFTWARE AUTHENTICATOR: real P-256 keys, real CBOR,
 * real ES256 signatures - the library verifies them exactly as it would a phone's. No database (the
 * repositories are in memory) and no wall clock (every call is handed its instant).
 */

const RP_ID = 'canari.emse.fr';
const FINGERPRINT = 'AB'.repeat(32);
const ORIGIN = `android:apk-key-hash:${Buffer.alloc(32, 0xab).toString('base64url')}`;
const T0 = new Date('2026-10-18T12:00:00.000Z');
const LATER = new Date(T0.getTime() + 60_000);
const USER = 'user-1';
const SID = '11111111-1111-4111-8111-111111111111';
const OTHER_SID = '22222222-2222-4222-8222-222222222222';
/** The CURRENT refresh id of a session in this file; a rotation moves it on. */
const JTI = 'jti-current';

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | Buffer | string) => createHash('sha256').update(b).digest();

/** A platform authenticator that holds one key, the way Credential Manager holds a restore key. */
class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly key: KeyObject;
  private readonly coseKey: Uint8Array;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.coseKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ])
    );
  }

  private flags(up: boolean, attested: boolean): number {
    return (up ? 0x01 : 0) | (attested ? 0x40 : 0);
  }

  /** Answers creation options (the challenge, as the phone echoes it) with a registration. */
  register(
    challenge: string,
    opts: { origin?: string; rpId?: string; up?: boolean } = {}
  ): Record<string, unknown> {
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(opts.rpId ?? RP_ID),
      Buffer.from([this.flags(opts.up ?? false, true)]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      idLen,
      this.credentialId,
      Buffer.from(this.coseKey),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]) as never
    );
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge, origin: opts.origin ?? ORIGIN })
    );
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: [],
      },
      clientExtensionResults: {},
    };
  }

  /** Answers request options with an assertion. */
  assert(
    challenge: string,
    opts: { origin?: string; rpId?: string; up?: boolean } = {}
  ): Record<string, unknown> {
    const authData = Buffer.concat([
      sha256(opts.rpId ?? RP_ID),
      Buffer.from([this.flags(opts.up ?? false, false)]),
      Buffer.alloc(4),
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin: opts.origin ?? ORIGIN })
    );
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.key);
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: b64u(randomBytes(32)),
      },
      clientExtensionResults: {},
    };
  }
}

/** In-memory stand-ins for the three tables and the transaction. */
function makeStore() {
  const credentials = new Map<string, RestoreCredential>();
  const spent = new Map<string, Date>();
  const sessions = new Map<
    string,
    {
      id: string;
      userId: string;
      expiresAt: Date;
      tokenId?: string;
      previousTokenId?: string | null;
      rotatedAt?: Date | null;
      deviceId?: string | null;
    }
  >();
  /** What `SessionPushEndService.enqueue` was handed, and how many drains followed. */
  const pushEndings: { id: string; userId: string; deviceId: string | null; cause: string }[] = [];
  const pushEnd = {
    drains: 0,
    enqueue: async (
      _m: unknown,
      ended: ReadonlyArray<{ id: string; userId: string; deviceId?: string | null }>,
      cause: string
    ) => {
      for (const row of ended)
        pushEndings.push({ id: row.id, userId: row.userId, deviceId: row.deviceId ?? null, cause });
      return ended.length;
    },
    drain: async () => {
      pushEnd.drains += 1;
    },
  };

  /** A credential found by its id, or by the session holding it. */
  const findCredential = (where: { id?: string; sessionId?: string }) => {
    if (where.id !== undefined) return credentials.get(where.id) ?? null;
    return [...credentials.values()].find((r) => r.sessionId === where.sessionId) ?? null;
  };

  const manager = {
    findOne: async (_e: unknown, opts: { where: { id?: string; sessionId?: string } }) =>
      findCredential(opts.where),
    delete: async (_e: unknown, where: { sessionId: string }) => {
      for (const [id, row] of credentials)
        if (row.sessionId === where.sessionId) credentials.delete(id);
    },
    insert: async (_e: unknown, row: RestoreCredential) => {
      // The two unique constraints, as PostgreSQL reports them (23505).
      if (
        credentials.has(row.id) ||
        [...credentials.values()].some((r) => r.sessionId === row.sessionId)
      )
        throw new QueryFailedError(
          'INSERT',
          [],
          Object.assign(new Error('duplicate key'), { code: '23505' })
        );
      credentials.set(row.id, row);
    },
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('INSERT INTO restore_challenges_spent')) {
        const nonce = params[0] as string;
        if (spent.has(nonce)) return [];
        spent.set(nonce, params[1] as Date);
        return [{ nonce }];
      }
      // A raw DELETE is answered `[rows, rowCount]`, as TypeORM's postgres driver answers it - a
      // fake answering the rows alone hid exactly that shape once.
      if (sql.startsWith('DELETE FROM restore_credentials')) {
        const row = credentials.get(params[0] as string);
        if (!row) return [[], 0];
        credentials.delete(row.id);
        return [[{ sessionId: row.sessionId }], 1];
      }
      if (sql.startsWith('DELETE FROM auth_sessions')) {
        const s = sessions.get(params[0] as string);
        if (!s) return [[], 0];
        sessions.delete(s.id);
        return [[{ id: s.id, userId: s.userId, deviceId: s.deviceId ?? null }], 1];
      }
      throw new Error(`unexpected SQL in the fake: ${sql}`);
    },
  };

  const service = new RestoreCredentialsService(
    {
      findOne: async (opts: { where: { id?: string; sessionId?: string } }) =>
        findCredential(opts.where),
    } as never,
    { delete: async () => ({ affected: 0 }) } as never,
    {
      findOne: async (opts: { where: { id: string; userId: string } }) => {
        const s = sessions.get(opts.where.id);
        return s && s.userId === opts.where.userId ? s : null;
      },
    } as never,
    { transaction: async (cb: (m: typeof manager) => unknown) => cb(manager) } as never,
    pushEnd as never
  );
  return { service, credentials, spent, sessions, manager, pushEnd, pushEndings };
}

/** A whole restore as the controller runs it: verify, then consume. */
async function restore(
  service: RestoreCredentialsService,
  response: unknown,
  now: Date
): Promise<{ status: string; reason?: string; userId?: string; sessionId?: string }> {
  const verified = await service.verifyAssertion(response as never, now);
  if (verified.status !== 'verified') return verified;
  const consumed = await service.consume(verified.assertion);
  if (consumed.status !== 'consumed') return consumed;
  return {
    status: 'ok',
    userId: verified.assertion.userId,
    sessionId: verified.assertion.sessionId,
  };
}

/** The challenge a phone would echo: the options' challenge, as base64url. */
const challengeOf = (options: { challenge: string }) => options.challenge;

describe('RestoreCredentialsService', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-not-the-production-one';
    process.env.ANDROID_APP_LINK_SHA256 = FINGERPRINT;
    process.env.FRONTEND_URL = `https://${RP_ID}`;
  });

  afterEach(() => {
    delete process.env.ANDROID_APP_LINK_SHA256;
    delete process.env.FRONTEND_URL;
  });

  /** A store holding one live session and a phone that registered its key under it. */
  async function registered(opts: { up?: boolean } = {}) {
    const store = makeStore();
    store.sessions.set(SID, {
      id: SID,
      userId: USER,
      expiresAt: new Date(T0.getTime() + 86_400_000),
      tokenId: JTI,
    });
    const phone = new SoftAuthenticator();
    const options = await store.service.registrationOptions(SID, T0);
    const result = await store.service.register(
      USER,
      SID,
      JTI,
      phone.register(challengeOf(options), { up: opts.up }) as never,
      true,
      T0
    );
    expect(result).toEqual({
      status: 'registered',
      credentialId: b64u(phone.credentialId),
      replaced: null,
    });
    return { ...store, phone };
  }

  it('issues options for the estate RP id, discouraging verification, naming nobody', async () => {
    const { service } = makeStore();
    const options = await service.registrationOptions(SID, T0);
    expect(options.rp).toEqual({ name: 'Canari', id: RP_ID });
    expect(options.user.name).toBe('Canari');
    expect(options.user.displayName).toBe('Canari');
    expect(options.attestation).toBe('none');
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'discouraged',
    });
    const request = await service.assertionOptions(T0);
    expect(request.rpId).toBe(RP_ID);
    expect(request.allowCredentials).toEqual([]);
  });

  it.each([false, true])(
    'registers a key and restores with it, with the user-presence flag %s',
    async (up) => {
      const { service, credentials, phone } = await registered({ up });
      expect(credentials.get(b64u(phone.credentialId))).toMatchObject({
        userId: USER,
        sessionId: SID,
        cloudBackup: true,
      });
      const request = await service.assertionOptions(LATER);
      const result = await restore(service, phone.assert(request.challenge, { up }), LATER);
      expect(result).toEqual({ status: 'ok', userId: USER, sessionId: SID });
    }
  );

  it('CONSUMES the key AND revokes its session in one transaction: never one session more', async () => {
    const { service, credentials, sessions, phone } = await registered();
    const first = await service.assertionOptions(LATER);
    expect((await restore(service, phone.assert(first.challenge), LATER)).status).toBe('ok');
    expect(credentials.size).toBe(0);
    expect(sessions.has(SID)).toBe(false);
    const second = await service.assertionOptions(LATER);
    expect(await restore(service, phone.assert(second.challenge), LATER)).toEqual({
      status: 'unknown',
    });
  });

  it("records the old session's push ending with the revocation, then drains: a sold phone gets no notification", async () => {
    const { service, sessions, pushEnd, pushEndings, phone } = await registered();
    sessions.set(SID, { ...sessions.get(SID)!, deviceId: 'old-phone' });
    const request = await service.assertionOptions(LATER);
    expect((await restore(service, phone.assert(request.challenge), LATER)).status).toBe('ok');
    expect(pushEndings).toEqual([
      { id: SID, userId: USER, deviceId: 'old-phone', cause: 'restored' },
    ]);
    expect(pushEnd.drains).toBe(1);
  });

  it('records no push ending when a concurrent revocation already deleted the session', async () => {
    const { service, sessions, manager, pushEnd, pushEndings, phone } = await registered();
    const request = await service.assertionOptions(LATER);
    const verified = await service.verifyAssertion(phone.assert(request.challenge) as never, LATER);
    if (verified.status !== 'verified') throw new Error('expected a verified assertion');
    // The session goes between the verification and the consumption (a logout racing it): that
    // revocation recorded its own ending, so this one names nothing and drains nothing.
    const realQuery = manager.query;
    manager.query = async (sql, params) => {
      if (sql.startsWith('DELETE FROM auth_sessions')) sessions.delete(SID);
      return realQuery(sql, params);
    };
    await expect(service.consume(verified.assertion)).resolves.toEqual({ status: 'consumed' });
    expect(pushEndings).toEqual([]);
    expect(pushEnd.drains).toBe(0);
  });

  it('writes NOTHING on verification alone, so a refusal before consume keeps the key', async () => {
    const { service, credentials, sessions, spent, pushEndings, phone } = await registered();
    const request = await service.assertionOptions(LATER);
    const verified = await service.verifyAssertion(phone.assert(request.challenge) as never, LATER);
    expect(verified.status).toBe('verified');
    expect(credentials.size).toBe(1);
    expect(sessions.has(SID)).toBe(true);
    expect(spent.size).toBe(0);
    expect(pushEndings).toEqual([]);
  });

  it('refuses a replayed assertion even when its key exists again (the spent nonce)', async () => {
    const { service, sessions, phone } = await registered();
    const request = await service.assertionOptions(LATER);
    const assertion = phone.assert(request.challenge);
    expect((await restore(service, assertion, LATER)).status).toBe('ok');
    // The same key registered again under a live session (a replayed registration).
    sessions.set(SID, {
      id: SID,
      userId: USER,
      expiresAt: new Date(LATER.getTime() + 1),
      tokenId: JTI,
    });
    const options = await service.registrationOptions(SID, LATER);
    await service.register(USER, SID, JTI, phone.register(options.challenge) as never, true, LATER);
    expect(await restore(service, assertion, LATER)).toEqual({
      status: 'invalid',
      reason: 'replay',
    });
  });

  it('refuses an assertion signed for another origin (a phishing page, an unsigned build)', async () => {
    const { service, phone } = await registered();
    const request = await service.assertionOptions(LATER);
    const result = await service.verifyAssertion(
      phone.assert(request.challenge, { origin: 'https://evil.example' }) as never,
      LATER
    );
    expect(result.status).toBe('invalid');
  });

  it('refuses an assertion for another RP id', async () => {
    const { service, phone } = await registered();
    const request = await service.assertionOptions(LATER);
    const result = await service.verifyAssertion(
      phone.assert(request.challenge, { rpId: 'dev.canari-emse.fr' }) as never,
      LATER
    );
    expect(result.status).toBe('invalid');
  });

  it('refuses an expired challenge, and a registration challenge presented to restore', async () => {
    const { service, phone } = await registered();
    const stale = await service.assertionOptions(T0);
    const after = new Date(T0.getTime() + RESTORE_CHALLENGE_TTL_MS);
    expect(
      (await service.verifyAssertion(phone.assert(stale.challenge) as never, after)).status
    ).toBe('invalid');
    const wrongPurpose = await service.registrationOptions(SID, LATER);
    expect(
      (await service.verifyAssertion(phone.assert(wrongPurpose.challenge) as never, LATER)).status
    ).toBe('invalid');
  });

  it('answers an unknown key when the session the key is bound to has expired', async () => {
    const { service, sessions, phone } = await registered();
    sessions.set(SID, { id: SID, userId: USER, expiresAt: LATER });
    const request = await service.assertionOptions(LATER);
    expect(await service.verifyAssertion(phone.assert(request.challenge) as never, LATER)).toEqual({
      status: 'unknown',
    });
  });

  it('refuses a registration for a session that is not live, or another session challenge', async () => {
    const { service, sessions } = makeStore();
    const phone = new SoftAuthenticator();
    const options = await service.registrationOptions(SID, T0);
    expect(
      await service.register(USER, SID, JTI, phone.register(options.challenge) as never, true, T0)
    ).toEqual({
      status: 'no-session',
    });
    sessions.set(SID, { id: SID, userId: USER, expiresAt: LATER, tokenId: JTI });
    sessions.set(OTHER_SID, { id: OTHER_SID, userId: USER, expiresAt: LATER, tokenId: JTI });
    const result = await service.register(
      USER,
      OTHER_SID,
      JTI,
      phone.register(options.challenge) as never,
      true,
      T0
    );
    expect(result.status).toBe('invalid');
  });

  it('never re-binds a key id already held by another session', async () => {
    const { service, sessions, credentials, phone } = await registered();
    sessions.set(OTHER_SID, { id: OTHER_SID, userId: USER, expiresAt: LATER, tokenId: JTI });
    const options = await service.registrationOptions(OTHER_SID, T0);
    expect(
      await service.register(
        USER,
        OTHER_SID,
        JTI,
        phone.register(options.challenge) as never,
        false,
        T0
      )
    ).toEqual({ status: 'taken' });
    expect(credentials.get(b64u(phone.credentialId))?.sessionId).toBe(SID);
  });

  it("replaces the session's previous key on re-registration, and names the key it replaced", async () => {
    const { service, credentials, phone } = await registered();
    expect(await service.registeredKeyOf(SID)).toBe(b64u(phone.credentialId));
    const newPhone = new SoftAuthenticator();
    const options = await service.registrationOptions(SID, T0);
    expect(
      await service.register(
        USER,
        SID,
        JTI,
        newPhone.register(options.challenge) as never,
        false,
        T0
      )
    ).toEqual({
      status: 'registered',
      credentialId: b64u(newPhone.credentialId),
      replaced: b64u(phone.credentialId),
    });
    expect([...credentials.keys()]).toEqual([b64u(newPhone.credentialId)]);
    expect(credentials.get(b64u(newPhone.credentialId))?.cloudBackup).toBe(false);
  });

  it('refuses a registration with a refresh credential the rotation has moved past (a stale, stolen copy)', async () => {
    const { service, sessions, credentials, phone } = await registered();
    // The owner's client refreshed: the session's current id is no longer the one a thief copied.
    sessions.set(SID, { ...sessions.get(SID)!, tokenId: 'jti-after-rotation' });
    const thief = new SoftAuthenticator();
    const options = await service.registrationOptions(SID, T0);
    expect(
      await service.register(USER, SID, JTI, thief.register(options.challenge) as never, true, T0)
    ).toEqual({ status: 'no-session' });
    expect([...credentials.keys()]).toEqual([b64u(phone.credentialId)]);
    expect(await service.isLiveSessionOf(USER, SID, T0, 'jti-after-rotation')).toBe(true);
  });

  it('accepts the refresh id the last rotation replaced inside the grace window, as a refresh does', async () => {
    const { service, sessions } = await registered();
    const rotatedAt = new Date(T0.getTime() - 1_000);
    sessions.set(SID, {
      ...sessions.get(SID)!,
      tokenId: 'jti-after-rotation',
      previousTokenId: JTI,
      rotatedAt,
    });
    expect(await service.isLiveSessionOf(USER, SID, T0, JTI)).toBe(true);
    const past = new Date(rotatedAt.getTime() + (ROTATION_GRACE_SECONDS + 1) * 1000);
    expect(await service.isLiveSessionOf(USER, SID, past, JTI)).toBe(false);
  });

  it('answers two registrations racing for one session with a typed conflict, never a 500', async () => {
    const { service, credentials, manager, phone } = await registered();
    // The racing registration commits between this one's delete and its insert.
    const racer = new SoftAuthenticator();
    const realDelete = manager.delete;
    manager.delete = async (e, where) => {
      await realDelete(e, where);
      credentials.set(b64u(racer.credentialId), {
        ...credentials.get(b64u(phone.credentialId))!,
        id: b64u(racer.credentialId),
        sessionId: SID,
      } as RestoreCredential);
    };
    const late = new SoftAuthenticator();
    const options = await service.registrationOptions(SID, T0);
    expect(
      await service.register(USER, SID, JTI, late.register(options.challenge) as never, true, T0)
    ).toEqual({ status: 'conflict' });
    expect([...credentials.keys()]).toEqual([b64u(racer.credentialId)]);
  });

  it('is unavailable, and issues nothing, with no fingerprint configured', async () => {
    process.env.ANDROID_APP_LINK_SHA256 = '';
    const { service } = makeStore();
    expect(service.available).toBe(false);
    await expect(service.assertionOptions(T0)).rejects.toThrow(/unavailable/);
  });
});
