/**
 * A PLATFORM CONFIG WRITE UPDATES THE COLUMNS IT NAMES, NEVER SAVES THE ROW IT READ, AGAINST A REAL
 * POSTGRESQL.
 *
 * Two administrators editing different settings of the one config row must both be kept. A TypeORM
 * `save` of the row read earlier writes back every column another administrator changed since that
 * read; one column `UPDATE` does not. The case lets a second write commit between the first write's
 * read and its own write - the second runs from inside the first's own `findOneOrFail`, so the
 * interleaving is deterministic (never a sleep).
 *
 * GATED ON `CORE_IT_DATABASE_URL`, like the other integration files; the `boot-nest-apps` job in
 * `ci.yml` sets it. It needs no existing schema: the table is created from its entity in a throwaway
 * schema, dropped at the end.
 *
 *   CORE_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- platform-config-write.integration
 */
import { Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { PlatformConfig } from './entities/platform-config.entity';
import { PlatformService } from './platform.service';

const URL = process.env.CORE_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const ADMIN_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const ADMIN_B = 'bbbbbbbb-2222-4222-8222-222222222222';

maybe('a platform config write against PostgreSQL', () => {
  const schema = `platform_write_it_${Math.random().toString(36).slice(2, 10)}`;
  let ds: DataSource;
  let repo: Repository<PlatformConfig>;
  let service: PlatformService;

  /**
   * Runs `hook` once, right after the service's next read of the config row has answered. The spy
   * is gone before `hook` runs, so the hook's own calls are real. Answers whether it ran.
   */
  const afterRead = (hook: () => Promise<unknown>): (() => boolean) => {
    let ran = false;
    const read = repo.findOneOrFail.bind(repo);
    const spy = jest.spyOn(repo, 'findOneOrFail').mockImplementation((async (
      ...args: Parameters<typeof read>
    ) => {
      const answer = await read(...args);
      spy.mockRestore();
      ran = true;
      await hook();
      return answer;
    }) as never);
    return () => ran;
  };

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'debug', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    const admin = new DataSource({ type: 'postgres', url: URL });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.destroy();
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [PlatformConfig],
      synchronize: true,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    repo = ds.getRepository(PlatformConfig);
    service = new PlatformService(repo);
    await service.onModuleInit();
  }, 60_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await ds?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds?.destroy();
  }, 60_000);

  it('two administrators editing different settings keep both', async () => {
    const before = await repo.findOneOrFail({ where: { id: 1 } });
    const ran = afterRead(() => service.updateConfig({ callsMode: 'audio' }, ADMIN_B));
    const answered = await service.updateConfig(
      { maintenanceEnabled: !before.maintenanceEnabled },
      ADMIN_A
    );
    expect(ran()).toBe(true);
    const row = await repo.findOneOrFail({ where: { id: 1 } });
    expect(row.callsMode).toBe('audio');
    expect(row.maintenanceEnabled).toBe(!before.maintenanceEnabled);
    // What the write answers is the row as stored, the other administrator's edit included.
    expect(answered.callsMode).toBe('audio');
  });
});
