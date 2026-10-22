/**
 * AN ADDRESSED HISTORY ANSWER IS ACCEPTED ONLY AS THE ANSWER TO OUR OWN QUESTION - rule 5 of step A
 * (docs/wiki/protocols/history-answer-addressing.md).
 *
 * Since step A every history answer on a conversation is routed by the server to the device that
 * asked (`recipientDevices`), and the server says so on the frame (`addressed`). MLS still encrypts
 * it for the whole group, so the routing is the only thing that made it private - and the same
 * routing would let a member show ONE device a frame the rest of the group never sees. So an
 * addressed frame is believed only when this device asked for exactly that:
 *
 * - every ask (`history_digest`, `history_pull`, `history_range`) carries a fresh `requestId`, kept
 *   here with the BOUND it stated; the answer echoes it;
 * - the inviter's push is solicited by this device's own admission: processing a Welcome records a
 *   `join` ask for the group;
 * - an ask takes at most {@link MAX_ANSWERERS_PER_ASK} answering devices - the elected responder and
 *   one re-elected over a stored probe - each closing it for itself with its chunk marked `last`,
 *   and is gone once they all have. The answerer is the device MLS verified (the caller refuses an
 *   addressed answer whose envelope names no device). The open asks are also a bounded FIFO per
 *   conversation ({@link MAX_OPEN_ASKS_PER_GROUP}) - state, never a clock; a restarted page has
 *   asked nothing, so it accepts nothing addressed.
 *
 * What an accepted answer may DO is decided by the bundle handler (add messages, nothing else); what
 * it may CARRY is decided here ({@link boundAddressedMessages}).
 */
import { UNDATED_SKEW_MARGIN_MS } from '$lib/utils/chat/historyEntitlement';
import { selectEntryIdsForPrefixes } from '$lib/utils/chat/historyManifest';
import { isWithinHistoryRange } from '$lib/utils/chat/historyWindow';

/**
 * What one ask stated, and therefore everything its answer may carry. `askedAt` is this device's
 * clock when the ask left: no answer can carry a message sent after the question.
 */
export type HistoryAsk =
  | { kind: 'digest'; since: number; askedAt: number }
  | {
      kind: 'pull';
      since: number;
      ids: readonly string[];
      prefixes: readonly string[];
      depth?: number;
      askedAt: number;
    }
  | { kind: 'range'; since: number; before: number; askedAt: number }
  | { kind: 'join'; askedAt: number };

/**
 * How many asks one conversation keeps open. A reconciliation asks one digest and at most a handful
 * of pulls, a reader one range per scroll; an ask whose answer never comes (a responder that went
 * away, a chunk that was entirely withheld) is pushed out by the next ones rather than by a timer.
 */
export const MAX_OPEN_ASKS_PER_GROUP = 32;

/**
 * How many devices may answer one ask. The rendezvous ELECTS one responder per solicitation; a
 * re-election can reuse a stored probe and hand the same ask to ONE more (an older probe answered
 * after the first responder went quiet). Nothing honest produces a third, so a third is refused and
 * logged by the caller - the bound is on the TOTAL answers an ask takes, not only on each answer.
 */
export const MAX_ANSWERERS_PER_ASK = 2;

/** The key a `join` ask is kept under - the push carries no request id, nobody asked it one. */
const JOIN_ASK = '__join__';

/**
 * One open ask: the answering devices (`sender:senderDeviceId`) it has taken, and those whose `last`
 * chunk closed it.
 */
type OpenAsk = { ask: HistoryAsk; answerers: Set<string>; closedBy: Set<string> };

/** Open asks, per conversation, in the order they were made. Insertion order is the FIFO. */
const openAsks = new Map<string, Map<string, OpenAsk>>();

/** A fresh request id for one ask. */
export function mintHistoryRequestId(): string {
  return crypto.randomUUID();
}

/**
 * The `requestId` a history frame carries, or `undefined` when it carries none usable - an older
 * asker, or a value shaped like nothing this build mints (a UUID: letters, digits and hyphens).
 * Echoed verbatim by the answerer, so it is checked where it enters rather than trusted into a log
 * line or a map key.
 */
export function parseHistoryRequestId(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(raw) ? raw : undefined;
}

