import { resolve } from '$app/paths';

/**
 * The address of a person's profile page, base-prefixed through `resolve`. ONE builder for the
 * conversation surfaces (a message's sender, a members row, a direct header), so the id is encoded
 * in one place. The page itself decides what its reader may see - visibility, blocks, the review
 * cohort - so a link needs no check beyond "is anyone there" (see `isAbsentUser`).
 */
export function profileHref(userId: string): string {
  return resolve('/profile/[id]', { id: encodeURIComponent(userId) });
}
