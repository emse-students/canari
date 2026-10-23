/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { SessionPushEndService } from './session-push-end.service';

jest.mock('axios');

/**
 * THE PUSH ENDING OF AN ENDED SESSION IS AN OUTBOX, NOT A CALL. These pin the outbox's decisions
 * against a scripted database: what the revocation's transaction records, the address and the
 * credential of the call, the delete after a 2xx only, and the retry state after anything else.
 * `session-push-end.integration.spec.ts` runs the same SQL against a real PostgreSQL.
 */
describe('SessionPushEndService', () => {
  const SID = '0f0f0f0f-0000-4000-8000-00000000a1b2';
  const axiosMock = jest.requireMock('axios') as { delete: jest.Mock };
  let previousSecret: string | undefined;

  beforeEach(() => {
    axiosMock.delete = jest.fn();
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

  const claimed = (over: Record<string, unknown> = {}) => ({
    sessionId: SID,
    userId: 'user-1',
    deviceId: 'phone-1',
    cause: 'logout',
    attempts: 0,
    createdAt: new Date(),
    ...over,
  });

  /** `claims` scripts what each claim answers; `live` whether a live session names the device. */
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
    return { service, queries };
  }

  it('records one ending per ended session that named a device, in the caller transaction', async () => {
    const { service } = make();
    const manager = { query: jest.fn().mockResolvedValue([]) };

    const queued = await service.enqueue(
      manager as unknown as EntityManager,
      [
        { id: SID, userId: 'user-1', deviceId: 'phone-1' },
        { id: 'other', userId: 'user-1', deviceId: null },
      ],
      'logout'
    );

    expect(queued).toBe(1);
    expect(manager.query).toHaveBeenCalledTimes(1);
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO session_push_endings');
    // A session ends once: a second writer of the same ending adds nothing.
    expect(sql).toContain('ON CONFLICT ("sessionId") DO NOTHING');
    expect(params).toEqual([SID, 'user-1', 'phone-1', 'logout']);
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

  it('ends the registration by session on the internal route, then deletes the row', async () => {
    const { service, queries } = make([[claimed()]]);
    axiosMock.delete.mockResolvedValue({ data: { removed: 1 } });

    await service.drain();

    expect(axiosMock.delete).toHaveBeenCalledWith(
      'http://chat-delivery-service:3010/api/internal/push/users/user-1/devices/phone-1',
      expect.objectContaining({
        params: { sessionId: SID, unbound: 'end' },
        headers: { 'x-internal-secret': 'internal-secret-for-tests' },
      })
    );
    const deletes = queries.filter(([sql]) => sql.startsWith('DELETE FROM session_push_endings'));
    expect(deletes).toEqual([[expect.any(String), [SID]]]);
  });

  it('keeps an unbound registration while a live session of the account names the device', async () => {
    const { service } = make([[claimed()]], true);
    axiosMock.delete.mockResolvedValue({ data: { removed: 0 } });

    await service.drain();

    expect(axiosMock.delete.mock.calls[0][1].params).toEqual({ sessionId: SID, unbound: 'keep' });
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
      const { service, queries } = make([[claimed({ attempts: 2 })]]);
      axiosMock.delete.mockRejectedValue(err);
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await service.drain();

      expect(queries.some(([sql]) => sql.startsWith('DELETE FROM session_push_endings'))).toBe(
        false
      );
      const update = queries.find(([sql]) => sql.includes('SET attempts = $2'));
      // Third failure: 30 s doubled twice.
      expect(update?.[1]).toEqual([SID, 3, recorded, 120]);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('attempts=3'));
      // The line never carries the credential the call authenticated with.
      expect(String(error.mock.calls[0][0])).not.toContain('internal-secret-for-tests');
    }
  );

  it('a drain with nothing due calls nobody, and a second drain of an ended row is harmless', async () => {
    const { service } = make([[claimed()], [], []]);
    axiosMock.delete.mockResolvedValue({ data: { removed: 0 } });

    await service.drain();
    await service.drain();

    expect(axiosMock.delete).toHaveBeenCalledTimes(1);
  });

  it('overlapping triggers share one drain', async () => {
    const { service } = make([[claimed()]]);
    axiosMock.delete.mockResolvedValue({ data: { removed: 1 } });

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
