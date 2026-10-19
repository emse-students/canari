import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { blockedUserIdsFor } from '../common/blocked-user-ids';
import { ModerationService } from '../moderation/moderation.service';
import {
  LIVE_CHAT_BACKLOG,
  LIVE_CHAT_MESSAGES_PER_WINDOW,
  LIVE_CHAT_PAGE,
  LIVE_CHAT_RATE_WINDOW_MS,
  LIVE_CHAT_SEALED_MAX_BYTES,
  LIVE_CHAT_SEALED_MIN_BYTES,
  LIVE_REACTION_BURSTS_PER_WINDOW,
  LIVE_REACTION_KINDS,
  LIVE_REACTION_PAGE,
  LIVE_REACTION_TAPS_PER_WINDOW,
  LIVE_REACTION_WINDOW_MS,
  type LiveEndReason,
  type LiveReactionKind,
} from './live.constants';
import { LivesService, liveEnded } from './lives.service';

/** A message as the poll serves it: ciphertext under the live key, base64 (C12). */
export interface LiveChatMessageView {
  id: string;
  seq: number;
  authorId: string;
  clientId: string;
  sealed: string;
  createdAt: Date;
}

/** A hidden message: the line a viewer drew for `id` is removed (C14). Nothing else is kept. */
export interface LiveChatTombstone {
  id: string;
  seq: number;
  hidden: true;
}

/** The sums of the reaction bursts of one 2 s window of the live (C7). */
export interface LiveReactionWindow {
  window: number;
  counts: Partial<Record<LiveReactionKind, number>>;
}

/** The `chat` block of a manifest poll (C3). Each cursor is passed back as is at the next poll. */
export interface LiveChatBlock {
  messages: (LiveChatMessageView | LiveChatTombstone)[];
  messagesCursor: number;
  reactions: LiveReactionWindow[];
  reactionsCursor: number;
}

/** Where the viewer's previous poll stopped; absent on its first poll (C13). */
export interface LiveChatCursors {
  messagesAfter?: number;
  reactionsAfter?: number;
}

/** A message's input once checked: the idempotence key and the sealed bytes. */
export interface ChatMessageInput {
  clientId: string;
  sealed: Buffer;
}

/** A reaction burst's input once checked. */
export interface ReactionBurstInput {
  burstId: string;
  counts: Partial<Record<LiveReactionKind, number>>;
  taps: number;
}

/** A uuid, any case; stored lower case. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strict base64: the alphabet, padding only at the end, a whole number of quads. */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The longest base64 spelling of {@link LIVE_CHAT_SEALED_MAX_BYTES}, checked before decoding. */
const SEALED_MAX_BASE64 = Math.ceil(LIVE_CHAT_SEALED_MAX_BYTES / 3) * 4;

const short = (id: string) => id.slice(0, 8);

/**
 * Checks a message body, `{ clientId, sealed }`: a uuid and the base64 of 29..928 bytes.
 * The server cannot read the text (C11, C12), so the sealed SIZE is all it can bound.
 * Throws 400 `LIVE_MESSAGE_INVALID` with the field at fault.
 */
export function parseChatMessageInput(body: {
  clientId?: unknown;
  sealed?: unknown;
}): ChatMessageInput {
  const { clientId, sealed } = body;
  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) {
    throw new BadRequestException({ code: 'LIVE_MESSAGE_INVALID', field: 'clientId' });
  }
  if (
    typeof sealed !== 'string' ||
    sealed.length > SEALED_MAX_BASE64 ||
    sealed.length % 4 !== 0 ||
    !BASE64_RE.test(sealed)
  ) {
    throw new BadRequestException({ code: 'LIVE_MESSAGE_INVALID', field: 'sealed' });
  }
  const bytes = Buffer.from(sealed, 'base64');
  if (bytes.length < LIVE_CHAT_SEALED_MIN_BYTES || bytes.length > LIVE_CHAT_SEALED_MAX_BYTES) {
    throw new BadRequestException({ code: 'LIVE_MESSAGE_INVALID', field: 'sealed' });
  }
  return { clientId: clientId.toLowerCase(), sealed: bytes };
}

