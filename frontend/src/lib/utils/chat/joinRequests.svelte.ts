import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { canonicalUserId } from '$lib/mls-client/leafIdentity';
import type { JoinAskOutcome } from '$lib/mls-client/joinAskFrames';
import type { JoinApprovalRequest } from './actions';

/**
 * A NEW PERSON ASKING TO JOIN A CONVERSATION, held until a member of it answers.
 *
 * An automatic Add never brings a new person in (`automaticAdmission` in `actions.ts`): whatever a
 * server row or a relayed request says, a user with no leaf in this device's tree is admitted only by
 * a member's own gesture. The two automatic adders raise the ask here instead, and the conversation
 * shows it as a discreet system line (`JoinRequestRow`; there is no app-wide banner). Accepting is the member's Add (`inviteMembersToGroup`, signed by this device); refusing removes
 * the request's roster row on the server, which is what stops the ask from coming back.
 *
 * ONE ENTRY PER PERSON AND CONVERSATION, whatever the number of their devices or of the sweeps that
 * raise it. THERE IS NO ASK ABOUT A DEVICE: a device of a member is added automatically (owner,
 * 2026-10-31 - the gate is on the user, never the device). The pending-invitation sweep is the durable source - the server's `pending` rows - so a
 * finished sweep REPLACES what it raised ({@link settleSweptJoinRequests}): an ask another member
 * answered, or whose row is gone, leaves with the next sweep rather than staying on screen.
 */
export interface JoinRequest {
  groupId: string;
  userId: string;
  /** The person's devices that asked, in the order they did. */
  deviceIds: string[];
  /**
   * The ask's identity - the id of the seat its link wrote - when the server named it. Absent only
   * from a server older than the field.
   */
  askId?: string;
}

/**
 * What running a member's answer did: `done` only when the answer really happened - the person's
 * device is in the tree (approve), or their roster row is gone (decline). Anything else names why,
 * and the ask stays on screen.
 */
export type JoinAnswerResult =
  | { done: true }
  | { done: false; reason: string; kind?: JoinRefusalKind };

/**
 * WHY AN ANSWER DID NOT HAPPEN WHEN ANOTHER MEMBER IS THE CAUSE, classified where it is known
 * (`admitJoinRequest`, from the Add's typed refusal) and never read back from the `reason` prose:
 * `busy` - another device holds the group's add lock, so someone is answering now; `raced` - the
 * ask was settled under this member's tap (the Add lost to a Decline or to another Add). Either way
 * the settlement frame clears the card, so the member is told who answered, not that something broke.
 */
export type JoinRefusalKind = 'busy' | 'raced';

/** What running a member's answer came to, for the caller that tells the member. */
export type JoinAnswerOutcome = 'done' | 'failed' | JoinRefusalKind;

/** What a member's answer runs, registered by the page holding a conversation context. */
export interface JoinRequestHandlers {
  approve: (request: JoinRequest) => Promise<JoinAnswerResult>;
  decline: (request: JoinRequest) => Promise<JoinAnswerResult>;
}

const requests = new SvelteMap<string, JoinRequest>();

/**
 * A DECLINE THIS MEMBER MADE, kept for the session so the conversation can say so. An accepted ask
 * needs no record: the Add writes its own `memberAdded` notice on every member's device. No frame
 * tells the OTHER members of a decline, so this line is this device's alone - never a stored row,
 * which history reconciliation would relay under an id nobody else holds.
 */
export interface DeclinedAsk {
  /** The entry's identity, unique per line. */
  key: string;
  groupId: string;
  userId: string;
}
const declined = new SvelteMap<string, DeclinedAsk>();

/** The declines this member made in one conversation, oldest first. Reactive. */
export function declinedJoinRequests(groupId: string): DeclinedAsk[] {
  return [...declined.values()].filter((d) => d.groupId === groupId);
}
/**
 * THE ASKS THE SERVER SAID WERE ANSWERED THIS SESSION, BY IDENTITY (`askId`, the seat's id). An ask
 * is settled for good: a raise naming a settled identity is a read made before the settlement - a
 * sweep, a roster read, an announcement - however late it lands, and it is not raised. A NEW ask of
 * the same person is a new seat, so a new identity, and is raised. No order of arrival is assumed.
 */
