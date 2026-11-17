/**
 * THE CONVERSATIONS A SHUT APP JOINED FROM A PUSH, HANDED TO THE APP AT ITS START, SO EACH IS OWED
 * ITS REGISTER LIKE ONE THE PAGE JOINED (docs/wiki/protocols/history-answer-addressing.md, "The
 * newcomer asks for its register").
 *
 * The push service installs a Welcome into `mls.bin` itself while no page runs
 * (`process_welcome_background_with_key`). The page later sees that Welcome redelivered for a group
 * it already holds - the idempotent branch of the Welcome handler, which admits nothing - so the
 * admission's three notes were never written: the register owed (`registerOwed.ts`), the inviter's
 * push solicited (`historyAddressing.ts`), and the fresh join announced (`onWelcomeProcessed`'s
 * `installed`). The native side notes every join it makes (`background_joins.json`); the app takes
 * and clears that ledger once per start, before anything drains.
 *
 * A FACT, NOT A GUESS: the ledger is written by the code that did the join, and believed only when
 * the MLS state loaded at this start holds the group (the tree is the fact - a note whose install
 * was refused names a group it does not hold).
 */

import type { IMlsService } from '$lib/mls-client/IMlsService';
import { holdsGroupState } from '$lib/utils/chat/groupUsability';
import { noteRegisterOwed } from '$lib/utils/chat/registerOwed';
import { isTauriRuntime } from '$lib/utils/openExternal';

/**
 * The groups taken at this start whose redelivered Welcome is still to come: the Welcome handler
 * reads each ONCE ({@link takeBackgroundJoined}) and treats that Welcome as the admission it was.
 * In memory, because the register owed - the durable part - is written at the take.
 */
const joinedInBackground = new Set<string>();

/** What {@link adoptBackgroundJoins} did, for the caller's one log line. */
export interface BackgroundJoinAdoption {
  owed: number;
  ignored: number;
}

/**
 * Makes every CONVERSATION the push service joined owe its register, and remembers it for its
 * redelivered Welcome. A group the loaded state does not hold, or a key group (no conversation
 * state), is logged and left. Split from the invoke so it is tested without a Tauri runtime.
 */
export function adoptBackgroundJoins(
  mlsService: Pick<IMlsService, 'isDistributionGroup'>,
  userId: string,
  groups: readonly string[],
  holds: (groupId: string) => boolean,
  log: (line: string) => void
): BackgroundJoinAdoption {
  const result: BackgroundJoinAdoption = { owed: 0, ignored: 0 };
  for (const groupId of groups) {
    const short = groupId.slice(0, 8);
    if (!holds(groupId)) {
      log(`[BG_JOIN] ${short}… joined in the background but NOT in the loaded state - ignored`);
      result.ignored++;
      continue;
    }
    if (mlsService.isDistributionGroup(groupId)) {
      log(`[BG_JOIN] ${short}… joined in the background is a key group - no register to owe`);
      result.ignored++;
      continue;
    }
    noteRegisterOwed(userId, groupId);
    joinedInBackground.add(groupId);
    result.owed++;
  }
  return result;
}

/**
 * Whether `groupId` was joined in the background and its redelivered Welcome not yet seen - read
 * ONCE: the first redelivery is the admission, any later one is a redelivery like any other.
 */
export function takeBackgroundJoined(groupId: string): boolean {
  return joinedInBackground.delete(groupId);
}

/**
 * Forgets `groupId` in the native ledger: the PAGE installed its Welcome itself, so whatever a
 * background engine noted for it is stale - a join whose `mls.bin` write was refused, or that the
 * page's own persist erased (review of #3777, P2-2). Left there, the next start would find the group
 * held, owe its register again although the page took it, and this device would DECLINE newcomers
 * it could answer. A no-op off the native app; a failure is said at error, never thrown - the
 * install it follows must not fail for it.
 */
export async function forgetBackgroundJoin(groupId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('forget_background_join', { groupId });
  } catch (e) {
    console.error(
      `[BG_JOIN] ${groupId.slice(0, 8)}… - its background note could not be forgotten; the next start may owe a register already taken: ${String(e).slice(0, 160)}`
    );
  }
}

/**
 * Takes the native ledger and adopts it. A no-op off the native app; a ledger that could not be
 * taken is said at error, and those conversations ask for no register.
 */
export async function takeBackgroundJoins(
  mlsService: IMlsService,
  userId: string,
  log: (line: string) => void
): Promise<BackgroundJoinAdoption | null> {
  if (!isTauriRuntime()) return null;
  // A START TAKES ANEW: what an earlier session of this page took (another account, a sign-out) is
  // not this one's.
  joinedInBackground.clear();
  let groups: string[];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    groups = await invoke<string[]>('take_background_joins');
  } catch (e) {
    console.error(
      `[BG_JOIN] the background-join ledger could not be taken - those conversations ask no register: ${String(e).slice(0, 160)}`
    );
    return null;
  }
  if (groups.length === 0) return { owed: 0, ignored: 0 };
  const result = adoptBackgroundJoins(
    mlsService,
    userId,
    groups,
    (groupId) => holdsGroupState(mlsService, groupId),
    log
  );
  log(
    `[BG_JOIN] ${groups.length} conversation(s) joined in the background: ${result.owed} owe their register, ${result.ignored} left`
  );
  return result;
}
