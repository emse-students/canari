/**
 * Whether a salon can be sealed for YET, and the event that says so - the gate a salon send waits
 * on instead of being refused.
 *
 * WHY IT EXISTS. A salon's seal needs its distribution scope (`scopeForChannel`), which only the
 * community listing teaches this session (`registerChannelWorkspace`) - and the salon itself is
 * drawn from the local store long before that listing answers: a cold start, a resume, a
 * notification landing (F1). A message sent in that window used to be refused with
 * `GraineUnknownChannelError` ("ce salon n'est pas encore charge", reported 2026-10-13 on both
 * phones), although nothing was wrong except the ORDER: the salon was about to load.
 *
 * WHAT IT ANSWERS, FROM STATE AND NEVER FROM A CLOCK:
 *
 * - `ready`: the salon was entered in this session ({@link openSalonSendGate}) - seal now.
 * - `wait`: it was not, and a listing that may enter it is in flight or has not yet run since the
 *   session began. The answer arrives as an EVENT: the salon is opened, a listing settles without
 *   it, the community is forgotten, or the session ends. Each of those is a proof, so the wait is
 *   bounded with no timer.
 * - refused: a listing settled and did not enter it (`not-listed` when it answered, `listing-failed`
 *   when the server answered with a failure), it was forgotten (`left`), or the session ended
 *   (`session-ended`).
 *
 * A LISTING THAT REACHED NOBODY REFUSES NOTHING (2026-10-14). Offline, or on a link that answers
 * nothing, the listing gives up `unreachable`: no server decided anything, so the salon is not
 * "not loadable", it is not loaded YET. The sends keep waiting, exactly what the offline banner
 * promises ("partiront dès le retour du réseau"), and the next listing - started by the reconnect
 * (`retryFailedListing`) - settles them. Refusing them is what the Mi 9T showed on `v1.2.7-alpha.1`:
 * every salon send and Retry refused `listing-failed` while the phone was offline, then online.
 *
 * The SEAL KEEPS ITS OWN REFUSAL: this gate decides when to try, never whether the row may go
 * unsigned. A held message is held as cleartext in memory and sealed and signed only when it is
 * released, exactly as an immediate send is.
 *
 * Import-free on purpose: `runtime` calls into it on sign-out and on a community purge, and a gate
 * that imported `runtime` would be a cycle.
 */

/** Why a salon will not be sealable without something new happening. */
export type SalonGateRefusal = 'not-listed' | 'listing-failed' | 'left' | 'session-ended';

/** What a send learns from the gate, once it is decided. */
export type SalonGateOutcome = { kind: 'ready' } | { kind: 'refused'; reason: SalonGateRefusal };

/**
 * Thrown by a send path that has no row to mark - an inline salon upload - when the gate refused:
 * nothing was uploaded or sealed. A TYPE, so the catch picks the sentence from {@link reason}.
 */
export class SalonNotLoadableError extends Error {
  constructor(readonly reason: SalonGateRefusal) {
    super(`[SEND] the salon cannot be loaded on this device (reason=${reason}): nothing was sent`);
    this.name = 'SalonNotLoadableError';
  }
}

/** The gate's answer at the instant it is asked. */
export type SalonGateReading = SalonGateOutcome | { kind: 'wait' };

/**
 * How the last community listing of this session ended; `none` until one has. `unreachable` is a
 * listing that got no answer at all, which waits like `none`: nothing was decided.
 */
type ListingOutcome = 'none' | 'loaded' | 'failed' | 'unreachable';

/** How a listing can end, as its caller reports it to {@link settleSalonListing}. */
export type SettledListing = Exclude<ListingOutcome, 'none'>;

/** Whether no settled listing has decided anything yet, so a salon not entered still waits. */
function undecided(): boolean {
  return lastListing === 'none' || lastListing === 'unreachable';
}

/** Salons entered in this session, raw uuid. */
const opened = new Set<string>();
/** Sends waiting for a salon, raw uuid -> resolvers in arrival order. */
const waiters = new Map<string, ((outcome: SalonGateOutcome) => void)[]>();
let listingsInFlight = 0;
let lastListing: ListingOutcome = 'none';
/**
 * Which session the counters belong to. A listing that began before a sign-out settles into the
 * NEXT session otherwise, and would refuse that session's first sends before its own listing ran.
 */
let generation = 0;

const READY: SalonGateOutcome = { kind: 'ready' };

/** Strip the `channel_` conversation prefix: the gate is keyed by the raw uuid, like the runtime. */
function raw(channelId: string): string {
  return String(channelId).replace(/^channel_/, '');
}

/** Resolves and forgets every waiter of `channel`. */
function settle(channel: string, outcome: SalonGateOutcome): void {
  const pending = waiters.get(channel);
  if (!pending) return;
  waiters.delete(channel);
  for (const resolve of pending) resolve(outcome);
}

/** The refusal a settled listing means for a salon it did not open. */
function listingRefusal(): SalonGateOutcome {
  return { kind: 'refused', reason: lastListing === 'failed' ? 'listing-failed' : 'not-listed' };
}

