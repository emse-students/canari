/**
 * MINESWEEPER REPLAY (owner, 2026-11-17): a won ranked game keeps its timed move log, and a global
 * admin can read it back to judge whether the game was legitimate.
 *
 * What these cases are built to catch, in the order a regression would hurt:
 *  - a log whose timestamps do not describe the game (wrong length, backwards) being ACCEPTED, or
 *    refused without the challenge being stored as rejected;
 *  - a win whose replay could not be stored turning into an error for an honest player;
 *  - the stored log losing its timestamps on the way into the table;
 *  - the replay endpoint answering for a score that has none, or leaving no trace of who read it.
 */
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { MinesweeperService } from './minesweeper.service';
import type { TimedMove } from './minesweeper.timings';
import { CHALLENGE, createBoard, revealCell } from './engine/game';
import type { MinesweeperBan } from './entities/minesweeper-ban.entity';
import type { MinesweeperChallenge } from './entities/minesweeper-challenge.entity';
import type { MinesweeperReplay } from './entities/minesweeper-replay.entity';
import type { MinesweeperScore } from './entities/minesweeper-score.entity';

const seed = '8601e326fcef5ef936a1c69d6ab6ac41';
const [x, y] = [9, 16];

/** A log that clears the generator-2 board of `seed`: the first click, then every other safe cell. */
function winningLog(): TimedMove[] {
  const board = createBoard(CHALLENGE, seed, 2);
  revealCell(board, x, y);
  const moves: TimedMove[] = [{ type: 'reveal', x, y, t: 0 }];
  board.cells.forEach((cell, i) => {
    if (!cell.mine) {
      moves.push({
        type: 'reveal',
        x: i % board.width,
        y: Math.floor(i / board.width),
        t: moves.length * 40,
      });
    }
  });
  return moves;
}

const challengeRow = (): MinesweeperChallenge =>
  ({
    id: 'challenge-1',
    userId: 'user-1',
    seed,
    width: CHALLENGE.width,
    height: CHALLENGE.height,
    mineCount: CHALLENGE.mineCount,
    startedAt: new Date(Date.now() - 300_000),
    expiresAt: new Date(Date.now() + 3_600_000),
    status: 'open',
    generatorVersion: 2,
  }) as MinesweeperChallenge;

function build() {
  const savedChallenges: Array<Partial<MinesweeperChallenge>> = [];
  const savedReplays: Array<Partial<MinesweeperReplay>> = [];
  const storedScores = new Map<string, MinesweeperScore>();
  const challenges = {
    findOne: jest.fn(),
    save: jest.fn(
      async (row: Partial<MinesweeperChallenge>) => void savedChallenges.push({ ...row })
    ),
  };
  const scores = {
    create: (row: Partial<MinesweeperScore>) => ({ id: 'score-1', ...row }) as MinesweeperScore,
    save: jest.fn(async (row: MinesweeperScore) => void storedScores.set(row.id, row)),
    // By id, or - as `getPersonalBest` asks - a player's fastest score.
    findOne: jest.fn(async ({ where }: { where: { id?: string; userId?: string } }) =>
      where.id
        ? (storedScores.get(where.id) ?? null)
        : ([...storedScores.values()]
            .filter((sc) => sc.userId === where.userId)
            .sort((a, b) => a.durationMs - b.durationMs)[0] ?? null)
    ),
    query: jest.fn(async (sql: string) =>
      sql.includes('"displayName"') ? [{ displayName: ' Ada ' }] : [{ cnt: 0 }]
    ),
  };
  const replays = {
    create: (row: Partial<MinesweeperReplay>) => row as MinesweeperReplay,
    save: jest.fn(async (row: Partial<MinesweeperReplay>) => void savedReplays.push(row)),
    findOne: jest.fn(),
  };
  const service = new MinesweeperService(
    challenges as unknown as Repository<MinesweeperChallenge>,
    scores as unknown as Repository<MinesweeperScore>,
    { count: async () => 0 } as unknown as Repository<MinesweeperBan>,
    replays as unknown as Repository<MinesweeperReplay>
  );
  return { service, challenges, scores, replays, savedChallenges, savedReplays, storedScores };
}

