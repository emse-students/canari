/// <reference types="jest" />

/**
 * THE PUSH-ENDING OUTBOX AGAINST A REAL POSTGRESQL, through a real TypeORM DataSource: migration 016
 * applied and replayed, a session delete and its outbox row committed or rolled back TOGETHER, the
 * `UPDATE ... RETURNING` claim, and a row that survives a failed call and goes after a 2xx - none of
 * which the scripted specs can vouch for. And the one session end outside `AuthSessionsService`, a
 * restore consuming its key (migration 013, applied and replayed): its raw `DELETE ... RETURNING`
 * answers are read in the driver's real shape, which an in-memory fake once hid.
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
import { RestoreCredentialsService } from './restore/restore-credentials.service';
import { ACCESS_TOKEN_TTL_SECONDS, CREDENTIAL_SKEW_SECONDS } from './token-lifetimes';

jest.mock('axios');

const URL = process.env.CORE_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '016_session_push_endings.sql'),
  'utf8'
);
/** The restore keys (WP-RESTORE-1): a restore is the one session end outside AuthSessionsService. */
const RESTORE_MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '013_restore_credentials.sql'),
  'utf8'
);

maybe('the push-ending outbox against PostgreSQL', () => {
  const schema = `push_end_it_${Date.now()}`;
  let ds: DataSource;
  let outbox: SessionPushEndService;
  let sessions: AuthSessionsService;
  const axios = jest.requireMock('axios') as { delete: jest.Mock; get: jest.Mock };

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
    // 013 references `users`, which only its id matters to; applied twice, like 016.
    await ds.query(`CREATE TABLE users (id VARCHAR(255) PRIMARY KEY)`);
    await ds.query(RESTORE_MIGRATION);
    await ds.query(RESTORE_MIGRATION);
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
    await ds.query(`DELETE FROM restore_challenges_spent`);
    await ds.query(`DELETE FROM auth_sessions`);
    axios.delete = jest.fn().mockResolvedValue({ data: { removed: 0 } });
    axios.get = jest.fn().mockResolvedValue({ data: { registered: false, sessionId: null } });
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

  it('retries after a transport failure, keeps the row for a final pass, and ends it after', async () => {
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

    // A 2xx while an access token of the session can still be valid: kept, due when they expire.
    await dueNow();
    await outbox.drain();
    expect(axios.delete).toHaveBeenCalledTimes(2);
    expect(axios.delete.mock.calls[1][0]).toContain(`/sessions/${sid}`);
    const [kept] = await ds.query(
      `SELECT extract(epoch FROM "nextAttemptAt" - "endedAt")::int AS gap FROM session_push_endings`
    );
    expect(kept.gap).toBe(ACCESS_TOKEN_TTL_SECONDS + CREDENTIAL_SKEW_SECONDS);

    // Once those tokens have expired, the final pass ends it for good.
    await ds.query(`UPDATE session_push_endings SET "endedAt" = now() - interval '2 hours'`);
    await dueNow();
    await outbox.drain();
    expect(axios.delete).toHaveBeenCalledTimes(3);
    expect(await outboxRows()).toEqual([]);

    await outbox.drain();
    expect(axios.delete).toHaveBeenCalledTimes(3);
  });

  it('revoking the others records one ending per session RETURNING named, never the kept one', async () => {
    axios.delete.mockRejectedValue(Object.assign(new Error('fail'), { response: { status: 503 } }));
    const keep = await boundSession('user-1', 'phone-1');
    const laptop = await boundSession('user-1', 'laptop-1');
    await boundSession('user-2', 'phone-2');
    const tab = await sessions.create('user-1');

    await expect(sessions.revokeOthers('user-1', keep)).resolves.toBe(2);

    const rows = await outboxRows();
    expect(rows.map((r) => r.sessionId).sort()).toEqual([laptop, tab.sessionId].sort());
    expect(rows.map((r) => r.sessionId)).not.toContain(keep);
  });

  it('a session that registered before it named its device is ended by session alone', async () => {
    const opened = await sessions.create('user-1');
    await sessions.revoke(opened.sessionId);
    await outbox.drain();

    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.delete.mock.calls[0][0]).toContain(`/sessions/${opened.sessionId}`);
    expect(axios.delete.mock.calls[0][1].params).toBeUndefined();
  });

  it("the device's last session ends a row a dead session left on it", async () => {
    const dead = '0d0d0d0d-0000-4000-8000-0000000000d1';
    const sid = await boundSession('user-1', 'phone-1');
    axios.get.mockResolvedValue({ data: { registered: true, sessionId: dead } });

    await sessions.revoke(sid);
    await outbox.drain();

    expect(axios.delete.mock.calls[0][1].params).toEqual({ device: 'phone-1', ifBoundTo: dead });
  });

  it("leaves the device's row to the live session that holds it", async () => {
    const old = await sessions.create('user-1');
    const current = await sessions.create('user-1');
    await ds.query(`UPDATE auth_sessions SET "deviceId" = 'phone-1' WHERE id = $1`, [
      old.sessionId,
    ]);
    axios.get.mockResolvedValue({ data: { registered: true, sessionId: current.sessionId } });

    await sessions.revoke(old.sessionId);
    await outbox.drain();

    expect(axios.delete.mock.calls[0][1].params).toBeUndefined();
  });

  it("migration 013 replays as a no-op, its two keys found in THIS schema's catalogue", async () => {
    const found: { conname: string }[] = await ds.query(
      `SELECT conname FROM pg_constraint
        WHERE connamespace = to_regnamespace(current_schema())::oid
          AND conname IN ('fk_restore_credentials_session', 'fk_restore_credentials_user')
        ORDER BY conname`
    );
    expect(found.map((c) => c.conname)).toEqual([
      'fk_restore_credentials_session',
      'fk_restore_credentials_user',
    ]);
  });

  it("a restore ends the old phone's session AND records its push ending, in one transaction", async () => {
    process.env.JWT_SECRET ??= 'session-push-end-it-secret';
    // `consume` reads nothing but the transaction; the repositories are for other routes.
    const restore = new RestoreCredentialsService(
      null as never,
      null as never,
      ds.getRepository(AuthSession),
      ds,
      outbox
    );
    await ds.query(`INSERT INTO users (id) VALUES ('user-1') ON CONFLICT DO NOTHING`);
    const sid = await boundSession('user-1', 'old-phone');
    await ds.query(
      `INSERT INTO restore_credentials (id, "userId", "sessionId", "publicKey", "cloudBackup")
       VALUES ('key-1', 'user-1', $1, '\\x00', true)`,
      [sid]
    );
    axios.delete.mockRejectedValue(Object.assign(new Error('fail'), { response: { status: 503 } }));
    const assertion = {
      userId: 'user-1',
      credentialId: 'key-1',
      sessionId: sid,
      challenge: { nonce: 'nonce-1', expiresAt: new Date(Date.now() + 60_000) },
    };

    await expect(restore.consume(assertion as never)).resolves.toEqual({ status: 'consumed' });
    await outbox.drain();

    expect(await ds.query(`SELECT id FROM auth_sessions`)).toEqual([]);
    expect(await ds.query(`SELECT id FROM restore_credentials`)).toEqual([]);
    expect(await outboxRows()).toEqual([
      { sessionId: sid, deviceId: 'old-phone', cause: 'restored', attempts: 1 },
    ]);
    // The same key again: gone, and nothing more recorded.
    await expect(
      restore.consume({ ...assertion, challenge: { ...assertion.challenge, nonce: 'nonce-2' } })
    ).resolves.toEqual({ status: 'unknown' });
    expect(await outboxRows()).toHaveLength(1);
  });

  it('a 400 drops the row after one accusation', async () => {
    const sid = await boundSession('user-1', 'phone-1');
    axios.delete.mockRejectedValue(Object.assign(new Error('bad'), { response: { status: 400 } }));

    await sessions.revoke(sid);
    await outbox.drain();

    expect(await outboxRows()).toEqual([]);
  });
});