/**
 * The gate's answer for `channelId` right now, without waiting.
 *
 * @param channelId Raw uuid or `channel_`-prefixed.
 */
export function readSalonSendGate(channelId: string): SalonGateReading {
  const channel = raw(channelId);
  if (opened.has(channel)) return READY;
  if (listingsInFlight > 0 || undecided()) return { kind: 'wait' };
  return listingRefusal();
}

/**
 * Resolves when `channelId` can be sealed for, or cannot without something new happening.
 * Resolves at once when the answer is already known; never rejects.
 *
 * @param channelId Raw uuid or `channel_`-prefixed.
 */
export function whenSalonSendable(channelId: string): Promise<SalonGateOutcome> {
  const reading = readSalonSendGate(channelId);
  if (reading.kind !== 'wait') return Promise.resolve(reading);
  const channel = raw(channelId);
  return new Promise((resolve) => {
    const pending = waiters.get(channel);
    if (pending) pending.push(resolve);
    else waiters.set(channel, [resolve]);
  });
}

/**
 * Records that this device has ENTERED `channelId` - its scope registered and, for a private salon,
 * its own group joined - and releases every send waiting on it.
 *
 * Called where a salon's entry ends, after the group join and not at the scope registration: a
 * private salon registered but not yet entered refuses its seal (`key-group-not-held`), so opening
 * the gate at the registration would release its waiters into that refusal.
 */
export function openSalonSendGate(channelId: string): void {
  const channel = raw(channelId);
  opened.add(channel);
  settle(channel, READY);
}

/**
 * A community listing started: a salon not yet entered may still be entered by it.
 *
 * @returns the token {@link settleSalonListing} takes, which ties the settle to this session.
 */
export function beginSalonListing(): number {
  listingsInFlight += 1;
  return generation;
}

/**
 * Whether `token` (from {@link beginSalonListing}) still names the current session. A listing that
 * outlived a sign-out reads `false` here and must stop writing: the communities, the runtime map and
 * the gates it would fill are the NEXT account's. One counter for the gate and the listing, so the
 * two can never disagree about which session a listing belongs to.
 */
export function isCurrentSalonSession(token: number): boolean {
  return token === generation;
}

/** The current session's token, for a caller that must later ask {@link isCurrentSalonSession}. */
export function currentSalonSession(): number {
  return generation;
}

/**
 * A community listing ended. When none is left in flight, every salon still waiting is refused:
 * the listing that could have entered it answered without it (`loaded`) or the server failed it
 * (`failed`). A listing that reached nobody (`unreachable`) refuses nothing: the waiters wait for
 * the next listing, which the reconnect starts.
 */
export function settleSalonListing(token: number, outcome: SettledListing): void {
  endInFlight(token, outcome);
}

/**
 * ONE salon is being entered outside a listing (`registerJoinedChannel`): its scope is registered
 * but its groups are still being joined, so a send typed into it now must WAIT for the entry rather
 * than be refused because the last listing already settled without it.
 *
 * @returns the token {@link settleSalonEntry} takes.
 */
export function beginSalonEntry(): number {
  return beginSalonListing();
}

/**
 * The entry begun by {@link beginSalonEntry} ended - opened ({@link openSalonSendGate}) or not.
 * Unlike a listing it says nothing about the communities, so it leaves the last listing's outcome
 * as it was; when nothing else is in flight, a waiter it did not open is refused as that listing
 * would have refused it, and before any listing has settled the waiters keep waiting for one.
 */
export function settleSalonEntry(token: number): void {
  endInFlight(token, null);
}

/** One in-flight listing or entry ended; refuses the waiters once nothing left could open them. */
function endInFlight(token: number, outcome: SettledListing | null): void {
  if (token !== generation) return;
  listingsInFlight = Math.max(0, listingsInFlight - 1);
  if (outcome !== null) lastListing = outcome;
  if (listingsInFlight > 0 || undecided()) return;
  const refusal = listingRefusal();
  for (const channel of waiters.keys()) settle(channel, refusal);
}

/**
 * Closes the gate of salons whose community left this device, refusing their waiters as `left`.
 *
 * @param channelIds Raw uuid or `channel_`-prefixed.
 */
export function forgetSalonSendGates(channelIds: readonly string[]): void {
  for (const channelId of channelIds) {
    const channel = raw(channelId);
    opened.delete(channel);
    settle(channel, { kind: 'refused', reason: 'left' });
  }
}

/**
 * The session ended: every waiter is refused and the gate starts over, so the next account waits
 * for its own first listing rather than inheriting this one's salons.
 */
export function resetSalonSendGate(): void {
  generation += 1;
  opened.clear();
  listingsInFlight = 0;
  lastListing = 'none';
  for (const channel of waiters.keys()) {
    settle(channel, { kind: 'refused', reason: 'session-ended' });
  }
}

/** How many sends wait on `channelId` - for tests and the log. */
export function salonSendWaiterCount(channelId: string): number {
  return waiters.get(raw(channelId))?.length ?? 0;
}
