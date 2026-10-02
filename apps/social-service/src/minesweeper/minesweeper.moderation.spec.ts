/**
 * MINESWEEPER MODERATION (user, 2026-10-02): a global admin can REMOVE a score and BAN a user.
 *
 * What these cases are built to catch, in the order a regression would hurt:
 *  - a banned player still opening a ranked challenge or submitting one opened before the ban;
 *  - a ban that DELETES anything - it must not, or lifting it could not restore the scores;
 *  - a banned player's standing still reaching a profile badge;
 *  - an unban that reports success for a user who was never banned;
 *  - a moderator banning themselves.
 *
 * The leaderboard and rank SQL need a real PostgreSQL and none is available to this suite: the two
 * statement checks below only pin that BOTH ask about bans - they prove the statement names the
 * table, not that it returns the right rows.
 */
import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { MinesweeperService } from './minesweeper.service';
import type { MinesweeperBan } from './entities/minesweeper-ban.entity';
import type { MinesweeperChallenge } from './entities/minesweeper-challenge.entity';
import type { MinesweeperScore } from './entities/minesweeper-score.entity';

function build() {
  const banRows = new Map<string, MinesweeperBan>();
  const scoreRows = new Map<string, MinesweeperScore>();
  const queries: string[] = [];

  const bans = {
    count: async ({ where }: { where: { userId: string } }) => (banRows.has(where.userId) ? 1 : 0),
    create: (row: Partial<MinesweeperBan>) => ({
      bannedAt: new Date('2026-10-02T10:00:00Z'),
      ...row,
    }),
    save: async (row: MinesweeperBan) => void banRows.set(row.userId, row),
    delete: async ({ userId }: { userId: string }) => ({
      affected: banRows.delete(userId) ? 1 : 0,
    }),
    find: async () => [...banRows.values()],
  };
  const scores = {
    findOne: async ({ where }: { where: { id?: string; userId?: string } }) =>
      [...scoreRows.values()].find((s) =>
        where.id ? s.id === where.id : s.userId === where.userId
      ) ?? null,
    delete: async ({ id }: { id: string }) => void scoreRows.delete(id),
    query: async (sql: string) => {
      queries.push(sql);
      return [];
    },
  };
  const challengeFindOne = jest.fn();
  const challenges = {
    findOne: challengeFindOne,
    createQueryBuilder: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  const service = new MinesweeperService(
    challenges as unknown as Repository<MinesweeperChallenge>,
    scores as unknown as Repository<MinesweeperScore>,
    bans as unknown as Repository<MinesweeperBan>
  );
  return { service, banRows, scoreRows, queries, challenges };
}

const score = (id: string, userId: string, durationMs: number): MinesweeperScore =>
  ({
    id,
    userId,
    durationMs,
    moveCount: 90,
    challengeId: `c-${id}`,
    verifiedAt: new Date(),
  }) as MinesweeperScore;

describe('MinesweeperService moderation', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('removing a score', () => {
    it('deletes that one score and leaves the player their others', async () => {
      const { service, scoreRows } = build();
      scoreRows.set('s1', score('s1', 'alice', 40_000));
      scoreRows.set('s2', score('s2', 'alice', 55_000));

      const out = await service.removeScore('s1', 'admin');

      expect(out).toEqual({ removed: true, userId: 'alice', durationMs: 40_000 });
      expect([...scoreRows.keys()]).toEqual(['s2']);
    });

    it('is a 404 for a score that is not there, so a stale list cannot claim a removal', async () => {
      const { service } = build();
      await expect(service.removeScore('nope', 'admin')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('banning a user', () => {
    it('records the ban with its author and reason, and deletes nothing', async () => {
      const { service, banRows, scoreRows } = build();
      scoreRows.set('s1', score('s1', 'mallory', 9_000));

      await service.ban('mallory', '  cheating  ', 'admin');

      expect(banRows.get('mallory')).toMatchObject({
        userId: 'mallory',
        reason: 'cheating',
        bannedBy: 'admin',
      });
      // The score stays, so lifting the ban restores it.
      expect(scoreRows.has('s1')).toBe(true);
    });

    it('keeps no reason when none is given, rather than an empty string', async () => {
      const { service, banRows } = build();
      await service.ban('mallory', '   ', 'admin');
      expect(banRows.get('mallory')?.reason).toBeNull();
    });

    it('refuses a moderator banning themselves', async () => {
      const { service, banRows } = build();
      await expect(service.ban('admin', undefined, 'admin')).rejects.toBeInstanceOf(
        BadRequestException
      );
      expect(banRows.size).toBe(0);
    });

    it('banning twice only updates the one row', async () => {
      const { service, banRows } = build();
      await service.ban('mallory', 'first', 'admin');
      await service.ban('mallory', 'second', 'admin');
      expect(banRows.size).toBe(1);
      expect(banRows.get('mallory')?.reason).toBe('second');
    });
  });

  describe('a banned player', () => {
    it('cannot start a ranked challenge', async () => {
      const { service, banRows, challenges } = build();
      banRows.set('mallory', { userId: 'mallory' } as MinesweeperBan);
      await expect(service.startChallenge('mallory')).rejects.toBeInstanceOf(ForbiddenException);
      expect(challenges.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('cannot submit a challenge opened before the ban', async () => {
      const { service, banRows, challenges } = build();
      banRows.set('mallory', { userId: 'mallory' } as MinesweeperBan);
      await expect(
        service.submit('mallory', 'c1', { moves: [], claimedDurationMs: 30_000 })
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(challenges.findOne).not.toHaveBeenCalled();
    });

    it('has no standing, so a profile badge cannot show a rank they were removed from', async () => {
      const { service, banRows, scoreRows } = build();
      scoreRows.set('s1', score('s1', 'mallory', 9_000));
      banRows.set('mallory', { userId: 'mallory' } as MinesweeperBan);
      expect(await service.userStanding('mallory')).toBeNull();
      expect(await service.me('mallory')).toEqual({ personalBestMs: null, rank: null });
    });

    it('has the standing back once the ban is lifted - nothing was deleted', async () => {
      const { service, banRows, scoreRows } = build();
      scoreRows.set('s1', score('s1', 'mallory', 9_000));
      banRows.set('mallory', { userId: 'mallory' } as MinesweeperBan);
      await service.unban('mallory', 'admin');
      const standing = await service.userStanding('mallory');
      expect(standing?.personalBestMs).toBe(9_000);
    });
  });

  describe('lifting a ban', () => {
    it('is a 404 when there was none', async () => {
      const { service } = build();
      await expect(service.unban('nobody', 'admin')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listing the bans', () => {
    it('is empty with no query when nobody is banned', async () => {
      const { service, queries } = build();
      expect(await service.listBans()).toEqual({ bans: [] });
      expect(queries).toHaveLength(0);
    });
  });

  // PIN THAT BOTH STATEMENTS ASK ABOUT BANS - not that they are right (that needs a database).
  describe('the leaderboard and the rank statements', () => {
    it('both leave a banned player out', async () => {
      const { service, queries } = build();
      await service.leaderboard();
      await service.rankForDurationMs(30_000);
      const asked = queries.filter((q) => /FROM minesweeper_scores/.test(q));
      expect(asked).toHaveLength(2);
      for (const sql of asked) expect(sql).toMatch(/minesweeper_bans/);
    });

    it("the leaderboard names each row's score id, which is what a moderator removes", async () => {
      const { service, queries } = build();
      await service.leaderboard();
      expect(queries[0]).toMatch(/s\.id AS "scoreId"/);
    });
  });
});
