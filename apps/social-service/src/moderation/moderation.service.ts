import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { isBlockedBetween } from '../common/user-blocks';
import { liveVisibleToViewerSql } from '../spaces/reader-spaces';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { DELETED_ACCOUNT } from '../internal/account-erasure';
import type { LiveChatReportedLine } from '../lives/entities/live-chat-reported-line.entity';
import { openLiveChatLine } from '../lives/live-chat-seal';
import {
  openLiveKeyOr503,
  storedLiveKeyColumns,
  type StoredLiveKey,
} from '../lives/live-key-at-rest';
import {
  type ReportedLineIntegrity,
  signReportedLine,
  signingKey,
  verifyReportedLine,
} from '../lives/live-report-signature';
import { standingsOf, type LiveStanding } from '../lives/live-strikes';
import { short } from '../lives/live-log';
import {
  LIVE_CHAT_REPORT_MAX_KEEP_MS,
  LIVE_CHAT_REPORT_TEXT_MAX_BYTES,
} from '../lives/live.constants';
import { ContentReport } from './entities/content-report.entity';
import { UserModeration } from './entities/user-moderation.entity';
import { sanitizeLog } from '../common/log.utils';
import { dropRepublicationsOf } from '../posts/republication-sql';

/** Number of distinct pending reports on the same content that triggers automatic hiding. */
const AUTO_HIDE_THRESHOLD = 5;

export interface CreateReportData {
  reporterId: string;
  contentType: 'post' | 'comment' | 'user' | 'live' | 'live_chat';
  contentId: string;
  reason: string;
  details?: string;
  /** User ID of the content author, used to enable quick moderation actions. */
  reportedUserId?: string | null;
  /** `live_chat` only: the live the line was read on, checked against the message's own. */
  liveId?: string;
  /** `live_chat` only: the line's plaintext as the reporter's client opened it. */
  message?: string;
}

/** The unique index that holds one report per reporter per thing (migration 099). */
const REPORT_UNIQUE_INDEX = 'content_reports_reporter_content_uniq';

/** A save refused by {@link REPORT_UNIQUE_INDEX}: a concurrent duplicate, classified at the throw. */
function isDuplicateReport(e: unknown): boolean {
  if (!(e instanceof QueryFailedError)) return false;
  const err = e.driverError as { code?: string; constraint?: string };
  return err.code === '23505' && err.constraint === REPORT_UNIQUE_INDEX;
}

/** A uuid, any case. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A reported live as the moderation queue shows it ({@link ModerationService.listAllReports}). */
export interface LiveReportState {
  state: 'open' | 'ended' | 'cut' | 'gone';
  broadcasterId: string | null;
  broadcasterName: string | null;
  associationId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  /** The cut's reason code, when staff cut it. */
  cutReason: string | null;
  /** How many of the broadcaster's lives staff cut ON RECORD (the rolling 90 days), this one included. */
  broadcasterCuts: number;
  /**
   * The broadcaster's place on the strike ladder (WP-L8b): the suspension running, a withdrawal
   * staff made, or one now due (`withdrawalDue`: the decision is the moderator's).
   */
  broadcasterStanding: LiveStanding | null;
}

/** A reported live chat LINE as the moderation queue shows it (WP-L8b), while it is kept. */
export interface LiveChatLineState {
  liveId: string;
  messageId: string;
  seq: number;
  /** The author; the erased tombstone once their account was erased (the line stays, owner 2026-10-20). */
  authorId: string;
  authorName: string | null;
  /** The plaintext AS REPORTED by the report's reporter, checked by the server against the sealed line. */
  text: string;
  messageCreatedAt: Date;
  keptAt: Date;
  /** When the 90-day bound erases it, handled or not. */
  keptUntil: Date;
  integrity: ReportedLineIntegrity;
}

/** Bound of the once-per-(reporter, message) mismatch log set. */
const MISMATCH_LOG_CAP = 1000;