const settledAsks = new SvelteSet<string>();
// Reactive, so a line is drawn for an ask only while something can answer it (`canAnswerJoinRequests`).
let handlers = $state.raw<JoinRequestHandlers | null>(null);

function keyOf(groupId: string, userId: string) {
  return `${groupId}|${canonicalUserId(userId)}`;
}

/** The store key of one ask as an automatic adder raised it. */
function keyOfAsk(ask: JoinApprovalRequest): string {
  return keyOf(ask.groupId, ask.requesterUserId);
}

/** The store key of one entry. */
function keyOfEntry(entry: JoinRequest): string {
  return keyOf(entry.groupId, entry.userId);
}

/**
 * The `groupId|userId` pairs whose seat was flagged as a person's ask while the user still held a
 * leaf (`admissionOfSeat` in `actions.ts`), already accused this session. The state is EXPECTED for
 * as long as a removed member's leaf outlives the removal, and every sweep meets it again: it is said
 * once at a level that accuses, then quietly, and asked about anew after a sign-out.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a log dedup ledger, nothing renders it
const flaggedAsksSaid = new Set<string>();

/** Whether this is the first time this session that the flagged ask of `userId` in `groupId` is met. */
export function firstSightOfFlaggedAsk(groupId: string, userId: string): boolean {
  const key = keyOf(groupId, userId);
  if (flaggedAsksSaid.has(key)) return false;
  flaggedAsksSaid.add(key);
  return true;
}

function short(groupId: string): string {
  return `${groupId.slice(0, 8)}...`;
}

/**
 * Records one ask; a second device of the same person joins the same entry. An ask whose identity
 * the server already settled is not recorded, and a newer ask of the same person replaces the entry.
 */
export function raiseJoinRequest(ask: JoinApprovalRequest): void {
  const key = keyOfAsk(ask);
  const userId = canonicalUserId(ask.requesterUserId);
  if (ask.askId && settledAsks.has(ask.askId)) {
    console.log(
      `[JOIN_REQUEST] ${userId} in ${short(ask.groupId)} - ask ${ask.askId.slice(0, 8)} was already answered, not raised`
    );
    return;
  }
  const known = requests.get(key);
  const anotherAsk = !!(known && ask.askId && known.askId && known.askId !== ask.askId);
  if (known && !anotherAsk) {
    const deviceIds = known.deviceIds.includes(ask.requesterDeviceId)
      ? known.deviceIds
      : [...known.deviceIds, ask.requesterDeviceId];
    const askId = known.askId ?? ask.askId;
    if (deviceIds === known.deviceIds && askId === known.askId) return;
    requests.set(key, { ...known, deviceIds, ...(askId ? { askId } : {}) });
    return;
  }
  requests.set(key, {
    groupId: ask.groupId,
    userId,
    deviceIds: [ask.requesterDeviceId],
    ...(ask.askId ? { askId: ask.askId } : {}),
  });
  console.log(
    `[JOIN_REQUEST] ${userId} asks to join ${short(ask.groupId)}${known ? ' again (a new ask)' : ''} - a member's answer is awaited`
  );
}

/** What one entry IS, for a sweep: its ask's identity, or - from a server older than it - its key. */
function tokenOf(key: string, entry: JoinRequest): string {
  return entry.askId ?? `key:${key}`;
}

/**
 * The asks on screen when a pending-invitation sweep STARTED - the only ones its result may take
 * away ({@link settleSweptJoinRequests}). Taken by the caller before the sweep reads anything.
 */
export interface JoinRequestSweep {
  /** A snapshot, read once by the settle - not reactive state. */
  readonly shown: readonly string[];
}

/** Marks the start of a sweep: the asks on screen now, by identity. */
export function beginJoinRequestSweep(): JoinRequestSweep {
  return { shown: [...requests].map(([key, entry]) => tokenOf(key, entry)) };
}

