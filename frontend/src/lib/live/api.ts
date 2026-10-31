/**
 * THE TYPED CLIENT OF `/api/lives` (social-service) AND OF THE PUBLIC SEGMENT FETCH (WP-L5's
 * foundation). Contract: docs/wiki/services/lives.md, "The API contract"; shapes in `./types`.
 *
 * - Every authenticated route goes through `apiFetch`: the bearer token, one silent refresh on a
 *   401, `SessionExpiredError` on a second - so only a 401 here can end a session, and every other
 *   status reaches the caller as an ANSWER.
 * - Every refusal is CLASSIFIED AT THE THROW as a {@link LiveRefusalError}: the status and the
 *   server's `code` (read by `refusalFromResponse`, the one implementation), the body's typed extras
 *   (`viewerCap`, `nextIndex`, `endedAt`, `endReason`), and a {@link LiveRefusalKind} saying what a screen does
 *   with it. A caller switches on `kind` or `code`, never on a message.
 * - A transport failure (no answer) is NOT a refusal: it propagates as `TransportFailureError` /
 *   `RequestDeadlineError` (`isTransportFailure`), never wrapped.
 * - Nothing here logs a key or a segment's bytes: ids, indexes, sizes and codes only.
 */

import { apiFetch, type ApiFetchOptions } from '$lib/utils/apiFetch';
import { mediaUrl, socialUrl } from '$lib/utils/apiUrl';
import { getClientAppVersion } from '$lib/utils/appVersion';
import { ApiRefusalError, refusalFromResponse } from '$lib/utils/apiRefusalError';
import { responseOrigin } from '$lib/utils/apiRefusal';
import { trackedFetch } from '$lib/utils/trackedFetch';
import { isTransportFailure } from '$lib/utils/transportFailure';
import type {
  LiveChatHidden,
  LiveChatMessageWire,
  LiveChatQuery,
  LiveChatTombstoneWire,
  LiveEndResult,
  LiveIngestResult,
  LiveLimits,
  LiveCutReason,
  LiveCutResult,
  LiveWithdrawalResult,
  LiveEndReason,
  LiveListItem,
  LiveManifest,
  LiveReactionKind,
  LiveRefusalKind,
  LiveRemovedViewer,
  LiveRulesStatus,
  LiveView,
} from './types';

/**
 * A REFUSAL A LIVES ROUTE (OR THE SEGMENT FETCH) ANSWERED. `status` and `code` come from the base
 * class; `kind` is the decision ({@link LiveRefusalKind}); the extras are the typed fields the
 * server puts next to `code`, `null` when that refusal carries none.
 */
export class LiveRefusalError extends ApiRefusalError {
  constructor(
    status: number,
    code: string | null,
    message: string,
    /** What a screen does with it - see {@link LiveRefusalKind}. */
    readonly kind: LiveRefusalKind,
    /** `LIVE_FULL`: how many seats the host has - the number a "live complet" screen names. */
    readonly viewerCap: number | null,
    /** The index the server expects next (`LIVE_SEGMENT_*`, `LIVE_SEGMENT_TOO_FAST`). */
    readonly nextIndex: number | null,
    /** `LIVE_ENDED`: when it ended, when the server says (ISO string). */
    readonly endedAt: string | null,
    /**
     * `LIVE_ENDED`: why it ended (`cut`: a moderator ended it) - what a screen branches on, never
     * the message. Null when the body carries none, or a value this build does not know.
     */
    readonly endReason: LiveEndReason | null = null,
    /** `LIVE_BROADCAST_SUSPENDED`: when the suspension ends (ISO string), null when absent. */
    readonly suspendedUntil: string | null = null
  ) {
    super(status, code, message);
    this.name = 'LiveRefusalError';
  }
}

/** Whether `error` is the `410` of a live a moderator CUT - the one test both ends of a live share. */
export function isLiveCut(error: unknown): boolean {
  return error instanceof LiveRefusalError && error.kind === 'ended' && error.endReason === 'cut';
}

