import {
  isSeenTrend,
  noteSeen,
  parseSeen,
  pruneSeen,
  serializeSeen,
  type SeenPosts,
} from '$lib/posts/seenPosts';
import {
  SEEN_POSTS_SLOT,
  onLocalCopiesOpen,
  readLocalCopy,
  writeLocalCopy,
} from '$lib/localCopies/localCopyStore.svelte';
import { getSavedUserId } from '$lib/stores/user';
import { isMobileTauriRuntime } from '$lib/utils/appVersion';
import { onPeerNamesEnded } from '$lib/utils/users/peerNameDirectory';

/**
 * THE POSTS THIS DEVICE DISPLAYED - the store behind "a campus trend for a post already seen shows
 * nothing" (owner, 2026-11-24, "Verif sur l'appareil"; the value and the why are `seenPosts.ts`).
 *
 * WHERE IT LIVES, one account's, on this device only - nothing is sent to the server:
 *  - memory (this file), the reactive copy the bell reads;
 *  - the account's SEALED local copy (`SEEN_POSTS_SLOT`, `localCopyStore.svelte.ts`: sealed under the
 *    device key in `feed_pages`, ended with the sign-out by the same epoch as the bell's copy and the
 *    peer names) - what survives a reload on the web and the desktop;
 *  - on mobile, `seen_posts.json` (Rust `store_seen_posts`, and in the iOS App Group): the FCM service,
 *    the iOS extension and `canari_push.mm` compose the banner while the app is closed and cannot ask
 *    the WebView, so they read this file under the rule of `notification-seen-trend.cases.json`.
 *
 * ERASED with the other per-account stores: the sign-out ({@link forgetSeenPosts}, called by
 * `clearUserLocally`), the account deletion (`eraseAccountRecordsLocally`), the factory wipe (the
 * App Group sweep in Rust), and a change of account (the epoch).
 *
 * WRITES ARE BATCHED BY THE LIFECYCLE, never a timer: a post noted only marks the record dirty, and
 * the app going to the background (the moment a native reader can first be needed) seals it and
 * hands it to Rust ({@link flushSeenPosts}). The bell reads memory, so it follows at once.
 */

// A plain Map on purpose: readers re-run on `revision`, which every change bumps.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- reactivity is `revision`, not the Map
const emptyRecord = (): SeenPosts => new Map();
let seen: SeenPosts = emptyRecord();
/** The account the in-memory record belongs to; never drawn or written under another. */
let owner: string | null = null;
/** Something was noted since the last write. */
let dirty = false;
/** Bumped on every change, so a reader (the bell) re-reads. A plain Map tracks nothing. */
let revision = $state(0);
/** A write is in flight: the next flush waits for it, so two never interleave. */
let inFlight: Promise<void> | null = null;

/** Drops the in-memory record (sign-out, another account). */
function reset(why: string): void {
  if (seen.size > 0) console.log(`[SEEN_TREND] record left memory (${why}): ${seen.size} post(s)`);
  seen = emptyRecord();
  owner = null;
  dirty = false;
  revision++;
}

/** The signed-in account, resetting the memory when it is not the one the record belongs to. */
function currentOwner(): string | null {
  const who = getSavedUserId();
  if (!who) return null;
  if (owner !== who) {
    if (owner !== null) reset('another account');
    owner = who;
  }
  return who;
}

onPeerNamesEnded(() => reset('sign-out'));

/**
 * The sealed copy opened for an account: its record is merged into what memory holds (a post noted
 * before the key arrived is kept) and pruned.
 */
onLocalCopiesOpen((access) => {
  void (async () => {
    const stored = await readLocalCopy(access, SEEN_POSTS_SLOT, parseSeen);
    if (!stored || getSavedUserId() !== access.userId) return;
    if (owner !== null && owner !== access.userId) reset('another account');
    owner = access.userId;
    let added = 0;
    for (const [id, at] of stored) if (noteSeen(seen, id, at)) added++;
    const pruned = pruneSeen(seen, Date.now());
    if (added > 0 || pruned.aged > 0) revision++;
    console.log(
      `[SEEN_TREND] ${added} post(s) drawn from the device copy, ${pruned.aged} aged out, ${pruned.capped} over the cap`
    );
  })();
});

