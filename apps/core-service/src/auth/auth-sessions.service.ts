import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AuthSession } from './entities/auth-session.entity';

/** Idle lifetime of a session. Every successful refresh pushes the deadline forward. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * How long the previous `jti` stays acceptable after a rotation.
 *
 * Two tabs (or a retried request whose response was lost) can present the same
 * refresh cookie within milliseconds of each other. Exactly one wins the
 * rotation; without this window the loser looks like a thief and the honest
 * user is signed out. A minute is far shorter than the 7-day token it protects.
 */
export const ROTATION_GRACE_SECONDS = 60;

/** How often expired rows are swept. Purely housekeeping - an expired row is already refused. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Client facts recorded on the session, refreshed on every rotation. */
export interface SessionClientInfo {
  userAgent?: string | null;
  ip?: string | null;
}

/** Outcome of {@link AuthSessionsService.rotate}, which the caller turns into a cookie or a 401. */
export type RotateResult =
  /** The presented `jti` was current: the session now expects `tokenId`. */
  | { status: 'rotated'; tokenId: string; expiresAt: Date }
  /** The presented `jti` was the previous one, inside the grace window: hand back the current token unchanged. */
  | { status: 'reissued'; tokenId: string; expiresAt: Date }
  /** The presented `jti` is neither: two holders share one cookie, so the session was destroyed. */
  | { status: 'replayed' }
  /** No such session, or it has expired or been revoked. */
  | { status: 'unknown' };

/** A session as shown to its owner in the security settings. */
export interface SessionSummary {
  id: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  lastIp: string | null;
}

/**
 * Server-side store backing the refresh cookie.
 *
 * Every method here exists because a stateless refresh token cannot do it:
 * signing out for real, killing one device from another, and noticing that a
 * cookie is being used by two holders at once.
 */
@Injectable()
export class AuthSessionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthSessionsService.name);
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(AuthSession)
    private readonly sessions: Repository<AuthSession>
  ) {}

  onModuleInit(): void {
    void this.deleteExpired();
    this.sweepTimer = setInterval(() => void this.deleteExpired(), SWEEP_INTERVAL_MS);
    // Housekeeping must never hold the process open on shutdown.
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Opens a session for a fresh login and returns the `sid`/`jti` pair the refresh JWT must carry. */
  async create(
    userId: string,
    client: SessionClientInfo = {}
  ): Promise<{ sessionId: string; tokenId: string; expiresAt: Date }> {
    const now = new Date();
    const row = this.sessions.create({
      id: randomUUID(),
      userId,
      tokenId: randomUUID(),
      previousTokenId: null,
      rotatedAt: null,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: expiryFrom(now),
      userAgent: truncateUserAgent(client.userAgent),
      lastIp: client.ip ?? null,
    });
    const saved = await this.sessions.save(row);
    this.logger.debug(`Session opened sid=${saved.id} user=${userId}`);
    return { sessionId: saved.id, tokenId: saved.tokenId, expiresAt: saved.expiresAt };
  }

  /**
   * Consumes the presented `jti` and issues the next one.
   *
   * The rotation is a single conditional UPDATE, so two concurrent refreshes
   * cannot both win: the second finds `tokenId` already changed, falls through
   * to the classification below, and lands in the grace window rather than in
   * the replay branch.
   */
  async rotate(
    sessionId: string,
    presentedTokenId: string,
    client: SessionClientInfo = {}
  ): Promise<RotateResult> {
    const now = new Date();
    const expiresAt = expiryFrom(now);
    const nextTokenId = randomUUID();

    const updated = await this.sessions
      .createQueryBuilder()
      .update(AuthSession)
      .set({
        tokenId: nextTokenId,
        previousTokenId: presentedTokenId,
        rotatedAt: now,
        lastUsedAt: now,
        expiresAt,
        userAgent: truncateUserAgent(client.userAgent),
        lastIp: client.ip ?? null,
      })
      .where('id = :id AND "tokenId" = :presented AND "expiresAt" > :now', {
        id: sessionId,
        presented: presentedTokenId,
        now,
      })
      .execute();

    if (updated.affected === 1) {
      return { status: 'rotated', tokenId: nextTokenId, expiresAt };
    }

    const row = await this.sessions.findOne({ where: { id: sessionId } });
    if (!row || row.expiresAt.getTime() <= now.getTime()) {
      return { status: 'unknown' };
    }

    if (
      row.previousTokenId === presentedTokenId &&
      row.rotatedAt !== null &&
      row.rotatedAt !== undefined &&
      now.getTime() - row.rotatedAt.getTime() <= ROTATION_GRACE_SECONDS * 1000
    ) {
      this.logger.debug(`Concurrent refresh accepted sid=${sessionId} (grace window)`);
      return { status: 'reissued', tokenId: row.tokenId, expiresAt: row.expiresAt };
    }

    // A `jti` that is neither current nor freshly rotated was already consumed:
    // the cookie exists in two places. Only revoking makes the theft useless -
    // logging it, as Le Cercle does, lets the rotation succeed for whoever asked.
    await this.sessions.delete({ id: sessionId });
    this.logger.warn(
      `Refresh token replay detected sid=${sessionId} user=${row.userId} - session revoked`
    );
    return { status: 'replayed' };
  }

  /** Destroys one session. Used by logout and by the owner revoking a device. */
  async revoke(sessionId: string): Promise<void> {
    await this.sessions.delete({ id: sessionId });
  }

  /** Destroys a session only if it belongs to `userId`. Returns false when it does not exist. */
  async revokeOwned(userId: string, sessionId: string): Promise<boolean> {
    const res = await this.sessions.delete({ id: sessionId, userId });
    return (res.affected ?? 0) > 0;
  }

  /** Destroys every session of `userId` except `keepSessionId`. Returns how many died. */
  async revokeOthers(userId: string, keepSessionId: string | null): Promise<number> {
    const qb = this.sessions
      .createQueryBuilder()
      .delete()
      .from(AuthSession)
      .where('"userId" = :userId', {
        userId,
      });
    if (keepSessionId) qb.andWhere('id != :keep', { keep: keepSessionId });
    const res = await qb.execute();
    return res.affected ?? 0;
  }

  /** Live sessions of a user, most recently used first. Expired rows are filtered out, not waited on. */
  async listForUser(userId: string): Promise<SessionSummary[]> {
    const rows = await this.sessions.find({
      where: { userId },
      order: { lastUsedAt: 'DESC' },
    });
    const now = Date.now();
    return rows
      .filter((row) => row.expiresAt.getTime() > now)
      .map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        expiresAt: row.expiresAt,
        userAgent: row.userAgent ?? null,
        lastIp: row.lastIp ?? null,
      }));
  }

  /** Drops rows past their idle deadline. Idempotent, so concurrent replicas may both run it. */
  async deleteExpired(): Promise<number> {
    try {
      const res = await this.sessions.delete({ expiresAt: LessThan(new Date()) });
      const removed = res.affected ?? 0;
      if (removed > 0) this.logger.debug(`Swept ${removed} expired session(s)`);
      return removed;
    } catch (e) {
      // Housekeeping must never take the service down (e.g. the table is not
      // migrated yet on a first boot).
      this.logger.warn(`Session sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    }
  }
}

/** Idle deadline for a session touched at `from`. */
function expiryFrom(from: Date): Date {
  return new Date(from.getTime() + SESSION_TTL_SECONDS * 1000);
}

/** Keeps the stored User-Agent inside the column, and normalises "absent" to null. */
function truncateUserAgent(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 255);
}
