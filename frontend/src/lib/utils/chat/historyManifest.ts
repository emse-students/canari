/**
 * WP-HIST-3, the pure half: what a device HOLDS for one conversation, summarised small enough to
 * put inside an MLS frame, and the difference between two such summaries.
 *
 * This exists because the fallback history exchange is all-or-nothing - `sendFullHistoryBundle`
 * ships the responder's ENTIRE store and the receiver dedupes by id, one way, with neither side
 * knowing what the other holds. A digest turns that into a diff: the responder, holding both its own
 * store and the requester's digest, sends exactly what the requester lacks and asks for exactly what
 * it lacks itself. No difference means zero traffic.
 *
 * Nothing here touches the network, storage or MLS. It is deliberately a pure module so the
 * agreement between two devices can be pinned by tests rather than observed on a phone: every rule
 * below is a rule BOTH sides must apply identically, and a disagreement does not fail loudly - it
 * silently declares a slice identical and loses the messages in it.
 *
 * **The unit of comparison is a slice of the ID SPACE, never a slice of TIME (2026-08-10).** An
 * earlier version bucketed by UTC month, and that made the diff depend on a value the two devices do
 * not agree on: a message whose stored timestamp differs between them (the sender's clock against
 * the server's) lands in a different month on each side, so BOTH months read as different, BOTH are
 * re-sent wholesale - and they do so again at the next exchange, and the next, because nothing the
 * exchange does can ever make the two months agree. At a few hundred messages that is waste; at
 * scale it is a permanent broadcast, and the diff never empties, so the durable awaiting-history
 * marker it is supposed to clear stays set forever. A message id, by contrast, is the same string on
 * every device by construction, so a slice of the id space holds the same members on both sides and
 * an exchange that equalises it keeps it equal.
 *
 * @see docs/wiki/frontend/modules/chat.md#pooling-history-between-devices
 */

/** One message as the manifest sees it: an identity, and the instant used only for ordering. */
export type HistoryEntry = { id: string; timestamp: number };

/** One slice of the id space: which slice, how many messages in it, and a fingerprint of exactly which. */
export type HistoryRange = {
  /** Hex prefix of {@link historyRangeOf}, `depth` characters long. */
  prefix: string;
  count: number;
  /** Truncated SHA-256 of the slice's sorted ids - see {@link hashIdList}. */
  hash: string;
};

/**
 * What one device tells another it holds for a conversation.
 *
 * `ids` is exact and lets the other side name what it wants. `range` is the fallback for a store too
 * large to enumerate: it partitions the id space into `16^depth` slices and fingerprints each, so a
 * difference resolves to a slice rather than to a message.
 */
export type HistoryDigest =
  | { mode: 'ids'; ids: string[] }
  | { mode: 'range'; depth: number; ranges: HistoryRange[] };

/**
 * The reading of a peer's digest against the local store.
 *
 * The id lists are populated in `ids` mode, the prefix lists in `range` mode; a diff never mixes the
 * two, because the mode is chosen by the digest's sender and the reader answers in kind.
 */
export type HistoryDiff = {
  /** Message ids the peer has and we do not. Pull these. */
  missingLocally: string[];
  /** Message ids we have and the peer does not. Push these. */
  missingOnPeer: string[];
  /** Id-space slices whose fingerprints disagree, or that only the peer has. Pull the slice wholesale. */
  pullPrefixes: string[];
  /** Id-space slices whose fingerprints disagree, or that only we have. Push the slice wholesale. */
  pushPrefixes: string[];
};

/**
 * Above this many messages a digest switches from `ids` to `range`. A UUID costs ~37 bytes on the
 * wire, so 1 000 ids is ~37 KB - still comfortably inside an MLS application message, while ten
 * times that is not.
 */
export const DIGEST_ID_MODE_MAX = 1000;

/** Hex characters kept from a slice's SHA-256, i.e. 64 bits. See {@link hashIdList}. */
const RANGE_HASH_HEX_CHARS = 16;

/**
 * How many messages a slice is aimed at holding, which is what a single differing slice costs in
 * over-sent messages. Deliberately of the same order as one page of history: small enough that a
 * handful of lost messages does not drag the whole store across the wire, large enough that the
 * digest itself stays far smaller than the store it describes.
 */