function remember(groupId: string, requestId: string, ask: HistoryAsk): void {
  let asks = openAsks.get(groupId);
  if (!asks) {
    asks = new Map();
    openAsks.set(groupId, asks);
  }
  asks.delete(requestId);
  asks.set(requestId, { ask, answerers: new Set(), closedBy: new Set() });
  while (asks.size > MAX_OPEN_ASKS_PER_GROUP) {
    const oldest = asks.keys().next().value;
    if (oldest === undefined) break;
    asks.delete(oldest);
  }
}

/** Records an ask this device is about to send, under the id the frame carries. */
export function noteHistoryAsk(groupId: string, requestId: string, ask: HistoryAsk): void {
  remember(groupId, requestId, ask);
}

/**
 * Records that this device was just ADMITTED to `groupId` (its Welcome was processed), which is what
 * solicits the inviter's push. A Welcome processed again re-opens it, which is the same fact.
 */
export function noteJoinSolicited(groupId: string, now: number = Date.now()): void {
  remember(groupId, JOIN_ASK, { kind: 'join', askedAt: now });
}

/**
 * The ask an addressed answer in `groupId` claims to answer, or `null` when this device asked no
 * such thing - the frame is then refused by the caller. `requestId` absent is the inviter's push.
 * `answerer` is the device the answer came from (`sender:senderDeviceId`, checked against the MLS
 * credential on decrypt): its chunk marked `last` closes the ask FOR IT, a device beyond the first
 * {@link MAX_ANSWERERS_PER_ASK} is refused, and the ask is gone once every answerer it took is done.
 */
export function takeAddressedAsk(
  groupId: string,
  requestId: string | undefined,
  answerer: string,
  last: boolean
): HistoryAsk | null {
  const asks = openAsks.get(groupId);
  const id = requestId ?? JOIN_ASK;
  const open = asks?.get(id);
  if (!open || open.closedBy.has(answerer)) return null;
  if (!open.answerers.has(answerer)) {
    if (open.answerers.size >= MAX_ANSWERERS_PER_ASK) return null;
    open.answerers.add(answerer);
  }
  if (last) {
    open.closedBy.add(answerer);
    if (open.closedBy.size >= MAX_ANSWERERS_PER_ASK) {
      asks?.delete(id);
      if (asks?.size === 0) openAsks.delete(groupId);
    }
  }
  return open.ask;
}

/** How many asks `groupId` holds open - the tests, and a diagnostic. */
export function openHistoryAskCount(groupId: string): number {
  return openAsks.get(groupId)?.size ?? 0;
}

/** Forgets every open ask - a sign-out, and the tests. */
export function forgetHistoryAsks(): void {
  openAsks.clear();
}

/** What {@link boundAddressedMessages} kept, and how many it dropped for lying outside the ask. */
export type BoundedMessages<M> = { kept: M[]; outOfBound: number };

/**
 * The messages of an addressed answer that lie inside what `ask` asked for. Placement uses the
 * sender's `timestamp`, which is what the answerer selected on; the latest instant is the ask
 * widened by the same skew margin an undated message is placed with
 * ({@link UNDATED_SKEW_MARGIN_MS}), because the two clocks are different devices'.
 */
export function boundAddressedMessages<M extends { id: string; timestamp: number }>(
  ask: HistoryAsk,
  messages: readonly M[]
): BoundedMessages<M> {
  const latest = ask.askedAt + UNDATED_SKEW_MARGIN_MS;
  let slice: Set<string> | null = null;
  if (ask.kind === 'pull' && ask.prefixes.length > 0 && ask.depth) {
    slice = new Set(selectEntryIdsForPrefixes(messages, ask.prefixes, ask.depth));
  }
  const named = ask.kind === 'pull' ? new Set(ask.ids) : null;
  const kept = messages.filter((m) => {
    const at = Number(m.timestamp);
    if (Number.isFinite(at) && at > latest) return false;
    switch (ask.kind) {
      case 'join':
        return true;
      case 'digest':
        return isWithinHistoryRange(at, ask.since);
      case 'range':
        return Number.isFinite(at) && at >= ask.since && at < ask.before;
      case 'pull':
        return (
          isWithinHistoryRange(at, ask.since) &&
          (named?.has(m.id) === true || slice?.has(m.id) === true)
        );
    }
  });
  return { kept, outOfBound: messages.length - kept.length };
}
