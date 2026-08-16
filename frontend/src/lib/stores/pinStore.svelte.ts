import { SvelteMap } from 'svelte/reactivity';

/**
 * Per-conversation pin state, as a last-write-wins register per message.
 *
 * Pin/unpin are shared actions: for DMs/groups they arrive as MLS `pin`/`unpin` system events (every
 * member applies them), for channels via server `channel.pin` events. Each device persists the
 * result in localStorage so it survives reloads, and it rides every `history_bundle` so a device
 * that was not there when the frame went out still converges.
 *
 * WHY A DATED REGISTER AND NOT A SET. Every other message mutation carries the clock its merge needs
 * - a reaction dates each `(user, emoji)` pair, an edit dates itself, a deletion is absorbing - and
 * pin was the one that carried nothing. Without a date there is no way to merge two devices'
 * answers: a union lets a peer that has not seen the `unpin` resurrect a pin, and a replacement
 * makes the outcome depend on which answer landed last. So an `unpin` is a dated entry rather than a
 * removal (a tombstone, exactly like a removed reaction), and the larger `at` wins.
 */

const storageKey = (conversationId: string) => `canari_pins_${conversationId}`;

/** One message's pin state and the sender's clock for it. */
export type PinEntry = { pinned: boolean; at: number };

/**
 * Total entries kept per conversation, pins and tombstones together, oldest evicted first.
 *
 * Bounded because a tombstone is never discharged by anything: without a cap, a conversation that
 * pins and unpins for years grows this without limit. The cost of the cap is that a bundle carrying
 * a pin OLDER than the oldest tombstone still held can resurrect it - which needs 500 distinct
 * pinned messages in one conversation to reach, and is written down rather than left to be found.
 */
const MAX_ENTRIES = 500;

// Plain Map for the per-conversation container: it's written lazily by load() which may run inside a
// $derived (reading pinnedMessageIds). Tracking it would throw state_unsafe_mutation on first
// access. Reactivity is carried by each inner SvelteMap instead - that's what pin/unpin mutate.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- intentional: see comment above
const pins = new Map<string, SvelteMap<string, PinEntry>>();

/**
 * Reads the persisted shape, accepting the pre-2026-08-16 one.
 *
 * That shape was a bare `string[]` of pinned ids with no dates. They are read back at `at: 0`, which
 * is the honest value: any dated statement about the same message, from any device, is newer than a
 * record that never knew when it was made. See `docs/wiki/legacy-compatibility.md`.
 */
function parseStored(raw: string): Array<[string, PinEntry]> {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return parsed
      .filter((id): id is string => typeof id === 'string' && !!id)
      .map((id) => [id, { pinned: true, at: 0 }]);
  }
  if (!parsed || typeof parsed !== 'object') return [];
  return Object.entries(parsed as Record<string, unknown>).flatMap(([id, v]) => {
    if (!id || !v || typeof v !== 'object') return [];
    const e = v as { pinned?: unknown; at?: unknown };
    return [[id, { pinned: e.pinned === true, at: Number(e.at) || 0 }] as [string, PinEntry]];
  });
}

/** Lazily loads (and caches) the pin register for a conversation from localStorage. */
function load(conversationId: string): SvelteMap<string, PinEntry> {
  const existing = pins.get(conversationId);
  if (existing) return existing;
  const map = new SvelteMap<string, PinEntry>();
  try {
    const raw = localStorage.getItem(storageKey(conversationId));
    if (raw) for (const [id, entry] of parseStored(raw)) map.set(id, entry);
  } catch {
    // ignore corrupt/inaccessible storage
  }
  pins.set(conversationId, map);
  return map;
}

function persist(conversationId: string, map: SvelteMap<string, PinEntry>): void {
  // Evict oldest-first when over the cap. A pin is never dropped while a tombstone survives it:
  // both are ordered by the same `at`, which is the only ordering either of them has.
  if (map.size > MAX_ENTRIES) {
    const doomed = [...map.entries()]
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, map.size - MAX_ENTRIES);
    for (const [id] of doomed) map.delete(id);
  }
  try {
    localStorage.setItem(storageKey(conversationId), JSON.stringify(Object.fromEntries(map)));
  } catch {
    // ignore quota / private-mode errors
  }
}

