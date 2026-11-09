import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { RedisService } from '../common/redis/redis.service';
import { invalidatePostListCache } from '../posts/post-list-cache';
import type { SpaceCampus, SpaceFormation } from '../spaces/space.entity';
import { sanitizeLog } from '../common/log.utils';

/** One cell granted to one named account. `formation: null` is the whole campus. */
export interface ReadGrantView {
  userId: string;
  campus: SpaceCampus;
  formation: SpaceFormation | null;
  grantedBy: string;
  createdAt: Date;
}

/**
 * One line of the journal: who granted or revoked which cell for whom, or turned their switch "voit
 * les commentaires" on (`cmt_show`) or off (`cmt_hide`), and when. A switch line names no cell:
 * `campus` and `formation` are null on it, and only on it (migration 132's check).
 */
export interface ReadGrantJournalEntry {
  userId: string;
  campus: SpaceCampus | null;
  formation: SpaceFormation | null;
  action: 'grant' | 'revoke' | 'cmt_show' | 'cmt_hide';
  actor: string;
  at: Date;
}

/** A named reader's switch "voit les commentaires", once set. A reader with no row is OFF. */
export interface ReadGrantReaderView {
  userId: string;
  seesComments: boolean;
  updatedBy: string;
  updatedAt: Date;
}

/** How many journal lines the admin page reads at once, newest first. */
export const JOURNAL_PAGE = 200;

/**
 * NOMINATIVE READ GRANTS (WP7 of profiles-and-access, D24). The model, in a sentence: a global admin
 * names an account and ticks cells (campus x formation, or a whole campus); that account then READS
 * the posts and events of the associations, lists and institutions reaching a ticked space, and may
 * react - never a personal post, never notified, never publishing (D31). On a post ONLY the grant
 * opens, the comments and who reacted or voted follow the reader's switch "voit les commentaires"
 * (`setSeesComments`, off by default; owner, 2026-11-04). Decisions and
 * proof: docs/wiki/profiles-and-access.md, "Nominative read grants as built".
 *
 * This service only WRITES and LISTS. What a grant lets a reader see is one SQL predicate,
 * `readGrantReachesAssociationSql` in `spaces/reader-spaces.ts`, spliced into the same fragments
 * every other read goes through - so there is no second visibility rule to drift.
 */
@Injectable()
export class ReadGrantsService {
  private readonly logger = new Logger(ReadGrantsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService
  ) {}

  /**
   * Every current grant, every named reader's switch that was ever set, and the most recent journal
   * lines. The list is internal: global admins only.
   */
  async list(): Promise<{
    grants: ReadGrantView[];
    readers: ReadGrantReaderView[];
    journal: ReadGrantJournalEntry[];
  }> {
    const grants = (await this.dataSource.query(
      `SELECT user_id AS "userId", campus, formation, granted_by AS "grantedBy", created_at AS "createdAt"
         FROM read_grants ORDER BY created_at DESC`
    )) as ReadGrantView[];
    const readers = (await this.dataSource.query(
      `SELECT user_id AS "userId", sees_comments AS "seesComments", updated_by AS "updatedBy",
              updated_at AS "updatedAt"
         FROM read_grant_readers ORDER BY updated_at DESC`
    )) as ReadGrantReaderView[];
    const journal = (await this.dataSource.query(
      `SELECT user_id AS "userId", campus, formation, action, actor, at
         FROM read_grant_journal ORDER BY at DESC LIMIT $1`,
      [JOURNAL_PAGE]
    )) as ReadGrantJournalEntry[];
    return { grants, readers, journal };
  }

  /**
   * Sets one named reader's switch "voit les commentaires" (owner, 2026-11-04). ON lets them read
   * the comments - and who reacted or voted - of the posts only a grant shows them, and comment there;
   * OFF (the default: no row) withholds all of it (`commentsWithheldFromViewerSql`). Idempotent like
   * `setCell`: a state already held writes nothing, so the journal (`cmt_show` / `cmt_hide`) records
   * CHANGES only; the row and its journal line are one transaction. Turning it ON for an account that
   * does not exist is a 404, as a grant is; turning it OFF never asks.
   */
  async setSeesComments(
    actor: string,
    userId: string,
    seesComments: boolean
  ): Promise<{ changed: boolean }> {
    this.logger.debug(
      `[READ_GRANT] comments ${seesComments ? 'shown to' : 'hidden from'} ${sanitizeLog(userId)} by ${sanitizeLog(actor)}`
    );
    const changed = await this.dataSource.transaction(async (manager) => {
      if (seesComments) {
        const known = (await manager.query(`SELECT 1 FROM users WHERE id = $1`, [
          userId,
        ])) as unknown[];
        if (known.length === 0) {
          this.logger.warn(`[READ_GRANT] refused: unknown account ${sanitizeLog(userId)}`);
          throw new NotFoundException('Unknown user');
        }
      }
      if (!seesComments) return this.turnCommentsOff(manager, userId, actor);
      // A state already held is left untouched by the conflict branch's WHERE: no row comes back.
      const rows = (await manager.query(
        `INSERT INTO read_grant_readers (user_id, sees_comments, updated_by) VALUES ($1, true, $2)
         ON CONFLICT (user_id) DO UPDATE SET sees_comments = true,
           updated_by = EXCLUDED.updated_by, updated_at = now()
           WHERE NOT read_grant_readers.sees_comments
         RETURNING user_id`,
        [userId, actor]
      )) as unknown[];
      if (rows.length === 0) return false;
      await manager.query(
        `INSERT INTO read_grant_journal (user_id, campus, formation, action, actor)
           VALUES ($1, NULL, NULL, 'cmt_show', $2)`,
        [userId, actor]
      );
      return true;
    });
    if (changed) {
      // What the reader's feed carries changed (comments, counts, who reacted): drop the cache.
      const dropped = await invalidatePostListCache(this.redis);
      this.logger.debug(`[READ_GRANT] feed cache dropped (${dropped} keys)`);
    }
    return { changed };
  }

