import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
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

/** One line of the journal: who granted or revoked which cell for whom, and when. */
export interface ReadGrantJournalEntry {
  userId: string;
  campus: SpaceCampus;
  formation: SpaceFormation | null;
  action: 'grant' | 'revoke';
  actor: string;
  at: Date;
}

/** How many journal lines the admin page reads at once, newest first. */
export const JOURNAL_PAGE = 200;

/**
 * NOMINATIVE READ GRANTS (WP7 of profiles-and-access, D24). The model, in a sentence: a global admin
 * names an account and ticks cells (campus x formation, or a whole campus); that account then READS
 * the posts, comments, reactions and events of the associations, lists and institutions reaching a
 * ticked space - never a personal post, never notified, never publishing (D31). Decisions and
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

  /** Every current grant and the most recent journal lines. The list is internal: global admins only. */
  async list(): Promise<{ grants: ReadGrantView[]; journal: ReadGrantJournalEntry[] }> {
    const grants = (await this.dataSource.query(
      `SELECT user_id AS "userId", campus, formation, granted_by AS "grantedBy", created_at AS "createdAt"
         FROM read_grants ORDER BY created_at DESC`
    )) as ReadGrantView[];
    const journal = (await this.dataSource.query(
      `SELECT user_id AS "userId", campus, formation, action, actor, at
         FROM read_grant_journal ORDER BY at DESC LIMIT $1`,
      [JOURNAL_PAGE]
    )) as ReadGrantJournalEntry[];
    return { grants, journal };
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
