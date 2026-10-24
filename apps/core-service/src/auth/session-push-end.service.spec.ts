/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { SessionPushEndService } from './session-push-end.service';
import { ACCESS_TOKEN_TTL_SECONDS, CREDENTIAL_SKEW_SECONDS } from './token-lifetimes';

jest.mock('axios');

/**
 * THE PUSH ENDING OF AN ENDED SESSION IS AN OUTBOX, NOT A CALL. These pin the outbox's decisions
 * against a scripted database: what the revocation's transaction records, the addresses and the
 * credential of each pass, the final pass after the session's access tokens expired, and the retry
 * state after anything else. `session-push-end.integration.spec.ts` runs the same SQL against a real
 * PostgreSQL.
 */
describe('SessionPushEndService', () => {
  const SID = '0f0f0f0f-0000-4000-8000-00000000a1b2';
  const OLD = '0e0e0e0e-0000-4000-8000-00000000a1b2';
  const BASE = 'http://chat-delivery-service:3010/api/internal/push/users/user-1';
  const FINAL_AFTER_MS = (ACCESS_TOKEN_TTL_SECONDS + CREDENTIAL_SKEW_SECONDS) * 1000;
  const axiosMock = jest.requireMock('axios') as { delete: jest.Mock; get: jest.Mock };
  let previousSecret: string | undefined;

  beforeEach(() => {
    axiosMock.delete = jest.fn().mockResolvedValue({ data: { removed: 1 } });
    axiosMock.get = jest.fn().mockResolvedValue({ data: { registered: false, sessionId: null } });
    previousSecret = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = 'internal-secret-for-tests';
    delete process.env.CHAT_DELIVERY_URL;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previousSecret;
  });

  /** A claimed row whose session ended long enough ago that this pass is the final one. */
  const claimed = (over: Record<string, unknown> = {}) => {
    const claimedAt = new Date();
    return {
      sessionId: SID,
      userId: 'user-1',
      deviceId: 'phone-1',
      cause: 'logout',
      attempts: 0,
      endedAt: new Date(claimedAt.getTime() - FINAL_AFTER_MS - 1000),
      claimedAt,
      ...over,
    };
  };

  /** `claims` scripts each claim's answer; `live` whether the read binding's session is live. */
  function make(claims: unknown[][] = [], live = false) {
    const queries: Array<[string, unknown[] | undefined]> = [];
    let claim = 0;
    const dataSource = {
      query: jest.fn(async (sql: string, params?: unknown[]): Promise<unknown> => {
        queries.push([sql, params]);
        if (sql.includes('RETURNING "sessionId"')) return [claims[claim++] ?? [], 0];
        if (sql.includes('FROM auth_sessions')) return live ? [{ '?column?': 1 }] : [];
        return [[], 1];
      }),
    };
    const service = new SessionPushEndService(dataSource as unknown as DataSource);
    const deleted = () =>
      queries.filter(([sql]) => sql.startsWith('DELETE FROM session_push_endings'));
    return { service, queries, deleted };
  }

  it('records one ending per ended session, device or not, in the caller transaction', async () => {
    const { service } = make();
    const manager = { query: jest.fn().mockResolvedValue([]) };

    const queued = await service.enqueue(
      manager as unknown as EntityManager,
      [
        { id: SID, userId: 'user-1', deviceId: 'phone-1' },
        { id: OLD, userId: 'user-1', deviceId: null },
      ],
      'logout'
    );

    expect(queued).toBe(2);
    const [sql] = manager.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO session_push_endings');
    // A session ends once: a second writer of the same ending adds nothing.
    expect(sql).toContain('ON CONFLICT ("sessionId") DO NOTHING');
    expect(manager.query.mock.calls.map(([, p]) => p)).toEqual([
      [SID, 'user-1', 'phone-1', 'logout'],
      [OLD, 'user-1', null, 'logout'],
    ]);
  });

  it('a failing insert fails the caller transaction - it is never swallowed', async () => {
    const { service } = make();
    const manager = { query: jest.fn().mockRejectedValue(new Error('relation does not exist')) };
    await expect(
      service.enqueue(
        manager as unknown as EntityManager,
        [{ id: SID, userId: 'user-1', deviceId: 'phone-1' }],
        'logout'
      )
    ).rejects.toThrow('relation does not exist');
  });

  it('ends by session on the internal route, with the internal secret, then deletes the row', async () => {
    const { service, deleted } = make([[claimed()]]);

    await service.drain();

    expect(axiosMock.get).toHaveBeenCalledWith(
      `${BASE}/devices/phone-1`,
      expect.objectContaining({ headers: { 'x-internal-secret': 'internal-secret-for-tests' } })
    );
    expect(axiosMock.delete).toHaveBeenCalledWith(
      `${BASE}/sessions/${SID}`,
      expect.objectContaining({
        params: undefined,
        headers: { 'x-internal-secret': 'internal-secret-for-tests' },
      })
    );
    expect(deleted()).toEqual([[expect.any(String), [SID]]]);
  });

  it('a session that never named a device is ended by session alone, with no binding read', async () => {
    const { service } = make([[claimed({ deviceId: null })]]);
    await service.drain();
    expect(axiosMock.get).not.toHaveBeenCalled();
    expect(axiosMock.delete.mock.calls[0][1].params).toBeUndefined();
  });

  it("deletes the device's row left by a dead session, compared against the binding it read", async () => {
    axiosMock.get.mockResolvedValue({ data: { registered: true, sessionId: OLD } });
    const { service, queries } = make([[claimed()]], false);

    await service.drain();

    const liveness = queries.find(([sql]) => sql.includes('FROM auth_sessions'));
    expect(liveness?.[1]).toEqual([OLD, 'user-1']);
    expect(axiosMock.delete.mock.calls[0][1].params).toEqual({
      device: 'phone-1',
      ifBoundTo: OLD,
    });
  });

  it('an unbound row on the device is ended as `none`', async () => {
    axiosMock.get.mockResolvedValue({ data: { registered: true, sessionId: null } });
    const { service } = make([[claimed()]]);
    await service.drain();
    expect(axiosMock.delete.mock.calls[0][1].params).toEqual({
      device: 'phone-1',
      ifBoundTo: 'none',
    });
  });

  it("leaves the device's row alone when a live session holds it, or the ending session itself does", async () => {
    axiosMock.get.mockResolvedValueOnce({ data: { registered: true, sessionId: OLD } });
    axiosMock.get.mockResolvedValueOnce({ data: { registered: true, sessionId: SID } });
    const { service } = make([[claimed()], [claimed()]], true);

    await service.drain();

    expect(axiosMock.delete.mock.calls.map(([, o]) => o.params)).toEqual([undefined, undefined]);
  });

  it('a pass before the session tokens expired keeps the row, due for one final pass at that instant', async () => {
    const endedAt = new Date();
    const { service, queries, deleted } = make([[claimed({ endedAt, claimedAt: endedAt })]]);

    await service.drain();

    expect(deleted()).toEqual([]);
    const final = queries.find(([sql]) => sql.includes('SET "nextAttemptAt" = $2'));
    expect(final?.[1]).toEqual([SID, new Date(endedAt.getTime() + FINAL_AFTER_MS)]);
  });

  it.each([
    ['a 5xx', Object.assign(new Error('fail'), { response: { status: 503 } }), 'HTTP 503'],
    [
      'a transport failure',
      Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
      'ECONNREFUSED',
    ],
  ])(
    'after %s the row stays, with its attempts, error and backoff, accused at error',
    async (_, err, recorded) => {
      const { service, queries, deleted } = make([[claimed({ attempts: 2 })]]);
      axiosMock.delete.mockRejectedValue(err);
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await service.drain();

      expect(deleted()).toEqual([]);
      const update = queries.find(([sql]) => sql.includes('SET attempts = $2'));
      // Third failure: 30 s doubled twice.
      expect(update?.[1]).toEqual([SID, 3, recorded, 120]);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('attempts=3'));
      // The line never carries the credential the call authenticated with.
      expect(String(error.mock.calls[0][0])).not.toContain('internal-secret-for-tests');
    }
  );

  it('a 400 is an address no retry can fix: accused once at error, and the row dropped', async () => {
    const { service, queries, deleted } = make([[claimed()]]);
    axiosMock.delete.mockRejectedValue(
      Object.assign(new Error('bad'), { response: { status: 400 } })
    );
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await service.drain();

    expect(deleted()).toEqual([[expect.any(String), [SID]]]);
    expect(queries.some(([sql]) => sql.includes('SET attempts = $2'))).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('HTTP 400'));
  });

  it('a drain with nothing due calls nobody, and a second drain of an ended row is harmless', async () => {
    const { service } = make([[claimed()], [], []]);

    await service.drain();
    await service.drain();

    expect(axiosMock.delete).toHaveBeenCalledTimes(1);
  });

  it('overlapping triggers share one drain', async () => {
    const { service } = make([[claimed()]]);

    const first = service.drain();
    const second = service.drain();

    expect(second).toBe(first);
    await first;
    expect(axiosMock.delete).toHaveBeenCalledTimes(1);
  });

  it('a drain whose claim fails logs it and never rejects', async () => {
    const service = new SessionPushEndService({
      query: jest.fn().mockRejectedValue(new Error('connection terminated')),
    } as unknown as DataSource);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(service.drain()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('drain failed'));
  });
});
