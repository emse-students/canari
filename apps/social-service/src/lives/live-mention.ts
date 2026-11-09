import { BadRequestException } from '@nestjs/common';
import { liveVisibleToUserSql } from '../spaces/reader-spaces';
import { LIVE_CHAT_MENTIONS_DECLARED_MAX, LIVE_CHAT_MENTIONS_MAX } from './live.constants';

/** A user id as a mention carries it: 64 lower-case hex characters (the client's `@[id]` token). */
const MENTION_ID_RE = /^[0-9a-f]{64}$/;

/**
 * Checks the `mentions` a chat line declares (owner, 2026-11-09): absent is none; otherwise an array
 * of at most {@link LIVE_CHAT_MENTIONS_DECLARED_MAX} 64-hex user ids. Returns them lower-cased,
 * deduplicated, in the order declared, WITHOUT the author (mentioning oneself tells nobody) and cut
 * to `max` ({@link LIVE_CHAT_MENTIONS_MAX} by default). Throws 400 `LIVE_MESSAGE_INVALID`, field
 * `mentions`.
 *
 * The ids are CANDIDATES only: whether each may be told is `liveMentionRecipientsSql`'s, never the
 * client's. The text is sealed, so the server cannot check that a declared id is in it - which is why
 * the audience, the block and the per-person window are asked of the database instead.
 */
export function parseChatMentions(
  raw: unknown,
  authorId: string,
  max: number = LIVE_CHAT_MENTIONS_MAX
): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > LIVE_CHAT_MENTIONS_DECLARED_MAX) {
    throw new BadRequestException({ code: 'LIVE_MESSAGE_INVALID', field: 'mentions' });
  }
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !MENTION_ID_RE.test(item.toLowerCase())) {
      throw new BadRequestException({ code: 'LIVE_MESSAGE_INVALID', field: 'mentions' });
    }
    const id = item.toLowerCase();
    if (id !== authorId.toLowerCase() && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, max);
}

/**
 * WHO OF THE CANDIDATES MAY BE MENTIONED in a live's chat: the ones who can SEE the live - the plain
 * predicate of a post by the same broadcaster (`liveVisibleToUserSql`, the audience of the
 * announcement, so a named reader through a read grant is not in it) - and who are neither removed
 * from the live, nor blocked either way with the author, nor with the broadcaster (the broadcaster
 * themselves may be mentioned).
 *
 * With `withWindow`, a person this author already mentioned on this live inside the window is left
 * out too: one notice, not one per line. Without it the same rule says who the composer may SUGGEST
 * (`LiveChatService.mentionAudience`) - ONE predicate for both, so a suggestion is never someone a
 * mention would then skip for want of audience.
 *
 * Parameters: `$1` the author, `$2` the live, `$3` the candidate ids (text[]), and with `withWindow`
 * `$4` the window in ms.
 */
export function liveMentionRecipientsSql(withWindow = true): string {
  const window = withWindow
    ? `
      AND NOT EXISTS (SELECT 1 FROM live_chat_messages prior
                       WHERE prior."liveId" = $2 AND prior."authorId" = $1
                         AND prior."mentionedUserIds" @> ARRAY[cand.id]
                         AND prior."createdAt" + $4 * interval '1 millisecond' > now())`
    : '';
  return `SELECT DISTINCT cand.id FROM unnest($3::text[]) AS cand(id)
    JOIN users cand_user ON cand_user.id = cand.id
    JOIN lives m_live ON m_live.id = $2
    WHERE cand.id <> $1
      AND ${liveVisibleToUserSql('m_live', 'cand_user')}
      AND NOT EXISTS (SELECT 1 FROM user_blocks b
                       WHERE (b."blockerId" = $1 AND b."blockedId" = cand.id)
                          OR (b."blockerId" = cand.id AND b."blockedId" = $1))
      AND (cand.id = m_live."broadcasterId" OR NOT EXISTS (SELECT 1 FROM user_blocks b2
                       WHERE (b2."blockerId" = m_live."broadcasterId" AND b2."blockedId" = cand.id)
                          OR (b2."blockerId" = cand.id AND b2."blockedId" = m_live."broadcasterId")))
      AND NOT EXISTS (SELECT 1 FROM live_removed_viewers r
                       WHERE r."liveId" = $2 AND r."viewerId" = cand.id)${window}`;
}
