/**
 * MINESWEEPER PER-PROMO RANKING against a REAL PostgreSQL (owner, 2026-11-10; the Games page,
 * docs/wiki/frontend/modules/minesweeper.md): the board narrowed to one entry year through
 * `users.promo`, the promos list with player counts, and the caller's own promo.
 *
 * What only the database can prove: ranks are counted INSIDE a promo (not in the global board), an
 * account with no promo (no cursus) is absent from every promo ranking and from the promo list, a
 * banned player and a removed score are excluded exactly as in the global ranking, and `mine` is the
 * caller's own `users.promo`.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Locally, against any throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- minesweeper.promo.integration
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { MinesweeperBan } from './entities/minesweeper-ban.entity';
import { MinesweeperChallenge } from './entities/minesweeper-challenge.entity';
import { MinesweeperScore } from './entities/minesweeper-score.entity';
import { MinesweeperService } from './minesweeper.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

/**
 * The cast and their best times (ms): promo 2026 has `a` (20 s), `b` (30 s) and `c` (40 s, banned);
 * promo 2027 has `d` (25 s) and `e` (35 s, whose 15 s score is later removed); `f` has no cursus (no
 * promo) and the fastest time of all, 10 s; `g` is promo 2026 with no score at all.
 */
const PEOPLE: Array<[string, number | null]> = [
  ['a', 2026],
  ['b', 2026],
  ['c', 2026],
  ['d', 2027],
  ['e', 2027],
  ['f', null],
  ['g', 2026],
];

maybe('minesweeper per-promo ranking against PostgreSQL', () => {
  const schema = `ms_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: MinesweeperService;
  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
  const scoreIds = new Map<string, string>();

  /** One verified score for `userId`, with the challenge row its foreign key needs. */
  async function score(label: string, userId: string, durationMs: number) {
    const challenge = await q(
      `INSERT INTO minesweeper_challenges ("userId", seed, width, height, "mineCount", "startedAt", "expiresAt", status)
       VALUES ($1, 's', 18, 32, 150, now(), now(), 'submitted') RETURNING id`,
      [userId]
    );
    const row = await q(
      `INSERT INTO minesweeper_scores ("challengeId", "userId", "durationMs", "moveCount", "verifiedAt")
       VALUES ($1, $2, $3, 90, now()) RETURNING id`,
      [challenge.rows[0].id, userId, durationMs]
    );
    scoreIds.set(label, row.rows[0].id as string);
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}, public`);
    await q(`CREATE TABLE users (id varchar(255) PRIMARY KEY, "displayName" varchar, promo int,
      cursus jsonb NOT NULL DEFAULT '[]')`);
    await q(migration('018_minesweeper_leaderboard.sql'));
    await q(migration('070_minesweeper_bans.sql'));
    for (const [id, promo] of PEOPLE) {
      await q(`INSERT INTO users (id, "displayName", promo) VALUES ($1, $2, $3)`, [
        id,
        id.toUpperCase(),
        promo,
      ]);
    }
    await score('a', 'a', 20_000);
    await score('a-slow', 'a', 90_000);
    await score('b', 'b', 30_000);
    await score('c', 'c', 40_000);
    await score('d', 'd', 25_000);
    await score('e', 'e', 35_000);
    await score('e-fast', 'e', 15_000);
    await score('f', 'f', 10_000);
    await q(`INSERT INTO minesweeper_bans ("userId", "bannedBy") VALUES ('c', 'admin')`);

    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [MinesweeperChallenge, MinesweeperScore, MinesweeperBan],
      synchronize: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    service = new MinesweeperService(
      ds.getRepository(MinesweeperChallenge),
      ds.getRepository(MinesweeperScore),
      ds.getRepository(MinesweeperBan)
    );
  });

  afterAll(async () => {
    await ds?.destroy();
    await q(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  const board = async (promo?: number) =>
    (await service.leaderboard(50, 'a', 0, promo)).entries.map((e) => `${e.rank}:${e.userId}`);

  it('the global board still holds everyone, the promo-less player and the banned one apart', async () => {
    // f (10 s), e (15 s, before its removal), a, d, b - c is banned.
    expect(await board()).toEqual(['1:f', '2:e', '3:a', '4:d', '5:b']);
  });

  it('counts ranks INSIDE a promo, with each player their best time only', async () => {
    expect(await board(2026)).toEqual(['1:a', '2:b']);
    expect(await board(2027)).toEqual(['1:e', '2:d']);
    expect((await service.leaderboard(50, 'a', 0, 2026)).total).toBe(2);
  });

  it('never shows a player without a promo in a promo ranking, nor a banned one', async () => {
    for (const promo of [2026, 2027]) {
      const ids = (await board(promo)).map((r) => r.split(':')[1]);
      expect(ids).not.toContain('f');
      expect(ids).not.toContain('c');
    }
    expect(await board(1999)).toEqual([]);
  });

  it('lists the promos with their ranked players, newest first, and the caller own promo', async () => {
    const out = await service.promos('a');
    expect(out).toEqual({
      promos: [
        { promo: 2027, players: 2 },
        { promo: 2026, players: 2 },
      ],
      mine: 2026,
    });
    // `f` has no cursus: no own promo, and a player with no score (`g`) still has one.
    expect((await service.promos('f')).mine).toBeNull();
    expect((await service.promos('g')).mine).toBe(2026);
  });

  it('excludes a removed score as the global ranking does, and a lifted ban brings the player back', async () => {
    await service.removeScore(scoreIds.get('e-fast')!, 'admin');
    expect(await board(2027)).toEqual(['1:d', '2:e']);
    expect(await board()).toEqual(['1:f', '2:a', '3:d', '4:b', '5:e']);

    await service.unban('c', 'admin');
    expect(await board(2026)).toEqual(['1:a', '2:b', '3:c']);
    expect((await service.promos('a')).promos).toEqual([
      { promo: 2027, players: 2 },
      { promo: 2026, players: 3 },
    ]);
  });
});
