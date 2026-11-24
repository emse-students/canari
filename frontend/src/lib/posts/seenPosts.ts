/**
 * THE POSTS THIS DEVICE DISPLAYED, as a pure value (owner, 2026-11-24, "Verif sur l'appareil").
 *
 * WHY. A campus trend ("Suggestion : ...") can announce a post the member already saw in the feed:
 * the server records no "seen" and must not (charter, principle 1 - your messages are yours - and 3 -
 * your attention is not for sale), so it cannot know. The DEVICE can: it keeps this record, and a trend
 * for a post in it shows no banner and no bell row. Nothing is sent to the server. The accepted limit:
 * a post seen on another device is not recognised there.
 *
 * WHAT A RECORD HOLDS. `post id -> epoch ms of its publishedAt`. The publication instant is the
 * PRUNING PROOF, not a timer: the server announces a trend only for a post published within
 * {@link TREND_WINDOW_HOURS} (`campus-trend.ts`, equal to the contract's `trendWindowHours`), so an
 * entry older than that window plus {@link TREND_PRUNE_GRACE_MS} names a post no trend can name again.
 * The clock only decides WHEN that proof is applied; a wrong clock costs a repeated banner or a
 * slightly larger record, never a wrong suppression.
 *
 * The native readers (Kotlin `SeenTrends`, the iOS extension, `canari_push.mm`) hold the same rule on
 * the same cases: `libs/contracts/notification-seen-trend.cases.json`.
 */

/** The server's `TREND_WINDOW_HOURS`, asserted equal by `campus-trend-window.contract.spec.ts`. */
export const TREND_WINDOW_HOURS = 24;

/**
 * Slack past the window before an entry is pruned: a trend is stamped up to the window after the
 * publication, then queued and pushed, and the device's clock is not the server's.
 */
export const TREND_PRUNE_GRACE_MS = 60 * 60 * 1000;

/** The most posts kept: a heavy reader displays a few hundred posts in a day. A cap, never a policy. */
export const SEEN_POSTS_MAX = 500;

/** The `contentKey`s of a campus trend - the FIELD a push is classified by, never its wording. */
export const TREND_CONTENT_KEYS: readonly string[] = [
  'social_campus_trend',
  'social_campus_trend_photo',
  'social_campus_trend_video',
];

/** The bell row type of a campus trend (`PostNotification.type`). */
const TREND_ROW_TYPE = 'campus_trend';

/** post id (lower-case) -> epoch ms of the post's `publishedAt`. */
export type SeenPosts = Map<string, number>;

/** A post id as the record stores it. */
function normalisePostId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * Notes `postId` (published at `publishedAtMs`) as displayed. Returns true when the record changed.
 * An id or an instant that cannot be stored is refused (false); a post already there keeps its entry.
 */
export function noteSeen(seen: SeenPosts, postId: string, publishedAtMs: number): boolean {
  const id = normalisePostId(postId);
  if (!id || !Number.isFinite(publishedAtMs) || seen.has(id)) return false;
  seen.set(id, publishedAtMs);
  return true;
}

/**
 * Drops what no trend can name any more, then the OLDEST publications beyond the cap. Returns how many
 * were dropped for age and how many for the cap, so the caller can say it.
 *
 * @param nowMs the clock, injected: a test asserts no wall clock.
 */
export function pruneSeen(seen: SeenPosts, nowMs: number): { aged: number; capped: number } {
  const horizon = nowMs - TREND_WINDOW_HOURS * 3_600_000 - TREND_PRUNE_GRACE_MS;
  let aged = 0;
  for (const [id, publishedAt] of seen) {
    if (publishedAt < horizon) {
      seen.delete(id);
      aged++;
    }
  }
  let capped = 0;
  if (seen.size > SEEN_POSTS_MAX) {
    const oldestFirst = [...seen].sort((a, b) => a[1] - b[1]);
    for (const [id] of oldestFirst.slice(0, seen.size - SEEN_POSTS_MAX)) {
      seen.delete(id);
      capped++;
    }
  }
  return { aged, capped };
}

