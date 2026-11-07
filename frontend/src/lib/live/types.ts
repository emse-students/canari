/**
 * THE WIRE SHAPES OF `/api/lives`, as social-service really serialises them.
 *
 * Read from `apps/social-service/src/lives/lives.service.ts` (`LiveView`, `LiveListItem`,
 * `LiveManifest`, `LiveIngestResult`, `LiveEndResult`) and `live.constants.ts` (`liveLimits`), not
 * from the wiki. Every server `Date` crosses the network as an ISO-8601 string, so it is typed
 * `string` here - a caller parses it where it needs a number, it is never silently a `Date`.
 * Contract: docs/wiki/services/lives.md, "The API contract".
 */

/**
 * Why a live ended - the row's `endReason` (`LiveEndReason` on the server). `max_duration` is no
 * longer written (the 60-minute cap is gone) but stays READABLE: rows ended before it was removed
 * still carry it until the retention purge deletes them.
 */
export type LiveEndReason = 'broadcaster' | 'dropped' | 'erased' | 'cut' | 'max_duration';

/**
 * A live as `POST /api/lives` (201) and `GET /api/lives/:id` answer it: the KEY included (L2, Q4).
 * `key` is 64 lower-case hex characters - 32 bytes of AES-256 key material, never logged.
 */
export interface LiveView {
  id: string;
  broadcasterId: string;
  associationId: string | null;
  startedAt: string;
  /** Written by the ingest only: the broadcaster's own liveness. `null` before segment 0. */
  lastSegmentAt: string | null;
  nextIndex: number;
  key: string;
  /** The live's optional title (owner, 2026-11-07); absent from an older server. */
  title?: string | null;
  /**
   * On `GET /api/lives/:id` only: the reader moderates this live as a BDE (2026-11-02), as on the
   * list. Absent (the broadcaster's own view, an older server) reads as false.
   */
  viewerModerates?: boolean;
  /**
   * On `GET /api/lives/:id` only: the chat is withheld from this reader - a named reader watching an
   * association's live through a read grant alone, "voit les commentaires" off (owner, 2026-11-04).
   * Absent (an older server) reads as false; every poll's chat block then says it again.
   */
  chatWithheld?: boolean;
}

/**
 * One open live in `GET /api/lives` (newest first, at most 50). The list TAKES NO SEAT (owner,
 * 2026-11-07): it carries what the feed card draws - the title, the viewer count, the newest preview
 * image and, with that image only, the key that opens it. Each new field is optional: an older
 * server sends none, and the card then reads as it did ("X est en direct", no picture).
 */
export interface LiveListItem {
  id: string;
  broadcasterId: string;
  associationId: string | null;
  startedAt: string;
  /**
   * The reader moderates this live as a BDE (its governed spaces hold it, 2026-11-02): draws the
   * staff hide button. Absent from an older server, read as false.
   */
  viewerModerates?: boolean;
  /** The live's optional title (plain text), null or absent for none. */
  title?: string | null;
  /** How many watch; null when the count did not answer (no number shown). */
  viewers?: number | null;
  /**
   * The newest preview image: `name` under the segments' public route, `ageMs` on the SERVER's
   * clock (`now() - posterAt`), so the card never compares a server stamp with the device's clock.
   */
  poster?: { name: string; ageMs: number } | null;
  /** The live key, served with a poster only - what opens it. Never logged. */
  key?: string | null;
}

/**
 * One segment of a manifest. `name` is its address under
 * `/api/media/public/live/<liveId>/<name>` (no token, nginx-cached); `bytes` is the ciphertext size.
 */
export interface LiveManifestSegment {
  index: number;
  name: string;
  bytes: number;
}

/**
 * What a viewer polls: `GET /api/lives/:id/manifest[?from=<index>]`. `serverNow` and `lastSegmentAt`
 * are BOTH the database's clock, so "reconnecting" is decided by comparing them, never against the
 * device's clock. At most `manifestWindow` segments, ascending by index.
 */
