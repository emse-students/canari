import { resolveAnchor, type VisibleAnchor } from './visibleRow';
import type { ChatMessage, ReadWatermarks } from '$lib/types';
import { messageTime, stampedTime } from './messageOrder';

/**
 * Read state as a watermark: one monotone instant per participant, meaning *this user has read
 * every message up to and including this point*. Merged as `max`, which makes it a CRDT - order of
 * arrival cannot change the result, and seeing the same value twice changes nothing.
 *
 * It replaces the per-message `readBy` array, and the reasons are structural rather than
 * cosmetic:
 *
 * - **it does not depend on which messages a device holds.** A `readBy` entry can only exist on a
 *   device that has the message, so a history catch-up delivering an older message marked it
 *   unread - the receipt for it had been sent long ago and was nowhere to be found. A watermark
 *   already covers messages the device has not seen yet;
 * - **it is one value per participant instead of one array per message**, so recording that a
 *   thousand messages were read is one write, not a thousand;
 * - **it survives a reinstall through the shared log**, because the whole read state of a
 *   conversation is a handful of numbers small enough to travel with every reconciliation.
 *
 * TWO CLOCKS, ONE PER MAP, BECAUSE A WATERMARK IS A NUMBER WITH NO UNIT (owner, 2026-10-31).
 *
 * - `serverReadWatermarks` is compared against `messageTime`, the SERVER's time when the row has it:
 *   the key the conversation is sorted by, so a mark never covers a row drawn below one it does not.
 *   This is the map this build writes for a DM or a group. A message delivered late sorts where it
 *   arrived, past every mark taken before it arrived, so it notifies and counts as unread.
 * - `readWatermarks` is compared against the row's STAMPED `timestamp` - the author's `sentAt` on an
 *   MLS row. It is the map every mark before 2026-10-31 was written in, the one an older client's
 *   frame still carries (`at` alone), and the one the native shade's "mark as read" writes. Kept,
 *   never converted: nothing can say which row a bare `at` meant. A salon's marks live here too,
 *   and for a salon the two clocks are one - a salon row's `timestamp` IS its server `createdAt`.
 *
 * A row is read when EITHER map covers it. A stamped mark from before the change keeps what it
 * already covered read, so nothing reads as unread on upgrade; the residue - a late message whose
 * `sentAt` is older than a STAMPED mark - is the old behaviour, and only where that stamped mark
 * is newer than every server mark. See docs/wiki/legacy-compatibility.md.
 */

/**
 * The instant a SERVER watermark is compared against - {@link messageTime}, the sort key. Kept in
 * one place so it cannot drift from the sort.
 */
export function readOrderKey(msg: Pick<ChatMessage, 'timestamp' | 'serverTimestamp'>): number {
  return messageTime(msg);
}

/** Whether a reader holding the `stamped` and `server` marks has read `msg`: either map covers it. */
export function isCoveredBy(
  msg: Pick<ChatMessage, 'timestamp' | 'serverTimestamp'>,
  stamped: number,
  server: number
): boolean {
  return (server > 0 && server >= readOrderKey(msg)) || stamped >= stampedTime(msg);
}

/** Both of one reader's marks in `convo`, 0 where a map holds nothing for them. */
export function readPointFor(
  convo: { readWatermarks?: ReadWatermarks; serverReadWatermarks?: ReadWatermarks },
  userNorm: string
): { stamped: number; server: number } {
  return {
    stamped: watermarkFor(convo.readWatermarks, userNorm),
    server: watermarkFor(convo.serverReadWatermarks, userNorm),
  };
}

/** This user's watermark, or 0 - which reads as "has read nothing", the correct default. */
export function watermarkFor(watermarks: ReadWatermarks | undefined, userNorm: string): number {
  return watermarks?.[userNorm.toLowerCase()] ?? 0;
}

/**
 * Advances one participant's watermark.
 *
 * @returns The new map, or `null` when `at` is not ahead of what is already held - the caller
 *          skips its write and its re-render on that answer, which is what keeps a receipt
 *          arriving twice from costing anything.
 */
