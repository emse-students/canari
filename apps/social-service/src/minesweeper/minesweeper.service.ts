import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { SubmitMinesweeperDto } from './dto/submit-minesweeper.dto';
import { MinesweeperChallenge } from './entities/minesweeper-challenge.entity';
import { MinesweeperScore } from './entities/minesweeper-score.entity';
import {
  CHALLENGE as BOARD_CONFIG,
  verifySolve,
  type MinesweeperMove,
} from './engine/game';

/** Challenge board must be cleared in at least this long (blocks 0ms cheats). */
const MIN_DURATION_MS = 8_000;
/** Open challenges expire after this window. */
const CHALLENGE_TTL_MS = 2 * 60 * 60 * 1000;
/** Client claim cannot exceed server elapsed by more than this skew. */
const CLIENT_CLOCK_SKEW_MS = 2_000;
const LEADERBOARD_LIMIT = 25;

/** Ranked Minesweeper: issue seeds, verify solves by replay, store best times. */
@Injectable()
export class MinesweeperService {
  private readonly logger = new Logger(MinesweeperService.name);

  constructor(
    @InjectRepository(MinesweeperChallenge)
    private readonly challenges: Repository<MinesweeperChallenge>,
    @InjectRepository(MinesweeperScore)
    private readonly scores: Repository<MinesweeperScore>
  ) {}

  /**
   * Starts a ranked run: cancels prior open challenges for this user and returns
   * a fresh seed. Duration is measured from `startedAt` on the server.
   */
  async startChallenge(userId: string) {
    const now = new Date();
    await this.challenges
      .createQueryBuilder()
      .update(MinesweeperChallenge)
      .set({ status: 'expired' })
      .where('"userId" = :userId AND status = :status', { userId, status: 'open' })
      .execute();

    const seed = randomBytes(16).toString('hex');
    const row = this.challenges.create({
      userId,
      seed,
      width: BOARD_CONFIG.width,
      height: BOARD_CONFIG.height,
      mineCount: BOARD_CONFIG.mineCount,
      startedAt: now,
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
      status: 'open',
    });
    await this.challenges.save(row);
    this.logger.log(`minesweeper challenge started user=${userId} id=${row.id}`);

    return {
      challengeId: row.id,
      seed: row.seed,
      config: {
        width: row.width,
        height: row.height,
        mineCount: row.mineCount,
      },
      startedAt: row.startedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      serverNow: now.toISOString(),
    };
  }

  /**
   * Verifies a claimed clear: regenerates the board from the challenge seed,
   * replays moves, and records server-measured `durationMs` when valid.
   */
  async submit(userId: string, challengeId: string, dto: SubmitMinesweeperDto) {
    const challenge = await this.challenges.findOne({ where: { id: challengeId } });
    if (!challenge) throw new NotFoundException('Challenge not found');
    if (challenge.userId !== userId) throw new ForbiddenException('Not your challenge');
    if (challenge.status !== 'open') {
      throw new BadRequestException(`Challenge is ${challenge.status}`);
    }

    const now = new Date();
    if (now.getTime() > challenge.expiresAt.getTime()) {
      challenge.status = 'expired';
      await this.challenges.save(challenge);
      throw new BadRequestException('Challenge expired');
    }

    const serverDurationMs = now.getTime() - challenge.startedAt.getTime();
    if (serverDurationMs < MIN_DURATION_MS) {
      challenge.status = 'rejected';
      await this.challenges.save(challenge);
      this.logger.warn(
        `minesweeper reject too_fast user=${userId} id=${challengeId} ms=${serverDurationMs}`
      );
      throw new BadRequestException('Solve too fast to be plausible');
    }

    // Client cannot have played longer than the server window (plus small skew).
    if (dto.claimedDurationMs > serverDurationMs + CLIENT_CLOCK_SKEW_MS) {
      challenge.status = 'rejected';
      await this.challenges.save(challenge);
      throw new BadRequestException('Claimed duration exceeds server elapsed time');
    }

    const moves: MinesweeperMove[] = dto.moves.map((m) => ({
      type: m.type,
      x: m.x,
      y: m.y,
    }));

    const result = verifySolve(challenge.seed, moves, {
      width: challenge.width,
      height: challenge.height,
      mineCount: challenge.mineCount,
    });

    if (!result.ok) {
      challenge.status = 'rejected';
      await this.challenges.save(challenge);
      this.logger.warn(
        `minesweeper reject replay user=${userId} id=${challengeId} reason=${result.reason}`
      );
      throw new BadRequestException(`Solve verification failed: ${result.reason ?? 'invalid'}`);
    }

    challenge.status = 'submitted';
    await this.challenges.save(challenge);

    const score = this.scores.create({
      challengeId: challenge.id,
      userId,
      durationMs: serverDurationMs,
      moveCount: moves.length,
      verifiedAt: now,
    });
    await this.scores.save(score);
    this.logger.log(
      `minesweeper score ok user=${userId} id=${challengeId} ms=${serverDurationMs} moves=${moves.length}`
    );

    const personalBest = await this.getPersonalBest(userId);
    return {
      accepted: true,
      durationMs: serverDurationMs,
      moveCount: moves.length,
      personalBestMs: personalBest?.durationMs ?? serverDurationMs,
      isPersonalBest: !personalBest || serverDurationMs <= personalBest.durationMs,
    };
  }

  /** Top verified clears (best time per user). Display names from shared `users` table. */
  async leaderboard(limit = LEADERBOARD_LIMIT) {
    const capped = Math.min(Math.max(limit, 1), 50);
    const rows: Array<{
      userId: string;
      durationMs: number;
      moveCount: number;
      verifiedAt: Date;
    }> = await this.scores.query(
      `
      SELECT DISTINCT ON (s."userId")
        s."userId" AS "userId",
        s."durationMs" AS "durationMs",
        s."moveCount" AS "moveCount",
        s."verifiedAt" AS "verifiedAt"
      FROM minesweeper_scores s
      ORDER BY s."userId", s."durationMs" ASC, s."verifiedAt" ASC
      `
    );

    rows.sort(
      (a, b) => a.durationMs - b.durationMs || a.verifiedAt.getTime() - b.verifiedAt.getTime()
    );
    const top = rows.slice(0, capped);
    const userIds = top.map((r) => r.userId);
    const nameById = new Map<string, string>();
    if (userIds.length > 0) {
      const users: Array<{ id: string; displayName: string | null }> = await this.scores.query(
        `SELECT id, "displayName" FROM users WHERE id = ANY($1)`,
        [userIds]
      );
      for (const u of users) {
        nameById.set(u.id, u.displayName?.trim() || u.id);
      }
    }

    return {
      entries: top.map((r, i) => ({
        rank: i + 1,
        userId: r.userId,
        displayName: nameById.get(r.userId) ?? r.userId,
        durationMs: r.durationMs,
        moveCount: r.moveCount,
        verifiedAt: new Date(r.verifiedAt).toISOString(),
      })),
    };
  }

  async getPersonalBest(userId: string): Promise<MinesweeperScore | null> {
    return this.scores.findOne({
      where: { userId },
      order: { durationMs: 'ASC', verifiedAt: 'ASC' },
    });
  }

  async me(userId: string) {
    const best = await this.getPersonalBest(userId);
    if (!best) return { personalBestMs: null as number | null };
    return {
      personalBestMs: best.durationMs,
      moveCount: best.moveCount,
      verifiedAt: best.verifiedAt.toISOString(),
    };
  }
}
