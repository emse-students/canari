import {
  isSeenTrend,
  noteSeen,
  parseSeen,
  parseSeenLedger,
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
import { currentUserId } from '$lib/stores/userState.svelte';
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
 * WRITES FOLLOW THE NOTE, never a timer: a social push is composed natively WHILE the app is in the
 * foreground (`ForegroundGuard`, `showsWhileForeground`), so a post noted in the open session must
 * already be in the native file when the next push arrives, and a crash must not lose it. A note
 * marks the record dirty and schedules ONE write on the microtask queue (every card noted in the same
 * tick shares it); a write in flight is never interleaved - the next one waits for it and runs while
 * the record is dirty ({@link flushSeenPosts}). NATIVE FIRST, then the sealed copy: the native file is
 * the one a push reads. The lifecycle flush stays as the last chance. The bell reads memory.
 *
 * THE BELL'S OWN DURABLE FACT. The record is pruned by the post's age (25 h) but a bell row lives 90
 * days, and a withheld "Suggestion" row must not come back, unread, in the list and the badge when its
 * post ages out. So the ids of the ROWS this device withheld are kept (`withholdsRow`), in the same
 * sealed copy, for as long as the rows are in the stored list (`retainWithheld`). A row is withheld
 * only if the post was displayed BEFORE the row was created - the case where its push was withheld
 * too: a trend the member already saw in the bell, or tapped from a shown push, is displayed AFTER
 * its row and never vanishes.
 */

// A plain Map on purpose: readers re-run on `revision`, which every change bumps.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- reactivity is `revision`, not the Map
const emptyRecord = (): SeenPosts => new Map();
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- reactivity is `revision`, not the Map
const emptyInstants = (): Map<string, number> => new Map();
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- reactivity is `revision`, not the Set
const emptyRowIds = (): Set<string> => new Set();
let seen: SeenPosts = emptyRecord();
/** The account the in-memory record belongs to; never drawn or written under another. */
let owner: string | null = null;
/** post id -> epoch ms this device FIRST displayed it (the bell's rule; never sent to the readers). */
let seenAt = emptyInstants();
/** Ids of the bell rows this device withheld, kept while the row is in the stored list. */
let withheldRows = emptyRowIds();
/** A write is queued on the microtask queue. */
let scheduled = false;
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
  seenAt = emptyInstants();
  withheldRows = emptyRowIds();
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

/**
 * A sign-out or a change of account: memory empties now, and the native copy of the account that
 * LEAVES goes with it (read from the user state, which still holds it at this moment, as the
 * nickname registers do - nothing here imports back into `stores/user.ts`).
 */
onPeerNamesEnded(() => {
  const leaving = currentUserId();
  reset('sign-out');
  if (leaving) void forgetSeenPosts(leaving);
});

/** Queues ONE write for the microtask queue: the cards noted in the same tick share it, no timer. */
function scheduleWrite(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    void flushSeenPosts();
  });
}

/**
 * The sealed copy opened for an account: its record is merged into what memory holds (a post noted
 * before the key arrived is kept) and pruned.
 */
onLocalCopiesOpen((access) => {
  void (async () => {
    const copy = await readLocalCopy(access, SEEN_POSTS_SLOT, (body) => {
      const posts = parseSeen(body);
      return posts ? { posts, ledger: parseSeenLedger(body) } : null;
    });
    if (!copy || getSavedUserId() !== access.userId) return;
    const { posts: stored, ledger } = copy;
    if (owner !== null && owner !== access.userId) reset('another account');
    owner = access.userId;
    let added = 0;
    for (const [id, at] of stored) if (noteSeen(seen, id, at)) added++;
    for (const [id, at] of ledger?.seenAt ?? []) {
      const known = seenAt.get(id);
      if (known === undefined || at < known) seenAt.set(id, at);
    }
    for (const id of ledger?.withheld ?? []) withheldRows.add(id);
    const pruned = pruneSeen(seen, Date.now());
    pruneSeenAt();
    if (added > 0 || pruned.aged > 0) revision++;
    // What the device copy held may be missing from the native file (a reinstall, a lost file, a
    // move of the data): the native readers are handed the merged record again.
    if (added > 0) {
      dirty = true;
      scheduleWrite();
    }
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
    seenAt.set(postId.trim().toLowerCase(), Date.now());
    dirty = true;
    revision++;
    scheduleWrite();
  },
  /**
   * Whether the bell must withhold `row`. A row withheld before stays withheld (the ledger, which
   * outlives the record's pruning). A new trend row is withheld only if its post was displayed
   * BEFORE the row was created: the push for it was withheld too. A post displayed after - the row
   * already shown in the bell, or the push tapped - leaves the row where it is.
   */
  withholdsRow(row: { id: string; type: string; postId: string; createdAt?: string }): boolean {
    void revision;
    if (!owner || owner !== getSavedUserId()) return false;
    if (withheldRows.has(row.id)) return true;
    if (!isSeenTrend(seen, { type: row.type }, row.postId)) return false;
    const displayed = seenAt.get(row.postId.trim().toLowerCase()) ?? 0;
    const created = Date.parse(row.createdAt ?? '');
    if (Number.isFinite(created) && displayed > created) return false;
    withheldRows.add(row.id);
    dirty = true;
    scheduleWrite();
    return true;
  },
  /**
   * A full server answer: the ledger keeps only the rows the stored list still holds, so it is
   * bounded by that list and a withheld row that is gone is forgotten with it.
   */
  retainWithheld(rowIdList: readonly string[]): void {
    const rowIds = emptyRowIds();
    for (const id of rowIdList) rowIds.add(id);
    let dropped = 0;
    for (const id of withheldRows) {
      if (!rowIds.has(id)) {
        withheldRows.delete(id);
        dropped++;
      }
    }
    if (dropped === 0) return;
    dirty = true;
    scheduleWrite();
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

/** Drops the first-display instants of posts the record no longer holds. */
function pruneSeenAt(): void {
  for (const id of seenAt.keys()) if (!seen.has(id)) seenAt.delete(id);
}

/** One write: the native readers' file first (mobile), then the sealed copy; each failure said. */
async function writeRecord(): Promise<void> {
  const who = owner;
  if (!who || !dirty || getSavedUserId() !== who) return;
  const pruned = pruneSeen(seen, Date.now());
  pruneSeenAt();
  dirty = false;
  if (pruned.aged > 0 || pruned.capped > 0) revision++;
  if (isMobileTauriRuntime()) await mirrorToNative(who);
  await writeLocalCopy(SEEN_POSTS_SLOT, serializeSeen(seen, { seenAt, withheld: withheldRows }));
}

/** Hands the record to the native readers; a failure keeps the record dirty for the next write. */
async function mirrorToNative(who: string): Promise<void> {
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
  seenAt = emptyInstants();
  withheldRows = emptyRowIds();
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