export function mergeReadWatermark(
  watermarks: ReadWatermarks | undefined,
  userId: string,
  at: number
): ReadWatermarks | null {
  if (!userId || !Number.isFinite(at) || at <= 0) return null;
  const userNorm = userId.toLowerCase();
  const current = watermarks?.[userNorm] ?? 0;
  if (at <= current) return null;
  return { ...watermarks, [userNorm]: at };
}

/** Merges a whole map - a bundle's read state - participant by participant, `max` each. */
export function mergeReadWatermarks(
  watermarks: ReadWatermarks | undefined,
  incoming: ReadWatermarks | undefined
): ReadWatermarks | null {
  if (!incoming) return null;
  let next = watermarks;
  let changed = false;
  for (const [userId, at] of Object.entries(incoming)) {
    const merged = mergeReadWatermark(next, userId, at);
    if (merged) {
      next = merged;
      changed = true;
    }
  }
  return changed ? (next ?? null) : null;
}

/**
 * Reads a watermark map out of untrusted input - a peer's bundle, a replayed frame, a stored
 * column - keeping only the entries that are a user id and a usable instant.
 *
 * One place, because the same map arrives from three sources and a merge of `max` has no way to
 * take a bad value back: a single `Infinity` would mark every message of the conversation read for
 * that participant, for ever.
 *
 * @param raw A JSON string, an already-parsed object, or anything at all.
 */
