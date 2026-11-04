/**
 * MINESWEEPER STATS AND PAGING (2026-11-04): a player's own ranked record, and a leaderboard that
 * pages. The server only knows RANKED games - a casual game never opens a challenge - so "played" is
 * the player's challenges and "won" their stored scores.
 *
 * Pinned: the shape and the arithmetic of `stats` (lost = played - won, a rate that is null rather
 * than NaN for a player who never played, `won` never above `played`), the offset and `total` of the
 * leaderboard with ranks that continue across pages, and a negative or fractional offset clamped.
 * The SQL itself (percentile_cont, DISTINCT ON) needs a real PostgreSQL and none is available here.
 */
import type { Repository } from 'typeorm';
import { MinesweeperService } from './minesweeper.service';
import type { MinesweeperBan } from './entities/minesweeper-ban.entity';
import type { MinesweeperChallenge } from './entities/minesweeper-challenge.entity';
import type { MinesweeperScore } from './entities/minesweeper-score.entity';

interface Fixture {
  played: number;
  aggregate: { won: number; best: number | null; average: number | null; median: number | null };
  recent: Array<{ scoreId: string; durationMs: number; moveCount: number; verifiedAt: Date }>;
  leaderboardRows: Array<{
    scoreId: string;
    userId: string;
    durationMs: number;
    moveCount: number;
    verifiedAt: Date;
  }>;
  rankCount: number;
  personalBest: { durationMs: number; moveCount: number; verifiedAt: Date } | null;
}

function build(f: Partial<Fixture> = {}) {
  const fx: Fixture = {
    played: 0,
    aggregate: { won: 0, best: null, average: null, median: null },
    recent: [],
    leaderboardRows: [],
    rankCount: 0,
    personalBest: null,
    ...f,
  };
  const challenges = {
    query: async () => [{ played: fx.played }],
  };
  const scores = {
    findOne: async () => fx.personalBest,
    query: async (sql: string) => {
      if (sql.includes('percentile_cont')) return [fx.aggregate];
      if (sql.includes('LIMIT')) return fx.recent;
      if (sql.includes('DISTINCT ON')) return fx.leaderboardRows;
      if (sql.includes('FROM users')) return [];
      if (sql.includes('bests')) return [{ cnt: fx.rankCount }];
      return [];
    },
  };
  const bans = { count: async () => 0 };
  return new MinesweeperService(
    challenges as unknown as Repository<MinesweeperChallenge>,
    scores as unknown as Repository<MinesweeperScore>,
    bans as unknown as Repository<MinesweeperBan>
  );
}

const row = (n: number) => ({
  scoreId: `s${n}`,
  userId: `u${n}`,
  durationMs: 10_000 + n * 1000,
  moveCount: 90,
  verifiedAt: new Date('2026-11-01T10:00:00Z'),
});

describe('MinesweeperService.stats', () => {
  it('is all zeros and a null rate for a player who never played ranked', async () => {
    const stats = await build().stats('me');
    expect(stats).toMatchObject({
      played: 0,
      won: 0,
      lost: 0,
      winRate: null,
      bestMs: null,
      averageMs: null,
      medianMs: null,
      rank: null,
      recent: [],
    });
  });

  it('counts a challenge that never became a score as a loss', async () => {
    const when = new Date('2026-11-02T09:00:00Z');
    const stats = await build({
      played: 8,
      aggregate: { won: 2, best: 41_000, average: 50_000, median: 50_000 },
      recent: [
        { scoreId: 'a', durationMs: 41_000, moveCount: 90, verifiedAt: when },
        { scoreId: 'b', durationMs: 59_000, moveCount: 95, verifiedAt: when },
      ],
      personalBest: { durationMs: 41_000, moveCount: 90, verifiedAt: when },
      rankCount: 3,
    }).stats('me');
    expect(stats.played).toBe(8);
    expect(stats.won).toBe(2);
    expect(stats.lost).toBe(6);
    expect(stats.winRate).toBeCloseTo(0.25);
    expect([stats.bestMs, stats.averageMs, stats.medianMs]).toEqual([41_000, 50_000, 50_000]);
    expect(stats.rank).toBe(4);
    expect(stats.recent.map((r) => r.scoreId)).toEqual(['a', 'b']);
    expect(stats.recent[0].verifiedAt).toBe(when.toISOString());
  });

  it('never reports more wins than games played', async () => {
    const stats = await build({
      played: 1,
      aggregate: { won: 3, best: 30_000, average: 31_000, median: 31_000 },
    }).stats('me');
    expect(stats.played).toBe(3);
    expect(stats.lost).toBe(0);
    expect(stats.winRate).toBe(1);
  });
});

describe('MinesweeperService.leaderboard paging', () => {
  const rows = Array.from({ length: 25 }, (_, i) => row(i + 1));

  it('returns the first page with the total of ranked players', async () => {
    const page = await build({ leaderboardRows: rows }).leaderboard(10, 'me', 0);
    expect(page.total).toBe(25);
    expect(page.entries.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('continues the ranks on the next page and stops short on the last one', async () => {
    const service = build({ leaderboardRows: rows });
    const second = await service.leaderboard(10, 'me', 10);
    expect(second.entries[0]).toMatchObject({ rank: 11, userId: 'u11' });
    const last = await service.leaderboard(10, 'me', 20);
    expect(last.entries.map((e) => e.rank)).toEqual([21, 22, 23, 24, 25]);
    expect((await service.leaderboard(10, 'me', 40)).entries).toEqual([]);
  });

  it('clamps a negative or fractional offset to a real place', async () => {
    const service = build({ leaderboardRows: rows });
    expect((await service.leaderboard(5, 'me', -7)).entries[0].rank).toBe(1);
    expect((await service.leaderboard(5, 'me', 2.9)).entries[0].rank).toBe(3);
  });

  it('keeps the 50-per-page cap', async () => {
    const many = Array.from({ length: 80 }, (_, i) => row(i + 1));
    expect((await build({ leaderboardRows: many }).leaderboard(500, 'me', 0)).entries).toHaveLength(
      50
    );
  });
});
