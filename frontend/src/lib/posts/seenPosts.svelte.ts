import {
  isSeenTrend,
  noteSeen,
  parseSeen,
  parseSeenLedger,
  pruneSeen,
  serializeSeen,
  withinTrendWindow,
  BELL_ROW_RETENTION_MS,
  type BellCoverage,
  type SeenPosts,
} from '$lib/posts/seenPosts';
import {
  SEEN_POSTS_SLOT,
  localCopiesAccess,
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
 * THE BELL DECIDES ONCE, FROM STATE THAT OUTLIVES THE RECORD'S AGE. The record is by the post's age
 * (25 h) but a bell row lives 90 days, and a withheld "Suggestion" row must not come back, unread, when
 * its post ages out - nor must a trend the member already saw in the bell (or tapped from a shown push)
 * vanish afterwards. So the FIRST time a trend row appears in this device's list ({@link
 * seenPostsStore.decideRows}) its post is either in the record (the row is WITHHELD for good) or not (the
 * row is KEPT for good): one fact, no comparison of two clocks. Both sets live in the sealed copy, each id
 * with the row's own `createdAt`, and are dropped when the row is older than its 90 days.
 * THE RECORD ITSELF IS NOT AGED OUT in memory until the bell has PROVEN it holds every trend row of a post
 * (`BellCoverage`, `pruneSeen`): an answer taken after the post's window closed that reaches back before
 * the post was published (its oldest row is older, or the page was short) - an app closed through the
 * window still withholds, at its reopening, the row whose push was withheld meanwhile. The native file keeps pruning by age: it is read by pushes only.
 */

// A plain Map on purpose: readers re-run on `revision`, which every change bumps.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- reactivity is `revision`, not the Map
const emptyRecord = (): SeenPosts => new Map();
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- reactivity is `revision`, not the Map
const emptyInstants = (): Map<string, number> => new Map();

/** The bell row type of a campus trend (`PostNotification.type`). */
const TREND_ROW_TYPE = 'campus_trend';

/** The fields of a bell row the decision reads. */
export interface BellRow {
  id: string;
  type: string;
  postId: string;
  createdAt?: string;
}
let seen: SeenPosts = emptyRecord();
/** The account the in-memory record belongs to; never drawn or written under another. */
let owner: string | null = null;
/** Trend rows whose post had ALREADY been displayed when they first appeared: row id -> createdAt ms. */
let withheldRows = emptyInstants();
/** Trend rows whose post had NOT been displayed when they first appeared: kept for good. */
let keptRows = emptyInstants();
/** What the last qualifying bell answer proved it listed (`answeredAt` 0: none); ages the record. */
let coverage: BellCoverage = { answeredAt: 0, coveredFrom: 0 };
/** The account whose sealed copy is merged into memory: decisions wait for it, withholding does not. */
let mergedFor: string | null = null;
/** The last bell answer, decided again once the sealed copy is merged. */
let lastAnswer: { rows: BellRow[]; coversAll: boolean } | null = null;
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
  withheldRows = emptyInstants();
  keptRows = emptyInstants();
  coverage = { answeredAt: 0, coveredFrom: 0 };
  mergedFor = null;
  lastAnswer = null;
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
 * The sealed copy opened for an account: its record and the bell's decisions are merged into what
 * memory holds (a post noted before the key arrived is kept), then the last bell answer is decided
 * again - it may have come before the copy was read.
 */
onLocalCopiesOpen((access) => {
  void (async () => {
    const copy = await readLocalCopy(access, SEEN_POSTS_SLOT, (body) => {
      const posts = parseSeen(body);
      return posts ? { posts, ledger: parseSeenLedger(body) } : null;
    });
    if (getSavedUserId() !== access.userId) return;
    if (owner !== null && owner !== access.userId) reset('another account');
    owner = access.userId;
    if (copy) {
      const { posts: stored, ledger } = copy;
      let added = 0;
      for (const [id, at] of stored) if (noteSeen(seen, id, at)) added++;
      for (const [id, at] of ledger.withheld) if (!withheldRows.has(id)) withheldRows.set(id, at);
      for (const [id, at] of ledger.kept) if (!keptRows.has(id)) keptRows.set(id, at);
      if (ledger.coverage.answeredAt > coverage.answeredAt) coverage = ledger.coverage;
      const aged = ageRecord();
      if (added > 0 || aged > 0) revision++;
      // What the device copy held may be missing from the native file (a reinstall, a lost file, a
      // move of the data): the native readers are handed the merged record again.
      if (added > 0) {
        dirty = true;
        scheduleWrite();
      }
      console.log(
        `[SEEN_TREND] ${added} post(s) drawn from the device copy, ${aged} aged out, ${withheldRows.size} withheld and ${keptRows.size} kept row(s)`
      );
    }
    mergedFor = access.userId;
    revision++;
    if (lastAnswer) seenPostsStore.decideRows(lastAnswer.rows, lastAnswer.coversAll);
  })();
});

