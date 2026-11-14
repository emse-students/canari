import { currentUserId } from '$lib/stores/user';
import { isMobileTauriRuntime } from '$lib/utils/appVersion';
import { Log } from '$lib/utils/Log';

/**
 * The per-conversation nicknames this account may see, mirrored for the native push path (owner,
 * 2026-11-14: *"comme sur Messenger, tous les pseudos"* - a notification names a member by the
 * nickname set in THAT conversation, lock screen included - and *"Tout pourrait etre donne par
 * l'appareil et rien par le serveur"*: the device composes the name, no push carries one).
 *
 * The FCM service, the iOS extension and `canari_push.mm` cannot ask this WebView, so it hands
 * them what its register holds: `store_conversation_nicknames` (Rust,
 * `commands/conversation_nicknames.rs`) merges each change into `conversation_nicknames.json`, which
 * they read under the rule of `libs/contracts/notification-nickname.cases.json`. What is noted here
 * is already the VISIBLE nickname (`conversationNicknames.svelte.ts` applies the block rule before
 * noting), so a reader applies none.
 *
 * Built like `nameMirror.ts`: a change schedules ONE write at the end of the current task, one write
 * is in flight at a time, a failed write keeps its changes for the next one, hiding the app flushes
 * as an extra chance. No timer. The copy is one account's: changes learned under an account are never
 * written under the next one, and the sign-out removes the copy ({@link forgetNicknameMirror}).
 */

type Change = { scope: string; memberId: string; nickname: string | null };

/** Nickname changes since the last write, by `scope \0 member`. */
const pending = new Map<string, Change>();
/** Salon placements since the last write: salon id -> community scope, or `null` to forget it. */
const pendingSalons = new Map<string, string | null>();
/**
 * Scopes whose WHOLE register is restated by the changes noted after it: Rust empties each before
 * applying them, so an entry the device no longer holds (a community's list that stopped naming a
 * member, an eviction a killed app never wrote) leaves the copy too.
 */
const pendingRestated = new Set<string>();
/** The session's first write is owed even when it carries nothing: it makes the copy this account's. */
let sessionWriteOwed = false;
/** The account those changes were learned under. */
let pendingOwner: string | null = null;
/** The write in flight, if any - there is never more than one. */
let inFlight: Promise<void> | null = null;
/** A write is already scheduled for the end of the current task. */
let scheduled = false;

/** The signed-in account when a native reader exists to mirror for; null otherwise. */
function owner(): string | null {
  const id = currentUserId()?.trim().toLowerCase();
  return id && isMobileTauriRuntime() ? id : null;
}

/** Starts a fresh batch when the account changed, and schedules the write; false when not noted. */
function prepare(): boolean {
  const who = owner();
  if (!who) return false;
  if (pendingOwner !== who) {
    pending.clear();
    pendingSalons.clear();
    pendingRestated.clear();
    sessionWriteOwed = false;
    pendingOwner = who;
  }
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void flushNicknameMirror();
    });
  }
  return true;
}

/**
 * Records the nickname a notification gives `memberId` in `scope` - `null` for none (a reset, an
 * eviction, a nickname this account may not see). The later fact for one member wins.
 */
export function noteMirroredNickname(
  scope: string,
  memberId: string,
  nickname: string | null
): void {
  const member = memberId.trim().toLowerCase();
  if (!scope || !member || !prepare()) return;
  pending.set(`${scope}\u0000${member}`, { scope, memberId: member, nickname });
}

/**
 * Records that the salon `channelId` (with or without its `channel_` prefix) belongs to the community
 * whose nickname scope is `scope`, or that it is gone (`null`). A salon push names its salon only.
 */
export function noteMirroredSalon(channelId: string, scope: string | null): void {
  const id = channelId.replace(/^channel_/, '').trim();
  if (!id || !prepare()) return;
  pendingSalons.set(id, scope);
}

/**
 * Says that the changes noted next restate `scope`'s whole register: the copy forgets what it held
 * there first. A change for `scope` noted before this is dropped - the restatement supersedes it.
 */
export function noteMirroredScopeRestated(scope: string): void {
  if (!scope || !prepare()) return;
  for (const key of pending.keys()) if (key.startsWith(`${scope}\u0000`)) pending.delete(key);
  pendingRestated.add(scope);
}

