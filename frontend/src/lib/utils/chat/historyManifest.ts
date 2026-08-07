/**
 * WP-HIST-3, the pure half: what a device HOLDS for one conversation, summarised small enough to
 * put inside an MLS frame, and the difference between two such summaries.
 *
 * This exists because today's history exchange is all-or-nothing - `sendFullHistoryBundle` ships the
 * responder's ENTIRE store and the receiver dedupes by id, one way, with neither side knowing what
 * the other holds. A digest turns that into a diff: the requester, who alone sees both sides, asks
 * for exactly what it lacks and offers exactly what the peer lacks. No difference means zero traffic.
 *
 * Nothing here touches the network, storage or MLS. It is deliberately a pure module so the
 * agreement between two devices can be pinned by tests rather than observed on a phone: every rule
 * below is a rule BOTH sides must apply identically, and a disagreement does not fail loudly - it
 * silently declares a month identical and loses the messages in it.
 *
 * @see docs/wiki/frontend/modules/chat.md#pooling-history-between-devices
 */

/** One message as the manifest sees it: an identity, and the instant that decides its bucket. */
export type HistoryEntry = { id: string; timestamp: number };

/** One month of a `buckets`-mode digest: how many messages, and a fingerprint of exactly which. */
export type HistoryBucket = {
  /** `YYYY-MM`, always UTC. See {@link historyMonthOf}. */
  month: string;
  count: number;
  /** Truncated SHA-256 of the month's sorted ids - see {@link hashBucketIds}. */
  hash: string;
};

/**
 * What one device tells another it holds for a conversation.
 *
 * `ids` is exact and lets the requester name what it wants. `buckets` is the fallback for a store
 * too large to enumerate: it is ~2 KB for any history, at the cost of resolving a difference only
 * to the month.
 */
export type HistoryDigest =
  | { mode: 'ids'; ids: string[] }
  | { mode: 'buckets'; buckets: HistoryBucket[] };

/**
 * The requester's reading of a peer's digest against its own store.
 *
 * The id lists are populated in `ids` mode, the month lists in `buckets` mode; a diff never mixes
 * the two, because the mode is chosen by the responder and the requester answers in kind.
 */
export type HistoryDiff = {
  /** Message ids the peer has and we do not. Pull these. */
  missingLocally: string[];
  /** Message ids we have and the peer does not. Push these. */
  missingOnPeer: string[];
  /** Months whose fingerprints disagree, or that only the peer has. Pull the month wholesale. */
  pullMonths: string[];
  /** Months whose fingerprints disagree, or that only we have. Push the month wholesale. */
  pushMonths: string[];
};

/**
 * Above this many messages a digest switches from `ids` to `buckets`. A UUID costs ~37 bytes on the
 * wire, so 1 000 ids is ~37 KB - still comfortably inside an MLS application message, while ten
 * times that is not.
 */
export const DIGEST_ID_MODE_MAX = 1000;

/** Hex characters kept from each bucket's SHA-256, i.e. 64 bits. See {@link hashBucketIds}. */
const BUCKET_HASH_HEX_CHARS = 16;

/**
 * Maximum ids in a single `history_pull`. A pull is an MLS application message like any other, so a
 * diff of ten thousand messages has to be asked for across several frames rather than one.
 */
export const MAX_IDS_PER_PULL = 500;

/** The bucket for a timestamp that is missing, non-finite or non-positive. */
const UNDATED_MONTH = '0000-00';

/**
 * Orders ids by UTF-16 code point.
 *
 * NOT `localeCompare`: it is locale-dependent, so two devices with different locales would sort the
 * same ids differently and hash the same month to different values - every bucket would disagree
 * forever, and the diff would over-send the entire history on every exchange. A hash makes the sort
 * part of the protocol.
 */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Returns the `YYYY-MM` bucket of a timestamp, **in UTC**.
 *
 * UTC and not local time, because the two devices comparing these buckets are not guaranteed to be
 * in the same timezone - and a phone that travels is not even in the same one as itself. A local
 * month would put a message near a boundary in different buckets on each side, which the diff would
 * read as a difference and re-send the month for, on every single exchange.
 */
export function historyMonthOf(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return UNDATED_MONTH;
  const d = new Date(timestamp);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/**
 * Deduplicates entries by id, keeping the first timestamp seen, and returns the ids sorted.
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
 * Groups entries into `YYYY-MM` buckets of sorted, deduplicated ids.
 *
 * A message whose timestamp differs between the two devices (the sender's clock versus the server's)
 * can land in a different month on each side. That is not corruption: both months then read as
 * different, both are re-sent, and the receiver dedupes by id. The cost is bandwidth, never a
 * message.
 */
export function bucketHistoryEntries(entries: readonly HistoryEntry[]): Map<string, string[]> {
  const byMonth = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    if (!entry.id?.trim()) continue;
    const month = historyMonthOf(entry.timestamp);
    const list = byMonth.get(month);
    if (list) list.push(entry);
    else byMonth.set(month, [entry]);
  }

  const out = new Map<string, string[]>();
  for (const [month, list] of byMonth) out.set(month, uniqueSortedIds(list));
  return out;
}

/**
 * Fingerprints one month's sorted ids as the first 64 bits of their SHA-256.
 *
 * SHA-256 and not the cheap FNV-1a used by the inbound frame ledger: a collision there costs one
 * re-decrypt, a collision here declares a month identical that is not, and the messages in it are
 * lost silently and permanently. 64 bits is ~1 in 10^19 across the few hundred buckets a history can
 * have, and the whole digest stays ~2 KB.
 *
 * `\n` is a separator no message id can contain, so no two different id lists can serialise the same.
 */