export function parseReadWatermarks(raw: unknown): ReadWatermarks | undefined {
  let source = raw;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      return undefined;
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const clean: ReadWatermarks = {};
  for (const [userId, at] of Object.entries(source as Record<string, unknown>)) {
    if (!userId || typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue;
    const userNorm = userId.toLowerCase();
    clean[userNorm] = Math.max(clean[userNorm] ?? 0, Math.floor(at));
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/** Whether `userNorm` has read `msg`, by either map. */
export function hasRead(
  watermarks: ReadWatermarks | undefined,
  userNorm: string,
  msg: Pick<ChatMessage, 'timestamp' | 'serverTimestamp'>,
  serverWatermarks?: ReadWatermarks
): boolean {
  return isCoveredBy(
    msg,
    watermarkFor(watermarks, userNorm),
    watermarkFor(serverWatermarks, userNorm)
  );
}

/** Every participant either map names. */
function participantsOf(
  watermarks: ReadWatermarks | undefined,
  serverWatermarks: ReadWatermarks | undefined
): string[] {
  return [...new Set([...Object.keys(watermarks ?? {}), ...Object.keys(serverWatermarks ?? {})])];
}

/**
 * Everyone who has read `msg`, the author excluded - reading one's own message means nothing, and
 * the sender is the one asking who else has.
 *
 * Derived, never stored: the alternative is a second copy of the same fact on every message, and a
 * second copy is a thing that can disagree.
 */
export function readersOf(
  msg: Pick<ChatMessage, 'timestamp' | 'serverTimestamp' | 'senderId'>,
  watermarks: ReadWatermarks | undefined,
  serverWatermarks?: ReadWatermarks
): string[] {
  const authorNorm = msg.senderId.toLowerCase();
  return participantsOf(watermarks, serverWatermarks)
    .filter(
      (userNorm) => userNorm !== authorNorm && hasRead(watermarks, userNorm, msg, serverWatermarks)
    )
    .sort();
}

/**
 * Where each participant's "seen" head sits in a group or a salon: under the LAST message they
 * have read, whoever wrote it - the Messenger placement (user, 2026-10-02). A DM keeps the older
 * shape (readers under the sender's own last read message), so this is only called for the rest.
 *
 * - **Who appears is decided upstream, by what `watermarks` holds.** For a salon that map is the
 *   server's `read-marks`, already restricted to the members who may read the salon NOW; nothing
 *   here widens it.
 * - **The viewer never sees their own head**, and a system notice never carries one.
 * - **A participant's own message counts as read by them**, even when their watermark lags it
 *   (a sender's watermark moves when they READ, not when they write). Without that, an author
 *   whose watermark is older than their own reply would be drawn ABOVE the reply, claiming they
 *   had not seen it. And a head that would land on its owner's own message is not drawn: the
 *   message already says it.
 *
 * @param messages The conversation in DISPLAY order (`compareMessageOrder`). The WHOLE list, never
 *                 a render window: a window ending above a reader's true anchor would pin the head
 *                 to the window's last row.
 * @param serverWatermarks The server-clock marks (top of this file); a reader is placed by whichever
 *                 of their two marks reaches further.
 * @returns message id -> the participants anchored there, sorted; messages with none are absent.
 */
export function seenByAnchors(
  messages: ReadonlyArray<
    Pick<ChatMessage, 'id' | 'timestamp' | 'serverTimestamp' | 'senderId' | 'isSystem'>
  >,
  watermarks: ReadWatermarks | undefined,
  viewerId: string,
  serverWatermarks?: ReadWatermarks
): Map<string, string[]> {
  const anchors = new Map<string, string[]>();
  const viewerNorm = viewerId.trim().toLowerCase();
  const rows = messages.filter((msg) => !msg.isSystem && msg.senderId !== 'system');
  // ONE pass over the conversation, whatever the number of readers: each reader is then placed by
  // two binary searches and a lookup (review of #2824, P3-7) - never a scan per reader.
  const serverKeys = suffixMinima(rows.map(readOrderKey));
  const stampedKeys = suffixMinima(rows.map(stampedTime));
  const lastWritten = new Map<string, number>();
  rows.forEach((row, i) => lastWritten.set(row.senderId.toLowerCase(), i));

  for (const userNorm of participantsOf(watermarks, serverWatermarks)) {
    if (userNorm === viewerNorm) continue;
    const stamped = watermarkFor(watermarks, userNorm);
    const server = watermarkFor(serverWatermarks, userNorm);
    // The LAST row, in display order, this reader has read ({@link isCoveredBy}: either mark) or
    // wrote.
    const found = Math.max(
      server > 0 ? lastAtOrBelow(serverKeys, server) : -1,
      lastAtOrBelow(stampedKeys, stamped),
      lastWritten.get(userNorm) ?? -1
    );
    if (found < 0) continue;
    const anchor = rows[found];
    if (anchor.senderId.toLowerCase() === userNorm) continue;
    const heads = anchors.get(anchor.id);
    if (heads) heads.push(userNorm);
    else anchors.set(anchor.id, [userNorm]);
  }
  for (const heads of anchors.values()) heads.sort();
  return anchors;
}

/**
 * `out[i]` = the smallest of `keys[i..]`: non-decreasing, whatever order `keys` is in. The display
 * order is the server key's order for every dated row, but not for an unsent own row (ordered below
 * them all, on its `sentAt`) nor for the stamped key at all - so the anchors search THIS, never the
 * keys themselves.
 */
function suffixMinima(keys: readonly number[]): number[] {
  const out: number[] = Array.from({ length: keys.length }, () => 0);
  let min = Infinity;
  for (let i = keys.length - 1; i >= 0; i--) {
    min = Math.min(min, keys[i]);
    out[i] = min;
  }
  return out;
}

/**
 * The last index whose key is `<= mark`, or -1, by binary search over {@link suffixMinima}: the last
 * `i` with `suffixMin[i] <= mark` IS the last `j` with `keys[j] <= mark` - some key at or after `i`
 * is under the mark, and every key after the last such `j` is above it.
 */
function lastAtOrBelow(suffixMin: readonly number[], mark: number): number {
  let lo = 0;
  let hi = suffixMin.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (suffixMin[mid] <= mark) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Whether `msg` should still raise the unread badge for the user whose watermark is `watermark`.
 *
 * Own and system messages never count. Both recompute sites used to infer "unseen" from "arrived
 * just now", which is only a proxy and broke on a history bundle: those messages are new to THIS
 * device yet were already read on another one.
 */
export function isUnreadForUser(
  msg: Pick<ChatMessage, 'isOwn' | 'isSystem' | 'senderId' | 'timestamp' | 'serverTimestamp'>,
  watermark: number,
  serverWatermark = 0
): boolean {
  if (msg.isOwn || msg.isSystem || msg.senderId === 'system') return false;
  return !isCoveredBy(msg, watermark, serverWatermark);
}

/**
 * THE ONE WAY THIS USER'S OWN READ POINT MOVES: the watermark rises AND the unread counter follows.
 *
 * `unreadCount` is what the sidebar tile, the nav dot, the tab title `(N)` and the favicon dot all
 * read, and it is a counter maintained beside the watermark rather than derived from it. Every place
 * that advanced the watermark had to remember to zero the counter too, and the ones that did not
 * (a salon read on another device, the optimistic mark of an open conversation, a follower tab) left
 * a count nothing would ever clear - the title kept `(2)` after everything had been read.
 *
 * The count only ever FALLS here: it becomes the smaller of what it was and what is still unread at
 * the new watermark among the messages held. A message this device has not loaded cannot raise it,
 * and one it holds past the watermark keeps it - which is what an unconditional zero got wrong.
 *
 * `clock` names the map `at` belongs to (top of this file): `server` for a DM or group mark this
 * build decided or a frame that said `serverAt`; `stamped` for a salon mark, an older client's bare
 * `at`, and the native shade's.
 *
 * @returns `convo` itself when neither the watermark nor the count changes, so a repeat costs no
 *          re-render.
 */
export function withOwnReadAdvanced<
  C extends {
    messages: Array<
      Pick<ChatMessage, 'isOwn' | 'isSystem' | 'senderId' | 'timestamp' | 'serverTimestamp'>
    >;
    readWatermarks?: ReadWatermarks;
    serverReadWatermarks?: ReadWatermarks;
    unreadCount?: number;
  },
>(convo: C, userId: string, at: number, clock: ReadClock): C {
  const field = clock === 'server' ? 'serverReadWatermarks' : 'readWatermarks';
  const merged = mergeReadWatermark(convo[field], userId, at);
  const point = readPointFor({ ...convo, ...(merged ? { [field]: merged } : {}) }, userId);
  const held = convo.unreadCount ?? 0;
  const next = Math.min(held, countUnreadForUser(convo.messages, point.stamped, point.server));
  if (!merged && next === held) return convo;
  return {
    ...convo,
    ...(merged ? { [field]: merged } : {}),
    unreadCount: next,
  };
}

/**
 * Which map a mark belongs to: `server` is compared against the server's time of a row, `stamped`
 * against the row's own `timestamp`. See the top of this file.
 */
export type ReadClock = 'server' | 'stamped';

/** Counts the messages of `msgs` that still read as unread for a reader holding these two marks. */
export function countUnreadForUser(
  msgs: Array<
    Pick<ChatMessage, 'isOwn' | 'isSystem' | 'senderId' | 'timestamp' | 'serverTimestamp'>
  >,
  watermark: number,
  serverWatermark = 0
): number {
  return msgs.reduce(
    (total, msg) => total + (isUnreadForUser(msg, watermark, serverWatermark) ? 1 : 0),
    0
  );
}

/**
 * HOW MANY UNREAD MESSAGES LIE BELOW THE READER'S VIEWPORT - what the floating "scroll to bottom"
 * button may call new messages.
 *
 * The button used to carry {@link countUnreadForUser} over the WHOLE conversation: an unread row
 * anywhere - above the viewport, in view, or merely not yet covered by a mark that moves only while
 * the window is focused - put a "1" on an arrow that points at the bottom, and a reader scrolled up
 * on a thread with nothing new below saw a count of something they could not find (owner, 2026-11-01).
 * The question the arrow asks is positional, so the answer is: the unread rows AFTER the last row the
 * reader can see. A reaction, an edit or a pin is not a row and never reaches this function.
 *
 * @param msgs The thread in DISPLAY order (`messageGroups` rows), never the store's order.
 * @param anchor The last row at least partly in view above the composer; `null` when the position
 *        is not measured yet, which counts nothing - a count with no position would be the old lie.
 *        A row that has since gone resolves to the nearest surviving one (`resolveAnchor`).
 */
export function countUnreadBelow(
  msgs: ReadonlyArray<
    Pick<ChatMessage, 'id' | 'isOwn' | 'isSystem' | 'senderId' | 'timestamp' | 'serverTimestamp'>
  >,
  anchor: VisibleAnchor | null,
  watermark: number,
  serverWatermark = 0
): number {
  const { index } = resolveAnchor(
    msgs.map((msg) => msg.id),
    anchor
  );
  if (index < 0) return 0;
  return countUnreadForUser(msgs.slice(index + 1), watermark, serverWatermark);
}

/**
 * The watermark that marking `msgs` read would produce: the latest instant among the messages this
 * user could have read, never below what they already hold.
 *
 * Taken from the messages themselves rather than from the clock, so the value compares correctly
 * against the population it will be compared against - a device whose clock runs fast would
 * otherwise mark unread messages read, permanently and unfixably, the merge being `max`.
 *
 * `includeSystem` is for a SALON ONLY. A DM's notice is stamped by this device's clock, so it cannot
 * bound a read; a salon's notice is a server row dated by the SERVER, and the server counts it as
 * unread until a mark reaches it. Without it a salon whose newest rows are membership notices could
 * never be marked read: the badge came back at every reload (prod, 2026-10-11).
 */
export function watermarkAfterReading(
  msgs: Array<
    Pick<
      ChatMessage,
      'isOwn' | 'isSystem' | 'senderId' | 'timestamp' | 'serverTimestamp' | 'awaitingServerId'
    >
  >,
  current: number,
  includeSystem = false
): number {
  let highest = current;
  for (const msg of msgs) {
    if (!includeSystem && (msg.isSystem || msg.senderId === 'system')) continue;
    // A SALON ECHO IS DATED BY THE AUTHOR'S CLOCK until the server's row settles it (WP-OFF-2), and
    // a salon mark is on the server's `createdAt` clock: counting it would push this reader's own
    // mark past every row the server holds whenever the device runs fast - the permanent
    // over-read described above. The settled row, server-dated, moves the mark instead.
    if (msg.awaitingServerId) continue;
    const key = readOrderKey(msg);
    if (key > highest) highest = key;
  }
  return highest;
}

/**
 * Where reading an open conversation moves this user's own mark.
 *
 * A DM OR AN MLS GROUP MOVES OVER FOREIGN MESSAGES ONLY. The mark used to move over the reader's own
 * sends too, so every message sent was followed 2 s later by a `read_watermark` frame that told
 * nobody anything: an author is already placed at their own message (`seenByAnchors`) and an own
 * message is never unread (`isUnreadForUser`). Each of those frames is an MLS application frame that
 * every member's device must decrypt and then checkpoint. See history-reconciliation, "The sender says
 * only what is new".
 *
 * A SALON IS UNCHANGED, own and system rows included: its mark goes to the server, which counts
 * unread rows against it.
 *
 * THE ANSWER IS ON THE SERVER'S CLOCK (`readOrderKey`) for both: a DM or group mark goes into
 * `serverReadWatermarks` and its frame says `serverAt`; a salon row's two clocks are one.
 * `current` is the reader's mark in the map the answer goes into.
 */
export function readMarkTarget(
  msgs: Array<
    Pick<
      ChatMessage,
      'isOwn' | 'isSystem' | 'senderId' | 'timestamp' | 'serverTimestamp' | 'awaitingServerId'
    >
  >,
  current: number,
  isSalon: boolean,
  serverSeen: number
): number {
  if (isSalon) return watermarkAfterReading(msgs, current, true);
  const target = watermarkAfterReading(
    msgs.filter((msg) => !msg.isOwn),
    current
  );
  return Math.max(current, Math.min(target, serverMarkCeiling(msgs, serverSeen)));
}

/**
 * THE HIGHEST A SERVER-CLOCK MARK MAY GO: the newest `serverTimestamp` the conversation holds, and
 * never above what the server itself has said to this account on this device (`serverSeen`,
 * serverClock.ts, durable). 0 - the mark does not move - while the server has said nothing.
 *
 * WHY. The target is the newest key read, and a row's key falls back on its `sentAt` - the AUTHOR's
 * clock - when the row has no server time, while a bundle row's server time was written by the
 * member who relayed it. Unbounded, a phone running fast or a relayer writing 2100 would push the
 * reader's server mark past every message not yet received, and the merge is `max`: read for good,
 * before they arrive. An undated row newer than every server time held therefore stays unread until
 * a dated row catches up with it, which is the cost of never over-reading.
 *
 * A conversation holding no dated row at all is bounded by `serverSeen` alone.
 */
export function serverMarkCeiling(
  msgs: ReadonlyArray<Pick<ChatMessage, 'serverTimestamp'>>,
  serverSeen: number
): number {
  let held = 0;
  for (const msg of msgs) {
    const at = msg.serverTimestamp;
    if (typeof at === 'number' && Number.isFinite(at) && at > held) held = at;
  }
  // NOTHING KNOWN, NOTHING MOVED: with no server statement on this device yet (a first boot with no
  // network) the rows held are the only bound, and they are exactly what is not trusted.
  if (serverSeen <= 0) return 0;
  return held === 0 ? serverSeen : Math.min(held, serverSeen);
}

/**
 * The mark a `read_watermark` frame states, and the clock it is on.
 *
 * A frame from this build carries `serverAt` (the server's clock, `serverReadWatermarks`) AND `at`,
 * the same value, for an older client that reads `at` alone. A frame with no `serverAt` is from an
 * older client or the native shade, and its `at` is on the stamped clock (`readWatermarks`).
 * `null` when the frame states no usable instant.
 */
export function readWatermarkFrameMark(data: {
  at?: unknown;
  serverAt?: unknown;
}): { at: number; clock: ReadClock } | null {
  const server = Number(data.serverAt);
  if (Number.isFinite(server) && server > 0) return { at: server, clock: 'server' };
  const stamped = Number(data.at);
  if (Number.isFinite(stamped) && stamped > 0) return { at: stamped, clock: 'stamped' };
  return null;
}

/**
 * The mark a `read_watermark` frame RECEIVED from a member states, bounded by the server's own time
 * for that frame: an honest sender's server-clock mark is the server time of a row it holds, which
 * the server accepted before it accepted this frame. A server mark above `frameServerAt` - or any
 * server mark when the frame's server time is unknown - is REFUSED, with the reason: written by a
 * member, unbounded, it would mark every later message read before it arrives, for good (the merge
 * is `max`). A stamped mark (an older client's `{at}`) is on the author's clock and is passed through
 * as it always was.
 */
export function receivedReadWatermarkMark(
  data: { at?: unknown; serverAt?: unknown },
  frameServerAt: number | undefined
): { mark: { at: number; clock: ReadClock } | null; refused?: string } {
  const mark = readWatermarkFrameMark(data);
  if (!mark || mark.clock !== 'server') return { mark };
  if (!(typeof frameServerAt === 'number' && frameServerAt > 0)) {
    return { mark: null, refused: 'the frame carries no server time to bound it' };
  }
  if (mark.at > frameServerAt) {
    return {
      mark: null,
      refused: `serverAt ${mark.at} is after the server accepted the frame (${frameServerAt})`,
    };
  }
  return { mark };
}

/**
 * The server-clock marks a HISTORY BUNDLE restates, without any above the server's own time for the
 * bundle frame (see {@link receivedReadWatermarkMark}); `dropped` counts the refused ones. With no
 * server time for the frame, every server mark is refused.
 */
export function boundedServerMarks(
  marks: ReadWatermarks | null | undefined,
  frameServerAt: number | undefined
): { kept: ReadWatermarks | null; dropped: number } {
  if (!marks) return { kept: null, dropped: 0 };
  const bound = typeof frameServerAt === 'number' && frameServerAt > 0 ? frameServerAt : 0;
  const kept: ReadWatermarks = {};
  let dropped = 0;
  for (const [user, at] of Object.entries(marks)) {
    if (bound > 0 && at <= bound) kept[user] = at;
    else dropped++;
  }
  return { kept: Object.keys(kept).length > 0 ? kept : null, dropped };
}

/** The `data` of a `read_watermark` frame this build sends: the mark under both names (see above). */
export function readWatermarkFrameData(serverAt: number): { at: number; serverAt: number } {
  return { at: serverAt, serverAt };
}

/**
 * `convo` with `userId`'s mark on `clock` advanced to `at`, or `null` when it is not ahead - a
 * PEER's mark, which moves no badge. Our own goes through {@link withOwnReadAdvanced}.
 */
export function withReadMark<
  C extends { readWatermarks?: ReadWatermarks; serverReadWatermarks?: ReadWatermarks },
>(convo: C, userId: string, at: number, clock: ReadClock): C | null {
  const field = clock === 'server' ? 'serverReadWatermarks' : 'readWatermarks';
  const merged = mergeReadWatermark(convo[field], userId, at);
  return merged ? { ...convo, [field]: merged } : null;
}