/** Handles content reports and user mute/unmute moderation actions. */
@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  /**
   * (reporter, message) pairs whose chat-line mismatch was already logged at warn. The refusal rolls
   * its transaction back, so no durable row can say "already told"; this process-local set is
   * bounded by clearing at MISMATCH_LOG_CAP, never by a timer. After a restart or a clear the next
   * attempt warns once more, which costs one line.
   */
  private readonly loggedMismatches = new Set<string>();

  constructor(
    @InjectRepository(ContentReport)
    private readonly reportRepo: Repository<ContentReport>,
    @InjectRepository(UserModeration)
    private readonly muteRepo: Repository<UserModeration>
  ) {}

  // ── Content reports ───────────────────────────────────────────────────────

  /**
   * Creates a new content report. A user reports a given piece of content ONCE, whatever becomes of
   * that report: the duplicate check deliberately ignores `status`. It used to look at `pending`
   * only, which meant a dismissal re-opened the door - and a dismissal is an answer, not an
   * invitation to file the same accusation again.
   *
   * If the number of pending reports for a post reaches AUTO_HIDE_THRESHOLD, the post is
   * automatically hidden from public feeds until a moderator reviews it.
   *
   * The refusal is a 409 carrying a `code`, never a sentence: the client has to tell "already
   * reported" from a real failure, and a distinction carried in prose is a distinction exactly one
   * call site will make. It read `message.includes('already')` until 2026-08-27.
   */
  async createReport(data: CreateReportData): Promise<ContentReport> {
    if (data.contentType === 'live_chat') return this.createChatLineReport(data);
    if (data.contentType === 'live') {
      // The broadcaster is read from the live, never taken from the client: it is who a moderator's
      // cut and mute act on.
      // The id in lower case, as the cut matches it, so one live is one subject for the dedup.
      const live = await this.reportableLive(
        this.reportRepo.manager,
        data.reporterId,
        data.contentId
      );
      data = {
        ...data,
        contentId: data.contentId.toLowerCase(),
        reportedUserId: live.broadcasterId,
      };
    }
    if (data.contentType === 'comment') {
      // The writer is read from the stored comment, never taken from the client: an anonymous
      // comment is served WITHOUT its account, so the reporter cannot name it - and the mute that
      // follows a report needs it. It is held for moderators and never served to anyone else.
      data = { ...data, reportedUserId: await this.commentWriterId(data.contentId) };
    }
    const saved = await this.insertReport(this.reportRepo, data);

    // Auto-hide posts that accumulate too many pending reports.
    if (data.contentType === 'post') {
      const pendingCount = await this.reportRepo.count({
        where: { contentId: data.contentId, status: 'pending' },
      });
      if (pendingCount >= AUTO_HIDE_THRESHOLD) {
        const dropped = await this.reportRepo.manager.transaction(async (manager) => {
          await manager.query(`UPDATE posts SET "hiddenByModeration" = true WHERE id = $1`, [
            data.contentId,
          ]);
          // D38: a hidden post loses every republication and pending repost proposal.
          return dropRepublicationsOf(manager, data.contentId);
        });
        this.logger.log(
          `Post ${sanitizeLog(data.contentId)} auto-hidden after ${pendingCount} pending reports ` +
            `(${dropped.republications} republication(s), ${dropped.proposals} pending proposal(s) removed)`
        );
      }
    }

    return saved;
  }

  /**
   * Files one report, ONCE per reporter per subject whatever became of an earlier one (409
   * `ALREADY_REPORTED`, the dedup every content type shares). `repo` is the report store, or its
   * view inside the caller's transaction (a chat line's report and its kept line commit together).
   * The read answers the ordinary repeat; the unique index `content_reports_reporter_content_uniq`
   * (migration 099) answers two requests that both passed it, mapped to the same 409.
   */
  private async insertReport(
    repo: Repository<ContentReport>,
    data: CreateReportData
  ): Promise<ContentReport> {
    const existing = await repo.findOne({
      where: {
        reporterId: data.reporterId,
        contentId: data.contentId,
      },
    });
    if (existing) {
      this.logger.log(
        `Duplicate report refused: reporter=${short(data.reporterId)} content=${sanitizeLog(data.contentId)} existingStatus=${existing.status}`
      );
      throw new ConflictException({
        code: 'ALREADY_REPORTED',
        message: 'You have already reported this content',
      });
    }
    const report = repo.create({
      reporterId: data.reporterId,
      contentType: data.contentType,
      contentId: data.contentId,
      reason: data.reason,
      details: data.details ?? null,
      reportedUserId: data.reportedUserId ?? null,
    });
    try {
      return await repo.save(report);
    } catch (e) {
      if (isDuplicateReport(e)) {
        this.logger.log(
          `Duplicate report refused by the index: reporter=${short(data.reporterId)} content=${sanitizeLog(data.contentId)}`
        );
        throw new ConflictException({
          code: 'ALREADY_REPORTED',
          message: 'You have already reported this content',
        });
      }
      throw e;
    }
  }

  /**
   * A LIVE IS REPORTED BY THOSE WHO CAN SEE IT (WP-L8, D6): the live's row must exist (open, or ended
   * and not yet purged) and be visible to the reporter by the rule of a post
   * (`liveVisibleToViewerSql`), with no block between them - otherwise 404 `LIVE_NOT_FOUND`, the
   * live API's own answer, so the report route is no oracle for a live the reporter could not watch.
   * A viewer the broadcaster removed from that live (`live_removed_viewers`) may still report THE
   * LIVE itself - what they watched before the removal is theirs to report - so this does not refuse
   * them; the chat-line path refuses only a line written AFTER their `removedAt`.
   * A live ended and purged has nothing left to review (no replay, L3): report the person instead.
   * Returns the broadcaster (stored as the report's `reportedUserId`) and the live key AS STORED
   * (sealed, migration 110), which a chat line's report opens through `openLiveKey` alone to check the
   * reporter's plaintext. `FOR SHARE` when `lock`: the live's row then cannot be purged, nor a chat
   * line of it hidden, before the caller's transaction commits.
   */
  private async reportableLive(
    manager: EntityManager,
    reporterId: string,
    liveId: string,
    lock = false
  ): Promise<{ broadcasterId: string; storedKey: StoredLiveKey }> {
    const refuse = (why: string): NotFoundException => {
      this.logger.debug(
        `[REPORT] live ${sanitizeLog(liveId)} not reportable by ${sanitizeLog(reporterId)}: ${why}`
      );
      return new NotFoundException({ code: 'LIVE_NOT_FOUND' });
    };
    if (!UUID_RE.test(liveId)) throw refuse('not a live id');
    const rows: (StoredLiveKey & { broadcasterId: string; visible: boolean })[] =
      await manager.query(
        `SELECT "broadcasterId", ${storedLiveKeyColumns()},
                ${liveVisibleToViewerSql('lives', '$2')} AS visible
           FROM lives WHERE id = $1${lock ? ' FOR SHARE' : ''}`,
        [liveId.toLowerCase(), reporterId]
      );
    const live = rows[0];
    if (!live) throw refuse('no such live');
    if (live.visible !== true) throw refuse('not visible to the reporter');
    if (await isBlockedBetween(manager, reporterId, live.broadcasterId)) {
      throw refuse('a block with the broadcaster');
    }
    return {
      broadcasterId: live.broadcasterId,
      storedKey: {
        liveKeyCiphertext: live.liveKeyCiphertext,
        liveKeyVersion: live.liveKeyVersion,
        liveKey: live.liveKey,
      },
    };
  }

  /** Warns the FIRST time a reporter's text mismatches a line, then drops repeats to debug. */
  private logMismatchOnce(reporterId: string, messageId: string, line: string): void {
    const key = `${reporterId}|${messageId}`;
    if (this.loggedMismatches.has(key)) {
      this.logger.debug(`${line} (repeat)`);
      return;
    }
    if (this.loggedMismatches.size >= MISMATCH_LOG_CAP) this.loggedMismatches.clear();
    this.loggedMismatches.add(key);
    this.logger.warn(line);
  }

  /**
   * REPORTS ONE LINE OF A LIVE'S CHAT (WP-L8b; owner, 2026-10-20: the line is KEPT for staff until
   * the report is handled, 90 days at most). `contentId` is the message's id, `message` its
   * PLAINTEXT as the reporter's client opened it, `liveId` optional (checked when given).
   *
   * ONE TRANSACTION: the live's row `FOR SHARE` (it can be neither purged nor have this line hidden
   * meanwhile - both take it `FOR UPDATE`), then the message `FOR SHARE` (an erasure deleting it waits
   * for this commit, then anonymises the kept line it then sees), then:
   *
   * 1. who may report it: who may report the live (visible, no block with the broadcaster), no
   *    block with the AUTHOR either way (a line they were never shown), and, for a viewer the
   *    broadcaster removed, a line written no later than that removal - else 404 `LIVE_NOT_FOUND`,
   *    as for a hidden line, a purged live or a message that never existed: no oracle;
   * 2. THE PLAINTEXT IS CHECKED, not trusted: the sealed line is opened with the live key the row
   *    still holds, and must equal `message` exactly - else 400 `LIVE_CHAT_REPORT_MISMATCH`, so a
   *    reporter cannot put words in an author's mouth. The key is NOT copied anywhere;
   * 3. the report row (the shared dedup: once per reporter per line), `reportedUserId` the author;
   * 4. the KEPT LINE (`live_chat_reported_lines`): the text, the SHA-256 of the sealed bytes, the
   *    message's place, and the server's two signatures (`live-report-signature.ts`).
   *
   * No auto-hide and no count acts on it: a person answers it. Refused 503
   * `LIVE_REPORT_SIGNING_UNAVAILABLE` before anything is read when the estate has no signing key.
   */
  private async createChatLineReport(data: CreateReportData): Promise<ContentReport> {
    const key = signingKey();
    if (!key) {
      this.logger.error(
        '[REPORT] a live chat line cannot be kept: LIVE_REPORT_SIGNING_KEY is unset or too short'
      );
      throw new ServiceUnavailableException({ code: 'LIVE_REPORT_SIGNING_UNAVAILABLE' });
    }
    const text = data.message;
    if (
      typeof text !== 'string' ||
      text.length === 0 ||
      Buffer.byteLength(text, 'utf8') > LIVE_CHAT_REPORT_TEXT_MAX_BYTES
    ) {
      throw new BadRequestException({ code: 'LIVE_CHAT_REPORT_MESSAGE_INVALID' });
    }
    const messageId = data.contentId.toLowerCase();
    const notFound = (why: string) => {
      this.logger.debug(
        `[REPORT] chat line ${sanitizeLog(messageId)} not reportable by ${sanitizeLog(data.reporterId)}: ${why}`
      );
      return new NotFoundException({ code: 'LIVE_NOT_FOUND' });
    };
    if (!UUID_RE.test(messageId)) throw notFound('not a message id');

    const saved = await this.reportRepo.manager.transaction(async (tx) => {
      const owner: { liveId: string }[] = await tx.query(
        `SELECT "liveId"::text FROM live_chat_messages WHERE id = $1`,
        [messageId]
      );
      if (!owner[0]) throw notFound('no such message');
      const liveId = owner[0].liveId;
      if (data.liveId !== undefined && data.liveId.toLowerCase() !== liveId) {
        throw notFound('another live named');
      }
      const live = await this.reportableLive(tx, data.reporterId, liveId, true);
      const rows: {
        seq: number;
        authorId: string;
        clientId: string;
        sealed: Buffer | null;
        createdAt: Date;
        afterRemoval: boolean;
      }[] = await tx.query(
        `SELECT m.seq, m."authorId", m."clientId"::text, m.sealed, m."createdAt",
                EXISTS (SELECT 1 FROM live_removed_viewers r
                         WHERE r."liveId" = m."liveId" AND r."viewerId" = $2
                           AND m."createdAt" > r."removedAt") AS "afterRemoval"
           FROM live_chat_messages m
          WHERE m.id = $1 FOR SHARE OF m`,
        [messageId, data.reporterId]
      );
      const line = rows[0];
      if (!line || line.sealed === null) throw notFound('gone or hidden');
      // A removed viewer saw every line written before their removal legitimately; one written
      // after it was never shown to them (the server refuses them the key from then on). Compared
      // in SQL, at the database's microsecond precision.
      if (line.afterRemoval === true) {
        throw notFound('written after the reporter was removed from the live');
      }
      if (await isBlockedBetween(tx, data.reporterId, line.authorId)) {
        throw notFound('a block with the author');
      }
      // An unreadable stored key is a 503 (logged at ERROR by `openLiveKey`), never a mismatch: the
      // reporter's text was not found false, it could not be checked.
      const opened = openLiveChatLine(
        openLiveKeyOr503(liveId, live.storedKey),
        liveId,
        line.clientId,
        line.authorId,
        line.sealed
      );
      if (opened !== text) {
        this.logMismatchOnce(
          data.reporterId,
          messageId,
          `[REPORT] chat line ${messageId} on ${liveId}: the reporter's text does not match the ` +
            `sealed line (${opened === null ? 'the line does not open' : 'another text'}) - refused`
        );
        throw new BadRequestException({ code: 'LIVE_CHAT_REPORT_MISMATCH' });
      }
      const report = await this.insertReport(tx.getRepository(ContentReport), {
        ...data,
        contentId: messageId,
        reportedUserId: line.authorId,
      });
      // `keptAt` is SIGNED, so it is read before the insert rather than defaulted by it: the
      // database clock, to the millisecond a JavaScript Date carries, so what is signed is what is
      // stored and read back.
      const [{ keptAt }]: { keptAt: Date }[] = await tx.query(
        `SELECT date_trunc('milliseconds', now()) AS "keptAt"`
      );
      const content = {
        reportId: report.id,
        liveId,
        messageId,
        seq: line.seq,
        clientId: line.clientId,
        sealedSha256: createHash('sha256').update(line.sealed).digest('hex'),
        messageCreatedAt: line.createdAt,
        keptAt,
        text,
      };
      const signed = signReportedLine(key, content, {
        reportId: report.id,
        authorId: line.authorId,
        reporterId: data.reporterId,
      });
      await tx.query(
        `INSERT INTO live_chat_reported_lines ("reportId", "liveId", "messageId", seq, "authorId",
           "clientId", "sealedSha256", text, "messageCreatedAt", "keptAt", "keyId", signature,
           "authorSignature", "reporterSignature")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          report.id,
          liveId,
          messageId,
          line.seq,
          line.authorId,
          line.clientId,
          content.sealedSha256,
          Buffer.from(text, 'utf8'),
          line.createdAt,
          keptAt,
          signed.keyId,
          signed.signature,
          signed.authorSignature,
          signed.reporterSignature,
        ]
      );
      return report;
    });
    this.logger.log(
      `[REPORT] chat line ${short(messageId)} reported by ${short(data.reporterId)} ` +
        `reason=${sanitizeLog(data.reason)}: kept for staff (report ${short(saved.id)})`
    );
    return saved;
  }

  /**
   * Returns all content reports regardless of status, newest first.
   * Each report is enriched with `contentPreview` (a short text excerpt of the
   * reported content, or the display name when the report targets a person) and
   * `postId` (the parent post ID for comment reports).
   *
   * Retention is NOT this method's business. A lazy purge ran here on every call until 2026-08-27,
   * which made a moderator's GET delete rows as a side effect and gave `content_reports` a second,
   * contradictory lifetime. The one policy left is the weekly cron in `forms-reminder.scheduler`.
   */
  async listAllReports(
    limit = 50,
    offset = 0
  ): Promise<
    Array<
      ContentReport & {
        contentPreview: string | null;
        postId: string | null;
        live: LiveReportState | null;
        liveChat: LiveChatLineState | null;
      }
    >
  > {
    const reports = await this.reportRepo.find({
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 200),
      skip: offset,
    });

    const postIds = reports.filter((r) => r.contentType === 'post').map((r) => r.contentId);
    const commentIds = reports.filter((r) => r.contentType === 'comment').map((r) => r.contentId);
    const reportedUserIds = reports.filter((r) => r.contentType === 'user').map((r) => r.contentId);

    const postPreviews = new Map<string, string>();
    if (postIds.length > 0) {
      const rows: { id: string; markdown: string }[] = await this.reportRepo.manager.query(
        `SELECT id::text, LEFT(markdown, 250) AS markdown FROM posts WHERE id = ANY($1)`,
        [postIds]
      );
      for (const row of rows) postPreviews.set(row.id, row.markdown);
    }

    const commentPreviews = new Map<string, { text: string; postId: string }>();
    if (commentIds.length > 0) {
      const rows: { post_id: string; comment_id: string; text: string }[] =
        await this.reportRepo.manager.query(
          `SELECT p.id::text AS post_id, elem->>'id' AS comment_id, elem->>'text' AS text
           FROM posts p, jsonb_array_elements(COALESCE(p.comments, '[]'::jsonb)) elem
           WHERE elem->>'id' = ANY($1)`,
          [commentIds]
        );
      for (const row of rows)
        commentPreviews.set(row.comment_id, { text: row.text, postId: row.post_id });
    }

    // A report on a person carries no text, so the preview is who they are. Without it a moderator
    // reads a bare uuid and has to go look the account up by hand before deciding anything.
    const userPreviews = new Map<string, string>();
    if (reportedUserIds.length > 0) {
      const rows: { id: string; displayName: string | null }[] =
        await this.reportRepo.manager.query(
          `SELECT id, "displayName" FROM users WHERE id = ANY($1)`,
          [reportedUserIds]
        );
      for (const row of rows) userPreviews.set(row.id, row.displayName ?? row.id);
    }

    const lives = await this.liveReportStates(reports.filter((r) => r.contentType === 'live'));
    const chatLines = await this.chatLineStates(
      reports.filter((r) => r.contentType === 'live_chat')
    );

    return reports.map((r) => ({
      ...r,
      contentPreview:
        r.contentType === 'post'
          ? (postPreviews.get(r.contentId) ?? null)
          : r.contentType === 'comment'
            ? (commentPreviews.get(r.contentId)?.text ?? null)
            : r.contentType === 'user'
              ? (userPreviews.get(r.contentId) ?? null)
              : r.contentType === 'live'
                ? (lives.get(r.contentId)?.broadcasterName ?? null)
                : r.contentType === 'live_chat'
                  ? chatLines.get(r.id)?.integrity.content === 'verified'
                    ? chatLines.get(r.id)!.text
                    : null
                  : null,
      postId:
        r.contentType === 'comment' ? (commentPreviews.get(r.contentId)?.postId ?? null) : null,
      live: r.contentType === 'live' ? (lives.get(r.contentId) ?? null) : null,
      liveChat: r.contentType === 'live_chat' ? (chatLines.get(r.id) ?? null) : null,
    }));
  }

  /**
   * What a moderator reads of a reported CHAT LINE (WP-L8b), by report id: the kept text "as
   * reported by" the report's reporter, the author (anonymised once erased), the line's place, how
   * long it is still kept, and the server's verdict on its integrity. Absent once erased (the report
   * handled, or the 90-day bound): the queue then shows the report with `liveChat: null`.
   */
  private async chatLineStates(reports: ContentReport[]): Promise<Map<string, LiveChatLineState>> {
    const out = new Map<string, LiveChatLineState>();
    if (reports.length === 0) return out;
    const rows: (LiveChatReportedLine & { authorName: string | null })[] =
      await this.reportRepo.manager.query(
        `SELECT k."reportId"::text, k."liveId"::text, k."messageId"::text, k.seq, k."authorId",
                k."clientId"::text, k."sealedSha256", k.text, k."messageCreatedAt", k."keptAt",
                k."keyId", k.signature, k."authorSignature", k."reporterSignature",
                u."displayName" AS "authorName"
           FROM live_chat_reported_lines k
           LEFT JOIN users u ON u.id = k."authorId"
          WHERE k."reportId" = ANY($1::uuid[])`,
        [reports.map((r) => r.id)]
      );
    const reporterOf = new Map(reports.map((r) => [r.id, r.reporterId]));
    const key = signingKey();
    if (!key && rows.length > 0) {
      this.logger.error(
        `[REPORT] ${rows.length} kept chat line(s) shown UNVERIFIABLE: LIVE_REPORT_SIGNING_KEY is unset or too short`
      );
    }
    for (const k of rows) {
      const text = k.text.toString('utf8');
      out.set(k.reportId, {
        liveId: k.liveId,
        messageId: k.messageId,
        seq: k.seq,
        authorId: k.authorId,
        authorName: k.authorName,
        text,
        messageCreatedAt: k.messageCreatedAt,
        keptAt: k.keptAt,
        keptUntil: new Date(k.keptAt.getTime() + LIVE_CHAT_REPORT_MAX_KEEP_MS),
        integrity: verifyReportedLine(
          key,
          k,
          {
            reportId: k.reportId,
            liveId: k.liveId,
            messageId: k.messageId,
            seq: k.seq,
            clientId: k.clientId,
            sealedSha256: k.sealedSha256,
            messageCreatedAt: k.messageCreatedAt,
            keptAt: k.keptAt,
            text,
          },
          { reportId: k.reportId, authorId: k.authorId, reporterId: reporterOf.get(k.reportId)! },
          DELETED_ACCOUNT
        ),
      });
    }
    return out;
  }

  /**
   * What a moderator needs to act on a reported LIVE (WP-L8): whether it is still on air (`open` - the
   * cut button), `ended` (its row not yet purged), `cut` (staff cut it: reason and time), or `gone`
   * (ended and purged - nothing left to watch or cut; the person can still be muted). Plus who
   * broadcast it and how many of their lives staff cut (`broadcasterCuts`, the kept `live_cuts` -
   * the repeat-offender count, which no policy acts on yet).
   */
  private async liveReportStates(reports: ContentReport[]): Promise<Map<string, LiveReportState>> {
    const out = new Map<string, LiveReportState>();
    if (reports.length === 0) return out;
    const ids = [...new Set(reports.map((r) => r.contentId))];
    const lives: {
      id: string;
      broadcasterId: string;
      associationId: string | null;
      startedAt: Date;
      endedAt: Date | null;
      endReason: string | null;
    }[] = await this.reportRepo.manager.query(
      `SELECT id::text, "broadcasterId", "associationId", "startedAt", "endedAt", "endReason"
         FROM lives WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    const cuts: {
      liveId: string;
      broadcasterId: string;
      associationId: string | null;
      reason: string;
      cutAt: Date;
      liveStartedAt: Date;
      liveEndedAt: Date;
      liveEndReason: string;
    }[] = await this.reportRepo.manager.query(
      `SELECT "liveId"::text, "broadcasterId", "associationId", reason, "cutAt", "liveStartedAt",
              "liveEndedAt", "liveEndReason"
         FROM live_cuts WHERE "liveId" = ANY($1::uuid[])`,
      [ids]
    );
    const liveById = new Map(lives.map((l) => [l.id, l]));
    const cutById = new Map(cuts.map((c) => [c.liveId, c]));
    const broadcasterOf = (r: ContentReport): string | null =>
      liveById.get(r.contentId)?.broadcasterId ??
      cutById.get(r.contentId)?.broadcasterId ??
      r.reportedUserId;
    const broadcasters = [
      ...new Set(reports.map(broadcasterOf).filter((b): b is string => b !== null)),
    ];
    const names: { id: string; displayName: string | null }[] = await this.reportRepo.manager.query(
      `SELECT id, "displayName" FROM users WHERE id = ANY($1)`,
      [broadcasters]
    );
    const nameOf = new Map(names.map((n) => [n.id, n.displayName ?? n.id]));
    const standings = await standingsOf(this.reportRepo.manager, broadcasters);

    for (const r of reports) {
      const live = liveById.get(r.contentId);
      const cut = cutById.get(r.contentId);
      const broadcasterId = broadcasterOf(r);
      out.set(r.contentId, {
        state: cut ? 'cut' : !live ? 'gone' : live.endedAt ? 'ended' : 'open',
        broadcasterId,
        broadcasterName: broadcasterId ? (nameOf.get(broadcasterId) ?? null) : null,
        associationId: live?.associationId ?? cut?.associationId ?? null,
        startedAt: live?.startedAt ?? cut?.liveStartedAt ?? null,
        endedAt: live?.endedAt ?? cut?.liveEndedAt ?? null,
        endReason: live?.endReason ?? cut?.liveEndReason ?? null,
        cutReason: cut?.reason ?? null,
        broadcasterCuts: broadcasterId ? (standings.get(broadcasterId)?.cutsOnRecord ?? 0) : 0,
        broadcasterStanding: broadcasterId ? (standings.get(broadcasterId) ?? null) : null,
      });
    }
    return out;
  }

  /**
   * Marks a report as reviewed or dismissed.
   * @param action 'reviewed' - report actioned; 'dismissed' - no action taken.
   */
  async reviewReport(
    reportId: string,
    moderatorId: string,
    action: 'reviewed' | 'dismissed'
  ): Promise<ContentReport> {
    // The three review columns of the row, never a save of a report read first: a save writes back
    // every column changed since the read (an anonymised party included) and re-inserts a report
    // deleted since. 0 rows means the report is gone.
    const updated = await this.reportRepo.update(
      { id: reportId },
      { status: action, reviewedBy: moderatorId, reviewedAt: new Date() }
    );
    if (updated.affected !== 1) {
      this.logger.warn(
        `[REPORT] review refused: report=${reportId.slice(0, 8)} gone affected=${updated.affected ?? 'unknown'}`
      );
      throw new NotFoundException('Report not found');
    }
    this.logger.log(
      `[REPORT] report=${reportId.slice(0, 8)} ${action} by=${moderatorId.slice(0, 8)}`
    );
    const report = await this.reportRepo.findOne({ where: { id: reportId } });
    if (!report) throw new NotFoundException('Report not found');
    return report;
  }

  // ── User mute/unmute ──────────────────────────────────────────────────────

  /** Mutes a user: they can still read but cannot post, react, or comment. */
  async muteUser(userId: string, mutedBy: string, reason?: string): Promise<UserModeration> {
    // ONE statement keyed by the user's unique index, never a read then a save: there is no copy
    // of the record to go stale, and two first mutes cannot both insert.
    const rows = (await this.muteRepo.query(
      `INSERT INTO user_moderation ("userId", "isMuted", "mutedBy", "mutedAt", "mutedReason")
       VALUES ($1, true, $2, $3, $4)
       ON CONFLICT ("userId") DO UPDATE SET
         "isMuted" = true,
         "mutedBy" = EXCLUDED."mutedBy",
         "mutedAt" = EXCLUDED."mutedAt",
         "mutedReason" = EXCLUDED."mutedReason"
       RETURNING *`,
      [userId, mutedBy, new Date(), reason ?? null]
    )) as UserModeration[];
    const record = rows[0];
    if (!record) throw new Error(`muteUser: no row returned for ${userId.slice(0, 8)}`);
    this.logger.log(`[MUTE] user=${userId.slice(0, 8)} muted by=${mutedBy.slice(0, 8)}`);
    return this.muteRepo.create(record);
  }

  /**
   * Unmutes a user, re-enabling posting and reactions: ONE column update keyed by the user, never a
   * save of a record read first - a record gone since answers 404 and nothing is written.
   */
  async unmuteUser(userId: string): Promise<UserModeration> {
    const cleared = { isMuted: false, mutedBy: null, mutedAt: null, mutedReason: null };
    const updated = await this.muteRepo.update({ userId }, cleared);
    if (updated.affected !== 1) {
      this.logger.warn(
        `[MUTE] unmute refused: no moderation record user=${userId.slice(0, 8)} affected=${updated.affected ?? 'unknown'}`
      );
      throw new NotFoundException('Moderation record not found');
    }
    this.logger.log(`[MUTE] user=${userId.slice(0, 8)} unmuted`);
    const record = await this.muteRepo.findOne({ where: { userId } });
    if (!record) throw new NotFoundException('Moderation record not found');
    return record;
  }

  /** Returns whether a user is currently muted (false if no record exists). */
  async isUserMuted(userId: string): Promise<boolean> {
    const record = await this.muteRepo.findOne({ where: { userId } });
    return record?.isMuted ?? false;
  }

  /** Mute status for the authenticated user, including the reason shown in the app. */
  async getUserMuteStatus(userId: string): Promise<{
    isMuted: boolean;
    mutedReason: string | null;
    mutedAt: string | null;
  }> {
    const record = await this.muteRepo.findOne({ where: { userId } });
    if (!record?.isMuted) {
      return { isMuted: false, mutedReason: null, mutedAt: null };
    }
    return {
      isMuted: true,
      mutedReason: record.mutedReason ?? null,
      mutedAt: record.mutedAt ? record.mutedAt.toISOString() : null,
    };
  }

  /** The real account that wrote a stored comment, or `null` when it is gone or has none (erased). */
  private async commentWriterId(commentId: string): Promise<string | null> {
    const rows: { user_id: string | null }[] = await this.reportRepo.manager.query(
      `SELECT elem->>'userId' AS user_id
         FROM posts p, jsonb_array_elements(COALESCE(p.comments, '[]'::jsonb)) elem
        WHERE elem->>'id' = $1
        LIMIT 1`,
      [commentId]
    );
    return rows[0]?.user_id || null;
  }

  /** Locates the parent post of a comment by scanning JSON comment arrays. */
  async findPostIdForComment(commentId: string): Promise<string | null> {
    const rows: { id: string }[] = await this.reportRepo.manager.query(
      `SELECT id FROM posts
       WHERE EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(comments, '[]'::jsonb)) elem
         WHERE elem->>'id' = $1
       )
       LIMIT 1`,
      [commentId]
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Removes a comment (and its replies) from any post that contains it.
   * Used by moderators when acting on comment reports.
   */
  async deleteCommentById(commentId: string): Promise<{ postId: string }> {
    const postId = await this.findPostIdForComment(commentId);
    if (!postId) throw new NotFoundException('Comment not found');

    await this.reportRepo.manager.query(
      `UPDATE posts SET comments = COALESCE(
         (
           SELECT jsonb_agg(elem)
           FROM jsonb_array_elements(COALESCE(comments, '[]'::jsonb)) elem
           WHERE elem->>'id' != $2 AND COALESCE(elem->>'parentId', '') != $2
         ),
         '[]'::jsonb
       )
       WHERE id = $1`,
      [postId, commentId]
    );
    return { postId };
  }

  /** Returns all currently muted users. */
  async listMutedUsers(): Promise<UserModeration[]> {
    return this.muteRepo.find({ where: { isMuted: true }, order: { mutedAt: 'DESC' } });
  }
}