/** How long a bell row lives on the server (days), plus a day of slack: a decision is kept that long. */
export const BELL_ROW_RETENTION_MS = 91 * 24 * 3_600_000;

/**
 * What the bell keeps beside the record (see `seenPosts.svelte.ts`): its DECISION about each trend row,
 * taken ONCE, the first time the row appears in this device's list, from one fact - is its post in the
 * record at that moment. Each id maps to the row's `createdAt` (ms), only so the decision can be dropped
 * when the row itself is gone (a bell row lives {@link BELL_ROW_RETENTION_MS}).
 */
export interface SeenLedger {
  /** Rows whose post was already displayed when they first appeared: withheld for good. */
  withheld: Map<string, number>;
  /** Rows whose post was not: kept for good, however the post is displayed afterwards. */
  kept: Map<string, number>;
  /** The device instant of the last bell answer that listed EVERY row; 0 when there was none. */
  fullAnswerAt: number;
}

/** Whether `publishedAtMs` is still inside the window a trend can name (the native readers prune by this). */
export function withinTrendWindow(publishedAtMs: number, nowMs: number): boolean {
  return publishedAtMs >= nowMs - TREND_WINDOW_HOURS * 3_600_000 - TREND_PRUNE_GRACE_MS;
}

/** The record (and, for the sealed copy, the bell's ledger) as a sealable body. */
export function serializeSeen(
  seen: SeenPosts,
  ledger?: SeenLedger
): {
  posts: Record<string, number>;
  withheld?: Record<string, number>;
  kept?: Record<string, number>;
  fullAnswerAt?: number;
} {
  const body: ReturnType<typeof serializeSeen> = { posts: Object.fromEntries(seen) };
  if (ledger) {
    body.withheld = Object.fromEntries(ledger.withheld);
    body.kept = Object.fromEntries(ledger.kept);
    body.fullAnswerAt = ledger.fullAnswerAt;
  }
  return body;
}

function parseInstants(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, at] of Object.entries(raw)) {
      if (typeof at === 'number' && Number.isFinite(at)) out.set(id, at);
    }
  }
  return out;
}

/** The bell's ledger from a stored body; empty when the body carries none (tolerant, never refusing). */
export function parseSeenLedger(body: unknown): SeenLedger {
  const raw = body as { withheld?: unknown; kept?: unknown; fullAnswerAt?: unknown } | null;
  const at = raw?.fullAnswerAt;
  return {
    withheld: parseInstants(raw?.withheld),
    kept: parseInstants(raw?.kept),
    fullAnswerAt: typeof at === 'number' && Number.isFinite(at) ? at : 0,
  };
}

/** The record from a stored body, or `null` when it does not have the shape this build writes. */
export function parseSeen(body: unknown): SeenPosts | null {
  const posts = (body as { posts?: unknown } | null)?.posts;
  if (!posts || typeof posts !== 'object' || Array.isArray(posts)) return null;
  const seen: SeenPosts = new Map();
  for (const [id, at] of Object.entries(posts)) {
    if (typeof at !== 'number' || !Number.isFinite(at)) return null;
    seen.set(normalisePostId(id), at);
  }
  return seen;
}

/**
 * Whether a notification - a push (`contentKey`) or a bell row (`type`) - is a campus trend for a post
 * the record holds. Classified on the FIELD: a trend is its key or its type, never its text.
 */
export function isSeenTrend(
  seen: ReadonlyMap<string, number>,
  kind: { contentKey?: string | null; type?: string | null },
  postId: string | null | undefined
): boolean {
  const isTrend =
    (kind.contentKey != null && TREND_CONTENT_KEYS.includes(kind.contentKey)) ||
    kind.type === TREND_ROW_TYPE;
  if (!isTrend || !postId) return false;
  return seen.has(normalisePostId(postId));
}
