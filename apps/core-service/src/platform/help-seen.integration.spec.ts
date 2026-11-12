/**
 * THE SEEN-HELP STORE AGAINST A REAL POSTGRESQL: migration 019 as it ships, the controller and the
 * service over a real repository, and the account erasure's own statement for the table.
 *
 * GATED ON `CORE_IT_DATABASE_URL`, like `account-erasure.integration.spec.ts`: CI provides no
 * database here, so the file reports as skipped rather than passing. It needs nothing of core's
 * schema - the migration creates `help_seen` in a throwaway schema, dropped at the end.
 *
 *   CORE_IT_DATABASE_URL=postgres://user:pass@localhost:5432/auth_db bun run test -- help-seen.integration
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, Logger } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import type { User } from '../users/entities/user.entity';
import { HelpSeen } from './entities/help-seen.entity';
import { HelpSeenService } from './help-seen.service';
import { HelpSeenController } from './help-seen.controller';
import { CORE_ERASURE_STATEMENTS } from '../account-erasure/erasure-policy';

const URL = process.env.CORE_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

/** Not a UUID on purpose: `users.id` is a varchar and the table must take any account id. */
const SUBJECT = 'help-it-subject@example.org';
const OTHER = 'help-it-other@example.org';

maybe('help_seen against PostgreSQL', () => {
  const schema = `help_seen_it_${Date.now()}`;
  let ds: DataSource;
  let controller: HelpSeenController;

  beforeAll(async () => {
    const admin = new DataSource({ type: 'postgres', url: URL });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.destroy();
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [HelpSeen],
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    const migration = readFileSync(
      join(__dirname, '..', 'migrations', '019_help_seen.sql'),
      'utf8'
    );
    await ds.query(migration);
    // Applied twice, as the deploy ledger may replay a file: it must be a no-op the second time.
    await ds.query(migration);
    controller = new HelpSeenController(
      new HelpSeenService(ds.getRepository(HelpSeen), {} as Repository<User>)
    );
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  }, 60_000);

  afterAll(async () => {
    await ds?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds?.destroy();
    jest.restoreAllMocks();
  }, 60_000);

  async function rows(userId: string): Promise<number> {
    const [row] = await ds.query(`SELECT count(*)::int AS n FROM help_seen WHERE user_id = $1`, [
      userId,
    ]);
    return row.n;
  }

  it('is idempotent: the same id twice is one row and the same answer', async () => {
    await expect(controller.list(SUBJECT)).resolves.toEqual({
      seen: [],
      ageSeconds: {},
      profilePhotoPromptEligible: false,
    });
    await expect(controller.markSeen(SUBJECT, 'welcome-tour')).resolves.toEqual({ success: true });
    await expect(controller.markSeen(SUBJECT, 'welcome-tour')).resolves.toEqual({ success: true });
    expect(await rows(SUBJECT)).toBe(1);
    await expect(controller.list(SUBJECT)).resolves.toEqual({
      seen: ['welcome-tour'],
      ageSeconds: { 'welcome-tour': expect.any(Number) },
      profilePhotoPromptEligible: false,
    });
    // Another account's state is its own.
    await expect(controller.list(OTHER)).resolves.toEqual({
      seen: [],
      ageSeconds: {},
      profilePhotoPromptEligible: false,
    });
  });

  it('refuses an id outside the allowlist and writes nothing', async () => {
    await expect(controller.markSeen(OTHER, 'not-a-help')).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(controller.markSeen(OTHER, 'x'.repeat(65))).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(await rows(OTHER)).toBe(0);
  });

  it('a row a later release retired is kept in the table and never handed out', async () => {
    await ds.query(`INSERT INTO help_seen (user_id, help_id) VALUES ($1, 'retired-hint')`, [OTHER]);
    await expect(controller.list(OTHER)).resolves.toEqual({
      seen: [],
      ageSeconds: {},
      profilePhotoPromptEligible: false,
    });
  });

  it("is erased by the account erasure's statement, and only for that account", async () => {
    await controller.markSeen(OTHER, 'welcome-tour');
    const statement = CORE_ERASURE_STATEMENTS.find((s) => s.label === 'help_seen');
    expect(statement).toBeDefined();
    await ds.query(statement!.sql, [SUBJECT]);
    expect(await rows(SUBJECT)).toBe(0);
    expect(await rows(OTHER)).toBe(2);
  });
});
