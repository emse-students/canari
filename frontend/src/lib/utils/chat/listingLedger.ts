/**
 * WHAT THIS DEVICE LEARNED LIVE ABOUT A COMMUNITY OR A SALON, DATED BY A TICK A LISTING CAN BE
 * COMPARED AGAINST.
 *
 * A full community listing (`executeWorkspaceLoadAttempt`) ends by deleting every salon and community
 * its answer does not name, and between its request and that prune it awaits a key-group join and a
 * salon listing per community - seconds on a real account, more on a slow phone. Anything that came
 * into existence in that window is absent from an answer that was already on its way; anything that
 * LEFT in that window is still in it. Neither absence nor presence in that answer is then evidence.
 *
 * Two kinds of live fact reach this device inside the window, and both used to lose to the listing:
 * - PRESENT: a salon or community this device CREATED, or HEARD OF on the socket
 *   (`channel.member.joined`). Only creations were dated (2026-08-20); a salon heard of live during a
 *   listing was pruned by it, without a line, and the member never saw it until the next listing
 *   (dev, 2026-10-26: the server created the salon 2.4 s into a 6.2 s listing on the Mi 9T).
 * - GONE: a salon or community deleted, left, or removed from this member, by a gesture here or an
 *   event heard on the socket. The listing's answer predates it and used to draw it back.
 *
 * ONE RECORD FOR BOTH, keyed by the local id, holding the LAST fact and its tick: a salon deleted and
 * then re-created, or left and joined again, is whatever was learned last.
 *
 * A COUNTER, NEVER A CLOCK. The question is "did I learn this after I asked", and a monotonic tick
 * answers it exactly: a listing reads {@link ListingLedger.tick} BEFORE its request goes out, and any
 * fact recorded afterwards carries a larger one, whatever order the network completes in.
 */

/** The last thing learned live about one id. */
export type LiveFact = 'present' | 'gone';

/** The ledger a workspace store keeps; see the module note. */
export interface ListingLedger {
  /** The current tick. A listing reads it BEFORE its request goes out. */
  readonly tick: number;
  /** Records that `key` exists now: created on this device, or heard of live. */
  present(key: string): void;
  /** Records that `key` is gone now: deleted, left, or a removal heard live. */
  gone(key: string): void;
  /**
   * What was learned of `key` after a listing asked at `askedAt`, or `null` when nothing was - in
   * which case the listing's answer is the truth about it.
   */
  learnedSince(key: string, askedAt: number): LiveFact | null;
}

/** Creates an empty ledger at tick 0. */
export function createListingLedger(): ListingLedger {
  let tick = 0;
  // A plain Map, never reactive: nothing draws it, and only the prune reads it.
  const facts = new Map<string, { fact: LiveFact; tick: number }>();
  const record = (key: string, fact: LiveFact) => {
    tick += 1;
    facts.set(key, { fact, tick });
  };
  return {
    get tick() {
      return tick;
    },
    present: (key) => record(key, 'present'),
    gone: (key) => record(key, 'gone'),
    learnedSince(key, askedAt) {
      const entry = facts.get(key);
      return entry !== undefined && entry.tick > askedAt ? entry.fact : null;
    },
  };
}

/**
 * The ledger key of a community, by its sidebar id (slug). Salons are keyed by their conversation id
 * (`channel_<id>`), so the prefix keeps the two id spaces apart in the one record.
 */
export function communityLedgerKey(slug: string): string {
  return `community:${slug}`;
}
