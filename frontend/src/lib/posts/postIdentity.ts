/**
 * WHO A POST IS PUBLISHED AS - the one reading of the identity field the post composer and the
 * CanaReels publish step share (`PostIdentityPicker.svelte` draws it).
 *
 * The field holds `''` (the member), `ANONYMOUS_POST_IDENTITY`, or an association's UUID; this file
 * turns it into the payload's fields and lists the associations a member may speak for. Both were
 * written inline in `CreatePostForm`, and a reel is published "with the same audience as posts
 * have" (R3), so the camera reads the same two answers rather than a second spelling of them.
 */
import { listAssociations, listMyAssociations, type Association } from '$lib/associations/api';
import { isGlobalAdmin } from '$lib/stores/user';
import { ANONYMOUS_POST_IDENTITY } from './postComposerDraft';
import type { CreatePostPayload } from './api';

/**
 * The associations the member may publish as: every one for a global admin, otherwise those they
 * administer (`POST_AS_ASSO` is checked again by the server - this list only decides what is OFFERED).
 */
export async function listPostAsAssociations(): Promise<Association[]> {
  if (isGlobalAdmin()) return listAssociations();
  const mine = await listMyAssociations();
  return mine.filter((a) => a.isAdmin);
}

/** The payload fields an identity choice adds: an association, anonymity, or nothing (the member). */
export function postIdentityFields(
  identity: string
): Pick<CreatePostPayload, 'associationId' | 'anonymous'> {
  if (!identity) return {};
  if (identity === ANONYMOUS_POST_IDENTITY) return { anonymous: true };
  return { associationId: identity };
}
