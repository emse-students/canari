import { goto } from '$app/navigation';
import { resolve } from '$app/paths';

/**
 * The address of a person's profile page, base-prefixed through `resolve`. ONE builder for every
 * conversation surface (a message's sender, a members row, a direct header, `UserName`), so the id
 * is encoded in one place. The page itself decides what its reader may see - visibility, blocks,
 * the review cohort - so a link needs no check beyond "is anyone there" (see `isAbsentUser`).
 */
export function profileHref(userId: string): string {
  return resolve('/profile/[id]', { id: encodeURIComponent(userId) });
}

/** Navigates to a person's profile - the one place that pairs {@link profileHref} with `goto`. */
export function openProfile(userId: string): Promise<void> {
  return goto(resolve('/profile/[id]', { id: encodeURIComponent(userId) }));
}
