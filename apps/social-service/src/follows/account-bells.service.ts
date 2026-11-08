import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AccountBell } from './entities/account-bell.entity';
import { Association } from '../associations/entities/association.entity';
import { FOLLOW_ACCEPTED } from './follow-status';

/**
 * What a reader receives from one account (engagement WP-3, decisions 3d, 5a and 10):
 * `all` - posts and lives, the default every follow sets and the only level NOT stored;
 * `lives` - lives only; `none` - nothing pushed. The bell row in-app is written whatever the level.
 */
export type BellLevel = 'all' | 'lives' | 'none';

/** The two levels a row stores (L3: no row is `all`). */
export type StoredBellLevel = Exclude<BellLevel, 'all'>;

/** Whose bell: a person, or an entity (an association, a list, an institution). */
export type BellTargetKind = 'user' | 'association';

export const BELL_LEVELS: readonly BellLevel[] = ['all', 'lives', 'none'];
export const BELL_TARGET_KINDS: readonly BellTargetKind[] = ['user', 'association'];

/** Typed refusal codes of the bell routes, read by the client from the body, never the message. */
export const BELL_CODES = {
  /** No association with that id, or a person the caller does not follow (accepted) - L7. */
  targetNotFound: 'BELL_TARGET_NOT_FOUND',
  /** A kind or a level outside the lists above. */
  invalid: 'BELL_INVALID',
} as const;

/**
 * THE PUSH TYPES A BELL CAN REDUCE, and what each is to it: a `post` of the account or a `live` of
 * it. An ALLOWLIST: a type absent here is never withheld by a bell - mentions, replies, comments and
 * reactions are somebody addressing YOU, and `repost_proposed`, `coorganise_proposed` and the
 * `event_*` types are an association's MANAGERS' work (the rule the association mute already had).
 *
 * - `association_post`, `association_repost`, `live_started` and `repost_personal_requested` are the
 *   four types the association mute silenced (`MUTABLE_PUSH_TYPES`, which this replaces); the last
 *   is an association asking an author to carry their post - not a live, so `lives` withholds it.
 * - `followed_post` and `member_repost` are a followed PERSON's publication and repost (L17: a
 *   repost is what that person puts in the reader's feed, so it is one of their "posts").
 * - `live_started` is a person's live when the push names no association.
 */
export const BELL_PUSH_KINDS: ReadonlyMap<string, 'post' | 'live'> = new Map([
  ['association_post', 'post'],
  ['association_repost', 'post'],
  ['repost_personal_requested', 'post'],
  ['followed_post', 'post'],
  ['member_repost', 'post'],
  ['live_started', 'live'],
]);

/** The account a push is about, as a bell names it, and what the push is to that bell. */
export interface BellTarget {
  kind: BellTargetKind;
  id: string;
  push: 'post' | 'live';
}

/**
 * The bell a push answers to, or null when no bell can reduce it. The ASSOCIATION when the push
 * carries one (its post, its repost, its live, its request - `actorId` is then only the member who
 * pressed the button), the PERSON acting otherwise (the author, the reposter, the broadcaster).
 */
export function bellTargetOf(data: {
  type: string;
  actorId: string;
  associationId?: string;
}): BellTarget | null {
  const push = BELL_PUSH_KINDS.get(data.type);
  if (!push) return null;
  if (data.associationId) return { kind: 'association', id: data.associationId, push };
  return { kind: 'user', id: data.actorId, push };
}

/** Whether a stored level withholds a push: `none` withholds all, `lives` everything but a live. */
export function levelWithholds(level: StoredBellLevel, push: 'post' | 'live'): boolean {
  return level === 'none' || push === 'post';
}

/** One reduced bell as the notification settings list it. `name` is an association's, null for a person. */
export interface ReducedBell {
  kind: BellTargetKind;
  targetId: string;
  level: StoredBellLevel;
  name: string | null;
}

/** A muted association as the legacy settings list shows it. */
export type MutedAssociation = Pick<Association, 'id' | 'name' | 'slug' | 'logoUrl'>;

