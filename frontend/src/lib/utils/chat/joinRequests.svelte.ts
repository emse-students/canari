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
// Reactive, so the banner shows an ask only while something can answer it (`canAnswerJoinRequests`).
let handlers = $state.raw<JoinRequestHandlers | null>(null);

function keyOf(groupId: string, userId: string): string {
  return `${groupId}|${canonicalUserId(userId)}`;
}

/** Records one ask; a second device of the same person joins the same entry. */
export function raiseJoinRequest(ask: JoinApprovalRequest): void {
  const key = keyOf(ask.groupId, ask.requesterUserId);
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
}