/**
 * Replaces the asks with what one COMPLETED pending-invitation sweep raised: the server's `pending`
 * rows are the durable state, so an ask the sweep did not raise again has been answered or has
 * gone. A sweep that did not complete settles nothing, and a group it did not read through
 * (`notSwept`) keeps its asks.
 *
 * ONLY AN ASK THAT WAS ON SCREEN WHEN THE SWEEP STARTED can be taken away by it (`sweep`, by identity
 * - never a clock): an ask announced while the sweep was reading may postdate every row it read, so
 * the sweep's silence about it says nothing.
 *
 * AND THE SAME ORDER DECIDES WHICH OF TWO ASKS OF ONE PERSON STAYS. An entry on screen when the sweep
 * started is older than the rows it read, so a different ask the sweep raised for that person is the
 * newer one and replaces it. An entry that arrived WHILE it read is not ordered against those rows,
 * and a live announcement is never older than a read made before it: it stays, and the sweep's ask
 * for that person is not raised over it (the live ask's own settlement, or the next sweep, decides).
 */
export function settleSweptJoinRequests(
  sweep: JoinRequestSweep,
  raised: readonly JoinApprovalRequest[],
  notSwept?: ReadonlySet<string>
): void {
  const keep = raised.map(keyOfAsk);
  // Deleting the entry being visited is safe while iterating a Map. A group the sweep did not read
  // through (its add lock was busy) keeps what it shows: no flicker while another device adds.
  for (const [key, entry] of requests) {
    if (notSwept?.has(entry.groupId)) continue;
    if (!keep.includes(key) && sweep.shown.includes(tokenOf(key, entry))) requests.delete(key);
  }
  for (const ask of raised) {
    const key = keyOfAsk(ask);
    const live = requests.get(key);
    if (
      live?.askId &&
      ask.askId &&
      live.askId !== ask.askId &&
      !sweep.shown.includes(tokenOf(key, live))
    ) {
      console.log(
        `[JOIN_REQUEST] ${live.userId} in ${short(ask.groupId)} - the sweep read ask ${ask.askId.slice(0, 8)}, ask ${live.askId.slice(0, 8)} arrived while it read and stays`
      );
      continue;
    }
    raiseJoinRequest(ask);
  }
}

/** An ask the server says has ended (`group.join_ask.settled`), named by its identity. */
export interface SettledJoinAsk {
  groupId: string;
  userId: string;
  askId: string;
  outcome: JoinAskOutcome;
}

/**
 * Takes an ask off this screen because the SERVER says it ended - answered by another member, by
 * this one on another device, by a race this member's own answer lost (two Adds, or an Add and a
 * Decline the server's seat lock ordered), or withdrawn or expired. The identity is remembered, so no
 * read made before this - however late it lands - raises it again. An entry holding a DIFFERENT
 * identity is a newer ask of the same person, and stays.
 */
export function settleJoinRequest(settled: SettledJoinAsk): void {
  settledAsks.add(settled.askId);
  const key = keyOf(settled.groupId, settled.userId);
  const known = requests.get(key);
  if (!known) return;
  if (known.askId !== undefined && known.askId !== settled.askId) {
    console.log(
      `[JOIN_REQUEST] ${canonicalUserId(settled.userId)} in ${short(settled.groupId)} - an earlier ask ${settled.outcome}, the newer one stays`
    );
    return;
  }
  requests.delete(key);
  console.log(
    `[JOIN_REQUEST] ${canonicalUserId(settled.userId)} ${settled.outcome} in ${short(settled.groupId)} - the ask leaves this screen`
  );
}

/** The asks awaiting an answer, oldest first. Reactive. */
export function pendingJoinRequests(): JoinRequest[] {
  return [...requests.values()];
}

/**
 * Whether an answer can run now: the page holding a conversation context is mounted and registered
 * its handlers. Reactive. An ask shown without them failed on tap with a toast and nothing done.
 */