export interface LiveManifest {
  liveId: string;
  nextIndex: number;
  lastSegmentAt: string | null;
  serverNow: string;
  segments: LiveManifestSegment[];
  /**
   * How many accounts watch the live: the seats it holds on the host's cap, the caller's own
   * included, the broadcaster never. A COUNT ONLY - no answer of the API names a viewer. `null` when
   * the broadcaster's count did not answer: show no number, never a guessed one.
   */
  viewers: number | null;
  /** The live chat (WP-L6), present only when the poll asked for it (`chat=1`). */
  chat?: LiveChatBlock;
}

/** The five floating reactions (decided 2026-10-20), the server's `LIVE_REACTION_KINDS`. */
export type LiveReactionKind = 'like' | 'laugh' | 'clap' | 'fire' | 'canari';

/** One message of the chat as the poll serves it: ciphertext under the live key, base64 (C12). */
export interface LiveChatMessageWire {
  id: string;
  seq: number;
  authorId: string;
  clientId: string;
  sealed: string;
  createdAt: string;
}

/** A hidden message: the line drawn for `id` goes (C14). */
export interface LiveChatTombstoneWire {
  id: string;
  seq: number;
  hidden: true;
}

/** The sums of every reaction burst of one 2 s window of the live (C7). */
export interface LiveReactionWindow {
  window: number;
  counts: Partial<Record<LiveReactionKind, number>>;
}

/**
 * The `chat` block of a manifest poll (`?chat=1&messagesAfter=&reactionsAfter=`). Each cursor is
 * passed back as is at the next poll; the server's sequence never skips (lives.md, C4).
 */
export interface LiveChatBlock {
  messages: (LiveChatMessageWire | LiveChatTombstoneWire)[];
  messagesCursor: number;
  reactions: LiveReactionWindow[];
  reactionsCursor: number;
  /**
   * `true` when the chat is withheld from this reader (owner, 2026-11-04): `messages` is empty and
   * the message cursor is not the reader's to keep; the reactions are served as to anyone.
   */
  withheld?: true;
  /**
   * THE ARRIVAL LINES ("X a rejoint", owner, 2026-11-07): the accounts that arrived since the last
   * poll - at most 3, never the reader and never an account blocked either way - the count folded
   * behind them, and the cursor to pass back. Absent from a withheld reader's block and from an older
   * server's, so an arrival line is drawn only where the server sent one.
   */
  arrivals?: { userId: string; seq: number }[];
  arrivalsMore?: number;
  arrivalsCursor?: number;
}

/** What a poll asks of the chat: absent cursors on the first poll (the newest 50, no reaction backlog). */
export interface LiveChatQuery {
  messagesAfter?: number;
  reactionsAfter?: number;
  arrivalsAfter?: number;
}

/** `POST /api/lives/:id/messages/:messageId/hide`. */
export interface LiveChatHidden {
  liveId: string;
  messageId: string;
  hidden: true;
}

/** `PUT /api/lives/:id/segments/:index` - and its idempotent repeat with the same bytes. */
export interface LiveIngestResult {
  index: number;
  name: string;
  nextIndex: number;
}

/** `PUT /api/lives/:id/poster` (owner, 2026-11-07): the stored preview image's name and time. */
export interface LivePosterResult {
  name: string;
  posterAt: string;
}

/** `PATCH /api/lives/:id`: the title as the server now holds it. */
export interface LiveTitleResult {
  id: string;
  title: string | null;
}

/** `POST /api/lives/:id/end`. */
export interface LiveEndResult {
  id: string;
  endedAt: string;
  endReason: LiveEndReason;
}

/** The reason a moderator gives for a cut: the report reasons' own four. */
export type LiveCutReason = 'spam' | 'harassment' | 'inappropriate' | 'other';

/** `POST /api/lives/:id/cut` (200, idempotent): `newlyCut` false is the answer to a repeat. */
export interface LiveCutResult {
  liveId: string;
  broadcasterId: string;
  reason: LiveCutReason;
  cutAt: string;
  endReason: LiveEndReason;
  /** True when this call recorded the cut; false when the live had already been cut. */
  newlyCut: boolean;
  /** How many times the broadcaster was cut BEFORE this one - the repeat-offender count. */
  priorCuts: number;
}

/**
 * A broadcaster's place on the strike ladder, as the moderation queue states it (the server's
 * `LiveStanding`, dates as ISO strings). `withdrawalDue`: enough cuts are on record and the right is
 * not withdrawn - the decision is a moderator's.
 */
