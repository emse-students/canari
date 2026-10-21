import { currentUserId } from '$lib/stores/user';
import { isMobileTauriRuntime } from '$lib/utils/appVersion';
import { Log } from '$lib/utils/Log';

/**
 * The names this device has resolved, mirrored for the native push path (WP-MENTION-NAME,
 * decided 2026-10-18).
 *
 * A mention travels as `@[<64 hex>]` and a push handler has no name directory, so its banner said
 * "@someone" for everybody but its reader, and a salon banner named no author at all. The
 * decision: the name comes from the PHONE'S OWN copy - what this WebView already resolved for the
 * signed-in account - and never from the push, which the server would have to fill and Google or
 * Apple would carry. `store_display_names` (Rust, `commands/display_names.rs`) merges what is
 * handed here into `display_names.json`, which the FCM service, the iOS extension and
 * `canari_push.mm` read; an id it does not hold stays "someone".
 *
 * WRITTEN WHEN A NAME CHANGES, NOT WHEN THE APP IS HIDDEN. A change schedules ONE write at the end
 * of the current task (a microtask), so a burst - a profile batch settling twenty names - is one
 * IPC; one write is in flight at a time, and whatever changed meanwhile goes in the next. No timer.
 * Hiding the app flushes too, but only as an extra chance: WKWebView may suspend the page before an
 * IPC started at `hidden` completes, so the hide is never what a name's arrival depends on.
 *
 * What this does NOT guarantee: a name learned in the instant the page is suspended may not reach
 * the file before a banner is drawn; that banner says "someone", and the name is written at the next
 * change or hide. A failed write is retried the same way.
 *
 * A DELETED ACCOUNT IS DROPPED ({@link noteDeletedAccount}): the server answered that it does not
 * exist, so its name leaves the file and a banner falls back to "someone". The file only learns it
 * when this app asks the server for that id; until then a name already stored stays.
 */

/** A mention can only name a 64-hex user id; anything else could never be looked up natively. */
const MENTION_ID = /^[0-9a-f]{64}$/;

/** Changes since the last write, by lower-cased id: a name, or `null` for a deleted account. */
const pending = new Map<string, string | null>();
/**
 * The account those changes were learned under. The native file is one account's, so names noted
 * before a sign-out are never written under the account that signs in after it.
 */
let pendingOwner: string | null = null;
/** The write in flight, if any - there is never more than one. */
let inFlight: Promise<void> | null = null;
/** A write is already scheduled for the end of the current task. */
let scheduled = false;

/** Records one change for the signed-in account and schedules its write; false when not noted. */
function note(userId: string, value: string | null): boolean {
  const id = userId.trim().toLowerCase();
  const owner = currentUserId()?.trim().toLowerCase();
  if (!owner || !MENTION_ID.test(id) || !isMobileTauriRuntime()) return false;
  if (pendingOwner !== owner) {
    pending.clear();
    pendingOwner = owner;
  }
  // The later fact wins: a name noted after a deletion (or the reverse) replaces it here.
  pending.set(id, value);
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void flushNameMirror();
    });
  }
  return true;
}

/**
 * Records a name the app has RESOLVED for `userId` - a real name, never the unknown-user label,
 * which would then be printed on a banner as if it were somebody's name.
 *
 * Synchronous: the write follows at the end of the current task ({@link flushNameMirror}).
 */
export function noteResolvedName(userId: string, name: string): void {
  const value = name.trim();
  if (value) note(userId, value);
}

/**
 * Records that the server answered `userId` does not exist (a deleted account): its name is
 * DROPPED from the native file, so no banner names it again.
 */
export function noteDeletedAccount(userId: string): void {
  if (note(userId, null)) Log.d('NameMirror', 'a deleted account is dropped from the native names');
}

/** Hands the pending changes to Rust in ONE call; on failure they are kept for the next write. */
async function writePending(): Promise<void> {
  const userId = currentUserId()?.trim().toLowerCase();
  if (!userId || userId !== pendingOwner) {
    Log.d('NameMirror', `account changed since ${pending.size} change(s) were learned - dropped`);
    pending.clear();
    return;
  }
  const batch = new Map(pending);
  pending.clear();
  const names: Record<string, string> = {};
  const removed: string[] = [];
  for (const [id, name] of batch) {
    if (name === null) removed.push(id);
    else names[id] = name;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const held = await invoke<number>('store_display_names', { userId, names, removed });
    Log.d(
      'NameMirror',
      `mirrored ${batch.size - removed.length} name(s), ${removed.length} removal(s), ${held} held`
    );
  } catch (e) {
    // A newer change for the same id, noted while this one failed, wins.
    for (const [id, name] of batch) if (!pending.has(id)) pending.set(id, name);
    console.warn(`[NAME_MIRROR] store failed, ${batch.size} change(s) kept: ${String(e)}`);
  }
}

/**
 * Writes every change not written yet. Only a mobile Tauri build ever notes one: the web and the
 * desktop have no native push path. Resolves once the pending changes it found are written (or
 * kept after a failure), including a write that was already in flight when it was called.
 */
export async function flushNameMirror(): Promise<void> {
  while (inFlight) await inFlight;
  if (pending.size === 0) return;
  inFlight = writePending().finally(() => {
    inFlight = null;
  });
  await inFlight;
}

/** How many changes wait for the next write - for tests and a debug surface. */
export function pendingMirroredNames(): number {
  return pending.size;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushNameMirror();
  });
}
