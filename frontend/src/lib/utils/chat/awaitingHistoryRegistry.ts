// ---------------------------------------------------------------------------
// Persistent registry of MLS groups still awaiting their pre-join history bundle.
//
// A device that (re)joins a group via an external commit or a Welcome lands at the current epoch
// WITHOUT the pre-join history it cannot decrypt on its own: it must solicit a re-encrypted bundle
// from an online member. That solicitation used to be a one-shot burst tied to the join event
// (bounded retries over ~3 min, in-memory only). If the sole reachable member stayed offline for
// that window, the bundle never arrived AND was never re-requested - a later session finds the group
// already in WASM, so recovery (which owns the solicit) short-circuits and never re-solicits.
//
// This registry makes the "still needs history" intent durable: it is set when a solicitation
// starts and cleared once a bundle actually arrives. The connection sync re-solicits every awaiting
// group on each (re)connect, so the history is retried across sessions until it lands.
//
// EVERY marker carries the EVIDENCE that justified it. The registry used to be written on the mere
// fact of joining, which made "I rejoined" mean "history is missing" - false for the commonest join
// of all: a device rotating its MLS identity in a browser whose message store (keyed by USER, not
// by device) still holds everything. Such a device marked EVERY one of its groups, solicited them
// forever and showed the pending banner over conversations that were already complete. A reason is
// therefore mandatory, and a marker without one is legacy: it proves nothing and is dropped rather
// than replayed.
// ---------------------------------------------------------------------------

const PREFIX = 'mls_awaiting_history_since';

/**
 * Why a group is recorded as awaiting its history bundle.
 * - `no-local-history`: we hold NOTHING for this group, so we cannot tell an empty conversation
 *   from a missing one - the presumption of a gap, and the only case a blind ask is warranted.
 * - `unreadable-frames`: the replay actually gave up on a frame it could never decrypt (pre-join
 *   or forked epoch). A re-encrypted bundle is the ONLY way to obtain it: a proven gap.
 * - `peer-holds-more`: a manifest diff named messages a peer holds and we do not (WP-HIST-3). The
 *   strongest evidence of all - not a presumption from emptiness, nor a frame we failed to read,
 *   but message ids the other side listed. This is what turns "awaiting history" from a state that
 *   only a bundle can end into one that empties itself: the marker lasts exactly as long as the
 *   difference does.
 */
export type AwaitingHistoryReason = 'no-local-history' | 'unreadable-frames' | 'peer-holds-more';

/**
 * Ranks the evidence behind a marker. A PROOF must never be overwritten by a PRESUMPTION: a device
 * that knows a specific frame is unreadable, or knows the exact ids a peer holds, has learnt
 * something a later "my store looks non-empty" cannot unlearn.
 */
const REASON_RANK: Record<AwaitingHistoryReason, number> = {
  'no-local-history': 0,
  'peer-holds-more': 1,
  'unreadable-frames': 1,
};

/** A stored marker: when we started waiting, and the evidence that we are. */
type AwaitingMarker = { since: number; reason: AwaitingHistoryReason };

/**
 * Parses a stored marker, returning null for anything that carries no evidence - malformed
 * entries, and the legacy bare-timestamp format written by the old join-time solicitation.
 */
function readMarker(raw: string | null): AwaitingMarker | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AwaitingMarker>;
    if (typeof parsed?.since !== 'number' || !Number.isFinite(parsed.since)) return null;
    if (parsed.reason === undefined || !(parsed.reason in REASON_RANK)) return null;
    return { since: parsed.since, reason: parsed.reason };
  } catch {
    return null;
  }
}

/**
 * Give-up horizon: past this age we stop re-soliciting and drop the marker. Pre-join history is not
 * urgent, and a group whose only other member is permanently gone must not solicit (and grow
 * localStorage) forever. Generous because a peer can legitimately be away for weeks.
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function key(userId: string, groupId: string): string {
  return `${PREFIX}:${userId}:${groupId}`;
}

/**
 * Records that `groupId` is awaiting its history bundle, with the evidence for it. Idempotent:
 * keeps the earliest instant so the give-up horizon is stable across sessions.
 *
 * A proof outranks a presumption: once the replay has reported `unreadable-frames` the reason is
 * never downgraded, so a later join that happens to find a non-empty store cannot erase the fact
 * that some frame is genuinely unreadable.
 */
export function markAwaitingHistory(
  userId: string,
  groupId: string,
  reason: AwaitingHistoryReason
): void {
  if (typeof localStorage === 'undefined') return;
  const k = key(userId, groupId);
  const existing = readMarker(localStorage.getItem(k));
  const next: AwaitingMarker = {
    since: existing?.since ?? Date.now(),
    reason: existing?.reason === 'unreadable-frames' ? 'unreadable-frames' : reason,
  };
  localStorage.setItem(k, JSON.stringify(next));
}

/** Clears the awaiting-history marker for `groupId` (bundle arrived, or the group was dropped). */
export function clearAwaitingHistory(userId: string, groupId: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(key(userId, groupId));
}

/**
 * Whether this device is itself still awaiting the history bundle of `groupId`.
 *
 * Used by the RESPONDER side: an empty local store only proves the group has no history if we are
 * not ourselves waiting for it. A device that just joined has an empty store for a group that may
 * well have years of history held by others, so its emptiness says nothing and it must stay silent.
 * Honours the same give-up horizon as {@link enumerateAwaitingHistory} - an expired marker means we
 * gave up waiting, so our store is authoritative again.
 */
export function isAwaitingHistory(userId: string, groupId: string): boolean {
  if (typeof localStorage === 'undefined') return false;
  const marker = readMarker(localStorage.getItem(key(userId, groupId)));
  if (marker === null) return false;
  return Date.now() - marker.since <= MAX_AGE_MS;
}

/**
 * All groupIds for `userId` still awaiting their history bundle. Two kinds of entry are pruned as a
 * side effect of enumeration, so the registry stays bounded without a separate GC pass:
 * entries past {@link MAX_AGE_MS} (given up on), and entries carrying no evidence - the legacy
 * bare-timestamp markers the join-time solicitation used to write for every group it rejoined.
 * Dropping the latter is the one-shot migration: they were posted without anyone checking whether
 * anything was actually missing, and a device that IS missing something re-proves it at the next
 * replay.
 */
export function enumerateAwaitingHistory(userId: string): string[] {
  if (typeof localStorage === 'undefined') return [];
  const prefix = `${PREFIX}:${userId}:`;
  const now = Date.now();
  const out: string[] = [];
  const stale: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k === null || !k.startsWith(prefix)) continue;
    const marker = readMarker(localStorage.getItem(k));
    if (marker === null || now - marker.since > MAX_AGE_MS) {
      stale.push(k);
      continue;
    }
    out.push(k.slice(prefix.length));
  }
  for (const k of stale) localStorage.removeItem(k);
  return out;
}