/** Whether `error` is a lives refusal of that kind - the one test a screen needs. */
export function isLiveRefusal(error: unknown, kind: LiveRefusalKind): error is LiveRefusalError {
  return error instanceof LiveRefusalError && error.kind === kind;
}

/** Codes whose refusal means: send the SAME segment index again after a short backoff. */
const RETRY_SEGMENT_CODES: ReadonlySet<string> = new Set([
  'LIVE_SEGMENT_IN_PROGRESS',
  'LIVE_SEGMENT_RESERVATION_LOST',
  'LIVE_STORE_UNAVAILABLE',
  'LIVE_INGEST_BUSY',
]);

/**
 * THE ONE DECISION from a refused answer to a {@link LiveRefusalKind}. The code decides first (it
 * is the server's own name); the status decides only where no code was given. `segmentFetch` marks
 * the public segment route, where a bare 404 is an absent segment rather than the switch.
 */
export function classifyLiveRefusal(
  status: number,
  code: string | null,
  origin: 'gateway' | 'edge',
  segmentFetch = false
): LiveRefusalKind {
  if (code === 'LIVE_FULL') return 'full';
  if (code === 'LIVE_SEATS_UNAVAILABLE') return 'seats-unavailable';
  if (status === 429) return 'rate-limited';
  if (code === 'LIVE_NOT_FOUND') return 'not-found';
  if (code === 'LIVE_ENDED') return 'ended';
  if (code === 'LIVE_VIEWER_REMOVED') return 'removed';
  // The strike ladder's two refusals of a START (WP-L8b): 403 with the code, told apart by code only.
  if (code === 'LIVE_BROADCAST_SUSPENDED') return 'suspended';
  if (code === 'LIVE_BROADCAST_WITHDRAWN') return 'withdrawn';
  if (code === 'LIVE_SEGMENT_OUT_OF_ORDER') return 'out-of-order';
  // The stored key does not open (a viewer's read) or cannot be sealed (a start): the server's
  // failure, not a verdict on this request, so retryable like any 5xx - never a terminal refusal.
  if (code === 'LIVE_KEY_UNAVAILABLE' || code === 'LIVE_KEY_SEALING_UNAVAILABLE')
    return 'unavailable';
  if (code !== null && RETRY_SEGMENT_CODES.has(code)) return 'retry-segment';
  if (status === 404 && code === null) {
    if (segmentFetch) return 'not-found';
    // Only OUR gateway's bare 404 is the live guard (`LIVE_ENABLED` or `lives_mode` off); an edge
    // page says nothing about it.
    return origin === 'gateway' ? 'disabled' : 'refused';
  }
  // A 5xx nobody named is "no verdict, retry later". A 4xx from the edge (a WAF page, nginx's own
  // 413) is NOT retried: re-sending the same request meets the same refusal.
  if (status >= 500 && code === null) return 'unavailable';
  return 'refused';
}

const LIVE_END_REASONS: ReadonlySet<string> = new Set<LiveEndReason>([
  'broadcaster',
  'dropped',
  'erased',
  'cut',
  'max_duration',
]);

/** A refusal body's `endReason` when it is one this build knows, else null (never a guess). */
export function liveEndReasonOf(value: unknown): LiveEndReason | null {
  return typeof value === 'string' && LIVE_END_REASONS.has(value) ? (value as LiveEndReason) : null;
}

