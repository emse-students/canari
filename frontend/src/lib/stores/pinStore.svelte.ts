import { SvelteSet } from 'svelte/reactivity';

/**
 * Reactive set of pinned message IDs per conversation.
 *
 * Pin/unpin are shared actions: for DMs/groups they arrive as MLS `pin`/`unpin`
 * system events (every member applies them), for channels via server `channel.pin`
 * events. Each device persists the resulting set in localStorage so it survives
 * reloads; replaying the events on history sync keeps devices converged.
 */

const storageKey = (conversationId: string) => `canari_pins_${conversationId}`;

// Plain Map for the per-conversation container: it's written lazily by load()
// which may run inside a $derived (reading pinnedMessageIds). Tracking it would
// throw state_unsafe_mutation on first access. Reactivity is carried by each
// inner SvelteSet instead - that's what pin/unpin actually mutate.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- intentional: see comment above
const pins = new Map<string, SvelteSet<string>>();

/** Lazily loads (and caches) the pinned set for a conversation from localStorage. */
function load(conversationId: string): SvelteSet<string> {
  const existing = pins.get(conversationId);
  if (existing) return existing;
  const set = new SvelteSet<string>();
  try {
    const raw = localStorage.getItem(storageKey(conversationId));
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) for (const id of arr) if (typeof id === 'string') set.add(id);
    }
  } catch {
    // ignore corrupt/inaccessible storage
  }
  pins.set(conversationId, set);
  return set;
}

function persist(conversationId: string, set: SvelteSet<string>): void {
  try {
    localStorage.setItem(storageKey(conversationId), JSON.stringify([...set]));
  } catch {
    // ignore quota / private-mode errors
  }
}

/** Returns the pinned message IDs for a conversation (reactive). */
export function pinnedMessageIds(conversationId: string): string[] {
  return [...load(conversationId)];
}

/** Whether a given message is pinned in a conversation (reactive). */
export function isMessagePinned(conversationId: string, messageId: string): boolean {
  return load(conversationId).has(messageId);
}

/** Replaces the entire pinned set for a conversation (e.g. from the server list on channel open). */
export function setPinnedSet(conversationId: string, messageIds: string[]): void {
  if (!conversationId) return;
  const set = load(conversationId);
  set.clear();
  for (const id of messageIds) if (id) set.add(id);
  persist(conversationId, set);
}

/**
 * Adopts a peer's pinned set for a conversation this device holds no pin state for.
 *
 * SEEDS, NEVER OVERWRITES. A `history_bundle` states what the ANSWERING device holds, and there is
 * no clock to order that against ours - taking it wholesale would let a peer that has not yet seen
 * an `unpin` resurrect a pin this device just took back. An empty set is the one case with nothing
 * to lose, and it is exactly the gap this closes: a device that was not in the conversation when
 * the `pin` frame went out has no other way of ever learning about it, because the frame itself
 * ages out of the server's retention window while the pin does not (MUT-15).
 *
 * Returns whether anything was adopted - the caller reports a state change it did not compute.
 */
export function seedPinnedSet(conversationId: string, messageIds: unknown): boolean {
  if (!conversationId || !Array.isArray(messageIds) || messageIds.length === 0) return false;
  const set = load(conversationId);
  if (set.size > 0) return false;
  for (const id of messageIds) if (typeof id === 'string' && id) set.add(id);
  if (set.size === 0) return false;
  persist(conversationId, set);
  return true;
}

/** Applies a pin/unpin to the local set and persists it. */
export function applyPin(conversationId: string, messageId: string, pinned: boolean): void {
  if (!conversationId || !messageId) return;
  const set = load(conversationId);
  if (pinned) set.add(messageId);
  else set.delete(messageId);
  persist(conversationId, set);
}