export function canAnswerJoinRequests(): boolean {
  return handlers !== null;
}

/** Registers what an answer runs; `null` unregisters (the page left, the session ended). */
export function setJoinRequestHandlers(next: JoinRequestHandlers | null): void {
  handlers = next;
}

/** Removes `request`'s entry only while it still is that ask - never a newer ask of the person. */
function forget(request: JoinRequest): void {
  const key = keyOfEntry(request);
  const live = requests.get(key);
  if (live?.askId === request.askId) {
    requests.delete(key);
  }
}

/**
 * Runs a member's answer. The ask leaves only once the answer went through - the handler's
 * {@link JoinAnswerResult} says `done` - and an answer that did not happen, or threw, keeps it on
 * screen, logged with its reason, so the member can answer again. The invite flow never throws
 * (`inviteMembersToGroup` returns its outcome), so "no exception" is not "added".
 *
 * AN ASK THE SERVER ALREADY SETTLED IS NOT ANSWERED: nothing runs, the entry goes, and the call
 * reports no failure - the outcome is the server's, and the member's tap came after it. An answer
 * that fails because the server settled the ask WHILE it ran is reported the same way.
 *
 * @returns whether nothing is left to answer: the answer went through, or the ask was already settled.
 */
export async function answerJoinRequest(
  request: JoinRequest,
  answer: 'approve' | 'decline'
): Promise<boolean> {
  return (await answerJoinRequestOutcome(request, answer)) === 'done';
}

/**
 * {@link answerJoinRequest} with the cause of a refusal kept: `done` when nothing is left to answer,
 * `busy` / `raced` ({@link JoinRefusalKind}) when another member is the cause, `failed` otherwise.
 */
export async function answerJoinRequestOutcome(
  request: JoinRequest,
  answer: 'approve' | 'decline'
): Promise<JoinAnswerOutcome> {
  const settledBefore = request.askId !== undefined && settledAsks.has(request.askId);
  if (settledBefore) {
    forget(request);
    console.log(
      `[JOIN_REQUEST] ${answer} of ${request.userId} in ${short(request.groupId)} not run - the server already settled this ask`
    );
    return 'done';
  }
  if (!handlers) {
    console.error(`[JOIN_REQUEST] no handler registered - the ${answer} of an ask was not run`);
    return 'failed';
  }
  let result: JoinAnswerResult;
  try {
    result = await handlers[answer](request);
  } catch (e) {
    // A handler that THROWS broke its contract (each returns its outcome): that accuses.
    console.error(
      `[JOIN_REQUEST] ${answer} of ${request.userId} in ${short(request.groupId)} threw, the ask stays: ${String(e)}`
    );
    return 'failed';
  }
  if (!result.done) {
    if (request.askId !== undefined && settledAsks.has(request.askId)) {
      console.log(
        `[JOIN_REQUEST] ${answer} of ${request.userId} in ${short(request.groupId)} did not happen - the server settled the ask meanwhile (${result.reason})`
      );
      return 'done';
    }
    // An answer that did not happen is a known outcome (another device holds the add lock, the
    // network is down), named by its reason and retried by the member - a warning, not an error.
    console.warn(
      `[JOIN_REQUEST] ${answer} of ${request.userId} in ${short(request.groupId)} did not happen, the ask stays: ${result.reason}`
    );
    return result.kind ?? 'failed';
  }
  forget(request);
  if (answer === 'decline') {
    declined.set(keyOfEntry(request), {
      key: keyOfEntry(request),
      groupId: request.groupId,
      userId: request.userId,
    });
  }
  console.log(
    `[JOIN_REQUEST] ${request.userId} ${answer === 'approve' ? 'admitted' : 'declined'} in ${short(request.groupId)}`
  );
  return 'done';
}

/** Forgets every ask (sign-out, tests): they belong to the account that was signed in. */
export function resetJoinRequests(): void {
  requests.clear();
  declined.clear();
  settledAsks.clear();
  flaggedAsksSaid.clear();
}