/** Whether this account's sealed copy is open but not yet merged into memory. */
function awaitingCopy(who: string): boolean {
  return localCopiesAccess()?.userId === who && mergedFor !== who;
}

/**
 * Ages the in-memory record, per entry, on what the last bell answer proved (`pruneSeen`) - and the cap. Returns how many entries went.
 */
function ageRecord(): number {
  const pruned = pruneSeen(seen, coverage);
  return pruned.aged + pruned.capped;
}

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
    scheduleWrite();
  },
  /**
   * Whether the bell withholds `row`: it was decided so, once, when it first appeared. Pure - it
   * decides nothing (`decideRows` does).
   */
  withholdsRow(row: BellRow): boolean {
    void revision;
    const who = getSavedUserId();
    if (!who) return false;
    const mine = owner === who;
    if (mine && withheldRows.has(row.id)) return true;
    // A trend row with NO decision yet - met before this account's record is read, or drawn from the
    // sealed bell copy by an app killed before its first answer - is not shown: it is decided by the
    // first answer, so a row is never shown and then withdrawn.
    return row.type === TREND_ROW_TYPE && !(mine && keptRows.has(row.id));
  },
  /**
   * A bell answer: every trend row not yet decided is decided NOW, once - WITHHELD if its post is in
   * the record, KEPT if it is not - and the decision is kept as long as the row can exist. Before this
   * account's sealed copy is merged nothing is decided (the answer is kept and decided at the merge), so
   * a record not yet read never keeps a row it would have withheld. `coversAll` says the answer listed
   * EVERY row the bell will ever show: it was shorter than the page asked for, or it filled the bell's
   * whole page (a row beyond it is never shown). Otherwise it still proves it listed every row newer than
   * its oldest, which is what lets the record age out per post.
   */
  decideRows(rows: readonly BellRow[], coversAll: boolean): void {
    const who = currentOwner();
    if (!who) return;
    if (awaitingCopy(who)) {
      lastAnswer = { rows: [...rows], coversAll };
      return;
    }
    let withheldNow = 0;
    let keptNow = 0;
    for (const row of rows) {
      if (row.type !== TREND_ROW_TYPE || withheldRows.has(row.id) || keptRows.has(row.id)) continue;
      const created = Date.parse(row.createdAt ?? '');
      const at = Number.isFinite(created) ? created : Date.now();
      if (isSeenTrend(seen, { type: row.type }, row.postId)) {
        withheldRows.set(row.id, at);
        withheldNow++;
      } else {
        keptRows.set(row.id, at);
        keptNow++;
      }
    }
    let changed = withheldNow + keptNow > 0;
    const horizon = Date.now() - BELL_ROW_RETENTION_MS;
    for (const map of [withheldRows, keptRows]) {
      for (const [id, at] of map) {
        if (at < horizon) {
          map.delete(id);
          changed = true;
        }
      }
    }
    // What this answer proves it listed: every row (a short page), or every row newer than its oldest.
    const created = rows
      .map((r) => Date.parse(r.createdAt ?? ''))
      .filter((n) => Number.isFinite(n));
    if (coversAll || (rows.length > 0 && created.length === rows.length)) {
      coverage = { answeredAt: Date.now(), coveredFrom: coversAll ? 0 : Math.min(...created) };
      changed = true;
      if (ageRecord() > 0) revision++;
    }
    if (withheldNow > 0) {
      revision++;
      // NEVER SILENT, and never with the post's id: one line per decision, which is once per row.
      console.log(
        `[SEEN_TREND] bell: ${withheldNow} campus trend row(s) withheld - the post was already displayed on this device`
      );
    }
    if (!changed) return;
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

/** One write: the native readers' file first (mobile), then the sealed copy; each failure said. */
async function writeRecord(): Promise<void> {
  const who = owner;
  if (!who || !dirty || getSavedUserId() !== who) return;
  dirty = false;
  if (isMobileTauriRuntime()) await mirrorToNative(who);
  await writeLocalCopy(
    SEEN_POSTS_SLOT,
    serializeSeen(seen, { withheld: withheldRows, kept: keptRows, coverage })
  );
}

/** Hands the record to the native readers; a failure keeps the record dirty for the next write. */
async function mirrorToNative(who: string): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // The native file prunes by AGE, always: a push reads it, and a post past the trend window can
    // never be announced again. (The in-memory record waits for a full bell answer: `ageRecord`.)
    const now = Date.now();
    const posts = [...seen]
      .filter(([, publishedAt]) => withinTrendWindow(publishedAt, now))
      .map(([postId, publishedAt]) => ({ postId, publishedAt }));
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
  withheldRows = emptyInstants();
  keptRows = emptyInstants();
  coverage = { answeredAt: 0, coveredFrom: 0 };
  mergedFor = null;
  lastAnswer = null;
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
