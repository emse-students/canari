import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AuthSession } from './entities/auth-session.entity';
import { SessionPushEndService } from './session-push-end.service';

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

/**
 * Whether `presented` is the `jti` the session's last rotation replaced, still inside
 * {@link ROTATION_GRACE_SECONDS}. ONE predicate for every caller that accepts that token: the
 * refresh itself, and a restore-key registration racing it (docs/wiki/account-restore.md).
 */
export function isPreviousTokenInGrace(
  row: Pick<AuthSession, 'previousTokenId' | 'rotatedAt'>,
  presented: string,
  now: Date
): boolean {
  return (
    row.previousTokenId === presented &&
    row.rotatedAt !== null &&
    row.rotatedAt !== undefined &&
    now.getTime() - row.rotatedAt.getTime() <= ROTATION_GRACE_SECONDS * 1000
  );
}

/**
 * How often expired rows are swept. An expired row is already refused, so for AUTHENTICATION this is
 * housekeeping - but the sweep is also what deletes `lastIp` and `userAgent`, and the privacy
 * policy promises IP logs are kept 90 days at most. Every write of `lastIp` moves `expiresAt` to
 * `SESSION_TTL_SECONDS` later in the same statement, so a stored IP is never older than the TTL
 * plus this interval: 7 days and 1 hour, with no job of its own
 * (docs/wiki/infrastructure/logging.md, "the 90-day ceiling").
 */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

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
  /** The MLS device this login belongs to, or null when the client never said. */
  deviceId: string | null;
}