export interface LiveStanding {
  cutsOnRecord: number;
  suspendedUntil: string | null;
  withdrawnAt: string | null;
  withdrawalDue: boolean;
}

/** `POST /api/lives/broadcasters/:userId/withdrawal` (200, idempotent). */
export interface LiveWithdrawalResult {
  userId: string;
  reason: LiveCutReason;
  withdrawnAt: string;
  /** False when the right had already been withdrawn: the answer is the first withdrawal's. */
  newlyWithdrawn: boolean;
  cutsOnRecord: number;
}

/** `POST /api/lives/:id/removed-viewers`. */
export interface LiveRemovedViewer {
  liveId: string;
  viewerId: string;
}

/**
 * `GET /api/lives/limits` - the server's numbers, the ONE copy (`liveLimits()`). A client carries
 * none of them, because an installed build keeps whatever it was compiled with.
 */
export interface LiveLimits {
  segmentMaxBytes: number;
  reconnectWindowMs: number;
  manifestWindow: number;
  segmentMinDurationMs: number;
  segmentBurst: number;
  startsPerHour: number;
  viewerCap: number;
  seatLeaseMs: number;
  /** WP-L6: the longest message, in UTF-16 units of plain text - the client's to enforce. */
  chatMessageMaxChars: number;
  chatSealedMaxBytes: number;
  chatMessagesPerWindow: number;
  chatRateWindowMs: number;
  chatBacklog: number;
  reactionKinds: LiveReactionKind[];
  reactionWindowMs: number;
  reactionBurstsPerWindow: number;
  reactionTapsPerWindow: number;
  /**
   * The longest title, in characters (code points), owner 2026-11-07. Absent from a server before
   * the titles: the screen then offers no title field.
   */
  titleMaxChars?: number;
  /** The largest sealed preview image, in bytes. Absent from an older server: no preview is sent. */
  posterMaxBytes?: number;
  /** A preview image every this many segments (segment 0 first). */
  posterEverySegments?: number;
  /** How often a feed card on screen re-reads the list, in ms. Absent: the card refreshes with the feed only. */
  cardRefreshMs?: number;
}

/**
 * `GET /api/lives/rules` - the caller's standing with the first-live rules (L11, WP-L8). The rules
 * are shown, and the start carries `acceptedRulesVersion: version`, while `acceptedVersion` is
 * below `version` (null: never accepted). The server records the acceptance with the start.
 */
export interface LiveRulesStatus {
  version: number;
  acceptedVersion: number | null;
  acceptedAt: string | null;
}

/**
 * Every `code` a lives route (or the segment fetch) puts in a refusal body. The server throws each
 * as `new XxxException({ code, ... })`, which Nest serialises as that object.
 */
export type LiveRefusalCode =
  | 'LIVE_KEY_INVALID'
  | 'LIVE_ASSOCIATION_INVALID'
  | 'LIVE_MUTED'
  | 'LIVE_RULES_NOT_ACCEPTED'
  | 'LIVE_ASSOCIATION_FORBIDDEN'
  | 'LIVE_ASSOCIATION_ARCHIVED'
  | 'LIVE_ALREADY_OPEN'
  | 'LIVE_WITHDRAWAL_FORBIDDEN'
  | 'LIVE_WITHDRAWAL_NOT_DUE'
  | 'LIVE_ACCOUNT_INVALID'
  | 'LIVE_START_RATE'
  | 'LIVE_NOT_FOUND'
  | 'LIVE_ENDED'
  | 'LIVE_VIEWER_REMOVED'
  | 'LIVE_FULL'
  | 'LIVE_SEATS_UNAVAILABLE'
  | 'LIVE_KEY_UNAVAILABLE'
  | 'LIVE_KEY_SEALING_UNAVAILABLE'
  | 'LIVE_SEGMENT_OUT_OF_ORDER'
  | 'LIVE_SEGMENT_CONFLICT'
  | 'LIVE_SEGMENT_IN_PROGRESS'
  | 'LIVE_SEGMENT_RESERVATION_LOST'
  | 'LIVE_SEGMENT_TOO_FAST'
  | 'LIVE_SEGMENT_EMPTY'
  | 'LIVE_STORE_UNAVAILABLE'
  | 'LIVE_TITLE_INVALID'
  | 'LIVE_POSTER_EMPTY'
  | 'LIVE_POSTER_TOO_LARGE'
  | 'LIVE_POSTER_TOO_FAST'
  | 'LIVE_POSTER_IN_PROGRESS'
  | 'LIVE_POSTER_RESERVATION_LOST'
  | 'LIVE_INGEST_BUSY'
  | 'LIVE_INDEX_INVALID'
  | 'LIVE_FROM_INVALID'
  | 'LIVE_VIEWER_INVALID'
  | 'LIVE_VIEWER_IS_SELF'
  | 'LIVE_CUT_FORBIDDEN'
  | 'LIVE_CUT_REASON_INVALID'
  | 'LIVE_CUT_DETAILS_INVALID'
  | 'LIVE_MESSAGE_INVALID'
  | 'LIVE_MESSAGE_CONFLICT'
  | 'LIVE_MESSAGE_TOO_FAST'
  | 'LIVE_MESSAGE_NOT_FOUND'
  | 'LIVE_REACTION_INVALID'
  | 'LIVE_REACTION_CONFLICT'
  | 'LIVE_REACTION_TOO_FAST'
  | 'LIVE_MESSAGES_AFTER_INVALID'
  | 'LIVE_REACTIONS_AFTER_INVALID';