/** A number field of a refusal body, or null. */
function numberField(body: Record<string, unknown> | null, key: string): number | null {
  const v = body?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * TYPES A REFUSED RESPONSE AT THE THROW. `refusalFromResponse` reads status and `code` (from a
 * clone); the extras are read from the body here. Logged once, at warn for an outcome a viewer or
 * broadcaster will see, with the route, status, code and kind - never the body.
 */
async function liveRefusal(
  res: Response,
  what: string,
  segmentFetch = false
): Promise<LiveRefusalError> {
  const base = await refusalFromResponse(res, what);
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON (an edge page): no extras, and `responseOrigin` below calls it the edge's.
  }
  const kind = classifyLiveRefusal(base.status, base.code, responseOrigin(res), segmentFetch);
  const endedAt = typeof body?.endedAt === 'string' ? body.endedAt : null;
  const endReason = liveEndReasonOf(body?.endReason);
  console.warn(
    `[LIVE] ${what}: ${base.status} ${base.code ?? '-'} -> ${kind}${endReason ? ` (${endReason})` : ''}`
  );
  return new LiveRefusalError(
    base.status,
    base.code,
    base.message,
    kind,
    numberField(body, 'viewerCap'),
    numberField(body, 'nextIndex'),
    endedAt,
    endReason,
    typeof body?.suspendedUntil === 'string' ? body.suspendedUntil : null
  );
}

/** `/api/lives` on social-service (same origin on the web, `VITE_SOCIAL_URL` on Tauri). */
function livesBase(): string {
  return `${socialUrl()}/api/lives`;
}

/** One live's path; the id is a uuid, encoded anyway so a caller's typo cannot reach another route. */
function livePath(liveId: string): string {
  return `${livesBase()}/${encodeURIComponent(liveId)}`;
}

/**
 * The header every lives call carries so the server can answer a build below `1.5.4` like a
 * switched-off estate (`LiveEnabledGuard`, docs/wiki/legacy-compatibility.md). Absent on a build
 * that predates it - which is the evidence the server reads.
 */
export const LIVE_CLIENT_VERSION_HEADER = 'X-Canari-Client-Version';

/** `init` with the client-version header added. */
function withClientVersion(init: ApiFetchOptions = {}): ApiFetchOptions {
  return {
    ...init,
    headers: { ...init.headers, [LIVE_CLIENT_VERSION_HEADER]: getClientAppVersion() },
  };
}

/** Runs one authenticated lives call and returns its JSON, or throws the typed refusal. */
async function liveJson<T>(url: string, what: string, init: ApiFetchOptions = {}): Promise<T> {
  const res = await apiFetch(url, withClientVersion(init));
  if (!res.ok) throw await liveRefusal(res, what);
  return (await res.json()) as T;
}

/** `GET /api/lives/limits` - the server's numbers; a client keeps no copy of them. */
export async function fetchLiveLimits(): Promise<LiveLimits> {
  console.debug('[LIVE] limits');
  return liveJson<LiveLimits>(`${livesBase()}/limits`, 'Live limits');
}

/** `GET /api/lives` - the open lives the caller may watch, newest first, at most 50, no key. */
export async function listOpenLives(): Promise<LiveListItem[]> {
  console.debug('[LIVE] list');
  return liveJson<LiveListItem[]>(livesBase(), 'Live list');
}

/** `GET /api/lives/rules` - whether the caller must accept the first-live rules before starting. */
export async function fetchLiveRules(): Promise<LiveRulesStatus> {
  console.debug('[LIVE] rules');
  return liveJson<LiveRulesStatus>(`${livesBase()}/rules`, 'Live rules');
}

/**
 * `POST /api/lives` - starts a live (201, the live WITH its key).
 *
 * @param keyHex The live key the broadcaster's client generated: 64 lower-case hex characters, as
 *   `generateMediaCek()` (`$lib/mediaCrypto`) produces. Never logged.
 * @param associationId Broadcast AS this association (needs `POST_AS_ASSO` there), or omitted.
 * @param acceptedRulesVersion The rules version the member accepted on THIS screen, sent only then:
 *   the server records it with the start. Omitted when the account accepted it before.
 * Refusals: `LIVE_KEY_INVALID`, `LIVE_ASSOCIATION_INVALID`, `LIVE_MUTED`, `LIVE_RULES_NOT_ACCEPTED`,
 * `LIVE_ASSOCIATION_FORBIDDEN`, `LIVE_ALREADY_OPEN` (all `refused`), `LIVE_START_RATE` (`rate-limited`),
 * `LIVE_KEY_SEALING_UNAVAILABLE` (`unavailable`: the server cannot seal the key, nothing was written).
 */
