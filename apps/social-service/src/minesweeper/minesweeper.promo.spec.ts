/**
 * MINESWEEPER PER-PROMO RANKING (owner, 2026-11-10): the board narrowed to one entry year through
 * `users.promo` (the cursus' entry year - an account with no cursus has none, so it never appears in
 * a promo ranking), and the list of promos that have a ranking. The SQL itself needs a real
 * PostgreSQL and none is available here, so this pins its shape and its parameters.
 */
import type { Repository } from 'typeorm';
import { MinesweeperService } from './minesweeper.service';
import type { MinesweeperBan } from './entities/minesweeper-ban.entity';
import type { MinesweeperChallenge } from './entities/minesweeper-challenge.entity';
import type { MinesweeperScore } from './entities/minesweeper-score.entity';

function capture() {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const scores = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('GROUP BY u.promo')) {
        return [
          { promo: 2027, players: '3' },
          { promo: 2026, players: 12 },
        ];
      }
      if (sql.includes('SELECT promo FROM users')) return [{ promo: 2026 }];
      return [];
    },
  };
  const service = new MinesweeperService(
    { query: async () => [] } as unknown as Repository<MinesweeperChallenge>,
    scores as unknown as Repository<MinesweeperScore>,
    { count: async () => 0 } as unknown as Repository<MinesweeperBan>
  );
  return { service, calls };
}

describe('MinesweeperService per-promo ranking', () => {
  it('narrows the board to the entry year, through users.promo, the year being a parameter', async () => {
    const { service, calls } = capture();
    await service.leaderboard(25, 'me', 0, 2026);
    const board = calls.find((c) => c.sql.includes('DISTINCT ON'));
    expect(board?.sql).toContain('pu.promo = $1');
    expect(board?.params).toEqual([2026]);
  });

  it('leaves the global board untouched without a promo', async () => {
    const { service, calls } = capture();
    await service.leaderboard(25, 'me', 0);
    const board = calls.find((c) => c.sql.includes('DISTINCT ON'));
    expect(board?.sql).not.toContain('pu.promo');
    expect(board?.params).toEqual([]);
  });

  it('lists the promos that have a ranking, newest first, with the caller own promo', async () => {
    const { service, calls } = capture();
    const out = await service.promos('me');
    expect(out).toEqual({
      promos: [
        { promo: 2027, players: 3 },
        { promo: 2026, players: 12 },
      ],
      mine: 2026,
    });
    // Only an account with a cursus (a promo) is ranked, and a banned player is not.
    const sql = calls.find((c) => c.sql.includes('GROUP BY u.promo'))?.sql ?? '';
    expect(sql).toContain('u.promo IS NOT NULL');
    expect(sql).toContain('minesweeper_bans');
  });
});
