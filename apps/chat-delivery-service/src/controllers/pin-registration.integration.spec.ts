/**
 * THE FIRST PIN OF AN ACCOUNT, AGAINST A REAL POSTGRESQL (PIN audit, 2026-11-20).
 *
 * `pin-check` used to read the placeholder row `GET pin-salt` writes, see the empty verifier, and save
 * its own unconditionally: two devices creating at once were BOTH told `registered` and the row kept
 * the last save. The registration is now one conditional write, and these cases hold it against the
 * database rather than a mocked repository:
 *
 * - two creations racing on the placeholder: exactly one `registered`, the other COMPARED (`ok` for
 *   the same PIN, `mismatch` for another), and the row holds the registered one;
 * - an unlock on an account with no PIN: `not-set`, nothing stored;
 * - `pin-status` reads the placeholder as NOT registered, a stored verifier as registered.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads.
 * Locally:
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- pin-registration.integration
 *
 * A throwaway schema, created before the DataSource initializes and dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { SecurityController } from './security.controller';
import { PinVerifier } from '../entities/pin-verifier.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { KeyPackage } from '../entities/key-package.entity';
import type { MessagingService } from '../services/messaging.service';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION_011 = readFileSync(
  join(__dirname, '..', 'migrations', '011_pin_verifier_salt.sql'),
  'utf8'
);

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

maybe('the first PIN of an account (PostgreSQL)', () => {
  const schema = `pin_registration_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let controller: SecurityController;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  /** The placeholder row `GET pin-salt` writes for an account with no PIN yet. */
  const placeholder = (userId: string) => controller.getPinSalt(userId, userId);
  const create = (userId: string, verifier: string, salt: string) =>
    controller.checkPinVerifier({ userId, verifier, salt, intent: 'create' }, userId);
  const storedVerifier = async (userId: string) =>
    (
      (await q(`SELECT verifier FROM pin_verifier WHERE "userId" = $1`, [userId])) as {
        verifier: string;
      }[]
    )[0]?.verifier;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [PinVerifier, RevokedDevice, KeyPackage],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    await ds.synchronize();
    await q(MIGRATION_011);
    controller = new SecurityController(
      ds.getRepository(PinVerifier),
      ds.getRepository(RevokedDevice),
      ds.getRepository(KeyPackage),
      {} as MessagingService
    );
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
    jest.restoreAllMocks();
  });

  it('two creations racing on the placeholder: one registered, the other compared', async () => {
    const { salt } = await placeholder('u-race');
    const answers = await Promise.all([create('u-race', A, salt), create('u-race', B, salt)]);
    const statuses = answers.map((r) => r.status).sort();

    expect(statuses).toEqual(['mismatch', 'registered']);
    const winner = answers[0].status === 'registered' ? A : B;
    expect(await storedVerifier('u-race')).toBe(winner);
  });

  it('the same PIN created on two devices at once: registered and ok', async () => {
    const { salt } = await placeholder('u-same');
    const answers = await Promise.all([create('u-same', A, salt), create('u-same', A, salt)]);

    expect(answers.map((r) => r.status).sort()).toEqual(['ok', 'registered']);
    expect(await storedVerifier('u-same')).toBe(A);
  });

  it('an unlock on an account with no PIN answers not-set and stores nothing', async () => {
    const { salt } = await placeholder('u-unlock');
    await expect(
      controller.checkPinVerifier(
        { userId: 'u-unlock', verifier: A, salt, intent: 'unlock' },
        'u-unlock'
      )
    ).resolves.toEqual({ status: 'not-set', resetRequired: false });
    expect(await storedVerifier('u-unlock')).toBe('');
  });

  it('pin-status reads the placeholder as not registered, a stored PIN as registered', async () => {
    const { salt } = await placeholder('u-status');
    await expect(controller.getPinStatus('u-status', 'u-status')).resolves.toEqual({
      registered: false,
    });
    await create('u-status', A, salt);
    await expect(controller.getPinStatus('u-status', 'u-status')).resolves.toEqual({
      registered: true,
    });
  });
});
