import { BadRequestException, Logger } from '@nestjs/common';

/**
 * The most DISTINCT user ids one presence-audience question may carry. The gateway refuses a
 * larger question before asking (`MAX_PRESENCE_USERS` in `apps/chat-gateway/src/presence.rs`), so
 * reaching this bound here is a caller bug, never a user's list.
 *
 * ONE NUMBER IN THREE PLACES, PINNED BY ONE FILE: `libs/contracts/presence-audience.cases.json`
 * carries it as `maxUserIds`, and the gateway's test and this module's spec (in both services)
 * assert their own constant against it.
 */
export const MAX_PRESENCE_AUDIENCE_USERS = 1000;

const logger = new Logger('PresenceAudience');

/**
 * Validates the body of a presence-audience question - chat-delivery's
 * `POST /internal/presence/shared-conversations` and social-service's
 * `POST /internal/presence/shared-communities` take the same one: a non-empty `viewerId` and an
 * array of string `userIds` (blank entries dropped, duplicates collapsed, order kept). Every id is
 * lowercased - the spelling both services' auth guards store ids under - so the answer is
 * lowercase too. The viewer is NOT removed: what to do with them is each route's decision.
 *
 * BYTE-IDENTICAL IN BOTH SERVICES (`.github/scripts/lib/declared-duplicates.mjs`), and its answers
 * are pinned by `libs/contracts/presence-audience.cases.json`.
 *
 * Refuses with a 400 rather than answering an empty audience: a malformed question answered
 * "nobody" would read, at the gateway, as "every one of them is invisible to you".
 */
export function parsePresenceAudienceBody(body: { viewerId?: unknown; userIds?: unknown }): {
  viewerId: string;
  userIds: string[];
} {
  const viewerId = typeof body?.viewerId === 'string' ? body.viewerId.trim().toLowerCase() : '';
  const raw = body?.userIds;
  if (!viewerId || !Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) {
    logger.warn('[PRESENCE_AUDIENCE] refused: malformed body');
    throw new BadRequestException('viewerId and an array of string userIds are required');
  }
  const userIds = [
    ...new Set((raw as string[]).map((id) => id.trim().toLowerCase()).filter(Boolean)),
  ];
  if (userIds.length > MAX_PRESENCE_AUDIENCE_USERS) {
    logger.warn(`[PRESENCE_AUDIENCE] refused: ${userIds.length} userIds`);
    throw new BadRequestException(`at most ${MAX_PRESENCE_AUDIENCE_USERS} userIds`);
  }
  return { viewerId, userIds };
}
