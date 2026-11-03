/**
 * REPUBLICATION (D38), the client's pure half: the card's "Republie par" line and the associations
 * each dialog offers. What may actually be written is the server's to decide - these lists only
 * decide what is OFFERED, and every choice is checked again on the way in.
 */
import { AssociationPermissionFlag, type Association } from '$lib/associations/api';
import type { PostEntity } from './api';
import type { InstitutionAudience } from '$lib/proposals/api';
import {
  CAMPUSES,
  FORMATIONS,
  campusLabel,
  formationLabel,
  type Campus,
  type Formation,
} from '$lib/profile/miconnectProfile';
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
 *
 * `repostedByMe` (the card's own WP-F6 field, owner 2026-11-02): the reader who reposted the post
 * reads "vous" FIRST - "Republie par vous", "vous et Marie", "vous, Marie et 2 autres". Only that
 * reader's card carries it, so nobody else is ever shown the line.
 */
export function republishedByText(
  republishedBy: PostEntity['republishedBy'],
  repostedBy: PostEntity['repostedBy'] = [],
  repostedByMe = false
): string | null {
  const line = republishedByLine(republishedBy, repostedBy);
  if (repostedByMe) {
    if (!line) return m.post_republished_by_you();
    const name = line.names[0];
    return line.extra > 0
      ? m.post_republished_by_you_and_more({ name, count: line.extra })
      : m.post_republished_by_you_and({ name });
  }
  if (!line) return null;
  const names = line.names.join(', ');
  return line.extra > 0
    ? m.post_republished_by_more({ names, count: line.extra })
    : m.post_republished_by({ names });
}

/**
 * The kinds that republish a post, the server's `REPUBLISHING_ASSOCIATION_TYPES`: an allowlist, so a
 * kind added later is offered nothing until listed. Every kind of today: associations, institutions
 * (WP6e) and campaign lists (owner, 2026-10-31).
 */
const REPUBLISHING_KINDS: readonly Association['type'][] = ['association', 'list', 'institution'];

/**
 * The kinds that may ASK a person to republish their personal post (D38b), the server's
 * `PERSONAL_REPUBLISHING_ASSOCIATION_TYPES` - its own allowlist. Every kind since the owner's
 * decision of 2026-11-02 ("Oui partout sans exception"): an institution may carry a student's post
 * to its audience, staff included, once the student accepts.
 */
const PERSONAL_REQUESTING_KINDS: readonly Association['type'][] = [
  'association',
  'list',
  'institution',
];

/** A kind on `kinds`, not archived: an archived one no longer speaks. */
function speaksAs(a: Association, kinds: readonly Association['type'][]): boolean {
  return kinds.includes(a.type) && !a.archived;
}

function mayRepublishAtAll(a: Association): boolean {
  return speaksAs(a, REPUBLISHING_KINDS);
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
 * memberships, those holding `POST_AS_ASSO` - HELD, the administrator tier never stands in - of a
 * kind that may ask (`PERSONAL_REQUESTING_KINDS`), not archived, not already carrying the post, and
 * with no request that still stands for it.
 */
export function personalRequestCandidates(
  mine: readonly Association[],
  post: PostEntity
): Association[] {
  const keep = notAlreadyCarrying(post);
  const asked = new Set((post.republicationRequests ?? []).map((r) => r.associationId));
  return mine.filter(
    (a) =>
      speaksAs(a, PERSONAL_REQUESTING_KINDS) &&
      keep(a) &&
      !asked.has(a.id) &&
      ((a.permissions ?? 0) & AssociationPermissionFlag.POST_AS_ASSO) !== 0
  );
}

/** One audience rule as words: "ICM - Saint-Etienne", a null side read as "every ...". */
function audienceSpaceLabel(space: InstitutionAudience['spaces'][number]): string {
  const campus =
    space.campus === null
      ? m.republication_requests_audience_any_campus()
      : (CAMPUSES as readonly string[]).includes(space.campus)
        ? campusLabel(space.campus as Campus)
        : space.campus;
  const formation =
    space.formation === null
      ? m.republication_requests_audience_any_formation()
      : (FORMATIONS as readonly string[]).includes(space.formation)
        ? formationLabel(space.formation as Formation)
        : space.formation;
  return m.republication_requests_audience_space({ formation, campus });
}

/**
 * THE WARNING AN AUTHOR READS BEFORE AN INSTITUTION CARRIES THEIR POST (owner, 2026-11-02), one
 * sentence a line, from the institution's audience as the server read it - never "the School", since
 * an institution is not necessarily it. Everyone is said plainly; otherwise the spaces it reaches,
 * or that it addresses none; then ALWAYS that its members see the post too (review of #2965,
 * 2026-11-02: also when it has rules); and the staff side whenever a staff member belongs to it.
 * Empty for a request that is not an institution's (`null`).
 */
export function institutionAudienceWarning(
  audience: InstitutionAudience | null | undefined
): string[] {
  if (!audience) return [];
  const lines: string[] = [];
  if (audience.everyone) lines.push(m.republication_requests_audience_everyone());
  else if (audience.spaces.length === 0) lines.push(m.republication_requests_audience_none());
  else {
    const spaces = audience.spaces.map(audienceSpaceLabel).join(', ');
    lines.push(m.republication_requests_audience_spaces({ spaces }));
  }
  lines.push(m.republication_requests_audience_members());
  if (audience.staffMembers) lines.push(m.republication_requests_audience_staff());
  return lines;
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