/**
 * WHAT A SCREEN DOES WITH A REFUSAL - decided once, at the throw ({@link classifyLiveRefusal}), so
 * no caller re-derives it from a status. The three the brief forbids confusing are separate kinds:
 *
 * - `full`: `503 LIVE_FULL` - every seat of the host is held. The "live complet" screen; back off,
 *   never hammer (a 503 is what HTTP stacks retry on their own).
 * - `seats-unavailable`: `503 LIVE_SEATS_UNAVAILABLE` - the seat count (Redis) did not answer. A
 *   failure to retry, NEVER "complet".
 * - `rate-limited`: any `429` - a server code (`LIVE_START_RATE`, `LIVE_SEGMENT_TOO_FAST`) or nginx's
 *   own (no code: the ingest zone, or the per-address segment bound).
 * - `not-found`: `404 LIVE_NOT_FOUND` (absent, invisible, blocked, another member's live on a write,
 *   or an ended live already purged), or a 404 on a segment fetch.
 * - `ended`: `410 LIVE_ENDED`, whose body carries `endedAt` and `endReason` (`cut`: a moderator ended it).
 * - `removed`: `403 LIVE_VIEWER_REMOVED` - the broadcaster removed this viewer.
 * - `disabled`: a `404` with no code on `/api/lives` - the live guard: the `LIVE_ENABLED` deploy lock
 *   (off on production) or the runtime kill switch `platform_config.lives_mode` set to `off`.
 * - `out-of-order`: `409 LIVE_SEGMENT_OUT_OF_ORDER` - `nextIndex` says which index the server wants.
 * - `retry-segment`: the SAME index should be sent again after a short backoff:
 *   `409 LIVE_SEGMENT_IN_PROGRESS`, `409 LIVE_SEGMENT_RESERVATION_LOST`,
 *   `503 LIVE_STORE_UNAVAILABLE`, `503 LIVE_INGEST_BUSY`.
 * - `refused`: any other answer the gateway gave a verdict in (a 4xx with or without a code:
 *   validation, `LIVE_MUTED`, `LIVE_ALREADY_OPEN`, `LIVE_SEGMENT_CONFLICT`, a 413...). Read `code`.
 * - `unavailable`: a 5xx with no live code (a 502 mid-deploy, an edge error page): nobody gave a
 *   verdict; retry later. A 4xx from the edge (a WAF page, nginx's own 413) is `refused`, since
 *   re-sending the same request meets the same refusal.
 */
export type LiveRefusalKind =
  | 'full'
  | 'seats-unavailable'
  | 'rate-limited'
  | 'not-found'
  | 'ended'
  | 'removed'
  | 'suspended'
  | 'withdrawn'
  | 'disabled'
  | 'out-of-order'
  | 'retry-segment'
  | 'refused'
  | 'unavailable';