/** Longest device identifier the column accepts. Anything longer is a client bug, not a device. */
const MAX_DEVICE_ID_LENGTH = 128;

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
    private readonly sessions: Repository<AuthSession>,
    private readonly pushEnd: SessionPushEndService
  ) {}

  /** The push-registration endings started by a revocation and not yet answered. */
  private readonly pushEndsInFlight = new Set<Promise<void>>();

  /**
   * ENDING A SESSION ENDS ITS DEVICE'S PUSH REGISTRATION - for every row a revocation deleted that
   * named a device (`docs/wiki/sessions.md`, "A session that ends takes its device's push
   * registration with it").
   *
   * NOT AWAITED by the revocation: the logout answers the user, and a slow chat-delivery-service
   * must not turn it into a sign-out the client reads as "the server did NOT revoke". Every failure
   * is logged where it happens; {@link pushEndsSettled} is what a test or a drain waits on.
   *
   * A device another LIVE session of the same account still names keeps its registration: that
   * session is the device's current one (a re-sign-in whose row was bound before the old one went),
   * and its pushes are its own.
   */
  private endPushOfEndedSessions(
    ended: ReadonlyArray<{ userId: string; deviceId?: string | null }>,
    cause: string
  ): void {
    const devices = new Map<string, { userId: string; deviceId: string }>();
    for (const row of ended) {
      if (!row.deviceId) continue;
      devices.set(`${row.userId}\u0000${row.deviceId}`, {
        userId: row.userId,
        deviceId: row.deviceId,
      });
    }
    if (devices.size === 0) {
      if (ended.length > 0) {
        this.logger.debug(
          `[PUSH_SESSION_END] cause=${cause} - ${ended.length} ended session(s) named no device`
        );
      }
      return;
    }
    for (const { userId, deviceId } of devices.values()) {
      const settled = this.endDevicePushUnlessLive(userId, deviceId, cause).finally(() => {
        this.pushEndsInFlight.delete(settled);
      });
      this.pushEndsInFlight.add(settled);
    }
  }

  /** One device of {@link endPushOfEndedSessions}. Never rejects. */
  private async endDevicePushUnlessLive(
    userId: string,
    deviceId: string,
    cause: string
  ): Promise<void> {
    try {
      const now = Date.now();
      const live = (await this.sessions.find({ where: { userId, deviceId } })).filter(
        (row) => row.expiresAt.getTime() > now
      );
      if (live.length > 0) {
        this.logger.log(
          `[PUSH_SESSION_END] user=${userId.slice(0, 8)} device=${deviceId} cause=${cause} - ` +
            `another live session names this device, its push registration is kept`
        );
        return;
      }
      await this.pushEnd.endDevice(userId, deviceId, cause);
    } catch (e) {
      this.logger.error(
        `[PUSH_SESSION_END] user=${userId.slice(0, 8)} device=${deviceId} cause=${cause} - ` +
          `not ended: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** Resolves once every push-registration ending started so far has been answered. */
  async pushEndsSettled(): Promise<void> {
    await Promise.all(this.pushEndsInFlight);
  }

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
    return {
      sessionId: saved.id,
      tokenId: saved.tokenId,
      expiresAt: saved.expiresAt,
    };
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
      // The caller signs the device out on this answer, so it names which of the two it was. A
      // missing row is a revocation - or a database replaced under the session, as dev's refresh
      // from production does - and it was the one refusal here that left no line (2026-09-28).
      this.logger.warn(
        `Refresh refused sid=${sessionId} - ${row ? 'session expired' : 'no such session'}`
      );
      return { status: 'unknown' };
    }

    if (isPreviousTokenInGrace(row, presentedTokenId, now)) {
      this.logger.debug(`Concurrent refresh accepted sid=${sessionId} (grace window)`);
      return {
        status: 'reissued',
        tokenId: row.tokenId,
        expiresAt: row.expiresAt,
      };
    }

    // A `jti` that is neither current nor freshly rotated was already consumed:
    // the cookie exists in two places. Only revoking makes the theft useless -
    // logging it, as Le Cercle does, lets the rotation succeed for whoever asked.
    await this.sessions.delete({ id: sessionId });
    this.endPushOfEndedSessions([row], 'replay');
    // Two causes end here and look identical from outside: the previous token presented AFTER the
    // window (a client that lost the response of its last rotation, e.g. a suspended phone) and a
    // token spent two or more rotations ago (the credential genuinely forked). Say which, and how
    // long ago the last rotation was, because nothing else on the server can separate them.
    const kind = row.previousTokenId === presentedTokenId ? 'previous' : 'older';
    const ago = row.rotatedAt
      ? `${Math.round((now.getTime() - row.rotatedAt.getTime()) / 1000)}s`
      : 'never';
    this.logger.warn(
      `Refresh token replay detected sid=${sessionId} user=${row.userId} presented=${kind} rotatedAgo=${ago} - session revoked`
    );
    return { status: 'replayed' };
  }

  /**
   * Destroys one session - the logout - and ends the push registration of the device it named.
   *
   * The device is read before the row goes because the row is the only record of it; a session that
   * never named one (a web tab, or a holder that never unlocked) has no push registration to end.
   */
  async revoke(sessionId: string): Promise<void> {
    const row = await this.sessions.findOne({ where: { id: sessionId } });
    await this.sessions.delete({ id: sessionId });
    if (row) this.endPushOfEndedSessions([row], 'logout');
  }

  /**
   * Destroys a session only if it belongs to `userId`, ending its device's push registration with
   * it. Returns false when it does not exist.
   */
  async revokeOwned(userId: string, sessionId: string): Promise<boolean> {
    const row = await this.sessions.findOne({ where: { id: sessionId, userId } });
    const res = await this.sessions.delete({ id: sessionId, userId });
    const revoked = (res.affected ?? 0) > 0;
    if (revoked && row) this.endPushOfEndedSessions([row], 'revoked-by-owner');
    return revoked;
  }

  /**
   * Records which MLS device a live session belongs to, and makes that mapping
   * one-to-one by destroying any other session claiming the same device.
   *
   * Called once per app start, after the client has unlocked MLS and can name
   * its own device - never on the refresh path, which is the app's cold-start
   * critical section and must not grow a round trip for a label.
   *
   * THE PURGE IS NOT HOUSEKEEPING, IT CLOSES A HOLE. A browser profile holds
   * exactly one refresh cookie and one device identifier, and so does an app
   * install. A second LIVE session naming the same device is therefore, by
   * construction, unreachable from that device: either its cookie was dropped
   * without being revoked - cleared cookies, a reinstall, a login that never
   * signed the old one out - and nobody holds it, or somebody else does. Both
   * readings say the same thing, so the owner's next unlock ends it. Without
   * this, such a credential stayed valid for seven idle days with no trace.
   *
   * Scoped by `userId` as well as `sessionId` so a caller can only ever stamp
   * its own session. One read answers both questions, and the ordinary case -
   * an app restarting against a session that already names its device, with no
   * stray beside it - performs no write at all.
   *
   * Returns false when no live session of that user has that id, which the
   * caller reports rather than retries: the session is gone and the next
   * request will be answered with a 401 anyway.
   */
  async bindDevice(userId: string, sessionId: string, deviceId: string): Promise<boolean> {
    const trimmed = deviceId.trim();
    if (!trimmed || trimmed.length > MAX_DEVICE_ID_LENGTH) {
      this.logger.warn(
        `Device binding refused sid=${sessionId} user=${userId}: unusable device id (${trimmed.length} chars)`
      );
      return false;
    }
    // Our own row and every session already claiming this device, in one query.
    const rows = await this.sessions.find({
      where: [
        { id: sessionId, userId },
        { userId, deviceId: trimmed },
      ],
      select: { id: true, deviceId: true },
    });
    const own = rows.find((row) => row.id === sessionId);
    if (!own) {
      this.logger.warn(`Device binding refused sid=${sessionId} user=${userId}: no such session`);
      return false;
    }

    // Deleted by explicit id rather than by `deviceId`, so the statement cannot
    // reach the session we are about to stamp with that very value.
    // The ONE revocation that does not end a push registration: every stray names the device this
    // very session is being bound to, so the device's registration is the live session's.
    const strays = rows.filter((row) => row.id !== sessionId).map((row) => row.id);
    if (strays.length > 0) {
      await this.sessions.delete({ id: In(strays) });
      this.logger.warn(
        `Revoked ${strays.length} unreachable session(s) claiming device ${trimmed} for user=${userId} - kept sid=${sessionId}`
      );
    }

    if (own.deviceId !== trimmed) {
      await this.sessions.update({ id: sessionId, userId }, { deviceId: trimmed });
      this.logger.debug(`Session sid=${sessionId} bound to device ${trimmed}`);
    }
    return true;
  }

  /**
   * Destroys every session of `userId` except `keepSessionId`, ending the push registration of each
   * device they named - except the device the kept session names, which is the caller's own.
   * Returns how many died.
   */
  async revokeOthers(userId: string, keepSessionId: string | null): Promise<number> {
    // RETURNING, so the devices whose push registration ends are exactly the rows THIS delete
    // removed - not a read taken before it, which a concurrent sign-in or revocation could change.
    const qb = this.sessions
      .createQueryBuilder()
      .delete()
      .from(AuthSession)
      .where('"userId" = :userId', {
        userId,
      })
      .returning(['userId', 'deviceId']);
    if (keepSessionId) qb.andWhere('id != :keep', { keep: keepSessionId });
    const res = await qb.execute();
    const ended = (res.raw ?? []) as Array<Pick<AuthSession, 'userId' | 'deviceId'>>;
    // The kept session's device survives through the live-session check, not a filter here.
    this.endPushOfEndedSessions(ended, 'revoked-others');
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
        deviceId: row.deviceId ?? null,
      }));
  }

  /** Drops rows past their idle deadline. Idempotent, so concurrent replicas may both run it. */
  async deleteExpired(): Promise<number> {
    try {
      const res = await this.sessions.delete({
        expiresAt: LessThan(new Date()),
      });
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
