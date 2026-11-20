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
 * - a creation whose placeholder a reset replaced between its read and its write (a new salt):
 *   `stale-salt`, never `registered` on a row whose salt it did not derive from;
 * - the legacy path (no intent, no salt, no row): two inserts racing, decided by the returned row,
 *   and an insert meeting a placeholder minted meanwhile, which it must not fill;
 * - an unlock on an account with no PIN: `not-set`, nothing stored;
 * - `pin-status` reads the placeholder as NOT registered, a stored verifier as registered.
 *
 * THE RACES ARE HELD, NOT HOPED FOR: {@link afterReads} parks every racer after its read of the row
 * until all of them have read it, so each test fails on a write that is not conditional.
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
import { DataSource, Repository } from 'typeorm';
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
  let pinRepo: Repository<PinVerifier>;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  /** The placeholder row `GET pin-salt` writes for an account with no PIN yet. */
  const placeholder = (userId: string) => controller.getPinSalt(userId, userId);
  const create = (userId: string, verifier: string, salt: string) =>
    controller.checkPinVerifier({ userId, verifier, salt, intent: 'create' }, userId);
  /** A client from before the intent and the salt: no row read, an INSERT. */
  const legacyCreate = (userId: string, verifier: string) =>
    controller.checkPinVerifier({ userId, verifier }, userId);
  /** What a "forgot PIN" reset does to the row: deletes it (`pin-salt` then mints a new one). */
  const resetRow = (userId: string) => q(`DELETE FROM pin_verifier WHERE "userId" = $1`, [userId]);

  /**
   * Parks the next `count` reads of `pin_verifier` until all of them have been made, runs `between`,
   * then lets them go: every racer has read the row before any of them writes. Later reads (the
   * re-read after a lost write, `between`'s own) pass straight through.
   */
  const afterReads = (count: number, between: () => Promise<unknown> = async () => undefined) => {
    const read = pinRepo.findOne.bind(pinRepo);
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spy = jest.spyOn(pinRepo, 'findOne').mockImplementation(async (options) => {
      const row = await read(options);
      if (arrived < count) {
        arrived += 1;
        if (arrived === count) {
          await between();
          release();
        }
        await gate;
      }
      return row;
    });
    return () => spy.mockRestore();
  };
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
    pinRepo = ds.getRepository(PinVerifier);
    controller = new SecurityController(
      pinRepo,
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
    const done = afterReads(2);
    const answers = await Promise.all([create('u-race', A, salt), create('u-race', B, salt)]);
    done();

    expect(answers.map((r) => r.status).sort()).toEqual(['mismatch', 'registered']);
    const winner = answers[0].status === 'registered' ? A : B;
    expect(await storedVerifier('u-race')).toBe(winner);
  });

  it('the same PIN created on two devices at once: registered and ok', async () => {
    const { salt } = await placeholder('u-same');
    const done = afterReads(2);
    const answers = await Promise.all([create('u-same', A, salt), create('u-same', A, salt)]);
    done();

    expect(answers.map((r) => r.status).sort()).toEqual(['ok', 'registered']);
    expect(await storedVerifier('u-same')).toBe(A);
  });

  it('a reset between the read and the write: stale-salt, the new placeholder left empty', async () => {
    const { salt: oldSalt } = await placeholder('u-reset-race');
    const done = afterReads(1, async () => {
      await resetRow('u-reset-race');
      await placeholder('u-reset-race');
    });
    const answer = await create('u-reset-race', A, oldSalt);
    done();

    expect(answer).toEqual({ status: 'stale-salt', resetRequired: false });
    expect(await storedVerifier('u-reset-race')).toBe('');
  });

  it('a creation with the salt of a placeholder a reset replaced: never registered', async () => {
    const { salt: oldSalt } = await placeholder('u-reset');
    await resetRow('u-reset');
    const { salt: newSalt } = await placeholder('u-reset');
    expect(newSalt).not.toBe(oldSalt);

    await expect(create('u-reset', A, oldSalt)).resolves.toEqual({
      status: 'stale-salt',
      resetRequired: false,
    });
    expect(await storedVerifier('u-reset')).toBe('');
  });

  it('LEGACY: two inserts racing on no row - the returned row decides', async () => {
    const done = afterReads(2);
    const answers = await Promise.all([legacyCreate('u-legacy', A), legacyCreate('u-legacy', B)]);
    done();

    expect(answers.map((r) => r.status).sort()).toEqual(['mismatch', 'registered']);
    const winner = answers[0].status === 'registered' ? A : B;
    expect(await storedVerifier('u-legacy')).toBe(winner);
  });

  it('LEGACY: an insert meeting a placeholder minted meanwhile does not fill it', async () => {
    const done = afterReads(1, () => placeholder('u-legacy-mint'));
    const answer = await legacyCreate('u-legacy-mint', A);
    done();

    expect(answer).toEqual({ status: 'stale-salt', resetRequired: false });
    expect(await storedVerifier('u-legacy-mint')).toBe('');
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
