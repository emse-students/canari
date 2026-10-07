/**
 * REPUBLICATION (D38), the client's pure half: the card's "Republie par" line and the associations
 * each dialog offers. What may actually be written is the server's to decide - these lists only
 * decide what is OFFERED, and every choice is checked again on the way in.
 */
import { AssociationPermissionFlag, type Association } from '$lib/associations/api';
import type { PostEntity } from './api';

/** How many republishers the card names before it counts the rest ("+N"). */
export const REPUBLISHED_BY_SHOWN = 3;

/**
 * The "Republie par X, Y" line: the first `REPUBLISHED_BY_SHOWN` names, and how many more there
 * are. `null` when nobody republished the post, so the card draws no line at all.
 */
export function republishedByLine(
  republishedBy: PostEntity['republishedBy']
): { names: string[]; extra: number } | null {
  if (!republishedBy || republishedBy.length === 0) return null;
  return {
    names: republishedBy.slice(0, REPUBLISHED_BY_SHOWN).map((a) => a.name),
    extra: Math.max(0, republishedBy.length - REPUBLISHED_BY_SHOWN),
  };
}

/**
 * Only associations and institutions republish - never a promo list (the server's `REPUBLISHING_ASSOCIATION_TYPES`).
 * Archived ones are left out: they no longer speak.
 */
function mayRepublishAtAll(a: Association): boolean {
  return (a.type === 'association' || a.type === 'institution') && !a.archived;
}

/** Neither the post's own association nor one that already republished it. */
function notAlreadyCarrying(post: PostEntity): (a: Association) => boolean {
  const taken = new Set([post.associationId, ...(post.republishedBy ?? []).map((r) => r.id)]);
  return (a) => !taken.has(a.id);
}

/**
 * The associations the reader may republish `post` AS, at once.
 *
 * `mine` is the reader's memberships (`listMyAssociations`, which carries `permissions`); the
 * reader must hold `POST_AS_ASSO` there - the very flag the server checks. A global admin is handed
 * the whole directory instead, the way the composer offers it (`listPostAsAssociations`).
 */
export function republishCandidates(
  mine: readonly Association[],
  post: PostEntity,
  isGlobalAdmin: boolean
): Association[] {
  const keep = notAlreadyCarrying(post);
  return mine.filter(
    (a) =>
      mayRepublishAtAll(a) &&
      keep(a) &&
      (isGlobalAdmin || ((a.permissions ?? 0) & AssociationPermissionFlag.POST_AS_ASSO) !== 0)
  );
}

/** The associations `post` may be PROPOSED to: any association that does not carry it yet. */
export function proposalCandidates(
  directory: readonly Association[],
  post: PostEntity
): Association[] {
  const keep = notAlreadyCarrying(post);
  return directory.filter((a) => mayRepublishAtAll(a) && keep(a));
}
