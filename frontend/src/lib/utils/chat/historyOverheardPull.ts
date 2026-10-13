import type { HistoryDigest } from '$lib/utils/chat/historyManifest';

/**
 * The ONE retry an overheard-digest pull gets, and what keeps it to one.
 *
 * A pull is a transport frame: the server hands it only to devices online at that instant, so a pull
 * to an author that went to the background seconds after its digest is dropped, and the client is
 * never told (production, 2026-10-13: the elected responder's pull hit `TRANSPORT_SKIPPED_OFFLINE`
 * seven seconds after the phone's digest). This module remembers, per conversation and per author,
 * the LATEST digest that made this device ask, and hands it back exactly once - when a frame from
 * that author arrives LIVE, which proves it was online seconds ago.
 *
 * **AN EVENT, NOT A CLOCK, AND ONE RETRY, NOT "UNTIL ANSWERED".** An author that holds only ids below
 * our window answers nothing at all, so "retry until answered" would ask again on every frame it ever
 * sends. Taken once, the entry is gone: one overheard digest costs at most two pulls, by construction.
 * A newer digest from the same author REPLACES the entry (it is the newer statement of what it holds),
 * and an author that never comes back costs one map entry per (conversation, author) and no traffic.
 *
 * **SESSION-BOUND.** It is memory about one account's conversations: a sign-out or an account switch
 * empties it ({@link resetOwedPulls}, through `resetHistoryReconciliation`), leaving a conversation
 * forgets that conversation ({@link forgetOwedPulls}, through `forgetGroupReconciliation`), and a
 * {@link OwedPullTicket} taken when the digest ARRIVED stops a pull still in flight across either
 * from recording for a session or a conversation that no longer exists.
 */

/** What the retry needs: the digest to diff again, in the conversation it was overheard in. */
export type OwedPull = { groupId: string; author: string; digest: HistoryDigest };

/**
 * Taken synchronously when the digest arrives, checked when the pull is recorded - which happens
 * only after the mailbox drained, so a sign-out or a leave can fall in between.
 */
export type OwedPullTicket = { generation: number; groupEpoch: number };

/** `groupId` -> author identity (lower-cased) -> the digest that made us ask. */
const owed = new Map<string, Map<string, HistoryDigest>>();
/** Moved on by every reset, so a ticket from the previous session is recognisably stale. */
let generation = 0;
/** Moved on per conversation by every forget, for the same reason at a conversation's scale. */
const groupEpochs = new Map<string, number>();

/** The ticket for a digest arriving now on `groupId`. */
export function owedPullTicket(groupId: string): OwedPullTicket {
  return { generation, groupEpoch: groupEpochs.get(groupId) ?? 0 };
}

/**
 * States what the latest digest from `author` left this device owing: `digest` when a pull went out
 * on it, `null` when it did not (we held everything, or the digest was one this road declines).
 * Either way it SUPERSEDES the previous entry - the newer digest is the author's newer statement.
 */
export function supersedeOwedPull(
  groupId: string,
  author: string,
  digest: HistoryDigest | null,
  ticket: OwedPullTicket,
  log: (msg: string) => void
): void {
  const short = groupId.slice(0, 8);
  if (ticket.generation !== generation || ticket.groupEpoch !== (groupEpochs.get(groupId) ?? 0)) {
    log(
      `[HISTORY_DIGEST] ${short}... ${author}'s digest outlived its session or its conversation - no retry recorded`
    );
    return;
  }
  const key = author.toLowerCase();
  const perAuthor = owed.get(groupId);
  const had = perAuthor?.has(key) ?? false;
  if (digest === null) {
    if (!had) return;
    perAuthor!.delete(key);
    if (perAuthor!.size === 0) owed.delete(groupId);
    log(
      `[HISTORY_DIGEST] ${short}... ${author}'s newer digest leaves nothing owed - retry dropped`
    );
    return;
  }
  const next = perAuthor ?? new Map<string, HistoryDigest>();
  next.set(key, digest);
  owed.set(groupId, next);
  log(
    `[HISTORY_DIGEST] ${short}... retry owed to ${author} on its next live frame${had ? ' (replaces the older digest)' : ''}`
  );
}

/**
 * Hands back, ONCE, every retry owed to `author` - called for a frame that arrived LIVE from it, in
 * any conversation, because a live frame is the proof it is online now. Silent when nothing is owed,
 * which is every frame but a handful.
 */
export function takeOwedPulls(author: string): OwedPull[] {
  if (owed.size === 0) return [];
  const key = author.toLowerCase();
  const taken: OwedPull[] = [];
  for (const [groupId, perAuthor] of owed) {
    const digest = perAuthor.get(key);
    if (!digest) continue;
    perAuthor.delete(key);
    if (perAuthor.size === 0) owed.delete(groupId);
    taken.push({ groupId, author: key, digest });
  }
  return taken;
}

/** Forgets what is owed in a conversation this device no longer holds. */
export function forgetOwedPulls(groupId: string): void {
  owed.delete(groupId);
  groupEpochs.set(groupId, (groupEpochs.get(groupId) ?? 0) + 1);
}

/** Forgets everything - sign-out, account switch, test cleanup. */
export function resetOwedPulls(): void {
  owed.clear();
  groupEpochs.clear();
  generation++;
}

/** How many retries are owed, across every conversation. For the bound tests. */
export function owedPullCount(): number {
  let n = 0;
  for (const perAuthor of owed.values()) n += perAuthor.size;
  return n;
}

/** How many retries are owed in one conversation - printed by the forget seam, which says what it held. */
export function owedPullsIn(groupId: string): number {
  return owed.get(groupId)?.size ?? 0;
}
