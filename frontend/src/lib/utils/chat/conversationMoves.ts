/**
 * WHERE A CONVERSATION'S MAP KEY WENT - the re-key as a FACT, written by the one writer that moves a
 * thread under a new key (the Welcome folding a duplicate DM onto the group it joined,
 * `setupMessageHandler`), and read by every store that holds rows under the OLD key: the bulk
 * buffer, the framed orphans, the kept batches and writes (`useMessaging`).
 *
 * Inferring the move from what the new thread shows fails exactly when it matters: a row decrypted
 * during a catch-up window is shown nowhere yet, and a thread that showed nothing when it moved
 * carries no id to find it by. Unknown, its rows were dropped as if the conversation had been
 * removed, and their frames acknowledged (review of #4054). See
 * [chat](docs/wiki/frontend/modules/chat.md#a-catch-up-lands-in-one-render-2026-11-24).
 *
 * Page memory, like the rows it routes: forgotten at sign-out ({@link forgetConversationMoves}).
 */

import { SvelteMap, SvelteSet } from 'svelte/reactivity';

/** Old map key -> the key the thread moved to. */
const movedTo = new SvelteMap<string, string>();

/** Notes that the thread under `oldKey` now lives under `newKey`. */
export function recordConversationMove(oldKey: string, newKey: string): void {
  const from = oldKey.toLowerCase();
  const to = newKey.toLowerCase();
  if (!from || !to || from === to) return;
  console.debug(`[ADD_MSG] conversation "${from}" moved to "${to}"`);
  movedTo.set(from, to);
}

/**
 * The key the thread once under `key` lives under now, following every move noted since (a cycle
 * ends the walk), or `null` when no move was noted for it.
 */
export function movedKeyOf(key: string): string | null {
  let current = key.toLowerCase();
  const seen = new SvelteSet<string>([current]);
  for (let next = movedTo.get(current); next !== undefined; next = movedTo.get(current)) {
    if (seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current === key.toLowerCase() ? null : current;
}

/** Forgets every move noted (sign-out); returns how many there were. */
export function forgetConversationMoves(): number {
  const count = movedTo.size;
  movedTo.clear();
  return count;
}
