/// <reference types="jest" />

/**
 * THE PUSH-ENDING OUTBOX AGAINST A REAL POSTGRESQL, through a real TypeORM DataSource: migration 016
 * applied and replayed, a session delete and its outbox row committed or rolled back TOGETHER, the
 * `UPDATE ... RETURNING` claim, and a row that survives a failed call and goes after a 2xx - none of
 * which the scripted specs can vouch for.
 *
 * GATED ON `CORE_IT_DATABASE_URL`, like `account-erasure.integration.spec.ts`: skipped without it,
 * and run by the `boot-nest-apps` job in `ci.yml` against the database the boot just used. It needs
 * no existing schema: `auth_sessions` is created from its entity in a throwaway schema, and
 * chat-delivery is mocked.
 *
 *   CORE_IT_DATABASE_URL=postgres://user:pass@localhost:5432/auth_db bun run test -- session-push-end.integration
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthSession } from './entities/auth-session.entity';
import { AuthSessionsService } from './auth-sessions.service';
import { SessionPushEndService } from './session-push-end.service';

jest.mock('axios');

const URL = process.env.CORE_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '016_session_push_endings.sql'),
  'utf8'
);

maybe('the push-ending outbox against PostgreSQL', () => {
  const schema = `push_end_it_${Date.now()}`;
  let ds: DataSource;
  let outbox: SessionPushEndService;
  let sessions: AuthSessionsService;
  const axios = jest.requireMock('axios') as { delete: jest.Mock };

  beforeAll(async () => {
    const admin = new DataSource({ type: 'postgres', url: URL });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.destroy();
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [AuthSession],
      synchronize: true,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    // Applied TWICE: the deploy ledger replays a file whose successor failed.
    await ds.query(MIGRATION);
    await ds.query(MIGRATION);
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    outbox = new SessionPushEndService(ds);
    sessions = new AuthSessionsService(ds.getRepository(AuthSession), outbox);
  }, 60_000);

  afterAll(async () => {
    await ds?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds?.destroy();
    jest.restoreAllMocks();
  }, 60_000);

  beforeEach(async () => {
    await ds.query(`DELETE FROM session_push_endings`);
    await ds.query(`DELETE FROM auth_sessions`);
    axios.delete = jest.fn();
  });

  async function boundSession(userId: string, deviceId: string): Promise<string> {
    const opened = await sessions.create(userId);
    await sessions.bindDevice(userId, opened.sessionId, deviceId);
    return opened.sessionId;
  }

  async function outboxRows(): Promise<
    Array<{ sessionId: string; deviceId: string; cause: string; attempts: number }>
  > {
    return ds.query(
      `SELECT "sessionId", "deviceId", cause, attempts FROM session_push_endings ORDER BY "deviceId"`
    );
  }

  /** Makes every row due now, so a drain claims it without waiting out the backoff. */
  async function dueNow(): Promise<void> {
    await ds.query(`UPDATE session_push_endings SET "nextAttemptAt" = now()`);
  }

  it('replays as a no-op on a table that already holds rows', async () => {
    await ds.query(
      `INSERT INTO session_push_endings ("sessionId", "userId", "deviceId", cause)
       VALUES (gen_random_uuid(), 'user-1', 'phone-1', 'logout')`
    );
    await ds.query(MIGRATION);
    expect(await outboxRows()).toHaveLength(1);
  });

  it('a logout commits the session delete and its ending together; a 5xx keeps the ending', async () => {
    const sid = await boundSession('user-1', 'phone-1');
    axios.delete.mockRejectedValue(Object.assign(new Error('fail'), { response: { status: 503 } }));

    await sessions.revoke(sid);
    await outbox.drain();

    expect(await ds.query(`SELECT id FROM auth_sessions`)).toEqual([]);
    expect(await outboxRows()).toEqual([
      { sessionId: sid, deviceId: 'phone-1', cause: 'logout', attempts: 1 },
    ]);
  });

  it('an ending that cannot be written rolls the session delete back', async () => {
    const sid = await boundSession('user-1', 'phone-1');
    await ds.query(`ALTER TABLE session_push_endings RENAME TO session_push_endings_away`);
    try {
      await expect(sessions.revoke(sid)).rejects.toThrow('session_push_endings');
    } finally {
      await ds.query(`ALTER TABLE session_push_endings_away RENAME TO session_push_endings`);
    }
    expect(await ds.query(`SELECT id FROM auth_sessions`)).toEqual([{ id: sid }]);
    expect(await outboxRows()).toEqual([]);
  });

  it('retries after a transport failure, deletes after a 2xx, and a second drain is harmless', async () => {
    const sid = await boundSession('user-1', 'phone-1');
    axios.delete.mockRejectedValueOnce(
      Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
    );
    await sessions.revoke(sid);
    await outbox.drain();
    expect((await outboxRows())[0].attempts).toBe(1);

    // Not due yet: the backoff holds it.
    axios.delete.mockResolvedValue({ data: { removed: 1 } });
    await outbox.drain();
    expect(axios.delete).toHaveBeenCalledTimes(1);

    await dueNow();
    await outbox.drain();
    expect(axios.delete).toHaveBeenCalledTimes(2);
    expect(axios.delete.mock.calls[1][1].params).toEqual({ sessionId: sid, unbound: 'end' });
    expect(await outboxRows()).toEqual([]);

    await outbox.drain();
    expect(axios.delete).toHaveBeenCalledTimes(2);
  });

  it('revoking the others records one ending per session RETURNING named, never the kept one', async () => {
    axios.delete.mockRejectedValue(Object.assign(new Error('fail'), { response: { status: 503 } }));
    const keep = await boundSession('user-1', 'phone-1');
    const laptop = await boundSession('user-1', 'laptop-1');
    await boundSession('user-2', 'phone-2');
    const orphan = await sessions.create('user-1');

    await expect(sessions.revokeOthers('user-1', keep)).resolves.toBe(2);

    const rows = await outboxRows();
    expect(rows.map((r) => r.sessionId)).toEqual([laptop]);
    expect(rows.map((r) => r.sessionId)).not.toContain(orphan.sessionId);
  });

  it('a live session naming the device keeps an unbound registration', async () => {
    const old = await sessions.create('user-1');
    const current = await sessions.create('user-1');
    // Two live sessions naming one device: the window before the current one's binding purges.
    await ds.query(`UPDATE auth_sessions SET "deviceId" = 'phone-1' WHERE id IN ($1, $2)`, [
      old.sessionId,
      current.sessionId,
    ]);
    axios.delete.mockResolvedValue({ data: { removed: 0 } });

    await sessions.revoke(old.sessionId);
    await outbox.drain();

    expect(axios.delete.mock.calls[0][1].params).toEqual({
      sessionId: old.sessionId,
      unbound: 'keep',
    });
    expect(await outboxRows()).toEqual([]);
  });
});
