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

import { currentUserId } from '$lib/stores/userState.svelte';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/**
 * PER ACCOUNT. The register is stored under the signed-in account ({@link ACCOUNT_KEY}
 * `.conversationPins`), so two accounts sharing a conversation on one install keep two registers, and
 * an account deletion sweeps its own. With nobody signed in it lives in memory only.
 */
const owner = (): string => (currentUserId() ?? '').trim();

/**
 * THE KEY OF BUILDS BEFORE 2026-11-12, named by the conversation alone, so shared by every account of
 * the install and swept by nothing. Moved once to the account that first reads the conversation
 * (`takeLegacyRegister`); see `docs/wiki/legacy-compatibility.md`.
 */
const legacyKey = (conversationId: string) => `canari_pins_${conversationId}`;

/**
 * Moves a conversation's legacy register to `account`, and returns it (or null when there is none).
 *
 * The legacy copy was every account's, so whichever account reads the conversation first takes it -
 * the same register those accounts already shared - and nobody after it does.
 *
 * THE LEGACY KEY GOES ONLY ONCE THE COPY IS WRITTEN. A write that throws (quota, private mode) keeps
 * it, so nothing is lost: the register is still read from it this time, and the move is tried again
 * on the next load.
 */
function takeLegacyRegister(account: string, conversationId: string): string | null {
  const legacy = legacyKey(conversationId);
  const raw = localStorage.getItem(legacy);
  if (raw === null) return null;
  try {
    localStorage.setItem(ACCOUNT_KEY.conversationPins(account, conversationId), raw);
  } catch (e) {
    console.warn(
      `[PINS] legacy register of ${conversationId.slice(0, 8)}… not moved, kept where it is: ${String(e)}`
    );
    return raw;
  }
  localStorage.removeItem(legacy);
  console.log(
    `[PINS] legacy register of ${conversationId.slice(0, 8)}… moved to the signed-in account`
  );
  return raw;
}

/**
 * Forgets every pin register of `userId` on this install - its stored copies and what is in memory.
 * Run at sign-out (`clearUserLocally`) and by the account deletion (`eraseAccountRecordsLocally`), as
 * the nickname registers are: a shared install keeps nothing of the account that left, and the
 * history bundles restate the pins after the next sign-in.
 */
export function forgetConversationPins(userId: string): void {
  const account = userId.trim();
  if (!account) return;
  const prefix = ACCOUNT_KEY.conversationPins(account, '');
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch (e) {
    console.warn(`[PINS] stored registers of ${account.slice(0, 8)} not removed: ${String(e)}`);
  }
  // Deleting the entry being visited is defined for a Map's iterator: no copy is needed.
  for (const key of pins.keys()) if (key.startsWith(`${account}|`)) pins.delete(key);
  revision++;
}

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

// ONE REVISION CARRIES THE REACTIVITY, NOT A SVELTEMAP PER CONVERSATION. A register is created
// lazily by `load()`, and its first read is very often a `$derived` (the pinned banner). A source
// created INSIDE a reaction is not tracked by it, so a SvelteMap born there never told that derived
// about the first pin applied after it (pinStore.reactive.svelte.test.ts, 2026-11-09). `revision` is
// created with the module, outside every reaction: every reader reads it, every write bumps it. The
// containers are plain Maps, written by `load()` without notifying anyone, which a derived may do.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- `revision` carries the reactivity
const pins = new Map<string, Map<string, PinEntry>>();
let revision = $state(0);

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

/**
 * Lazily loads (and caches) the signed-in account's pin register for a conversation from
 * localStorage; a reactive read. The cache is keyed by account too, so a switch never reads the
 * previous account's register.
 */
function load(conversationId: string): Map<string, PinEntry> {
  void revision;
  const account = owner();
  const cacheKey = `${account}|${conversationId}`;
  const existing = pins.get(cacheKey);
  if (existing) return existing;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- `revision` carries the reactivity
  const map = new Map<string, PinEntry>();
  if (account) {
    try {
      const raw =
        localStorage.getItem(ACCOUNT_KEY.conversationPins(account, conversationId)) ??
        takeLegacyRegister(account, conversationId);
      if (raw) for (const [id, entry] of parseStored(raw)) map.set(id, entry);
    } catch (e) {
      // An unreadable copy costs the pins until the next bundle restates them - and it is said,
      // because nothing else would.
      console.warn(
        `[PINS] stored register unreadable for ${conversationId.slice(0, 8)}…: ${String(e)}`
      );
    }
  }
  pins.set(cacheKey, map);
  return map;
}

function persist(conversationId: string, map: Map<string, PinEntry>): void {
  revision++;
  // Evict oldest-first when over the cap. A pin is never dropped while a tombstone survives it:
  // both are ordered by the same `at`, which is the only ordering either of them has.
  if (map.size > MAX_ENTRIES) {
    const doomed = [...map.entries()]
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, map.size - MAX_ENTRIES);
    for (const [id] of doomed) map.delete(id);
  }
  const account = owner();
  if (!account) return;
  try {
    localStorage.setItem(
      ACCOUNT_KEY.conversationPins(account, conversationId),
      JSON.stringify(Object.fromEntries(map))
    );
  } catch (e) {
    console.warn(`[PINS] register not persisted for ${conversationId.slice(0, 8)}…: ${String(e)}`);
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
