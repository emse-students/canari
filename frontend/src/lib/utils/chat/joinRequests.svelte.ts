import { SvelteMap } from 'svelte/reactivity';
import { canonicalUserId } from '$lib/mls-client/leafIdentity';
import type { JoinApprovalRequest } from './actions';

/**
 * A NEW PERSON ASKING TO JOIN A CONVERSATION, held until a member of it answers.
 *
 * An automatic Add never brings a new person in (`automaticAdmission` in `actions.ts`): whatever a
 * server row or a relayed request says, a user with no leaf in this device's tree is admitted only by
 * a member's own gesture. The two automatic adders raise the ask here instead, and the banner shows
 * it. Accepting is the member's Add (`inviteMembersToGroup`, signed by this device); refusing removes
 * the request's roster row on the server, which is what stops the ask from coming back.
 *
 * ONE ENTRY PER PERSON AND CONVERSATION, whatever the number of their devices or of the sweeps that
 * raise it. The pending-invitation sweep is the durable source - the server's `pending` rows - so a
 * finished sweep REPLACES what it raised ({@link settleSweptJoinRequests}): an ask another member
 * answered, or whose row is gone, leaves with the next sweep rather than staying on screen.
 */
export interface JoinRequest {
  groupId: string;
  userId: string;
  /** The person's devices that asked, in the order they did. */
  deviceIds: string[];
}

/**
 * What running a member's answer did: `done` only when the answer really happened - the person's
 * device is in the tree (approve), or their roster row is gone (decline). Anything else names why,
 * and the ask stays on screen.
 */
export type JoinAnswerResult = { done: true } | { done: false; reason: string };

/** What a member's answer runs, registered by the page holding a conversation context. */
export interface JoinRequestHandlers {
  approve: (request: JoinRequest) => Promise<JoinAnswerResult>;
  decline: (request: JoinRequest) => Promise<JoinAnswerResult>;
}

const requests = new SvelteMap<string, JoinRequest>();
/**
 * How many asks the server has said were answered this session, and, per ask, the count at which it
 * was - THE ORDER BETWEEN A SETTLEMENT AND A RAISE THAT READ ITS FACTS BEFORE IT. A live raise reads
 * the roster and the tree over a few awaits; a settlement arriving in between used to be undone by the
 * raise that followed it, and the answered ask stood until the next sweep. A raise says when it began
 * ({@link joinRequestClock}, `JoinApprovalRequest.seenAt`), and one that began before the ask's
 * settlement is not raised. A raise that began after it read facts the server wrote before announcing
 * it, so it can only be a NEW ask. No clock of the wall: a count of events, in the order they arrived.
 */
let settlements = 0;
const settledAt = new SvelteMap<string, number>();
// Reactive, so the banner shows an ask only while something can answer it (`canAnswerJoinRequests`).
let handlers = $state.raw<JoinRequestHandlers | null>(null);

function keyOf(groupId: string, userId: string): string {
  return `${groupId}|${canonicalUserId(userId)}`;
}

/** The settlement count a live raise starts at - see {@link settledAt}. */
export function joinRequestClock(): number {
  return settlements;
}

/**
 * Records one ask; a second device of the same person joins the same entry. An ask whose raise began
 * before the server settled it (`seenAt`) is not recorded: it was answered while it was being read.
 */
export function raiseJoinRequest(ask: JoinApprovalRequest): void {
  const key = keyOf(ask.groupId, ask.requesterUserId);
  if (ask.seenAt !== undefined && (settledAt.get(key) ?? 0) > ask.seenAt) {
    console.log(
      `[JOIN_REQUEST] ${canonicalUserId(ask.requesterUserId)} in ${ask.groupId.slice(0, 8)}... was answered while this ask was being read - not raised`
    );
    return;
  }
  const known = requests.get(key);
  if (known) {
    if (known.deviceIds.includes(ask.requesterDeviceId)) return;
    requests.set(key, { ...known, deviceIds: [...known.deviceIds, ask.requesterDeviceId] });
    return;
  }
  requests.set(key, {
    groupId: ask.groupId,
    userId: canonicalUserId(ask.requesterUserId),
    deviceIds: [ask.requesterDeviceId],
  });
  console.log(
    `[JOIN_REQUEST] ${canonicalUserId(ask.requesterUserId)} asks to join ${ask.groupId.slice(0, 8)}... - a member's answer is awaited`
  );
}