export async function hashBucketIds(sortedIds: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(sortedIds.join('\n'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, BUCKET_HASH_HEX_CHARS);
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

  const byMonth = bucketHistoryEntries(entries);
  const months = [...byMonth.keys()].sort(compareIds);
  const buckets: HistoryBucket[] = [];
  for (const month of months) {
    const monthIds = byMonth.get(month)!;
    buckets.push({ month, count: monthIds.length, hash: await hashBucketIds(monthIds) });
  }
  return { mode: 'buckets', buckets };
}

/**
 * Reads a peer's digest against the local store and says what each side is missing.
 *
 * Run by the REQUESTER only: it is the one holding both sides, which is what lets a single exchange
 * settle the difference in both directions instead of two blind full bundles.
 *
 * In `buckets` mode a differing month goes into BOTH lists. The fingerprints prove the month is not
 * the same on the two devices; they say nothing about who is short, and guessing would drop
 * messages. Over-sending a month is bandwidth, and the receiver dedupes by id.
 */
export async function diffHistoryDigest(
  localEntries: readonly HistoryEntry[],
  remote: HistoryDigest
): Promise<HistoryDiff> {
  const empty: HistoryDiff = {
    missingLocally: [],
    missingOnPeer: [],
    pullMonths: [],
    pushMonths: [],
  };

  if (remote.mode === 'ids') {
    const localIds = new Set(uniqueSortedIds(localEntries));
    const remoteIds = new Set(remote.ids.filter((id) => Boolean(id?.trim())));
    return {
      ...empty,
      missingLocally: [...remoteIds].filter((id) => !localIds.has(id)).sort(compareIds),
      missingOnPeer: [...localIds].filter((id) => !remoteIds.has(id)).sort(compareIds),
    };
  }

  const localByMonth = bucketHistoryEntries(localEntries);
  const remoteByMonth = new Map(remote.buckets.map((b) => [b.month, b]));
  const allMonths = new Set<string>([...localByMonth.keys(), ...remoteByMonth.keys()]);

  const pullMonths: string[] = [];
  const pushMonths: string[] = [];
  for (const month of [...allMonths].sort(compareIds)) {
    const localIds = localByMonth.get(month);
    const remoteBucket = remoteByMonth.get(month);

    if (!localIds) {
      pullMonths.push(month);
      continue;
    }
    if (!remoteBucket) {
      pushMonths.push(month);
      continue;
    }
    // The count is checked first only to skip a hash we already know will differ; a matching count
    // proves nothing on its own, which is the whole reason the bucket carries a fingerprint.
    if (
      remoteBucket.count !== localIds.length ||
      remoteBucket.hash !== (await hashBucketIds(localIds))
    ) {
      pullMonths.push(month);
      pushMonths.push(month);
    }
  }

  return { ...empty, pullMonths, pushMonths };
}

/**
 * True when the two devices hold the same history for this conversation, i.e. nothing has to be
 * exchanged and the awaiting-history marker can be cleared.
 */
export function isEmptyHistoryDiff(diff: HistoryDiff): boolean {
  return (
    diff.missingLocally.length === 0 &&
    diff.missingOnPeer.length === 0 &&
    diff.pullMonths.length === 0 &&
    diff.pushMonths.length === 0
  );
}

/**
 * Collects every local id falling in one of `months` - what a responder must send to answer a
 * bucket-mode pull, and what a requester must offer for a month the peer is short of.
 */
export function selectEntryIdsForMonths(
  entries: readonly HistoryEntry[],
  months: readonly string[]
): string[] {
  const wanted = new Set(months);
  if (wanted.size === 0) return [];
  const byMonth = bucketHistoryEntries(entries);
  const out: string[] = [];
  for (const [month, ids] of byMonth) {
    if (wanted.has(month)) out.push(...ids);
  }
  return out.sort(compareIds);
}

/**
 * Ceiling on what a single digest may claim, so a malformed or hostile peer cannot make this device
 * allocate without bound. Comfortably above {@link DIGEST_ID_MODE_MAX}, and above the number of
 * months any real conversation can have.
 */
const MAX_DIGEST_ENTRIES = 5000;

/**
 * Validates a digest that arrived from a peer, returning `null` for anything malformed.
 *
 * This is untrusted input: it crossed the network, and although MLS authenticates WHICH co-member
 * sent it, that says nothing about the shape of the JSON inside. Everything downstream - the diff,
 * the pull it produces, the bundle that answers - is driven by these fields, so they are checked
 * once here rather than defended against at each use.
 */
export function parseHistoryDigest(value: unknown): HistoryDigest | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { mode?: unknown; ids?: unknown; buckets?: unknown };

  if (raw.mode === 'ids') {
    if (!Array.isArray(raw.ids) || raw.ids.length > MAX_DIGEST_ENTRIES) return null;
    const ids: string[] = [];
    for (const id of raw.ids) {
      if (typeof id !== 'string' || !id.trim()) return null;
      ids.push(id);
    }
    return { mode: 'ids', ids };
  }

  if (raw.mode === 'buckets') {
    if (!Array.isArray(raw.buckets) || raw.buckets.length > MAX_DIGEST_ENTRIES) return null;
    const buckets: HistoryBucket[] = [];
    for (const entry of raw.buckets) {
      if (!entry || typeof entry !== 'object') return null;
      const { month, count, hash } = entry as Partial<HistoryBucket>;
      if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) return null;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null;
      if (typeof hash !== 'string' || !/^[0-9a-f]+$/.test(hash)) return null;
      buckets.push({ month, count, hash });
    }
    return { mode: 'buckets', buckets };
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