const RANGE_TARGET_LEAF = 64;

/**
 * Hard ceiling on the depth, i.e. on how large a digest may get: `16^3` = 4 096 slices, ~45 bytes
 * each, so ~180 KB for a store of a million messages and proportionally less for anything smaller.
 * Past that ceiling slices simply get bigger; the exchange stays correct and still terminates, it
 * just over-sends more per difference. A bound in exchange for a bound - never a round trip more.
 */
const MAX_RANGE_DEPTH = 3;

/**
 * Maximum ids in a single `history_pull`. A pull is an MLS application message like any other, so a
 * diff of ten thousand messages has to be asked for across several frames rather than one.
 */
export const MAX_IDS_PER_PULL = 500;

/**
 * Orders ids by UTF-16 code point.
 *
 * NOT `localeCompare`: it is locale-dependent, so two devices with different locales would sort the
 * same ids differently and hash the same slice to different values - every slice would disagree
 * forever, and the diff would over-send the entire history on every exchange. A hash makes the sort
 * part of the protocol.
 */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Which slice of the id space an id belongs to, as a `depth`-character hex prefix.
 *
 * FNV-1a and not SHA-256, and the distinction is the same one the inbound frame ledger draws: this
 * function decides only WHICH SLICE an id is compared in, so a collision or an uneven spread costs
 * bandwidth (a fatter slice, more messages re-sent for one difference) and can never cost a message.
 * The fingerprint of a slice's CONTENTS is the value that must not collide, and that one is SHA-256
 * ({@link hashIdList}). Being synchronous also matters: this runs once per stored message when a
 * digest is built, where an async hash would be a per-message round trip through the event loop.
 *
 * Hashing rather than slicing the id itself, even though ids are UUIDs today: `channelInviteMessageId`
 * and other derived ids are not uniformly distributed, and a derived-id conversation would otherwise
 * pile its whole history into one slice and degenerate to a full bundle.
 */
export function historyRangeOf(id: string, depth: number): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  // MurmurHash3's finaliser. FNV-1a alone leaves its HIGH bits barely mixed for short, similar
  // inputs, and the prefix is taken from exactly those bits: measured, 64 ids differing only in a
  // trailing counter landed in 5 of the 16 depth-1 slices. That is not a correctness failure - a
  // slice holds the same ids on both devices either way - but it is a three-fold over-send for every
  // difference, on precisely the derived ids this function exists to spread.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, depth);
}

/**
 * The depth a store of `size` messages is described at: enough slices that each holds about
 * {@link RANGE_TARGET_LEAF} messages, capped at {@link MAX_RANGE_DEPTH}.
 *
 * Derived from the size rather than fixed so that the digest and the over-send cost scale together:
 * a small store gets few, exact-ish slices and a large one gets many. It is part of the wire format
 * (the digest carries its own depth) precisely because the two devices have different sizes and must
 * NOT each pick their own - the reader re-slices its own store at the sender's depth.
 */
export function rangeDepthFor(size: number): number {
  let depth = 1;
  while (depth < MAX_RANGE_DEPTH && 16 ** depth < size / RANGE_TARGET_LEAF) depth++;
  return depth;
}

/**
 * Deduplicates entries by id and returns the ids sorted.
 *
 * A store should not hold the same id twice, but a digest that trusts that is a digest whose count
 * and hash can disagree with the peer's for a reason neither side can see.
 */
function uniqueSortedIds(entries: readonly HistoryEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = entry.id?.trim();
    if (id) seen.add(id);
  }
  return [...seen].sort(compareIds);
}

/**
 * Partitions ids into slices of the id space at `depth`, each sorted and deduplicated.
 *
 * Takes ids rather than entries: nothing about a slice depends on a timestamp, which is the whole
 * point of the id-space partition.
 */
export function sliceIdsByRange(ids: readonly string[], depth: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const id of ids) {
    const prefix = historyRangeOf(id, depth);
    const list = out.get(prefix);
    if (list) list.push(id);
    else out.set(prefix, [id]);
  }
  for (const list of out.values()) list.sort(compareIds);
  return out;
}