  /**
   * Turns a reader's switch OFF inside `manager`'s transaction, journalled as `cmt_hide` by `actor`
   * when it was ON; no row, or a row already OFF, writes nothing. Shared by the switch itself and by
   * the revocation of a reader's LAST cell, so a reader granted again later starts OFF, as decided.
   */
  private async turnCommentsOff(
    manager: EntityManager,
    userId: string,
    actor: string
  ): Promise<boolean> {
    const rows = (await manager.query(
      `UPDATE read_grant_readers SET sees_comments = false, updated_by = $2, updated_at = now()
         WHERE user_id = $1 AND sees_comments RETURNING user_id`,
      [userId, actor]
    )) as unknown[];
    if (rows.length === 0) return false;
    await manager.query(
      `INSERT INTO read_grant_journal (user_id, campus, formation, action, actor)
         VALUES ($1, NULL, NULL, 'cmt_hide', $2)`,
      [userId, actor]
    );
    this.logger.debug(`[READ_GRANT] comments switch of ${sanitizeLog(userId)} turned off`);
    return true;
  }

  /**
   * Grants or revokes one cell. Idempotent: setting a state already held changes nothing and writes
   * no journal line, so the journal records CHANGES and a retry cannot forge history. The grant row
   * and its journal line are one transaction. Granting to an account that does not exist is a 404
   * (a typo must not become a standing grant for whoever later gets that id); revoking never asks.
   */
  async setCell(
    actor: string,
    userId: string,
    campus: SpaceCampus,
    formation: SpaceFormation | null,
    granted: boolean
  ): Promise<{ changed: boolean }> {
    this.logger.debug(
      `[READ_GRANT] ${granted ? 'grant' : 'revoke'} ${campus}/${formation ?? '*'} for ${sanitizeLog(userId)} by ${sanitizeLog(actor)}`
    );
    const changed = await this.dataSource.transaction(async (manager) => {
      if (granted) {
        const known = (await manager.query(`SELECT 1 FROM users WHERE id = $1`, [
          userId,
        ])) as unknown[];
        if (known.length === 0) {
          this.logger.warn(`[READ_GRANT] refused: unknown account ${sanitizeLog(userId)}`);
          throw new NotFoundException('Unknown user');
        }
      }
      const rows = (await manager.query(
        granted
          ? `INSERT INTO read_grants (user_id, campus, formation, granted_by) VALUES ($1, $2, $3, $4)
               ON CONFLICT (user_id, campus, COALESCE(formation, '')) DO NOTHING RETURNING id`
          : `DELETE FROM read_grants WHERE user_id = $1 AND campus = $2
               AND COALESCE(formation, '') = COALESCE($3, '') RETURNING id`,
        granted ? [userId, campus, formation, actor] : [userId, campus, formation]
      )) as unknown[];
      if (rows.length === 0) return false;
      await manager.query(
        `INSERT INTO read_grant_journal (user_id, campus, formation, action, actor)
           VALUES ($1, $2, $3, $4, $5)`,
        [userId, campus, formation, granted ? 'grant' : 'revoke', actor]
      );
      if (!granted) {
        // The reader's LAST cell gone: their switch goes back OFF (journalled), so a reader granted
        // again later starts OFF like any new one (owner, 2026-11-04).
        const left = (await manager.query(`SELECT 1 FROM read_grants WHERE user_id = $1 LIMIT 1`, [
          userId,
        ])) as unknown[];
        if (left.length === 0) await this.turnCommentsOff(manager, userId, actor);
      }
      return true;
    });
    if (changed) {
      // The feed cache is keyed per reader and holds what that reader may see: a grant is a change to
      // one reader's page, and a revocation must not keep serving it for the TTL.
      const dropped = await invalidatePostListCache(this.redis);
      this.logger.debug(`[READ_GRANT] feed cache dropped (${dropped} keys)`);
    }
    return { changed };
  }
}