export async function startLive(
  keyHex: string,
  associationId?: string,
  acceptedRulesVersion?: number
): Promise<LiveView> {
  console.debug(
    `[LIVE] start${associationId ? ` as association ${associationId}` : ''}${
      acceptedRulesVersion === undefined ? '' : `, rules v${acceptedRulesVersion} accepted`
    }`
  );
  const body: { key: string; associationId?: string; acceptedRulesVersion?: number } = {
    key: keyHex,
  };
  if (associationId) body.associationId = associationId;
  if (acceptedRulesVersion !== undefined) body.acceptedRulesVersion = acceptedRulesVersion;
  const live = await liveJson<LiveView>(livesBase(), 'Live start', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  console.log(`[LIVE] started ${live.id}`);
  return live;
}

/**
 * `GET /api/lives/:id` - one live and its KEY; takes a seat on the host's viewer cap (none for the
 * broadcaster). Kinds: `not-found`, `ended`, `removed`, `full` (with `viewerCap`),
 * `seats-unavailable`.
 */
export async function fetchLive(liveId: string): Promise<LiveView> {
  console.debug(`[LIVE] open ${liveId}`);
  return liveJson<LiveView>(livePath(liveId), 'Live open');
}

/**
 * `GET /api/lives/:id/manifest[?from=<index>]` - what a viewer polls; renews its seat. Without
 * `from`, the newest `manifestWindow` segments (the join); with it, from that index on. Same kinds
 * as {@link fetchLive}.
 */
export async function fetchLiveManifest(
  liveId: string,
  from?: number,
  chat?: LiveChatQuery
): Promise<LiveManifest> {
  return liveJson<LiveManifest>(
    `${livePath(liveId)}/manifest${manifestQuery(from, chat)}`,
    'Live manifest'
  );
}

/**
 * The manifest's query string. `chat` asks for the chat block (WP-L6, C3) - the chat RIDES the poll
 * the viewer already makes, one request a tick; an absent cursor is the first poll's (C13).
 */
export function manifestQuery(from?: number, chat?: LiveChatQuery): string {
  const params = new URLSearchParams();
  if (from !== undefined) params.set('from', String(from));
  if (chat) {
    params.set('chat', '1');
    if (chat.messagesAfter !== undefined) params.set('messagesAfter', String(chat.messagesAfter));
    if (chat.reactionsAfter !== undefined)
      params.set('reactionsAfter', String(chat.reactionsAfter));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * `POST /api/lives/:id/messages` - one chat message, SEALED with the live key by the caller
 * (`sealLiveChatMessage`). A repeat with the same `clientId` and bytes answers the stored message
 * (a lost answer retried). Kinds: `rate-limited` (`LIVE_MESSAGE_TOO_FAST`), `refused`
 * (`LIVE_MUTED`, `LIVE_MESSAGE_INVALID`, `LIVE_MESSAGE_CONFLICT`), and the watch refusals.
 */
export async function postLiveMessage(
  liveId: string,
  clientId: string,
  sealed: string
): Promise<LiveChatMessageWire | LiveChatTombstoneWire> {
  console.debug(`[LIVE_CHAT] send ${clientId} on ${liveId}: ${sealed.length} b64 chars`);
  return liveJson(`${livePath(liveId)}/messages`, 'Live message', {
    method: 'POST',
    body: JSON.stringify({ clientId, sealed }),
  });
}

/**
 * `POST /api/lives/:id/reactions` - the taps of one tick, summed by kind (C7). Never one request a
 * tap. `rate-limited` (`LIVE_REACTION_TOO_FAST`) drops the burst: a floating reaction is a moment.
 */
export async function postLiveReactions(
  liveId: string,
  burstId: string,
  counts: Partial<Record<LiveReactionKind, number>>
): Promise<{ burstId: string; seq: number }> {
  console.debug(`[LIVE_CHAT] reactions ${burstId} on ${liveId}`);
  return liveJson(`${livePath(liveId)}/reactions`, 'Live reactions', {
    method: 'POST',
    body: JSON.stringify({ burstId, counts }),
  });
}

/**
 * `POST /api/lives/:id/messages/:messageId/hide` - the broadcaster or staff hides a message (C14).
 * Idempotent; `not-found` for a message not on that live or a caller who may not moderate it.
 */
export async function hideLiveMessage(liveId: string, messageId: string): Promise<LiveChatHidden> {
  console.debug(`[LIVE_CHAT] hide ${messageId} on ${liveId}`);
  return liveJson<LiveChatHidden>(
    `${livePath(liveId)}/messages/${encodeURIComponent(messageId)}/hide`,
    'Live hide message',
    { method: 'POST' }
  );
}

/**
 * `PUT /api/lives/:id/segments/:index` - one sealed segment, raw `application/octet-stream`, by
 * the broadcaster. `index` MUST be the live's `nextIndex`; a repeat of a stored index with the SAME
 * bytes answers as the first time (a lost answer retried). The ingest is gapless: never skip an
 * index - {@link LiveSegmentUploader} is the one sender that keeps that order.
 */
export async function putLiveSegment(
  liveId: string,
  index: number,
  sealed: Uint8Array<ArrayBuffer>
): Promise<LiveIngestResult> {
  console.debug(`[LIVE] segment ${index} of ${liveId}: ${sealed.byteLength} B`);
  // A Blob so `apiFetch` sets no JSON content type (Nest's JSON parser would take the body).
  const body = new Blob([sealed], { type: 'application/octet-stream' });
  return liveJson<LiveIngestResult>(`${livePath(liveId)}/segments/${index}`, 'Live segment', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
}

/**
 * `POST /api/lives/:id/end` - the broadcaster ends it. Idempotent while the row exists; once the
 * end's purge deleted it, a repeat is `not-found`, which means "ended and deleted" (no replay, L3).
 */
export async function endLive(liveId: string): Promise<LiveEndResult> {
  console.debug(`[LIVE] end ${liveId}`);
  const ended = await liveJson<LiveEndResult>(`${livePath(liveId)}/end`, 'Live end', {
    method: 'POST',
  });
  console.log(`[LIVE] ${liveId} ended (${ended.endReason})`);
  return ended;
}

/**
 * `POST /api/lives/:id/cut` - a content moderator ends a live and records why (WP-L8). Safe to
 * repeat: the second answer is the first cut with `newlyCut: false`. Refusals: `LIVE_CUT_FORBIDDEN`
 * (403, the caller is not a content moderator), `LIVE_CUT_REASON_INVALID` / `LIVE_CUT_DETAILS_INVALID`
 * (400), `LIVE_NOT_FOUND` (`not-found`) - all but the last are `refused`; read `code`.
 */
export async function cutLive(
  liveId: string,
  reason: LiveCutReason,
  details?: string
): Promise<LiveCutResult> {
  console.debug(`[LIVE] cut ${liveId} (${reason})`);
  const body: { reason: LiveCutReason; details?: string } = { reason };
  if (details) body.details = details;
  const cut = await liveJson<LiveCutResult>(`${livePath(liveId)}/cut`, 'Live cut', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  console.log(`[LIVE] ${liveId} cut (${cut.newlyCut ? 'new' : 'repeat'}, ${cut.priorCuts} prior)`);
  return cut;
}

/**
 * `POST /api/lives/broadcasters/:userId/withdrawal` - a content moderator withdraws an account's
 * right to broadcast (the ladder's 3rd step). Idempotent (`newlyWithdrawn: false`). Refusals, read by
 * `code`: `LIVE_WITHDRAWAL_FORBIDDEN` (403), `LIVE_WITHDRAWAL_NOT_DUE` (409, below the cuts it needs),
 * `LIVE_CUT_REASON_INVALID` / `LIVE_CUT_DETAILS_INVALID` (400).
 */
export async function withdrawBroadcaster(
  userId: string,
  reason: LiveCutReason,
  details?: string
): Promise<LiveWithdrawalResult> {
  console.debug(`[LIVE] withdraw the right of ${userId} (${reason})`);
  const body: { reason: LiveCutReason; details?: string } = { reason };
  if (details) body.details = details;
  const done = await liveJson<LiveWithdrawalResult>(
    `${livesBase()}/broadcasters/${encodeURIComponent(userId)}/withdrawal`,
    'Live withdrawal',
    { method: 'POST', body: JSON.stringify(body) }
  );
  console.log(
    `[LIVE] right of ${userId} withdrawn (${done.newlyWithdrawn ? 'new' : 'repeat'}, ${done.cutsOnRecord} cuts)`
  );
  return done;
}

/**
 * `DELETE /api/lives/:id/seat` (204) - the viewer leaves; its seat returns to the host's cap now
 * rather than when its 30 s lease lapses. Idempotent.
 */
export async function leaveLiveSeat(liveId: string): Promise<void> {
  console.debug(`[LIVE] leave ${liveId}`);
  const res = await apiFetch(`${livePath(liveId)}/seat`, withClientVersion({ method: 'DELETE' }));
  if (!res.ok) throw await liveRefusal(res, 'Live leave');
}

/**
 * `POST /api/lives/:id/removed-viewers` - the broadcaster removes a viewer (L6). Idempotent;
 * `LIVE_VIEWER_IS_SELF` / `LIVE_VIEWER_INVALID` are `refused`, an ended live `ended`.
 */
export async function removeLiveViewer(
  liveId: string,
  viewerId: string
): Promise<LiveRemovedViewer> {
  console.debug(`[LIVE] remove viewer ${viewerId} from ${liveId}`);
  return liveJson<LiveRemovedViewer>(`${livePath(liveId)}/removed-viewers`, 'Live remove viewer', {
    method: 'POST',
    body: JSON.stringify({ viewerId }),
  });
}

/**
 * The public address of one sealed segment, from the manifest's `name`. Served by Canari's nginx
 * cache, which answers ONLY the canonical lower-case path - so both ids are lower-cased here.
 */
export function liveSegmentUrl(liveId: string, name: string): string {
  return `${mediaUrl()}/api/media/public/live/${liveId.toLowerCase()}/${name.toLowerCase()}`;
}

/**
 * `GET /api/media/public/live/<liveId>/<name>` - one sealed segment's ciphertext.
 *
 * A PLAIN request, on purpose: no token and NO custom header, because the location allows GET/HEAD
 * only and a CORS preflight (which any custom header triggers from a WebView origin) is refused
 * there. Still through `trackedFetch`, so it has a deadline and feeds the connectivity reading.
 * A `429` is nginx's per-address bound (`rate-limited`): retry the SAME segment after a backoff, one
 * fetch in flight per player. A `404` is `not-found` (purged, or never stored).
 *
 * `signal` cancels the download (head AND body): a viewer that closes or restarts aborts its run's
 * fetches, so none keeps a connection beside the next run's under nginx's per-address bound.
 */
export async function fetchLiveSegment(
  liveId: string,
  name: string,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const res = await trackedFetch(fetch, liveSegmentUrl(liveId, name), { method: 'GET', signal });
  if (!res.ok) throw await liveRefusal(res, `Live segment ${name}`, true);
  return res.arrayBuffer();
}

/** Options of a {@link LiveSegmentUploader}. */
export interface LiveSegmentUploaderOptions {
  /** The first index to send - the live's `nextIndex` (0 for a new live, more after a resume). */
  startIndex?: number;
  /** The wait before re-sending the same index, by attempt (1, 2, ...). Default 250 ms doubling to 4 s. */
  backoffMs?: (attempt: number) => number;
  /** Told each segment the server stored. */
  onStored?: (result: LiveIngestResult) => void;
  /**
   * Told each failed send that WILL be retried (the broadcaster's quiet "reconnecting" state): the
   * index, the attempt that failed (1, 2, ...) and why. The next `onStored` ends that state.
   */
  onRetry?: (index: number, attempt: number, error: unknown) => void;
  /** Told the refusal that stopped the queue for good (`ended`, `not-found`, `out-of-order`...). */
  onStopped?: (error: unknown) => void;
}

const defaultBackoff = (attempt: number): number => Math.min(250 * 2 ** (attempt - 1), 4_000);

/** Whether a failed send is retried with the SAME index rather than ending the queue. */
function isRetryable(error: unknown): boolean {
  if (error instanceof LiveRefusalError) {
    return (
      error.kind === 'retry-segment' ||
      error.kind === 'rate-limited' ||
      error.kind === 'unavailable'
    );
  }
  return isTransportFailure(error);
}

/**
 * THE BROADCASTER'S ONE SENDER: segments go out ONE AT A TIME, IN INDEX ORDER, and an index is
 * retried until it lands - never skipped (WP-L1: a skipped index made every later one
 * `409 LIVE_SEGMENT_OUT_OF_ORDER`). A transport failure, a `retry-segment`, a `429` or an edge
 * answer retries the same index after a backoff; any other refusal STOPS the queue and is handed
 * to `onStopped` - so its termination is the server's verdict (`410` once the 60 s window or the
 * hour ended the live), never a client timer.
 */
export class LiveSegmentUploader {
  private next: number;
  private readonly queue: { index: number; sealed: Uint8Array<ArrayBuffer> }[] = [];
  private running: Promise<void> | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(
    private readonly liveId: string,
    private readonly options: LiveSegmentUploaderOptions = {}
  ) {
    this.next = options.startIndex ?? 0;
  }

  /**
   * The index the next {@link enqueue} must carry. The caller reads it BEFORE sealing, because the
   * seal binds the index (it is in the AAD): the uploader is the ONE counter, so a sealed segment
   * and the index it is sent as cannot drift apart.
   */
  get nextIndex(): number {
    return this.next;
  }

  /**
   * Queues a segment sealed for `index`. Throws a `RangeError` unless `index` is {@link nextIndex}:
   * a segment sealed for another index would be stored and then never open for any viewer,
   * silently - refusing it here makes the drift loud at its source.
   */
  enqueue(index: number, sealed: Uint8Array<ArrayBuffer>): void {
    if (this.stopped) throw new Error(`live ${this.liveId}: uploader stopped`);
    if (index !== this.next) {
      console.error(
        `[LIVE] uploader for ${this.liveId} refused segment ${index}: the next index is ${this.next}`
      );
      throw new RangeError(
        `live ${this.liveId}: segment sealed for index ${index}, the next index is ${this.next}`
      );
    }
    this.next++;
    this.queue.push({ index, sealed });
    this.running ??= this.drain().finally(() => {
      this.running = null;
    });
  }

  /** How many segments wait to be stored (the backlog a "reconnecting" badge can show). */
  get backlog(): number {
    return this.queue.length;
  }

  /** Resolves once every queued segment is stored or the queue stopped. */
  async idle(): Promise<void> {
    await this.running;
  }

  /** Stops sending (the broadcaster ended the live); queued segments are dropped. */
  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.wake?.();
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.queue.length > 0) {
      const head = this.queue[0];
      for (let attempt = 1; !this.stopped; attempt++) {
        try {
          const stored = await putLiveSegment(this.liveId, head.index, head.sealed);
          this.queue.shift();
          this.options.onStored?.(stored);
          break;
        } catch (e) {
          if (!isRetryable(e)) {
            console.warn(`[LIVE] uploader for ${this.liveId} stopped at segment ${head.index}`);
            this.stopped = true;
            this.queue.length = 0;
            this.options.onStopped?.(e);
            return;
          }
          // stop() may have run while this send was in flight: nothing left to wait for.
          if (this.stopped) return;
          this.options.onRetry?.(head.index, attempt, e);
          const wait = (this.options.backoffMs ?? defaultBackoff)(attempt);
          console.warn(
            `[LIVE] segment ${head.index} of ${this.liveId} not stored (attempt ${attempt}), retry in ${wait} ms`
          );
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, wait);
            this.wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          this.wake = null;
        }
      }
    }
  }
}