/**
 * Fingerprints one slice's sorted ids as the first 64 bits of their SHA-256.
 *
 * SHA-256 and not the cheap FNV-1a used to choose the slice: a collision there costs a slice that is
 * fatter than intended, a collision here declares a slice identical that is not, and the messages in
 * it are lost silently and permanently. 64 bits is ~1 in 10^19 across the few thousand slices a
 * history can have.
 *
 * `\n` is a separator no message id can contain, so no two different id lists can serialise the same.
 */
export async function hashIdList(sortedIds: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(sortedIds.join('\n'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, RANGE_HASH_HEX_CHARS);
}

/**
 * Summarises what this device holds for one conversation.
 *
 * An EMPTY store produces an empty `ids` digest rather than nothing at all. "I hold no history" and
 * "I did not answer" are different facts, and conflating them is exactly what forced the empty-bundle
 * hack in `sendFullHistoryBundle`: every join of a brand-new conversation timed out into
 * `pending-offline` and kept re-soliciting for the whole give-up horizon.
 */
export async function buildHistoryDigest(
  entries: readonly HistoryEntry[],
  idModeMax: number = DIGEST_ID_MODE_MAX
): Promise<HistoryDigest> {
  const ids = uniqueSortedIds(entries);
  if (ids.length <= idModeMax) return { mode: 'ids', ids };

  const depth = rangeDepthFor(ids.length);
  const bySlice = sliceIdsByRange(ids, depth);
  const ranges: HistoryRange[] = [];
  for (const prefix of [...bySlice.keys()].sort(compareIds)) {
    const sliceIds = bySlice.get(prefix)!;
    ranges.push({ prefix, count: sliceIds.length, hash: await hashIdList(sliceIds) });
  }
  return { mode: 'range', depth, ranges };
}

/**
 * Reads a peer's digest against the local store and says what each side is missing.
 *
 * Run by whichever device holds BOTH sides - the responder, which has the requester's digest and its
 * own store - which is what lets a single exchange settle the difference in both directions instead
 * of two blind full bundles.
 *
 * In `range` mode a differing slice goes into BOTH lists. The fingerprints prove the slice is not the
 * same on the two devices; they say nothing about who is short, and guessing would drop messages.
 * Over-sending a slice is bandwidth, and the receiver dedupes by id.
 *
 * The local store is re-sliced at the REMOTE digest's depth. Depth is derived from a store's size and
 * the two stores differ in size, so a reader that used its own depth would compare slices that do not
 * describe the same region of the id space - every one of them would disagree, forever.
 */
export async function diffHistoryDigest(
  localEntries: readonly HistoryEntry[],
  remote: HistoryDigest
): Promise<HistoryDiff> {
  const empty: HistoryDiff = {
    missingLocally: [],
    missingOnPeer: [],
    pullPrefixes: [],
    pushPrefixes: [],
  };
  const localIds = uniqueSortedIds(localEntries);

  if (remote.mode === 'ids') {
    const localSet = new Set(localIds);
    const remoteSet = new Set(remote.ids.filter((id) => Boolean(id?.trim())));
    return {
      ...empty,
      missingLocally: [...remoteSet].filter((id) => !localSet.has(id)).sort(compareIds),
      missingOnPeer: localIds.filter((id) => !remoteSet.has(id)),
    };
  }

  const localBySlice = sliceIdsByRange(localIds, remote.depth);
  const remoteBySlice = new Map(remote.ranges.map((r) => [r.prefix, r]));
  const allPrefixes = new Set<string>([...localBySlice.keys(), ...remoteBySlice.keys()]);

  const pullPrefixes: string[] = [];
  const pushPrefixes: string[] = [];
  for (const prefix of [...allPrefixes].sort(compareIds)) {
    const mine = localBySlice.get(prefix);
    const theirs = remoteBySlice.get(prefix);

    if (!mine) {
      pullPrefixes.push(prefix);
      continue;
    }
    if (!theirs) {
      pushPrefixes.push(prefix);
      continue;
    }
    // The count is checked first only to skip a hash we already know will differ; a matching count
    // proves nothing on its own, which is the whole reason the slice carries a fingerprint.
    if (theirs.count !== mine.length || theirs.hash !== (await hashIdList(mine))) {
      pullPrefixes.push(prefix);
      pushPrefixes.push(prefix);
    }
  }

  return { ...empty, pullPrefixes, pushPrefixes };
}

/**
 * True when the two devices hold the same history for this conversation, i.e. nothing has to be
 * exchanged and the awaiting-history marker can be cleared.
 */
export function isEmptyHistoryDiff(diff: HistoryDiff): boolean {
  return (
    diff.missingLocally.length === 0 &&
    diff.missingOnPeer.length === 0 &&
    diff.pullPrefixes.length === 0 &&
    diff.pushPrefixes.length === 0
  );
}

/**
 * Collects every local id falling in one of `prefixes` - what a responder must send to answer a
 * range-mode pull, and what it must offer for a slice the requester is short of.
 *
 * `depth` comes from the digest that produced the prefixes, never from the local store's own size:
 * see {@link diffHistoryDigest}.
 */
export function selectEntryIdsForPrefixes(
  entries: readonly HistoryEntry[],
  prefixes: readonly string[],
  depth: number
): string[] {
  const wanted = new Set(prefixes);
  if (wanted.size === 0) return [];
  const out: string[] = [];
  for (const id of uniqueSortedIds(entries)) {
    if (wanted.has(historyRangeOf(id, depth))) out.push(id);
  }
  return out;
}

/**
 * Ceiling on what a single digest may claim, so a malformed or hostile peer cannot make this device
 * allocate without bound. Comfortably above {@link DIGEST_ID_MODE_MAX} and above `16^MAX_RANGE_DEPTH`.
 */
const MAX_DIGEST_ENTRIES = 5000;

/**
 * Validates a digest that arrived from a peer, returning `null` for anything malformed.
 *
 * This is untrusted input: it crossed the network, and although MLS authenticates WHICH co-member
 * sent it, that says nothing about the shape of the JSON inside. Everything downstream - the diff,
 * the pull it produces, the bundle that answers - is driven by these fields, so they are checked
 * once here rather than defended against at each use.
 *
 * A digest from a client too old to speak `range` (it would send the retired `buckets` mode) is
 * rejected here like any other unknown shape, and the caller falls back to sending its whole store -
 * the same path a peer that sent no digest at all already takes. Correct, wasteful, and it lasts
 * exactly as long as the rollout.
 */
export function parseHistoryDigest(value: unknown): HistoryDigest | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { mode?: unknown; ids?: unknown; depth?: unknown; ranges?: unknown };

  if (raw.mode === 'ids') {
    if (!Array.isArray(raw.ids) || raw.ids.length > MAX_DIGEST_ENTRIES) return null;
    const ids: string[] = [];
    for (const id of raw.ids) {
      if (typeof id !== 'string' || !id.trim()) return null;
      ids.push(id);
    }
    return { mode: 'ids', ids };
  }

  if (raw.mode === 'range') {
    const depth = raw.depth;
    if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1) return null;
    if (depth > MAX_RANGE_DEPTH) return null;
    if (!Array.isArray(raw.ranges) || raw.ranges.length > MAX_DIGEST_ENTRIES) return null;
    const ranges: HistoryRange[] = [];
    for (const entry of raw.ranges) {
      if (!entry || typeof entry !== 'object') return null;
      const { prefix, count, hash } = entry as Partial<HistoryRange>;
      // The prefix must be exactly as long as the declared depth, or it names a slice neither side
      // can compute - and a shorter one would silently swallow the slices nested under it.
      if (typeof prefix !== 'string' || prefix.length !== depth || !/^[0-9a-f]+$/.test(prefix))
        return null;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null;
      if (typeof hash !== 'string' || !/^[0-9a-f]+$/.test(hash)) return null;
      ranges.push({ prefix, count, hash });
    }
    return { mode: 'range', depth, ranges };
  }

  return null;
}

/**
 * Splits an id list into frames of at most `size`. A diff is unbounded - a device returning after a
 * month away can be short thousands of messages - while an MLS application message is not.
 */
export function chunkIds(ids: readonly string[], size: number = MAX_IDS_PER_PULL): string[][] {
  if (size <= 0) throw new Error('chunkIds: size must be positive');
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