describe('submitting a timed log', () => {
  let errorLog: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('stores the log WITH its timestamps next to the score', async () => {
    const { service, challenges, savedReplays } = build();
    challenges.findOne.mockResolvedValue(challengeRow());
    const moves = winningLog();
    const claimedDurationMs = moves[moves.length - 1].t;
    const result = await service.submit('user-1', 'challenge-1', { moves, claimedDurationMs });
    expect(result.accepted).toBe(true);
    expect(savedReplays).toHaveLength(1);
    expect(savedReplays[0].scoreId).toBe('score-1');
    expect(savedReplays[0].moves).toEqual(moves);
  }, 60_000);

  it('does not fail an honest win because its replay could not be stored, and says so', async () => {
    const { service, challenges, replays } = build();
    challenges.findOne.mockResolvedValue(challengeRow());
    replays.save.mockRejectedValueOnce(new Error('disk full'));
    const moves = winningLog();
    const result = await service.submit('user-1', 'challenge-1', {
      moves,
      claimedDurationMs: moves[moves.length - 1].t,
    });
    expect(result.accepted).toBe(true);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('replay not stored score=score-1')
    );
  }, 60_000);

  it.each([
    ['ends before the claimed length', (m: TimedMove[]) => m, 1],
    ['runs backwards', (m: TimedMove[]) => m.map((mv, i) => (i === 3 ? { ...mv, t: 0 } : mv)), 0],
    [
      'starts after the first dig',
      (m: TimedMove[]) => m.map((mv, i) => (i === 0 ? { ...mv, t: 5 } : mv)),
      0,
    ],
  ])('refuses a log that %s, and stores the challenge as rejected', async (_n, mutate, skew) => {
    const { service, challenges, savedChallenges, savedReplays, storedScores } = build();
    challenges.findOne.mockResolvedValue(challengeRow());
    const moves = mutate(winningLog());
    await expect(
      service.submit('user-1', 'challenge-1', {
        moves,
        claimedDurationMs: moves[moves.length - 1].t + skew,
      })
    ).rejects.toThrow(/timings/);
    expect(savedChallenges[savedChallenges.length - 1]?.status).toBe('rejected');
    expect(savedReplays).toHaveLength(0);
    expect(storedScores.size).toBe(0);
  });

  it('refuses with a 400, not a server error', async () => {
    const { service, challenges } = build();
    challenges.findOne.mockResolvedValue(challengeRow());
    const moves = winningLog();
    await expect(
      service.submit('user-1', 'challenge-1', { moves, claimedDurationMs: 1 })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('reading a replay', () => {
  let readLog: jest.SpyInstance;
  let infoLog: jest.SpyInstance;
  beforeEach(() => {
    infoLog = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    readLog = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  const score = {
    id: 'score-1',
    userId: 'user-1',
    challengeId: 'challenge-1',
    durationMs: 61_000,
    verifiedAt: new Date('2026-11-17T10:00:00Z'),
  } as MinesweeperScore;

  it('returns the board to regenerate, the timed log and whose game it was', async () => {
    const { service, challenges, replays, storedScores } = build();
    storedScores.set('score-1', score);
    challenges.findOne.mockResolvedValue(challengeRow());
    const moves = winningLog().slice(0, 3);
    replays.findOne.mockResolvedValue({ scoreId: 'score-1', moves });
    const replay = await service.replay('score-1', 'viewer-1', false);
    expect(replay).toEqual({
      scoreId: 'score-1',
      userId: 'user-1',
      displayName: 'Ada',
      durationMs: 61_000,
      verifiedAt: '2026-11-17T10:00:00.000Z',
      seed,
      generatorVersion: 2,
      config: { width: 18, height: 32, mineCount: 150 },
      moves,
    });
  });

  it("leaves a trace of a member's read at debug only: it is routine traffic now", async () => {
    const { service, challenges, replays, storedScores } = build();
    storedScores.set('score-1', score);
    challenges.findOne.mockResolvedValue(challengeRow());
    replays.findOne.mockResolvedValue({ scoreId: 'score-1', moves: [] });
    await service.replay('score-1', 'viewer-1', false);
    expect(readLog).toHaveBeenCalledWith(
      expect.stringContaining('replay read score=score-1 user=user-1 by=viewer-1')
    );
    expect(infoLog).not.toHaveBeenCalledWith(expect.stringContaining('replay read'));
  });

  it("keeps a trace production retains for a global admin's read, which can reach hidden games", async () => {
    const { service, challenges, replays, storedScores } = build();
    storedScores.set('score-1', score);
    challenges.findOne.mockResolvedValue(challengeRow());
    replays.findOne.mockResolvedValue({ scoreId: 'score-1', moves: [] });
    await service.replay('score-1', 'admin-1', true);
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining('replay read score=score-1 user=user-1 by=admin-1 admin')
    );
  });

  it('is a 404 for a score that does not exist', async () => {
    const { service } = build();
    await expect(service.replay('nope', 'viewer-1', false)).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('is a 404 for a score won before replays were kept', async () => {
    const { service, challenges, replays, storedScores } = build();
    storedScores.set('score-1', score);
    challenges.findOne.mockResolvedValue(challengeRow());
    replays.findOne.mockResolvedValue(null);
    await expect(service.replay('score-1', 'viewer-1', false)).rejects.toThrow(
      /No replay was kept/
    );
  });

  describe('who may read it', () => {
    /** A viewer who is not the player, with the player banned or not. */
    function setup(banned: boolean) {
      const ctx = build();
      ctx.storedScores.set('score-1', score);
      ctx.challenges.findOne.mockResolvedValue(challengeRow());
      ctx.replays.findOne.mockResolvedValue({ scoreId: 'score-1', moves: [] });
      (ctx.service as unknown as { bans: { count: () => Promise<number> } }).bans = {
        count: async () => (banned ? 1 : 0),
      };
      return ctx;
    }

    it("lets any member watch another player's win", async () => {
      const { service } = setup(false);
      await expect(service.replay('score-1', 'someone-else', false)).resolves.toMatchObject({
        userId: 'user-1',
      });
    });

    it('lets a member watch only the BEST win of another player: the one the ranking shows', async () => {
      const { service, storedScores } = setup(false);
      storedScores.set('score-fast', { ...score, id: 'score-fast', durationMs: 50_000 });
      // score-1 (61 s) is no longer user-1's best.
      await expect(service.replay('score-1', 'someone-else', false)).rejects.toBeInstanceOf(
        NotFoundException
      );
      await expect(service.replay('score-fast', 'someone-else', false)).resolves.toMatchObject({
        scoreId: 'score-fast',
      });
    });

    it('lets the player watch any of their own, best or not', async () => {
      const { service, storedScores } = setup(false);
      storedScores.set('score-fast', { ...score, id: 'score-fast', durationMs: 50_000 });
      await expect(service.replay('score-1', 'user-1', false)).resolves.toMatchObject({
        scoreId: 'score-1',
      });
    });

    it('lets a global admin watch an earlier win too', async () => {
      const { service, storedScores } = setup(false);
      storedScores.set('score-fast', { ...score, id: 'score-fast', durationMs: 50_000 });
      await expect(service.replay('score-1', 'admin-1', true)).resolves.toMatchObject({
        scoreId: 'score-1',
      });
    });

    it('lets the player watch their own', async () => {
      const { service } = setup(false);
      await expect(service.replay('score-1', 'user-1', false)).resolves.toMatchObject({
        scoreId: 'score-1',
      });
    });

    it("hides a banned player's game from a member, as the ranking does: a 404", async () => {
      const { service, replays } = setup(true);
      await expect(service.replay('score-1', 'someone-else', false)).rejects.toBeInstanceOf(
        NotFoundException
      );
      expect(replays.findOne).not.toHaveBeenCalled();
    });

    it('shows it to a global admin, who must be able to judge a cheat', async () => {
      const { service } = setup(true);
      await expect(service.replay('score-1', 'admin-1', true)).resolves.toMatchObject({
        userId: 'user-1',
      });
    });
  });
});
