import { currentUserId } from '$lib/stores/user';
import { isMobileTauriRuntime } from '$lib/utils/appVersion';
import { Log } from '$lib/utils/Log';

/**
 * The names this device has resolved, mirrored for the native push path (WP-MENTION-NAME,
 * decided 2026-10-18).
 *
 * A mention travels as `@[<64 hex>]` and a push handler has no name directory, so its banner said
 * "@someone" for everybody but its reader. The decision: the name comes from the PHONE'S OWN copy -
 * what this WebView already resolved for the signed-in account - and never from the push, which the
 * server would have to fill and Google or Apple would carry. `store_display_names` (Rust,
 * `commands/display_names.rs`) merges what is handed here into `display_names.json`, which the FCM
 * service, the iOS extension and `canari_push.mm` read; an id it does not hold stays "someone".
 *
 * WRITTEN WHEN THE APP IS HIDDEN, AND THAT IS A PROOF RATHER THAN A SCHEDULE. A mention banner is
 * only drawn natively while the app is not in front, and reaching that state fires
 * `visibilitychange` to `hidden` first - so a name learned in this session is on disk before any
 * banner that could show it. One write per hide, of only the names learned since the last one, and
 * none at all when nothing was learned: no timer decides anything here.
 */

/** A mention can only name a 64-hex user id; anything else could never be looked up natively. */
const MENTION_ID = /^[0-9a-f]{64}$/;

/** Names learned since the last write, by lower-cased id. */
const pending = new Map<string, string>();
/**
 * The account those names were learned under. The native file is one account's, so names noted
 * before a sign-out are never written under the account that signs in after it.
 */
let pendingOwner: string | null = null;

/**
 * Records a name the app has RESOLVED for `userId` - a real name, never the unknown-user label,
 * which would then be printed on a banner as if it were somebody's name.
 *
 * Cheap and synchronous: it only remembers, {@link flushNameMirror} writes.
 */
export function noteResolvedName(userId: string, name: string): void {
  const id = userId.trim().toLowerCase();
  const value = name.trim();
  const owner = currentUserId()?.trim().toLowerCase();
  if (!value || !owner || !MENTION_ID.test(id) || !isMobileTauriRuntime()) return;
  if (pendingOwner !== owner) {
    pending.clear();
    pendingOwner = owner;
  }
  pending.set(id, value);
}

/**
 * Hands every name learned since the last call to the native mirror. Only a mobile Tauri build
 * ever notes one ({@link noteResolvedName}): the web and the desktop have no native push path.
 *
 * A failed write keeps its names for the next hide (a newer name for the same id wins), and is
 * logged at the level that accuses: it costs a banner "someone" where a name was known.
 */
export async function flushNameMirror(): Promise<void> {
  if (pending.size === 0) return;
  const userId = currentUserId()?.trim().toLowerCase();
  if (!userId || userId !== pendingOwner) {
    Log.d('NameMirror', `account changed since ${pending.size} name(s) were learned - dropped`);
    pending.clear();
    return;
  }
  const batch = new Map(pending);
  pending.clear();
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const held = await invoke<number>('store_display_names', {
      userId,
      names: Object.fromEntries(batch),
    });
    Log.d('NameMirror', `mirrored ${batch.size} name(s), ${held} held natively`);
  } catch (e) {
    for (const [id, name] of batch) if (!pending.has(id)) pending.set(id, name);
    console.warn(`[NAME_MIRROR] store failed, ${batch.size} name(s) kept: ${String(e)}`);
  }
}

/** How many names wait for the next write - for tests and a debug surface. */
export function pendingMirroredNames(): number {
  return pending.size;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushNameMirror();
  });
}
