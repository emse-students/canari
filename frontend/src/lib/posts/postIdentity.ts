/**
 * WHO A POST IS PUBLISHED AS - the one reading of the identity field the post composer and the
 * CanaReels publish step share (`PostIdentityPicker.svelte` draws it).
 *
 * The field holds `''` (the member), `ANONYMOUS_POST_IDENTITY`, or an association's UUID; this file
 * turns it into the payload's fields and lists the associations a member may speak for. Both were
 * written inline in `CreatePostForm`, and a reel is published "with the same audience as posts
 * have" (R3), so the camera reads the same two answers rather than a second spelling of them.
 */
import {
  AssociationPermissionFlag,
  hasPermissionFlag,
  listAssociations,
  listMyAssociations,
  type Association,
} from '$lib/associations/api';
import { isGlobalAdmin } from '$lib/stores/user';
import { ANONYMOUS_POST_IDENTITY } from './postComposerDraft';
import type { CreatePostPayload } from './api';

/**
 * The associations the member may publish - or comment - as: every one for a global admin,
 * otherwise those where they hold `POST_AS_ASSO` itself.
 *
 * It filtered on `isAdmin` ("holds ANY permission") until 2026-10-21, a wider test than the one the
 * server applies (`canPostAs`): a member who could only manage the roster was OFFERED an association
 * the server then refused. The server still checks - this list only decides what is offered.
 */
export async function listPostAsAssociations(): Promise<Association[]> {
  if (isGlobalAdmin()) return listAssociations();
  const mine = await listMyAssociations();
  return mine.filter((a) =>
    hasPermissionFlag(a.permissions ?? 0, AssociationPermissionFlag.POST_AS_ASSO)
  );
}

/** The payload fields an identity choice adds: an association, anonymity, or nothing (the member). */
export function postIdentityFields(
  identity: string
): Pick<CreatePostPayload, 'associationId' | 'anonymous'> {
  if (!identity) return {};
  if (identity === ANONYMOUS_POST_IDENTITY) return { anonymous: true };
  return { associationId: identity };
}

/**
 * Whether `identity` publishes AS AN ASSOCIATION - the question the landing feed asks. Not "is the
 * field set": anonymity sets it too, and an anonymous post is a personal one, landing in `all`
 * (review of #2124: `!!identity` sent an anonymous post to the associations feed).
 */
export function isAssociationIdentity(identity: string): boolean {
  return postIdentityFields(identity).associationId !== undefined;
}

/**
 * WHO A COMMENT IS WRITTEN AS: the member, anonymous (open to every member), or an association the
 * member may speak for (`POST_AS_ASSO`). It carries the association's CARD, not just its id,
 * because the comment is drawn under that name before the server has answered.
 */
export type CommentIdentity =
  | { kind: 'personal' }
  | { kind: 'anonymous' }
  | { kind: 'association'; association: Pick<Association, 'id' | 'name' | 'slug' | 'logoUrl'> };

/** The default identity of a comment: the member's own name. An unknown choice is never read as this - see `commentIdentityOf`. */
export const PERSONAL_COMMENT_IDENTITY: CommentIdentity = { kind: 'personal' };

/** The payload fields a comment identity adds - the same two a post's identity adds. */
export function commentIdentityFields(identity: CommentIdentity): {
  associationId?: string;
  anonymous?: boolean;
} {
  if (identity.kind === 'anonymous') return { anonymous: true };
  if (identity.kind === 'association') return { associationId: identity.association.id };
  return {};
}

/**
 * Reads the picker's value (`''`, `ANONYMOUS_POST_IDENTITY`, an association id) as a comment
 * identity, against the associations the picker offered. A value naming an association that is not
 * in the list returns `null`: the caller must not send, since sending would publish under the
 * member's own name a comment they meant to sign as an association.
 */
export function commentIdentityOf(
  value: string,
  associations: readonly Association[]
): CommentIdentity | null {
  const fields = postIdentityFields(value);
  if (fields.anonymous) return { kind: 'anonymous' };
  if (fields.associationId) {
    const found = associations.find((a) => a.id === fields.associationId);
    return found ? { kind: 'association', association: found } : null;
  }
  return PERSONAL_COMMENT_IDENTITY;
}
