/**
 * REPUBLICATION (D38), the client's pure half: the card's "Republie par" line and the associations
 * each dialog offers. What may actually be written is the server's to decide - these lists only
 * decide what is OFFERED, and every choice is checked again on the way in.
 */
import { AssociationPermissionFlag, type Association } from '$lib/associations/api';
import type { PostEntity } from './api';
import { m } from '$lib/paraglide/messages';

/**
 * How many republishers the card names before it counts the rest ("+N"). ONE since the line shares
 * the time's row (user, 2026-10-24): "2 h . Republie par BDE +2" stays short on a phone, and the
 * names are what truncates first.
 */
export const REPUBLISHED_BY_SHOWN = 1;

/**
 * The "Republie par X +N" line: the first `REPUBLISHED_BY_SHOWN` names, and how many more there
 * are. `null` when nobody republished the post, so the card draws no line at all.
 */
export function republishedByLine(
  republishedBy: PostEntity['republishedBy'],
  repostedBy: PostEntity['repostedBy'] = []
): { names: string[]; extra: number } | null {
  // WP-F6: the people the reader follows who reposted it come after the associations - one line.
  const all = [...(republishedBy ?? []), ...(repostedBy ?? [])].map((r) => r.name).filter(Boolean);
  if (all.length === 0) return null;
  return {
    names: all.slice(0, REPUBLISHED_BY_SHOWN),
    extra: Math.max(0, all.length - REPUBLISHED_BY_SHOWN),
  };
}

/**
 * The words of that line - "Republie par BDE, BDS +2" - or `null` when nobody republished the post.
 * The post header and the reel overlay both put it beside the time, so they read it from here.
 */
export function republishedByText(
  republishedBy: PostEntity['republishedBy'],
  repostedBy: PostEntity['repostedBy'] = []
): string | null {
  const line = republishedByLine(republishedBy, repostedBy);
  if (!line) return null;
  const names = line.names.join(', ');
  return line.extra > 0
    ? m.post_republished_by_more({ names, count: line.extra })
    : m.post_republished_by({ names });
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

/**
 * The associations the reader may ASK the author of a personal post about (D38b): of the reader's
 * memberships, those holding `POST_AS_ASSO` - HELD, the administrator tier never stands in - of the
 * one kind that may ask (`association`, the server's `PERSONAL_REPUBLISHING_ASSOCIATION_TYPES`),
 * not archived, not already carrying the post, and with no request that still stands for it.
 */
export function personalRequestCandidates(
  mine: readonly Association[],
  post: PostEntity
): Association[] {
  const keep = notAlreadyCarrying(post);
  const asked = new Set((post.republicationRequests ?? []).map((r) => r.associationId));
  return mine.filter(
    (a) =>
      a.type === 'association' &&
      !a.archived &&
      keep(a) &&
      !asked.has(a.id) &&
      ((a.permissions ?? 0) & AssociationPermissionFlag.POST_AS_ASSO) !== 0
  );
}

/**
 * The requests of the reader's associations still waiting on the author of `post` (D38b), named:
 * the card's "Demande envoyee au nom de X" line and the menu's "Annuler la demande de X". A refused
 * request is left out - it stands, but there is nothing left to wait for or to cancel.
 */
export function pendingRequests(post: PostEntity): { proposalId: string; name: string }[] {
  return (post.republicationRequests ?? [])
    .filter((r) => r.status === 'pending')
    .map((r) => ({ proposalId: r.proposalId, name: r.associationName }));
}

/**
 * The sentence a refused request (D38b) reads as, from the server's typed `code` - never from its
 * message - and its status when it carries none: a 409 without a code is the unique index (a request
 * already stands for this association), anything else is the generic failure.
 */
export function personalRequestRefusalMessage(code: string | null, status: number | null): string {
  switch (code) {
    case 'REPOST_PERSONAL_ANONYMOUS':
      return m.post_request_republication_refused_anonymous();
    case 'REPOST_PERSONAL_BLOCKED':
      return m.post_request_republication_refused_blocked();
    case 'REPOST_PERSONAL_AUTHOR_CAP':
      return m.post_request_republication_refused_author_cap();
    case 'REPOST_PERSONAL_ASSOCIATION_CAP':
      return m.post_request_republication_refused_association_cap();
    case 'REPOST_PERSONAL_ALREADY_REPUBLISHED':
      return m.post_republish_conflict();
    default:
      return status === 409 ? m.post_request_republication_conflict() : m.post_republish_error();
  }
}