/**
 * The per-account bell. Own rows only: every method takes the CALLER's id from the gateway header and
 * never a user id from the body; no method answers another reader's level.
 *
 * Also the LEGACY ASSOCIATION MUTE (`mute`, `unmute`, `isMuted`, `listMuted`): a build older than the
 * bell control still calls the push-mute routes, which now read and write `account_bells` (mute =
 * `none`, unmute = no row) - docs/wiki/legacy-compatibility.md, "an association mute set by a build
 * older than the bell", with its removal condition.
 */
@Injectable()
export class AccountBellsService {
  private readonly logger = new Logger(AccountBellsService.name);

  constructor(
    @InjectRepository(AccountBell) private readonly repo: Repository<AccountBell>,
    @InjectRepository(Association) private readonly assoRepo: Repository<Association>
  ) {}

  /** The caller's level for one account: `all` when no row is stored. */
  async levelOf(userId: string, kind: BellTargetKind, targetId: string): Promise<BellLevel> {
    const row = await this.repo.findOne({
      where: { userId, targetKind: kind, targetId },
      select: { level: true },
    });
    return row?.level ?? 'all';
  }

  /**
   * Sets the caller's level for one account. Idempotent: `all` deletes the row (deleting nothing is
   * not an error), a reduction is upserted. 404 BELL_TARGET_NOT_FOUND for an association that does
   * not exist, or for a person the caller does not follow (accepted): a bell on a person whose posts
   * the reader is not announced would be a second, silent follow (L7). For a person the check and the
   * write are ONE statement, so an unfollow cannot slip between them.
   */
  async setLevel(
    userId: string,
    kind: BellTargetKind,
    targetId: string,
    level: BellLevel
  ): Promise<{ level: BellLevel }> {
    if (!BELL_TARGET_KINDS.includes(kind) || !BELL_LEVELS.includes(level)) {
      this.logger.debug(`[BELL] ${short(userId)} refused: kind=${kind} level=${level}`);
      throw new BadRequestException({ code: BELL_CODES.invalid, message: 'Invalid bell' });
    }
    if (level === 'all') {
      await this.repo.delete({ userId, targetKind: kind, targetId });
      this.logger.log(`[BELL] ${short(userId)} ${kind}=${short(targetId)} -> all`);
      return { level };
    }
    let written: unknown[];
    if (kind === 'association') {
      // Not a uuid names no association, and would be the database's type error (a 500) below.
      if (!UUID_RE.test(targetId) || !(await this.assoRepo.exists({ where: { id: targetId } }))) {
        throw targetNotFound();
      }
      written = await this.repo.query(UPSERT_BELL_SQL, [userId, kind, targetId, level]);
    } else {
      written = await this.repo.query(UPSERT_PERSON_BELL_SQL, [
        userId,
        kind,
        targetId,
        level,
        FOLLOW_ACCEPTED,
      ]);
    }
    if (!Array.isArray(written) || written.length === 0) {
      this.logger.debug(`[BELL] ${short(userId)} ${kind}=${short(targetId)}: not followed`);
      throw targetNotFound();
    }
    this.logger.log(`[BELL] ${short(userId)} ${kind}=${short(targetId)} -> ${level}`);
    return { level };
  }

  /**
   * Every account the caller reduced, for the notification settings - so a reduction is never a
   * one-way door. An association carries its name; a person carries none, the client names them as
   * everywhere else. A row naming an association deleted since (none should survive its deletion)
   * is left out rather than listed nameless.
   */
  async listReduced(userId: string): Promise<ReducedBell[]> {
    const rows: ReducedBell[] = await this.repo.query(
      `SELECT b."targetKind" AS kind, b."targetId" AS "targetId", b.level, a.name
         FROM account_bells b
         LEFT JOIN associations a ON b."targetKind" = 'association' AND a.id::text = b."targetId"
        WHERE b."userId" = $1 AND (b."targetKind" = 'user' OR a.id IS NOT NULL)
        ORDER BY b."targetKind", lower(a.name), b."targetId"`,
      [userId]
    );
    this.logger.debug(`[BELL] ${short(userId)} lists ${rows.length} reduced bell(s)`);
    return rows;
  }

