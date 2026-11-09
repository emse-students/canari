/**
 * SUGGESTED POSTS IN MON ESPACE (engagement WP-7, decision 8, L13): popular posts the reader already
 * sees by the space rule, from accounts they do not follow, placed among the feed's own posts and
 * marked "Suggestion" - the post header carries Suivre (WP-2), since its author is not followed.
 *
 * - Read ONCE per reader (`me/suggested-posts`), when Mon espace opens; a failed read is a warning
 *   and is not asked again in the session - the suggestions are a bonus, not the feed.
 * - Placed by ONE rule ({@link placeSuggestedPosts}): at most one in every
 *   {@link SUGGESTED_POST_EVERY} items, never two in a row, only in Mon espace, never a post the
 *   page already shows.
 * - A per-reader cache: signing out or switching accounts forgets it.
 */
import { registerPerReaderCache } from '$lib/utils/sharedCache';
import { Log } from '$lib/utils/Log';
import { listSuggestedPosts, type PostEntity } from './api';

/** L13: a suggested post is at most one in every this many feed items. */
export const SUGGESTED_POST_EVERY = 8;

const state = $state<{ posts: PostEntity[] }>({ posts: [] });
let epoch = 0;
let asked = false;

/** Forgets everything: another account signed in, or the reader signed out (or a test). */
export function resetSuggestedPosts(): void {
  epoch++;
  asked = false;
  state.posts = [];
}
registerPerReaderCache(resetSuggestedPosts);

/** Reads the reader's suggested posts once; a second call, or one after a failure, does nothing. */
export function ensureSuggestedPosts(): void {
  if (asked) return;
  asked = true;
  const mine = epoch;
  listSuggestedPosts()
    .then((posts) => {
      if (mine !== epoch) return;
      Log.d('suggestedPosts', `${posts.length} suggested post(s)`);
      state.posts = posts;
    })
    .catch((e: unknown) => {
      if (mine !== epoch) return;
      console.warn('[suggestedPosts] read failed, not asked again this session', e);
    });
}

/** The suggested posts read so far, best first. */
export function suggestedPosts(): PostEntity[] {
  return state.posts;
}

/** Drops one suggested post that left the reader's view (deleted, hidden, its author blocked). */
export function forgetSuggestedPost(postId: string): void {
  state.posts = state.posts.filter((p) => p.id !== postId);
}

/**
 * WHERE EACH SUGGESTED POST GOES among `feedIds` (the feed page's own posts, in order): the key is
 * the index of the feed post it follows. One after every `SUGGESTED_POST_EVERY - 1` feed posts, so
 * a suggestion is at most one in every {@link SUGGESTED_POST_EVERY} items and never next to another;
 * a suggestion the page already shows is skipped (the next one takes the slot), and the slots stop
 * at the last feed post - a suggestion never ends the page.
 */
export function placeSuggestedPosts(
  feedIds: readonly string[],
  suggested: readonly PostEntity[],
  every = SUGGESTED_POST_EVERY
): Record<number, PostEntity> {
  const queue = suggested.filter((p) => !feedIds.includes(p.id));
  const placed: Record<number, PostEntity> = {};
  const gap = every - 1;
  for (let after = gap - 1; after < feedIds.length - 1 && queue.length > 0; after += gap) {
    placed[after] = queue.shift()!;
  }
  return placed;
}