/**
 * Checks a reaction burst, `{ burstId, counts }`: a uuid, and counts keyed by
 * {@link LIVE_REACTION_KINDS} only, each a whole 1..10, at most {@link LIVE_REACTION_TAPS_PER_WINDOW}
 * in all, at least one. Throws 400 `LIVE_REACTION_INVALID`.
 */
export function parseReactionBurstInput(body: {
  burstId?: unknown;
  counts?: unknown;
}): ReactionBurstInput {
  const { burstId, counts } = body;
  if (typeof burstId !== 'string' || !UUID_RE.test(burstId)) {
    throw new BadRequestException({ code: 'LIVE_REACTION_INVALID', field: 'burstId' });
  }
  if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) {
    throw new BadRequestException({ code: 'LIVE_REACTION_INVALID', field: 'counts' });
  }
  const kinds: readonly string[] = LIVE_REACTION_KINDS;
  const out: Partial<Record<LiveReactionKind, number>> = {};
  let taps = 0;
  for (const [kind, n] of Object.entries(counts as Record<string, unknown>)) {
    if (
      !kinds.includes(kind) ||
      typeof n !== 'number' ||
      !Number.isInteger(n) ||
      n < 1 ||
      n > LIVE_REACTION_TAPS_PER_WINDOW
    ) {
      throw new BadRequestException({ code: 'LIVE_REACTION_INVALID', field: 'counts' });
    }
    out[kind as LiveReactionKind] = n;
    taps += n;
  }
  if (taps === 0 || taps > LIVE_REACTION_TAPS_PER_WINDOW) {
    throw new BadRequestException({ code: 'LIVE_REACTION_INVALID', field: 'counts' });
  }
  return { burstId: burstId.toLowerCase(), counts: out, taps };
}

/**
 * Sums bursts per window (C7), leaving out the viewer's own (its client drew them already) and the
 * accounts blocked either way (C10). Pure: the poll's one aggregation, tested on its own.
 */
export function sumReactionBursts(
  bursts: { userId: string; window: number; counts: Record<string, number> }[],
  viewerId: string,
  blocked: ReadonlySet<string>
): LiveReactionWindow[] {
  const kinds: readonly string[] = LIVE_REACTION_KINDS;
  const byWindow = new Map<number, Partial<Record<LiveReactionKind, number>>>();
  for (const b of bursts) {
    if (b.userId === viewerId || blocked.has(b.userId)) continue;
    const sums = byWindow.get(b.window) ?? {};
    for (const [kind, n] of Object.entries(b.counts)) {
      // The column was validated at write time; a key that is not a kind would be a defect upstream.
      if (!kinds.includes(kind)) continue;
      const k = kind as LiveReactionKind;
      sums[k] = (sums[k] ?? 0) + n;
    }
    byWindow.set(b.window, sums);
  }
  return [...byWindow.entries()]
    .sort(([a], [b]) => a - b)
    .map(([window, counts]) => ({ window, counts }));
}

/** The live row as a chat write reads it, under its lock. */
interface LockedLive {
  broadcasterId: string;
  endedAt: Date | null;
  endReason: LiveEndReason | null;
}

/** A message row as read back. */
interface MessageRow {
  id: string;
  seq: number;
  authorId: string;
  clientId: string;
  sealed: Buffer | null;
  createdAt: Date;
}

/**
 * The chat and the floating reactions of a live (WP-L6; decisions C1-C16 in
 * docs/wiki/services/lives.md "Live chat and floating reactions").
 *
 * WHO MAY WRITE is decided by the caller first - `LivesService.assertMayWatch`, the one rule of who
 * may watch - and the two parts of it a concurrent write can change (the END and a REMOVAL) are
 * asked AGAIN here, under the live's row lock, which the end and the removal take too. So a message
 * never overtakes an end or a removal that committed first.
 *
 * EVERY WRITE TAKES THE LIVE'S ROW LOCK FIRST and allocates its sequence number from the row
 * (`chatSeq`, `reactionSeq`) in the same transaction: numbers commit in their own order, and a
 * poller's cursor can never skip a row that was still uncommitted when it read (C4). No call to
 * another service is made inside the transaction.
 */