/**
 * Does `next` supersede `held`?
 *
 * Strictly later wins; a TIE is resolved in favour of unpinning. The tie needs a rule at all because
 * two devices must reach the same answer from the same pair, and "keep what I had" is not a rule -
 * it depends on arrival order. Unpinning wins because it is the state a user can always restore.
 */
function supersedes(next: PinEntry, held: PinEntry | undefined): boolean {
  if (!held) return true;
  if (next.at !== held.at) return next.at > held.at;
  return !next.pinned && held.pinned;
}

/** Returns the pinned message IDs for a conversation (reactive). */
export function pinnedMessageIds(conversationId: string): string[] {
  return [...load(conversationId)].filter(([, e]) => e.pinned).map(([id]) => id);
}

/** The full register, tombstones included - what a `history_bundle` carries so peers can merge it. */
export function pinEntries(
  conversationId: string
): Array<{ id: string; pinned: boolean; at: number }> {
  return [...load(conversationId)].map(([id, e]) => ({ id, pinned: e.pinned, at: e.at }));
}

/** Whether a given message is pinned in a conversation (reactive). */
export function isMessagePinned(conversationId: string, messageId: string): boolean {
  return load(conversationId).get(messageId)?.pinned === true;
}

/**
 * Replaces the entire pin register from an AUTHORITATIVE list (the server's, on channel open).
 *
 * Only a channel has one of these. Every id it names is stamped `now`, which is correct precisely
 * because the source is authoritative: there is nothing to merge against it.
 */
export function setPinnedSet(conversationId: string, messageIds: string[]): void {
  if (!conversationId) return;
  const map = load(conversationId);
  const at = Date.now();
  map.clear();
  for (const id of messageIds) if (id) map.set(id, { pinned: true, at });
  persist(conversationId, map);
}

/**
 * Merges a peer's register into ours, entry by entry, larger `at` winning.
 *
 * Accepts the dated shape and, for one release, the bare `string[]` its predecessor sent - undated,
 * so read at `at: 0` and beaten by anything this device knows the date of.
 *
 * Returns how many entries actually changed, so the caller can report a convergence it did not
 * compute - and stay silent when a bundle restated what we already had, which is the common case.
 */
export function mergePinEntries(conversationId: string, incoming: unknown): number {
  if (!conversationId || !Array.isArray(incoming) || incoming.length === 0) return 0;
  const map = load(conversationId);
  let changed = 0;
  for (const raw of incoming) {
    let id: string | undefined;
    let entry: PinEntry | undefined;
    if (typeof raw === 'string') {
      id = raw;
      entry = { pinned: true, at: 0 };
    } else if (raw && typeof raw === 'object') {
      const r = raw as { id?: unknown; pinned?: unknown; at?: unknown };
      if (typeof r.id === 'string') {
        id = r.id;
        entry = { pinned: r.pinned !== false, at: Number(r.at) || 0 };
      }
    }
    if (!id || !entry) continue;
    if (!supersedes(entry, map.get(id))) continue;
    map.set(id, entry);
    changed++;
  }
  if (changed > 0) persist(conversationId, map);
  return changed;
}

/**
 * Applies one dated pin/unpin, and says whether it was the newest statement about that message.
 *
 * `false` means a later one is already held - which is the ordinary outcome of replaying a log a
 * device has already followed, not a failure.
 */
export function applyPin(
  conversationId: string,
  messageId: string,
  pinned: boolean,
  at: number
): boolean {
  if (!conversationId || !messageId) return false;
  const map = load(conversationId);
  const entry: PinEntry = { pinned, at: Number(at) || 0 };
  if (!supersedes(entry, map.get(messageId))) return false;
  map.set(messageId, entry);
  persist(conversationId, map);
  return true;
}