/**
 * Replaces the asks with what one COMPLETED pending-invitation sweep raised: the server's `pending`
 * rows are the durable state, so an ask the sweep did not raise again has been answered or has
 * gone. A sweep that did not complete settles nothing.
 */
export function settleSweptJoinRequests(raised: readonly JoinApprovalRequest[]): void {
  const keep = raised.map((ask) => keyOf(ask.groupId, ask.requesterUserId));
  // Deleting the entry being visited is safe while iterating a Map.
  for (const key of requests.keys()) {
    if (!keep.includes(key)) requests.delete(key);
  }
  for (const ask of raised) raiseJoinRequest(ask);
}

/**
 * An ask answered by SOME member, as the server holds it (`group.join_ask.settled`): a member's Add
 * admitted the person, or a member's Decline withdrew the seat.
 */
export interface SettledJoinAsk {
  groupId: string;
  userId: string;
  outcome: 'admitted' | 'declined';
}

/**
 * Takes an ask off this screen because the SERVER says it was answered - by another member, or by
 * this one on another device, or by a race this member's own answer lost (two Adds, or an Add and a
 * Decline the server's seat lock ordered). The outcome is the server's, so a losing answer settles on
 * it without a refresh; the member's own answer, still in flight, then finds nothing to remove.
 */
export function settleJoinRequest(settled: SettledJoinAsk): void {
  const key = keyOf(settled.groupId, settled.userId);
  settlements += 1;
  settledAt.set(key, settlements);
  if (!requests.delete(key)) return;
  console.log(
    `[JOIN_REQUEST] ${canonicalUserId(settled.userId)} ${settled.outcome} in ${settled.groupId.slice(0, 8)}... by a member - the ask leaves this screen`
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

/**
 * Runs a member's answer. The ask leaves only once the answer went through - the handler's
 * {@link JoinAnswerResult} says `done` - and an answer that did not happen, or threw, keeps it on
 * screen, logged with its reason, so the member can answer again. The invite flow never throws
 * (`inviteMembersToGroup` returns its outcome), so "no exception" is not "added".
 *
 * @returns whether the answer went through.
 */
export async function answerJoinRequest(
  request: JoinRequest,
  answer: 'approve' | 'decline'
): Promise<boolean> {
  if (!handlers) {
    console.error(`[JOIN_REQUEST] no handler registered - the ${answer} of an ask was not run`);
    return false;
  }
  let result: JoinAnswerResult;
  try {
    result = await handlers[answer](request);
  } catch (e) {
    // A handler that THROWS broke its contract (each returns its outcome): that accuses.
    console.error(
      `[JOIN_REQUEST] ${answer} of ${request.userId} in ${request.groupId.slice(0, 8)}... threw, the ask stays: ${String(e)}`
    );
    return false;
  }
  if (!result.done) {
    // An answer that did not happen is a known outcome (another device holds the add lock, the
    // network is down), named by its reason and retried by the member - a warning, not an error.
    console.warn(
      `[JOIN_REQUEST] ${answer} of ${request.userId} in ${request.groupId.slice(0, 8)}... did not happen, the ask stays: ${result.reason}`
    );
    return false;
  }
  requests.delete(keyOf(request.groupId, request.userId));
  console.log(
    `[JOIN_REQUEST] ${request.userId} ${answer === 'approve' ? 'admitted' : 'declined'} in ${request.groupId.slice(0, 8)}...`
  );
  return true;
}

/** Forgets every ask (sign-out, tests): they belong to the account that was signed in. */
export function resetJoinRequests(): void {
  requests.clear();
  settledAt.clear();
  settlements = 0;
}
