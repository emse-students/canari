import { BadRequestException } from '@nestjs/common';

/**
 * The most user ids one presence-audience question may carry. The gateway refuses a larger
 * question before asking (`MAX_PRESENCE_USERS` in `apps/chat-gateway/src/presence.rs`), so reaching
 * this bound here is a caller bug, never a user's list.
 */
export const MAX_PRESENCE_AUDIENCE_USERS = 1000;

/**
 * Validates the body of `POST /internal/presence/shared-conversations`: a non-empty `viewerId` and
 * an array of string `userIds` (blank entries dropped, duplicates collapsed, order kept). Every id
 * is lowercased - the spelling `HeaderAuthGuard` stores ids under - so the answer is lowercase too.
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
    throw new BadRequestException('viewerId and an array of string userIds are required');
  }
  const userIds = [
    ...new Set((raw as string[]).map((id) => id.trim().toLowerCase()).filter(Boolean)),
  ];
  if (userIds.length > MAX_PRESENCE_AUDIENCE_USERS) {
    throw new BadRequestException(`at most ${MAX_PRESENCE_AUDIENCE_USERS} userIds`);
  }
  return { viewerId, userIds };
}
