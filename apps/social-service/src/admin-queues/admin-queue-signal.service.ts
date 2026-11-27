import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RedisService } from '../common/redis/redis.service';
import { bdeModeratesCommentSql, reportInBdeScopeSql } from '../spaces/bde-moderation';
import { holdsBdeAgendaRightOverSql } from '../spaces/bde';

/**
 * The frame every admin badge refetches on (`frontend/src/lib/admin/adminQueueCounts.svelte.ts`).
 * It carries NOTHING: the counts are read afterwards from `GET /api/moderation/admin-queues`, which
 * answers only what the reader may act on, so the frame names no queue, no item and no person.
 */
export const ADMIN_QUEUES_CHANGED_EVENT = 'admin.queues.changed';

/** What changed in which queue - enough to name who may act on it, nothing the frame carries. */
export type AdminQueueChange =
  | { queue: 'profile-corrections' }
  | { queue: 'alumni-duplicates' }
  | { queue: 'moderation'; reportIds: readonly string[] }
  | { queue: 'agenda'; associationId: string };

/** The members holding any permission bit: the only accounts a scoped door can open for. */
const STAFF_SQL = `(SELECT DISTINCT aqs_m."userId" AS uid FROM association_members aqs_m
    WHERE aqs_m.permissions <> 0) aqs_c`;

/**
 * The reported comments, each with the post it sits under - resolved ONCE per signal. The queue's
 * own comment branch is a set computed per moderator, which is a hash probe when the moderator is a
 * parameter and a scan of every post PER CANDIDATE here, where the moderator is a column; so the
 * signal resolves the posts first and tests each candidate against that one row.
 */
const REPORTED_COMMENTS_SQL = `aqs_cm AS MATERIALIZED (SELECT aqs_r0.id AS "reportId", rp.id AS "postId",
    rc AS comment
  FROM content_reports aqs_r0
  JOIN posts rp ON aqs_r0."contentType" = 'comment'
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(rp.comments, '[]'::jsonb)) rc
  WHERE aqs_r0.id = ANY($1::uuid[]) AND rc->>'id' = aqs_r0."contentId")`;

/** The comment branch of the queue's scope, over {@link REPORTED_COMMENTS_SQL}'s rows. */
const COMMENT_IN_SCOPE_SQL = `EXISTS (SELECT 1 FROM aqs_cm JOIN posts rp ON rp.id = aqs_cm."postId"
  WHERE aqs_cm."reportId" = aqs_r.id AND ${bdeModeratesCommentSql('aqs_c.uid', 'rp', 'aqs_cm.comment')})`;

/**
 * Who may act on the change - the global admins and, for a scoped queue, every account the queue's
 * own scope primitive admits for it (the predicate the counts and the queue page apply), so a BDE
 * moderator is pinged only about reports in their spaces, an event validator only about the events
 * of the associations their BDE governs.
 */
const RECIPIENTS_SQL: Record<AdminQueueChange['queue'], string> = {
  'profile-corrections': `SELECT id AS uid FROM users WHERE admin = true`,
  'alumni-duplicates': `SELECT id AS uid FROM users WHERE admin = true`,
  moderation: `WITH ${REPORTED_COMMENTS_SQL}
    SELECT id AS uid FROM users WHERE admin = true
    UNION SELECT aqs_c.uid FROM ${STAFF_SQL}
    WHERE EXISTS (SELECT 1 FROM content_reports aqs_r
      WHERE aqs_r.id = ANY($1::uuid[])
        AND ${reportInBdeScopeSql('aqs_r', 'aqs_c.uid', COMMENT_IN_SCOPE_SQL)})`,
  agenda: `SELECT id AS uid FROM users WHERE admin = true
    UNION SELECT aqs_c.uid FROM ${STAFF_SQL}
    WHERE ${holdsBdeAgendaRightOverSql('aqs_c.uid', '$1::uuid')}`,
};

/**
 * The capability a socket declares when its code routes {@link ADMIN_QUEUES_CHANGED_EVENT}: the
 * gateway delivers the frame only to those sessions (`ADMIN_QUEUES_CAPABILITY` in
 * `apps/chat-gateway/src/addressing.rs` and in the client), so a build that predates the badges
 * never meets a frame it cannot route.
 */
export const ADMIN_QUEUES_CAPABILITY = 'admin-queues-1';

/**
 * THE ADMIN BADGES ARE TOLD, NOT POLLED (lead, 2026-11-18): when an item arrives in an admin queue
 * or leaves it, the accounts that may act on it get one content-free `admin.queues.changed` frame
 * over the socket the app already holds (`RedisService.publishChannelEvent`, the gateway's
 * `chat:channel_events` fan-out), and refetch their counts. Called AFTER the write committed, from
 * every path that moves an item in or out of a queue (docs/wiki/frontend/modules/admin.md, "The
 * badges"). Never throws: the write it follows is done whatever this does, and a frame that is not
 * sent is said at ERROR - a badge that does not move is the defect this exists to end.
 */
@Injectable()
export class AdminQueueSignal {
  private readonly logger = new Logger(AdminQueueSignal.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly redis: RedisService
  ) {}

  /** Tells the accounts that may act on `change` that their counts moved. */
  async changed(change: AdminQueueChange): Promise<void> {
    try {
      const params =
        change.queue === 'moderation'
          ? [change.reportIds]
          : change.queue === 'agenda'
            ? [change.associationId]
            : [];
      if (change.queue === 'moderation' && change.reportIds.length === 0) return;
      const rows: { uid: string }[] = await this.db.query(RECIPIENTS_SQL[change.queue], params);
      const userIds = [...new Set(rows.map((r) => r.uid))];
      if (userIds.length === 0) {
        this.logger.debug(`[ADMIN_QUEUES] ${change.queue} changed: nobody may act on it`);
        return;
      }
      await this.redis.publishChannelEvent(
        ADMIN_QUEUES_CHANGED_EVENT,
        {},
        userIds,
        ADMIN_QUEUES_CAPABILITY
      );
      // The publish logs its own failure (`RedisService.publish`); this line says what was ASKED.
      this.logger.debug(
        `[ADMIN_QUEUES] ${change.queue} changed: ${userIds.length} account(s) to recount`
      );
    } catch (err) {
      this.logger.error(
        `[ADMIN_QUEUES] ${change.queue} changed but the badges were NOT told: ${String(err)}`
      );
    }
  }
}

/** Global, so every service that moves a queue item reaches it without a module edge (or a cycle). */
@Global()
@Module({ providers: [AdminQueueSignal], exports: [AdminQueueSignal] })
export class AdminQueueSignalModule {}
