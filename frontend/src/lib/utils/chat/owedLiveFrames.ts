/**
 * LIVE SALON FRAMES THAT ARRIVED BEFORE THEIR SEED, still owed the decision a live frame gets.
 *
 * A salon reaction is announced in the foreground by ONE trigger, the live frame
 * (`channelEventHandler` -> `onInboundReaction`, `reactionNotification.ts`), because the push is
 * dropped while the app is open. The first frame of a sender's NEW seed session often arrives before
 * the seed that opens it: the live open fails as repairable, the seed lands in the same drain, and the
 * repair re-reads the salon's history - which by design raises nothing, since a page of history must
 * never announce a reaction. So the one live frame was consumed by the unreadable path and the repair
 * that later opened it was, by construction, not live: neither trigger drew the reaction (Mi 9T,
 * `1.7.0-alpha.10`, 2026-11-18; [backlog](../../../../../docs/wiki/backlog.d/p2-a-salon-reaction-that-opens-its-sender-s-new-seed-session-is-never-notified-in-the-foreground.md)).
 *
 * THE FACT "THIS ROW ARRIVED LIVE" IS CARRIED, NOT GUESSED. The live path parks the row's id with the
 * decision it could not take ({@link oweLiveDecision}); whichever reader opens THAT row first takes it
 * ({@link takeOwedLiveDecision}) - only that id, only once - and hands its reaction to it. Every other
 * row a page opens finds nothing here, so history still raises nothing. Keyed by the server row id,
 * the one name both paths give a row.
 *
 * Emptied with the account's seed layer (`setGraineRuntime(null)`): a parked decision closes over the
 * leaving session's context. Import-free on purpose, like `salonSendGate`: `runtime` calls into it,
 * and importing `runtime` back would be a cycle - so callers pass the RAW channel id (no `channel_`).
 */
import type { DecodedChannelReaction } from './channelCrypto';

/**
 * The decision a live frame could not take because it could not be opened: called with the reaction
 * the row turned out to carry, and whether applying it changed what this device holds.
 */
export type OwedLiveDecision = (reaction: DecodedChannelReaction, changed: boolean) => void;

/** `<raw channel id>#<row id>` -> the decision owed. */
const owed = new Map<string, OwedLiveDecision>();

function keyOf(rawChannelId: string, rowId: string): string {
  return `${rawChannelId}#${rowId}`;
}

/** Parks the decision of a live row that could not be opened for a missing seed. */
export function oweLiveDecision(
  rawChannelId: string,
  rowId: string,
  decide: OwedLiveDecision
): void {
  owed.set(keyOf(rawChannelId, rowId), decide);
  console.debug(
    `[CHANNEL] live row ${rowId.slice(0, 8)} of ${rawChannelId.slice(0, 8)} parked until its seed opens it - its reaction, if it is one, is still owed a live decision`
  );
}

/**
 * Takes - and forgets - the decision owed to a row this reader has just OPENED, or null for every row
 * that did not arrive live before its seed. Called for each opened row, whatever it carries, so a
 * parked line or edit is forgotten too.
 */
export function takeOwedLiveDecision(rawChannelId: string, rowId: string): OwedLiveDecision | null {
  const key = keyOf(rawChannelId, rowId);
  const decide = owed.get(key);
  if (!decide) return null;
  owed.delete(key);
  return decide;
}

/** Forgets every parked decision - the session they were taken for has ended. */
export function resetOwedLiveDecisions(): void {
  if (owed.size > 0) {
    console.debug(
      `[CHANNEL] ${owed.size} live row(s) still unopened at the end of the session - no decision taken for them`
    );
  }
  owed.clear();
}
