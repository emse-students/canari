/**
 * MINESWEEPER GENERATOR VERSION (owner, 2026-11-13): a challenge names the generator it is replayed with.
 *
 * What these cases are built to catch, in the order a regression would hurt:
 *  - a build that predates versions (it sends nothing) being issued a generator it cannot make,
 *    which would reject every honest solve it submits;
 *  - a client asking for a generator this server does not know being issued one anyway;
 *  - the replay ignoring the challenge's version, judging a v2 board on v1's mines (or the reverse);
 *  - a challenge stored with a version nobody can replay being judged on another's board.
 */
import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { chooseGeneratorVersion, MinesweeperService } from './minesweeper.service';
import { CHALLENGE, createBoard, revealCell } from './engine/game';
import type { MinesweeperBan } from './entities/minesweeper-ban.entity';
import type { MinesweeperChallenge } from './entities/minesweeper-challenge.entity';
import type { MinesweeperScore } from './entities/minesweeper-score.entity';

function build() {
  const saved: Array<Partial<MinesweeperChallenge>> = [];
  const challenges = {
    findOne: jest.fn(),
    create: jest.fn((row: Partial<MinesweeperChallenge>) => ({ id: 'challenge-1', ...row })),
    save: jest.fn(async (row: Partial<MinesweeperChallenge>) => void saved.push({ ...row })),
    createQueryBuilder: jest.fn(() => ({
      update: () => ({ set: () => ({ where: () => ({ execute: async () => ({}) }) }) }),
    })),
  };
  const bans = { count: async () => 0 };
  const service = new MinesweeperService(
    challenges as unknown as Repository<MinesweeperChallenge>,
    {} as unknown as Repository<MinesweeperScore>,
    bans as unknown as Repository<MinesweeperBan>
  );
  return { service, challenges, saved };
}

describe('the generator a challenge is issued with', () => {
  it.each([
    [undefined, 1],
    [1, 1],
    [2, 2],
    [3, 2],
    [999, 2],
    [0, 1],
    [-4, 1],
  ])('a client that asks for %s is issued %s', (requested, issued) => {
    expect(chooseGeneratorVersion(requested)).toBe(issued);
  });

  it('records the version on the row and returns it', async () => {
    const { service, challenges } = build();
    const response = await service.startChallenge('user-1', 2);
    expect(challenges.create).toHaveBeenCalledWith(
      expect.objectContaining({ generatorVersion: 2 })
    );
    expect(response.generatorVersion).toBe(2);
  });

  it('issues generator 1 to a client that says nothing', async () => {
    const { service } = build();
    expect((await service.startChallenge('user-1')).generatorVersion).toBe(1);
  });
});

describe('the replay honours the challenge version', () => {
  /** A log that clears the generator-2 board of this seed: the first click, then every other safe cell. */
  const seed = '8601e326fcef5ef936a1c69d6ab6ac41';
  const [x, y] = [9, 16];
  const winningLogForV2 = () => {
    const board = createBoard(CHALLENGE, seed, 2);
    revealCell(board, x, y);
    const moves = [{ type: 'reveal' as const, x, y }];
    board.cells.forEach((cell, i) => {
      if (!cell.mine)
        moves.push({ type: 'reveal', x: i % board.width, y: Math.floor(i / board.width) });
    });
    return moves;
  };
  const challengeRow = (generatorVersion: number): MinesweeperChallenge =>
    ({
      id: 'challenge-1',
      userId: 'user-1',
      seed,
      width: CHALLENGE.width,
      height: CHALLENGE.height,
      mineCount: CHALLENGE.mineCount,
      startedAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() + 3_600_000),
      status: 'open',
      generatorVersion,
    }) as MinesweeperChallenge;

  it('rejects the v2 log on a challenge issued with generator 1: it is another board', async () => {
    const { service, challenges, saved } = build();
    challenges.findOne.mockResolvedValue(challengeRow(1));
    await expect(
      service.submit('user-1', 'challenge-1', {
        moves: winningLogForV2(),
        claimedDurationMs: 60_000,
      })
    ).rejects.toThrow(/verification failed/);
    expect(saved[saved.length - 1]?.status).toBe('rejected');
  }, 60_000);

  it('refuses a challenge stored with a generator nobody can replay, and says so', async () => {
    const { service, challenges, saved } = build();
    challenges.findOne.mockResolvedValue(challengeRow(7));
    await expect(
      service.submit('user-1', 'challenge-1', {
        moves: winningLogForV2(),
        claimedDurationMs: 60_000,
      })
    ).rejects.toThrow(BadRequestException);
    expect(saved[saved.length - 1]?.status).toBe('rejected');
  }, 60_000);
});