@Injectable()
export class LiveChatService {
  private readonly logger = new Logger(LiveChatService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly moderation: ModerationService,
    private readonly lives: LivesService
  ) {}

  /**
   * Posts a message (C5, C6, C9). A repeat of the same `clientId` with the same bytes answers the
   * stored message; other bytes are 409 `LIVE_MESSAGE_CONFLICT`; a hidden one answers its tombstone.
   */
  async post(
    authorId: string,
    liveId: string,
    body: { clientId?: unknown; sealed?: unknown }
  ): Promise<LiveChatMessageView | LiveChatTombstone> {
    const input = parseChatMessageInput(body);
    this.logger.debug(`[LIVE_CHAT] message ${input.clientId} on ${liveId} by ${short(authorId)}`);
    await this.assertNotMuted(authorId, liveId);
    return this.db.transaction(async (tx) => {
      await this.lockOpen(tx, liveId, authorId);
      const prior: MessageRow[] = await tx.query(
        `SELECT id, seq, "authorId", "clientId", sealed, "createdAt" FROM live_chat_messages
          WHERE "liveId" = $1 AND "authorId" = $2 AND "clientId" = $3`,
        [liveId, authorId, input.clientId]
      );
      if (prior[0]) {
        const row = prior[0];
        if (row.sealed === null) {
          this.logger.debug(`[LIVE_CHAT] message ${input.clientId} repeated, already hidden`);
          return { id: row.id, seq: row.seq, hidden: true as const };
        }
        if (Buffer.compare(row.sealed, input.sealed) === 0) {
          this.logger.debug(`[LIVE_CHAT] message ${input.clientId} repeated, same bytes`);
          return toMessageView(row);
        }
        this.logger.warn(
          `[LIVE_CHAT] message ${input.clientId} on ${liveId} repeated with OTHER bytes`
        );
        throw new ConflictException({ code: 'LIVE_MESSAGE_CONFLICT' });
      }
      const [rate]: { recent: number; retryAfterMs: number | null }[] = await tx.query(
        `SELECT count(*)::int AS recent,
                ceil(extract(epoch FROM min("createdAt") + $3 * interval '1 millisecond' - now()) * 1000)::int
                  AS "retryAfterMs"
           FROM live_chat_messages
          WHERE "liveId" = $1 AND "authorId" = $2
            AND "createdAt" + $3 * interval '1 millisecond' > now()`,
        [liveId, authorId, LIVE_CHAT_RATE_WINDOW_MS]
      );
      if (rate.recent >= LIVE_CHAT_MESSAGES_PER_WINDOW) {
        this.logger.debug(
          `[LIVE_CHAT] message refused on ${liveId}: ${short(authorId)} posted ${rate.recent} in the window`
        );
        throw new HttpException(
          {
            code: 'LIVE_MESSAGE_TOO_FAST',
            limit: LIVE_CHAT_MESSAGES_PER_WINDOW,
            retryAfterMs: Math.max(0, rate.retryAfterMs ?? 0),
          },
          HttpStatus.TOO_MANY_REQUESTS
        );
      }
      const seq = await this.nextSeq(tx, liveId, 'chatSeq');
      const rows: MessageRow[] = await tx.query(
        `INSERT INTO live_chat_messages ("liveId", seq, "authorId", "clientId", sealed)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, seq, "authorId", "clientId", sealed, "createdAt"`,
        [liveId, seq, authorId, input.clientId, input.sealed]
      );
      this.logger.debug(`[LIVE_CHAT] message ${rows[0].id} on ${liveId} is seq ${seq}`);
      return toMessageView(rows[0]);
    });
  }