/**
 * Owes one write at the start of a signed-in session even when nothing changed, so the copy names
 * THIS account from then on (a copy left by the previous account of the install is replaced, not
 * kept beside it) and an absent file is a fault a reader may accuse rather than an ordinary state.
 */
export function noteMirrorSessionStart(): void {
  if (!prepare()) return;
  sessionWriteOwed = true;
}

/** Whether anything waits for a write. */
const hasPending = () =>
  pending.size > 0 || pendingSalons.size > 0 || pendingRestated.size > 0 || sessionWriteOwed;

/** Hands the pending changes to Rust in ONE call; on failure they are kept for the next write. */
async function writePending(): Promise<void> {
  const userId = owner();
  if (!userId || userId !== pendingOwner) {
    Log.d(
      'NicknameMirror',
      `account changed since ${pending.size + pendingSalons.size} change(s) were learned - dropped`
    );
    pending.clear();
    pendingSalons.clear();
    pendingRestated.clear();
    sessionWriteOwed = false;
    return;
  }
  const changes = new Map(pending);
  const salons = new Map(pendingSalons);
  const restated = [...pendingRestated];
  const owedSession = sessionWriteOwed;
  pending.clear();
  pendingSalons.clear();
  pendingRestated.clear();
  sessionWriteOwed = false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const held = await invoke<number>('store_conversation_nicknames', {
      userId,
      changes: [...changes.values()],
      channels: [...salons].map(([channelId, scope]) => ({ channelId, scope })),
      restatedScopes: restated,
    });
    Log.d(
      'NicknameMirror',
      `mirrored ${changes.size} nickname change(s), ${salons.size} salon(s), ${restated.length} scope(s) restated, ${held} held`
    );
  } catch (e) {
    // A newer change for the same key, noted while this one failed, wins.
    for (const [k, c] of changes) if (!pending.has(k)) pending.set(k, c);
    for (const [k, s] of salons) if (!pendingSalons.has(k)) pendingSalons.set(k, s);
    // A restatement is kept with its changes: Rust empties the scope before applying them, so a
    // change noted for it since is applied after the emptying, as it was noted after the restatement.
    for (const scope of restated) pendingRestated.add(scope);
    if (owedSession) sessionWriteOwed = true;
    console.warn(
      `[NICKNAME_MIRROR] store failed, ${changes.size + salons.size + restated.length} change(s) kept: ${String(e)}`
    );
  }
}

/**
 * Writes every change not written yet. Resolves once the changes it found are written (or kept after
 * a failure), including a write already in flight when it was called.
 */
export async function flushNicknameMirror(): Promise<void> {
  while (inFlight) await inFlight;
  if (!hasPending()) return;
  inFlight = writePending().finally(() => {
    inFlight = null;
  });
  await inFlight;
}

/**
 * Removes `userId`'s native copy and drops what was noted for it - the sign-out's half of
 * `forgetConversationNicknames`: a mirror outliving its account is a defect. Only the copy that
 * names `userId` is removed (Rust checks the owner).
 */
export async function forgetNicknameMirror(userId: string): Promise<void> {
  const who = userId.trim().toLowerCase();
  if (!who || !isMobileTauriRuntime()) return;
  if (pendingOwner === who) {
    pending.clear();
    pendingSalons.clear();
    pendingRestated.clear();
    sessionWriteOwed = false;
  }
  // A WRITE ALREADY IN FLIGHT LANDS BEFORE THE REMOVAL, never after it: a store for this account
  // completing once the copy is gone would recreate it after the sign-out.
  while (inFlight) await inFlight;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const removed = await invoke<boolean>('forget_conversation_nicknames', { userId: who });
    Log.d('NicknameMirror', `sign-out: native copy ${removed ? 'removed' : 'absent'}`);
  } catch (e) {
    console.error(
      `[NICKNAME_MIRROR] the native copy of ${who.slice(0, 8)} was NOT removed: ${String(e)}`
    );
  }
}

/** How many changes wait for the next write - for tests and a debug surface. */
export function pendingMirroredNicknames(): number {
  return pending.size + pendingSalons.size + pendingRestated.size + (sessionWriteOwed ? 1 : 0);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushNicknameMirror();
  });
}