  /**
   * Of `recipientIds`, the ones whose bell withholds this push - the server-side half of the bell,
   * asked by the one place that pushes. A client never filters its own pushes. One statement.
   */
  async withheldAmong(target: BellTarget, recipientIds: string[]): Promise<Set<string>> {
    if (recipientIds.length === 0) return new Set();
    const rows: { userId: string }[] = await this.repo.query(
      `SELECT "userId" FROM account_bells
        WHERE "targetKind" = $1 AND "targetId" = $2 AND "userId" = ANY($3::varchar[])
          AND (level = 'none' OR $4::text = 'post')`,
      [target.kind, target.id, recipientIds, target.push]
    );
    return new Set(rows.map((r) => r.userId));
  }

  // --- The legacy association mute (shim; see the class docblock) ------------------------------

  /** LEGACY: mutes one association = its bell at `none`. 404 for an association that does not exist. */
  async mute(userId: string, associationId: string): Promise<{ ok: boolean }> {
    this.logger.debug(`[BELL] legacy mute route: ${short(userId)} mutes ${short(associationId)}`);
    await this.setLevel(userId, 'association', associationId, 'none');
    return { ok: true };
  }

  /** LEGACY: lifts a mute = no row, posts and lives. Idempotent. */
  async unmute(userId: string, associationId: string): Promise<{ ok: boolean }> {
    this.logger.debug(
      `[BELL] legacy unmute route: ${short(userId)} unmutes ${short(associationId)}`
    );
    await this.setLevel(userId, 'association', associationId, 'all');
    return { ok: true };
  }

  /** LEGACY: whether the caller's bell on this association is at `none`. */
  async isMuted(userId: string, associationId: string): Promise<boolean> {
    return (await this.levelOf(userId, 'association', associationId)) === 'none';
  }

  /** LEGACY: the associations whose bell the caller set to `none`, by name. */
  async listMuted(userId: string): Promise<MutedAssociation[]> {
    const rows = await this.repo.find({
      where: { userId, targetKind: 'association', level: 'none' },
      select: { targetId: true },
    });
    if (rows.length === 0) return [];
    const assos = await this.assoRepo.findBy({ id: In(rows.map((r) => r.targetId)) });
    return assos
      .map((a) => ({ id: a.id, name: a.name, slug: a.slug, logoUrl: a.logoUrl }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** Writes a reduction; returns the row. */
const UPSERT_BELL_SQL = `INSERT INTO account_bells ("userId", "targetKind", "targetId", level)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT ("userId", "targetKind", "targetId")
    DO UPDATE SET level = EXCLUDED.level, "updatedAt" = now()
  RETURNING "userId"`;

/** Writes a reduction on a PERSON only while the caller follows them (accepted); no row otherwise. */
const UPSERT_PERSON_BELL_SQL = `INSERT INTO account_bells ("userId", "targetKind", "targetId", level)
  SELECT $1::varchar, $2::varchar, $3::varchar, $4::varchar
   WHERE EXISTS (SELECT 1 FROM user_follows f
                  WHERE f."followerUserId" = $1::varchar AND f."followedUserId" = $3::varchar
                    AND f.status = $5::varchar)
  ON CONFLICT ("userId", "targetKind", "targetId")
    DO UPDATE SET level = EXCLUDED.level, "updatedAt" = now()
  RETURNING "userId"`;

/**
 * The statement that DELETES a reader's bell row for one account, run by the write that makes a
 * follow come into being (L3), reading the rows that write RETURNED: a retried follow returns no row
 * and touches no bell. `$source` is the CTE's name; it must return `reader` and `target` columns.
 */
export function resetBellOnNewFollowSql(source: string, kind: BellTargetKind): string {
  return `DELETE FROM account_bells b USING ${source} s
   WHERE b."userId" = s.reader AND b."targetKind" = '${kind}' AND b."targetId" = s.target::text`;
}

const targetNotFound = () =>
  new NotFoundException({ code: BELL_CODES.targetNotFound, message: 'No bell for that account' });

const short = (id: string) => id.slice(0, 8);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