  /**
   * Records a reaction burst (C6, C7). The taps are summed into the live's windows at read time; a
   * repeat of the same `burstId` with the same counts answers the first time's seq.
   */
  async react(
    userId: string,
    liveId: string,
    body: { burstId?: unknown; counts?: unknown }
  ): Promise<{ burstId: string; seq: number }> {
    const input = parseReactionBurstInput(body);
    await this.assertNotMuted(userId, liveId);
    return this.db.transaction(async (tx) => {
      await this.lockOpen(tx, liveId, userId);
      const prior: { seq: number; counts: Record<string, number> }[] = await tx.query(
        `SELECT seq, counts FROM live_reaction_bursts
          WHERE "liveId" = $1 AND "userId" = $2 AND "burstId" = $3`,
        [liveId, userId, input.burstId]
      );
      if (prior[0]) {
        if (sameCounts(prior[0].counts, input.counts)) {
          this.logger.debug(`[LIVE_REACT] burst ${input.burstId} repeated`);
          return { burstId: input.burstId, seq: prior[0].seq };
        }
        this.logger.warn(
          `[LIVE_REACT] burst ${input.burstId} on ${liveId} repeated with OTHER counts`
        );
        throw new ConflictException({ code: 'LIVE_REACTION_CONFLICT' });
      }
      const [rate]: { bursts: number; taps: number; retryAfterMs: number | null }[] =
        await tx.query(
          `SELECT count(*)::int AS bursts, COALESCE(sum(taps), 0)::int AS taps,
                ceil(extract(epoch FROM min("createdAt") + $3 * interval '1 millisecond' - now()) * 1000)::int
                  AS "retryAfterMs"
           FROM live_reaction_bursts
          WHERE "liveId" = $1 AND "userId" = $2
            AND "createdAt" + $3 * interval '1 millisecond' > now()`,
          [liveId, userId, LIVE_REACTION_WINDOW_MS]
        );
      if (
        rate.bursts >= LIVE_REACTION_BURSTS_PER_WINDOW ||
        rate.taps + input.taps > LIVE_REACTION_TAPS_PER_WINDOW
      ) {
        this.logger.debug(
          `[LIVE_REACT] burst refused on ${liveId}: ${short(userId)} at ${rate.bursts} bursts, ${rate.taps} taps`
        );
        throw new HttpException(
          {
            code: 'LIVE_REACTION_TOO_FAST',
            // When the OLDEST burst of the window leaves it - computed as the message 429 is, from
            // the rows by the database clock, never a constant.
            retryAfterMs: Math.max(0, rate.retryAfterMs ?? 0),
          },
          HttpStatus.TOO_MANY_REQUESTS
        );
      }
      const [next]: [{ seq: number; window: number }[], number] = await tx.query(
        `UPDATE lives SET "reactionSeq" = "reactionSeq" + 1 WHERE id = $1
         RETURNING "reactionSeq" AS seq,
                   floor(extract(epoch FROM now() - "startedAt") * 1000 / $2)::int AS "window"`,
        [liveId, LIVE_REACTION_WINDOW_MS]
      );
      const { seq, window } = next[0];
      await tx.query(
        `INSERT INTO live_reaction_bursts ("liveId", seq, "userId", "burstId", "window", counts, taps)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          liveId,
          seq,
          userId,
          input.burstId,
          Math.max(0, window),
          JSON.stringify(input.counts),
          input.taps,
        ]
      );
      this.logger.debug(
        `[LIVE_REACT] burst ${input.burstId} on ${liveId}: ${input.taps} taps, seq ${seq}`
      );
      return { burstId: input.burstId, seq };
    });
  }

  /**
   * Hides a message (C14), by the live's broadcaster or by staff: the ciphertext is ERASED and the
   * row takes a new sequence number, so every viewer's next poll carries its tombstone. Idempotent.
   * A caller who is neither gets 404 `LIVE_NOT_FOUND`, the answer to a live that does not exist.
   */
  async hide(
    callerId: string,
    isStaff: boolean,
    liveId: string,
    messageId: string
  ): Promise<{ liveId: string; messageId: string; hidden: true }> {
    const id = messageId.toLowerCase();
    const by = await this.db.transaction(async (tx) => {
      const live = await this.lock(tx, liveId);
      if (!live) {
        // A live STAFF CUT and then purged answers its 410 `cut` (WP-L8's record), to the
        // broadcaster and to staff - the callers who may moderate it; anyone else gets the 404.
        const cut = await this.lives.cutOf(tx, liveId);
        if (cut && (cut.broadcasterId === callerId || isStaff)) {
          this.logger.debug(`[LIVE_CHAT] hide on ${liveId}: the live was cut and purged`);
          throw liveEnded(cut.liveEndedAt, cut.liveEndReason);
        }
      }
      const own = live?.broadcasterId === callerId;
      if (!live || !(own || isStaff)) {
        this.logger.debug(
          `[LIVE_CHAT] hide refused: ${short(callerId)} may not moderate ${liveId}`
        );
        throw new NotFoundException({ code: 'LIVE_NOT_FOUND' });
      }
      if (live.endedAt) throw liveEnded(live.endedAt, live.endReason);
      const rows: { hidden: boolean }[] = await tx.query(
        `SELECT "hiddenAt" IS NOT NULL AS hidden FROM live_chat_messages
          WHERE id = $1 AND "liveId" = $2`,
        [id, liveId]
      );
      if (!rows[0]) throw new NotFoundException({ code: 'LIVE_MESSAGE_NOT_FOUND' });
      if (rows[0].hidden) return null;
      const seq = await this.nextSeq(tx, liveId, 'chatSeq');
      await tx.query(
        `UPDATE live_chat_messages SET sealed = NULL, "hiddenAt" = now(), seq = $3
          WHERE id = $1 AND "liveId" = $2`,
        [id, liveId, seq]
      );
      return own ? 'broadcaster' : 'staff';
    });
    if (by) this.logger.log(`[LIVE_CHAT] message ${id} on ${liveId} hidden by the ${by}`);
    else this.logger.debug(`[LIVE_CHAT] message ${id} on ${liveId} already hidden`);
    return { liveId, messageId: id, hidden: true };
  }

  /**
   * The `chat` block of a manifest poll (C3, C7, C10, C13), for a viewer the caller has already let
   * watch. Messages after the cursor (at most {@link LIVE_CHAT_PAGE}), or the newest
   * {@link LIVE_CHAT_BACKLOG} without one; reaction sums after the cursor, or only the cursor
   * without one. Each cursor is the highest seq READ, filtered rows included, so a filtered row is
   * never read twice and - the numbers committing in their own order (C4) - none is ever skipped.
   */
  async read(viewerId: string, liveId: string, cursors: LiveChatCursors): Promise<LiveChatBlock> {
    const blocked = new Set(await blockedUserIdsFor(this.db.manager, viewerId));
    const first = cursors.messagesAfter === undefined;
    // A late joiner's cursor is the live's highest seq, read BEFORE its rows: the rows' snapshot is
    // then at least as new (numbers commit in order, C4), so nothing between is skipped; a row read
    // twice is deduped by the client on `author:clientId`.
    const top = first
      ? (
          (await this.db.query(
            `SELECT COALESCE(max(seq), 0)::int AS top FROM live_chat_messages WHERE "liveId" = $1`,
            [liveId]
          )) as { top: number }[]
        )[0].top
      : 0;
    const rows: MessageRow[] = first
      ? (
          (await this.db.query(
            // The newest {@link LIVE_CHAT_BACKLOG} the viewer can SEE: hidden rows and blocked
            // authors are left out BEFORE the limit, so hides never empty a joiner's backlog.
            `SELECT id, seq, "authorId", "clientId", sealed, "createdAt" FROM live_chat_messages
              WHERE "liveId" = $1 AND sealed IS NOT NULL AND NOT ("authorId" = ANY($3::varchar[]))
              ORDER BY seq DESC LIMIT $2`,
            [liveId, LIVE_CHAT_BACKLOG, [...blocked]]
          )) as MessageRow[]
        ).reverse()
      : await this.db.query(
          `SELECT id, seq, "authorId", "clientId", sealed, "createdAt" FROM live_chat_messages
            WHERE "liveId" = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
          [liveId, cursors.messagesAfter, LIVE_CHAT_PAGE]
        );
    const messages: (LiveChatMessageView | LiveChatTombstone)[] = [];
    for (const row of rows) {
      if (row.sealed === null) {
        // A late joiner drew nothing to remove; a viewer with a cursor may have drawn it.
        if (!first) messages.push({ id: row.id, seq: row.seq, hidden: true });
      } else if (!blocked.has(row.authorId)) {
        messages.push(toMessageView(row));
      }
    }
    const messagesCursor = first
      ? Math.max(top, rows.length > 0 ? rows[rows.length - 1].seq : 0)
      : rows.length > 0
        ? rows[rows.length - 1].seq
        : (cursors.messagesAfter ?? 0);

    if (cursors.reactionsAfter === undefined) {
      const [{ top }]: { top: number }[] = await this.db.query(
        `SELECT COALESCE(max(seq), 0)::int AS top FROM live_reaction_bursts WHERE "liveId" = $1`,
        [liveId]
      );
      return { messages, messagesCursor, reactions: [], reactionsCursor: top };
    }
    const bursts: {
      seq: number;
      userId: string;
      window: number;
      counts: Record<string, number>;
    }[] = await this.db.query(
      `SELECT seq, "userId", "window", counts FROM live_reaction_bursts
          WHERE "liveId" = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [liveId, cursors.reactionsAfter, LIVE_REACTION_PAGE]
    );
    return {
      messages,
      messagesCursor,
      reactions: sumReactionBursts(bursts, viewerId, blocked),
      reactionsCursor: bursts.length > 0 ? bursts[bursts.length - 1].seq : cursors.reactionsAfter,
    };
  }

  /** 403 `LIVE_MUTED` for an account under the moderation mute (C9) - the code a muted start gets. */
  private async assertNotMuted(userId: string, liveId: string): Promise<void> {
    if (await this.moderation.isUserMuted(userId)) {
      this.logger.debug(`[LIVE_CHAT] refused on ${liveId}: ${short(userId)} is muted`);
      throw new ForbiddenException({ code: 'LIVE_MUTED' });
    }
  }

  /** Takes the live's row lock; `null` when there is no such live. */
  private async lock(tx: EntityManager, liveId: string): Promise<LockedLive | null> {
    const rows: LockedLive[] = await tx.query(
      `SELECT "broadcasterId", "endedAt", "endReason" FROM lives WHERE id = $1 FOR UPDATE`,
      [liveId]
    );
    return rows[0] ?? null;
  }

  /**
   * Takes the live's row lock, then asks AGAIN the two parts of the watch rule a concurrent write
   * changes: the end (410) and a removal of this account (403 `LIVE_VIEWER_REMOVED`, the code
   * `assertMayWatch` answers). The removal is read in its OWN statement, after the lock, so a removal
   * that committed while this one waited is seen (its transaction held the same lock).
   */
  private async lockOpen(tx: EntityManager, liveId: string, userId: string): Promise<void> {
    const live = await this.lock(tx, liveId);
    if (!live) {
      // Purged since the watch rule let this account in: a CUT live answers its 410 `cut`, as
      // every live route does (WP-L8's lookup), anything else the 404.
      await this.lives.refuseIfCut(tx, liveId, userId, 'viewer');
      throw new NotFoundException({ code: 'LIVE_NOT_FOUND' });
    }
    if (live.endedAt) throw liveEnded(live.endedAt, live.endReason);
    if (live.broadcasterId === userId) return;
    const removed: unknown[] = await tx.query(
      `SELECT 1 FROM live_removed_viewers WHERE "liveId" = $1 AND "viewerId" = $2`,
      [liveId, userId]
    );
    if (removed.length > 0) {
      this.logger.debug(`[LIVE_CHAT] refused on ${liveId}: ${short(userId)} was removed`);
      throw new ForbiddenException({ code: 'LIVE_VIEWER_REMOVED' });
    }
  }

  /** The live's next sequence number of one kind, under the lock the caller already holds (C4). */
  private async nextSeq(
    tx: EntityManager,
    liveId: string,
    column: 'chatSeq' | 'reactionSeq'
  ): Promise<number> {
    const [rows]: [{ seq: number }[], number] = await tx.query(
      `UPDATE lives SET "${column}" = "${column}" + 1 WHERE id = $1 RETURNING "${column}" AS seq`,
      [liveId]
    );
    return rows[0].seq;
  }
}

function toMessageView(row: MessageRow): LiveChatMessageView {
  return {
    id: row.id,
    seq: row.seq,
    authorId: row.authorId,
    clientId: row.clientId,
    sealed: (row.sealed as Buffer).toString('base64'),
    createdAt: row.createdAt,
  };
}

/** Whether two count maps carry the same taps (a jsonb object comes back with its own key order). */
function sameCounts(a: Record<string, number>, b: Record<string, number | undefined>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}
