/// <reference types="jest" />

/**
 * MIGRATION 037 AND THE END-OF-SESSION DELETE AGAINST A REAL POSTGRESQL: the column lands on an empty
 * and on a populated `push_token`, replays as a no-op, and the end-of-session deletes - by session,
 * and the device's stale row by compare-and-delete, including a NULL binding - remove what the ended
 * session left and never a newer registration of the same device.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads:
 * skipped without it, and run by the `test-chat-delivery-integration` job in `ci.yml`, which refuses
 * a skip. It needs no existing schema: it builds
 * `push_token` in the shape migration 020 left it, in a throwaway schema.
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/db bun run test -- 037_push_token_session
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PushToken } from '../entities/push-token.entity';
import { InternalController } from '../controllers/internal.controller';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '037_push_token_session.sql'), 'utf8');
const SECRET = 'internal-secret-for-tests';
const OLD_SID = '0a0a0a0a-0000-4000-8000-0000000000a1';
const NEW_SID = '0b0b0b0b-0000-4000-8000-0000000000b2';

/** `push_token` as an estate holds it before 037. */
const PUSH_TOKEN_BEFORE_037 = `
  CREATE TABLE push_token (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" varchar(255) NOT NULL,
    "deviceId" varchar NOT NULL,
    token varchar NOT NULL,
    platform varchar(10) NOT NULL,
    "pushSecret" varchar(64),
    "voipToken" varchar(255),
    locale varchar(5),
    "createdAt" timestamp NOT NULL DEFAULT now(),
    "updatedAt" timestamp NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX ON push_token ("userId", "deviceId");`;

maybe('migration 037 (push_token.sessionId) against PostgreSQL', () => {
  const schema = `push_session_it_${Date.now()}`;
  let ds: DataSource;
  let controller: InternalController;

  beforeAll(async () => {
    const admin = new DataSource({ type: 'postgres', url: URL });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.destroy();
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [PushToken],
      synchronize: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    controller = Object.create(InternalController.prototype) as InternalController;
    Object.assign(controller, {
      pushTokenRepo: ds.getRepository(PushToken),
      logger: new Logger('it'),
      secret: SECRET,
    });
  }, 60_000);

  afterAll(async () => {
    await ds?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds?.destroy();
    jest.restoreAllMocks();
  }, 60_000);

  beforeEach(async () => {
    await ds.query(`DROP TABLE IF EXISTS push_token`);
    await ds.query(PUSH_TOKEN_BEFORE_037);
  });

  async function insert(userId: string, deviceId: string, sessionId: string | null): Promise<void> {
    await ds.query(
      `INSERT INTO push_token ("userId", "deviceId", token, platform, "sessionId")
       VALUES ($1, $2, 'tok', 'android', $3)`,
      [userId, deviceId, sessionId]
    );
  }

  async function rows(): Promise<Array<{ deviceId: string; sessionId: string | null }>> {
    return ds.query(`SELECT "deviceId", "sessionId" FROM push_token ORDER BY "deviceId"`);
  }

  it('applies on an empty table, and replays as a no-op', async () => {
    await ds.query(MIGRATION);
    await ds.query(MIGRATION);
    const [col] = await ds.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'push_token' AND column_name = 'sessionId'`,
      [schema]
    );
    expect(col).toEqual({ data_type: 'uuid', is_nullable: 'YES' });
  });

  it('applies on a populated table and leaves every existing row unbound (no backfill)', async () => {
    await ds.query(
      `INSERT INTO push_token ("userId", "deviceId", token, platform)
       VALUES ('user-1', 'phone-1', 'tok', 'android'), ('user-2', 'phone-2', 'tok', 'ios')`
    );
    await ds.query(MIGRATION);
    expect(await rows()).toEqual([
      { deviceId: 'phone-1', sessionId: null },
      { deviceId: 'phone-2', sessionId: null },
    ]);
  });

  it('ending a session never removes the newer registration a re-sign-in wrote on the same device', async () => {
    await ds.query(MIGRATION);
    // The re-sign-in's registration rewrote the device's one row with its own session.
    await insert('user-1', 'phone-1', NEW_SID);

    await expect(
      controller.endSessionPushRegistration(SECRET, 'user-1', OLD_SID, undefined, undefined)
    ).resolves.toEqual({ removed: 0 });
    expect(await rows()).toEqual([{ deviceId: 'phone-1', sessionId: NEW_SID }]);

    await expect(
      controller.endSessionPushRegistration(SECRET, 'user-1', NEW_SID, undefined, undefined)
    ).resolves.toEqual({ removed: 1 });
    expect(await rows()).toEqual([]);
  });

  it('a session that registered before it named its device is ended by session alone', async () => {
    await ds.query(MIGRATION);
    await insert('user-1', 'phone-1', OLD_SID);
    await expect(
      controller.endSessionPushRegistration(SECRET, 'user-1', OLD_SID, undefined, undefined)
    ).resolves.toEqual({ removed: 1 });
    expect(await rows()).toEqual([]);
  });

  it("a device's row left by a dead session goes with the device's last session, by compare-and-delete", async () => {
    await ds.query(MIGRATION);
    // Bound to a session that is gone; the device's live session never registered.
    await insert('user-1', 'phone-1', OLD_SID);
    const read = await controller.readDevicePushBinding(SECRET, 'user-1', 'phone-1');
    expect(read).toEqual({ registered: true, sessionId: OLD_SID });

    await expect(
      controller.endSessionPushRegistration(SECRET, 'user-1', NEW_SID, 'phone-1', OLD_SID)
    ).resolves.toEqual({ removed: 1 });
    expect(await rows()).toEqual([]);
  });

  it('a registration written after the binding was read is never reached', async () => {
    await ds.query(MIGRATION);
    await insert('user-1', 'phone-1', null);
    // Read: unbound. Then a new sign-in registers before the delete lands.
    await ds.query(`UPDATE push_token SET "sessionId" = $1`, [NEW_SID]);

    await expect(
      controller.endSessionPushRegistration(SECRET, 'user-1', OLD_SID, 'phone-1', 'none')
    ).resolves.toEqual({ removed: 0 });
    expect(await rows()).toEqual([{ deviceId: 'phone-1', sessionId: NEW_SID }]);
  });

  it('an unbound row is ended only for its own account, and a second end is harmless', async () => {
    await ds.query(MIGRATION);
    await insert('user-1', 'phone-1', null);
    await insert('user-2', 'phone-1', null);

    await expect(
      controller.endSessionPushRegistration(SECRET, 'user-1', OLD_SID, 'phone-1', 'none')
    ).resolves.toEqual({ removed: 1 });
    expect(await rows()).toEqual([{ deviceId: 'phone-1', sessionId: null }]);
    await expect(
      controller.endSessionPushRegistration(SECRET, 'user-1', OLD_SID, 'phone-1', 'none')
    ).resolves.toEqual({ removed: 0 });
  });
});