export const seenPostsStore = {
  /**
   * Notes that `postId` was displayed on this device. `publishedAt` is the post's own publication
   * instant (ISO), the proof its entry is pruned by. Nothing is stored for a post with none.
   */
  note(postId: string, publishedAt: string | null | undefined): void {
    const who = currentOwner();
    if (!who || !publishedAt) return;
    const at = Date.parse(publishedAt);
    if (!noteSeen(seen, postId, at)) return;
    dirty = true;
    revision++;
  },
  /** Whether a notification (a bell row's `type`, a push's `contentKey`) is a trend for a displayed post. */
  isSeenTrend(kind: { contentKey?: string | null; type?: string | null }, postId: string): boolean {
    void revision;
    return !!owner && owner === getSavedUserId() && isSeenTrend(seen, kind, postId);
  },
  /** How many posts the record holds - for tests and a debug surface. */
  get size(): number {
    void revision;
    return seen.size;
  },
};

/** One write: the pruned record sealed on the device, then handed to the native readers on mobile. */
async function writeRecord(): Promise<void> {
  const who = owner;
  if (!who || !dirty || getSavedUserId() !== who) return;
  const pruned = pruneSeen(seen, Date.now());
  dirty = false;
  if (pruned.aged > 0 || pruned.capped > 0) revision++;
  await writeLocalCopy(SEEN_POSTS_SLOT, serializeSeen(seen));
  if (!isMobileTauriRuntime()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const posts = [...seen].map(([postId, publishedAt]) => ({ postId, publishedAt }));
    const held = await invoke<number>('store_seen_posts', { userId: who, posts });
    console.log(
      `[SEEN_TREND] mirrored ${posts.length} post(s) for the native readers, ${held} held`
    );
  } catch (e) {
    // Kept for the next write: the readers would show a trend for a post that was displayed.
    dirty = true;
    console.warn(
      `[SEEN_TREND] the native copy was NOT written, kept for the next write: ${String(e)}`
    );
  }
}

/** Writes what was noted since the last write. Resolves once it is written (or kept after a failure). */
export async function flushSeenPosts(): Promise<void> {
  while (inFlight) await inFlight;
  if (!dirty) return;
  inFlight = writeRecord().finally(() => {
    inFlight = null;
  });
  await inFlight;
}

/**
 * Erases `userId`'s record: memory now, the native copy (Rust checks its owner), the sealed copy by
 * the sign-out's epoch. A mirror outliving its account is a defect - the post ids a member displayed
 * are theirs.
 */
export async function forgetSeenPosts(userId: string): Promise<void> {
  const who = userId.trim().toLowerCase();
  if (!who) return;
  if (owner === who) reset('sign-out');
  // A WRITE IN FLIGHT LANDS BEFORE THE REMOVAL, never after it, or it would recreate the copy.
  while (inFlight) await inFlight;
  if (!isMobileTauriRuntime()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const removed = await invoke<boolean>('forget_seen_posts', { userId: who });
    console.log(`[SEEN_TREND] sign-out: native copy ${removed ? 'removed' : 'absent'}`);
  } catch (e) {
    console.error(
      `[SEEN_TREND] the native copy of ${who.slice(0, 8)} was NOT removed: ${String(e)}`
    );
  }
}

/** Test seam: forgets everything held in memory without touching a device. */
export function resetSeenPostsForTest(): void {
  seen = emptyRecord();
  owner = null;
  dirty = false;
  inFlight = null;
  revision++;
}

if (typeof document !== 'undefined') {
  const flushOnLeave = () => void flushSeenPosts();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnLeave();
  });
  window.addEventListener('pagehide', flushOnLeave);
}
