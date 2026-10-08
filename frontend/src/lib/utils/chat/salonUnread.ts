/**
 * The unread count of a salon, taken from the server and merged with what arrived live.
 *
 * WHY THE SERVER. A salon's `unreadCount` used to be a tally of what arrived while this device was
 * listening - never persisted (a salon's messages are not stored on the device) and fed only by the
 * live socket. So a reload, a cold start, a phone that was asleep, a socket that was down: every
 * badge read zero while the server's read mark for the member said the salon was unread. Measured
 * 2026-10-08 with ten communities: the reader's marks never moved and every badge vanished at the
 * first reload. The server holds both halves of the question (the member's mark and the rows), so
 * it answers (`GET /api/channels/unread-counts`) and this module merges the answer.
 *
 * THE MERGE IS A SUM, NOT A MAX, AND IT IS CLOCKED BY THE SERVER'S OWN CLOCK. The answer carries
 * `asOf`, the server's time when it counted. A message that landed live AFTER that instant is not in
 * the answer and is added; one before it is in the answer and is not added again. Both sides of the
 * comparison are the row's `createdAt` (`ChatMessage.serverTimestamp`), never the author's `sentAt`,
 * so no clock of a device enters it.
 *
 * A SALON OPENED WHILE THE ANSWER WAS IN FLIGHT IS LEFT ALONE. Its mark is on its way to the server
 * and the answer was counted before it landed, so applying the answer would put back the badge the
 * reader had just cleared. {@link beginUnreadReconcile} takes a token from a counter, and
 * {@link noteSalonOpened} stamps the same counter - an ORDER, not a duration, so there is no timer
 * to be wrong.
 */
import type { Conversation } from '$lib/types';
import { isUnreadForUser, watermarkFor } from '$lib/utils/chat/readState';

/** A salon's conversation key is `channel_<uuid>`; kept local so this module stays pure. */
const isSalonKey = (key: string): boolean => key.startsWith('channel_');

/** What `GET /api/channels/unread-counts` answers. */
export interface SalonUnreadAnswer {
  asOf: number;
  counts: Record<string, number>;
}

/** A monotonic counter: every reconcile start and every salon opening takes the next value. */
let ticks = 0;
const openedAtTick = new Map<string, number>();

/** Records that the reader opened `conversationId` now, for the reconcile that may be in flight. */
export function noteSalonOpened(conversationId: string): void {
  if (!isSalonKey(conversationId)) return;
  openedAtTick.set(conversationId, ++ticks);
}

/** Starts a reconcile: the token a later {@link reconcileSalonUnread} is called with. */
export function beginUnreadReconcile(): number {
  return ++ticks;
}

/** Forgets every stamp. Called when the session ends, and by tests. */
export function resetSalonUnread(): void {
  ticks = 0;
  openedAtTick.clear();
}

/** Reads the wire answer defensively: a shape nobody recognises is reported, never half-applied. */
export function parseSalonUnreadAnswer(raw: unknown): SalonUnreadAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const { asOf, counts } = raw as { asOf?: unknown; counts?: unknown };
  if (typeof asOf !== 'number' || !Number.isFinite(asOf) || !counts || typeof counts !== 'object') {
    return null;
  }
  const clean: Record<string, number> = {};
  for (const [id, n] of Object.entries(counts as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) clean[id.toLowerCase()] = n;
  }
  return { asOf, counts: clean };
}

/**
 * Sets every salon conversation's unread count to the server's count plus the messages that arrived
 * live after the server counted.
 *
 * Nothing else about a conversation is touched, and the open salon is skipped: the reader is
 * looking at it and the receipt effect owns its count.
 *
 * @param token what {@link beginUnreadReconcile} returned BEFORE the request was made.
 * @returns the keys whose count changed, for logging.
 */
export function reconcileSalonUnread(
  conversations: Map<string, Conversation>,
  answer: SalonUnreadAnswer,
  selectedId: string | null,
  userId: string,
  token: number
): string[] {
  const me = userId.toLowerCase();
  const changed: string[] = [];
  for (const [key, convo] of conversations.entries()) {
    if (!isSalonKey(key) || key === selectedId) continue;
    if ((openedAtTick.get(key) ?? 0) > token) continue;
    const counted = answer.counts[key.replace(/^channel_/, '').toLowerCase()] ?? 0;
    const watermark = watermarkFor(convo.readWatermarks, me);
    let after = 0;
    for (const m of convo.messages) {
      if (
        m.serverTimestamp !== undefined &&
        m.serverTimestamp > answer.asOf &&
        isUnreadForUser(m, watermark)
      ) {
        after++;
      }
    }
    const next = counted + after;
    if ((convo.unreadCount ?? 0) === next) continue;
    conversations.set(key, { ...convo, unreadCount: next });
    changed.push(key);
  }
  return changed;
}

/**
 * Asks the server for the counts and applies them - the one entry both callers (the community load
 * and the socket coming back) go through. A failure is a warning and leaves every count as it was:
 * a count that could not be refreshed is stale, not wrong, and the next occasion asks again.
 */
export async function reconcileSalonUnreadFromServer(opts: {
  conversations: Map<string, Conversation>;
  selectedId: string | null;
  userId: string;
  fetchCounts: () => Promise<unknown>;
  log: (message: string) => void;
  /** Where the counts were asked for, for the one line this leaves. */
  reason: string;
}): Promise<void> {
  const token = beginUnreadReconcile();
  try {
    const answer = parseSalonUnreadAnswer(await opts.fetchCounts());
    if (!answer) {
      console.warn(
        `[UNREAD] ${opts.reason}: the server answered a shape nobody recognises - counts left as they were`
      );
      return;
    }
    const changed = reconcileSalonUnread(
      opts.conversations,
      answer,
      opts.selectedId,
      opts.userId,
      token
    );
    opts.log(
      `[UNREAD] ${opts.reason}: ${Object.keys(answer.counts).length} salon(s) unread on the server, ${changed.length} count(s) moved here`
    );
  } catch (e) {
    console.warn(
      `[UNREAD] ${opts.reason}: counts not refreshed - badges may be stale until the next load: ${String(e)}`
    );
  }
}
