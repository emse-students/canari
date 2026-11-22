/**
 * ONE ORDERED LANE PER SALON (2026-11-22): the order a member wrote their salon messages in is the
 * order the server receives them, by construction.
 *
 * Before it, every held salon text owned its own retry - its ladder step, its debt to the reconnect -
 * and the first answer that was not "not now" went to whichever text asked first. Measured on the
 * iPhone 12 (`1.7.3-alpha.5`, dev's social-service stopped ~80 s): `T1`..`T8` written in order were
 * stored `T1 T6 T7 T8 T2 T3 T4 T5`, the texts typed after the return overtaking the ones still on a
 * 30 s step. A reorder after the fact would be a heal; here no later text is ever POSTed while an
 * earlier one of the same salon still waits to go by itself.
 *
 * The lane is the ORDER only: which message's turn it is. What a turn does (the gate, the offline
 * hold, the POST, the classification of its answer) stays in `messaging.ts`, which tells the lane
 * when a message stops holding its place. A message holds it while the machine will send it again
 * by itself (in flight, held for the server, owed to the reconnect, waiting for its salon to load);
 * it leaves when it is settled, given up, or waits for its author (`error`, `unconfirmed`) - the
 * outbox's own rule for a parked entry (`outbox.ts`, WP-OFF-5): a message waiting on a human does not
 * make the ones after it wait too.
 *
 * Memory only: the durable order is the unsent ledger's (`salonUnsent.ts`), whose entries a next
 * page life reserves here in that order before any of them is drawn (`reserveSalonLaneTurns`).
 */

/** Per salon (its conversation key), the message ids in the order they must reach the server. */
const lanes = new Map<string, string[]>();
/** Each queued message's salon, so a message can leave without its caller naming the salon. */
const laneOf = new Map<string, string>();
/** Messages that have TAKEN their turn: attempted at least once, so nothing may be placed ahead. */
const started = new Set<string>();

/**
 * Places `messageId` at the end of its salon's lane, unless it already has a place - a repeat of a
 * message keeps the place it was given when it was written.
 */
export function joinSalonLane(conversationKey: string, messageId: string): void {
  if (laneOf.has(messageId)) return;
  const lane = lanes.get(conversationKey) ?? [];
  lane.push(messageId);
  lanes.set(conversationKey, lane);
  laneOf.set(messageId, conversationKey);
}

/**
 * Reserves places for messages a PAST page life wrote (the unsent ledger's leftovers, in the ledger's
 * order): ahead of every message of this page life that has not taken its turn yet, since they were
 * written before it - and behind the one that has, which may already be on the server. An id that
 * already has a place keeps it.
 */
export function reserveSalonLaneTurns(conversationKey: string, messageIds: string[]): void {
  const fresh = messageIds.filter((id) => !laneOf.has(id));
  if (fresh.length === 0) return;
  const lane = lanes.get(conversationKey) ?? [];
  const at = lane.length > 0 && started.has(lane[0]) ? 1 : 0;
  lane.splice(at, 0, ...fresh);
  lanes.set(conversationKey, lane);
  for (const id of fresh) laneOf.set(id, conversationKey);
}

/**
 * The message whose turn it is ahead of `messageId`, or `null` when it is `messageId`'s own turn (or
 * it has no place, which nothing in `messaging.ts` lets happen: every delivery joins first).
 */
export function salonLaneTurnAhead(messageId: string): string | null {
  const key = laneOf.get(messageId);
  if (key === undefined) return null;
  const head = lanes.get(key)?.[0];
  return head === undefined || head === messageId ? null : head;
}

/** Marks that `messageId` took its turn: nothing reserved later is placed ahead of it. */
export function takeSalonLaneTurn(messageId: string): void {
  if (laneOf.has(messageId)) started.add(messageId);
}

/** How many messages of `messageId`'s salon are ahead of it, for the log. */
export function salonLanePosition(messageId: string): number {
  const key = laneOf.get(messageId);
  if (key === undefined) return -1;
  return lanes.get(key)?.indexOf(messageId) ?? -1;
}

/**
 * Takes `messageId` out of its lane. Returns the message whose turn it now is when `messageId` WAS
 * the turn and another one waits behind it - the caller sends that one - else `null`.
 */
export function leaveSalonLane(messageId: string): string | null {
  const key = laneOf.get(messageId);
  started.delete(messageId);
  if (key === undefined) return null;
  laneOf.delete(messageId);
  const lane = lanes.get(key) ?? [];
  const at = lane.indexOf(messageId);
  if (at >= 0) lane.splice(at, 1);
  if (lane.length === 0) {
    lanes.delete(key);
    return null;
  }
  return at === 0 ? lane[0] : null;
}

/** Forgets every lane: the session ended, and what is unanswered stays in its account's ledger. */
export function clearSalonLanes(): void {
  lanes.clear();
  laneOf.clear();
  started.clear();
}
