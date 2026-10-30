import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { canonicalUserId } from '$lib/mls-client/leafIdentity';
import type { JoinAskOutcome } from '$lib/mls-client/joinAskFrames';
import type { JoinApprovalRequest } from './actions';
import { resetMemberDeviceAnswers, setMemberDeviceSweep } from './memberDeviceAnswers';

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
 * raise it - and ONE ENTRY PER DEVICE for an unseen device of a member (`kind: 'device'`), which the
 * member approves on its own, under the key it shows. The pending-invitation sweep is the durable source - the server's `pending` rows - so a
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
  /**
   * `device`: a DEVICE never seen by this one, of a user already in the conversation, asks to join
   * (`memberDeviceAnswers.ts`). ONE ENTRY PER DEVICE - `deviceIds` holds exactly that device - beside
   * any ask of the person, never merged with another device's: one tap approves one device.
   */
  kind?: 'device';
  /** A `device` entry's key fingerprint, shown and bound into the approval. */
  keyFingerprint?: string;
  /** A `device` entry's name, as its account registered it; shown, never trusted. */
  deviceLabel?: string;
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
 * THE ASKS THE SERVER SAID WERE ANSWERED THIS SESSION, BY IDENTITY (`askId`, the seat's id). An ask
 * is settled for good: a raise naming a settled identity is a read made before the settlement - a
 * sweep, a roster read, an announcement - however late it lands, and it is not raised. A NEW ask of
 * the same person is a new seat, so a new identity, and is raised. No order of arrival is assumed.
 */
const settledAsks = new SvelteSet<string>();
// Reactive, so the banner shows an ask only while something can answer it (`canAnswerJoinRequests`).
let handlers = $state.raw<JoinRequestHandlers | null>(null);

function keyOf(groupId: string, userId: string, device?: { kind?: 'device'; deviceId: string }) {
  const person = `${groupId}|${canonicalUserId(userId)}`;
  return device?.kind === 'device' ? `${person}|device|${device.deviceId}` : person;
}

/** The store key of one ask as an automatic adder raised it. */
function keyOfAsk(ask: JoinApprovalRequest): string {
  return keyOf(ask.groupId, ask.requesterUserId, {
    kind: ask.kind,
    deviceId: ask.requesterDeviceId,
  });
}

/** The store key of one entry. */
function keyOfEntry(entry: JoinRequest): string {
  return keyOf(entry.groupId, entry.userId, { kind: entry.kind, deviceId: entry.deviceIds[0] });
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
  if (ask.kind === 'device') {
    raiseDeviceAsk(key, userId, ask);
    return;
  }
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

/**
 * Records the ask about ONE unseen device of a member. The same device showing ANOTHER key replaces
 * the entry - the member answers about the key now shown, never one an earlier read showed.
 */
function raiseDeviceAsk(key: string, userId: string, ask: JoinApprovalRequest): void {
  const known = requests.get(key);
  if (known?.keyFingerprint === ask.keyFingerprint && known?.deviceLabel === ask.deviceLabel) {
    return;
  }
  requests.set(key, {
    groupId: ask.groupId,
    userId,
    deviceIds: [ask.requesterDeviceId],
    kind: 'device',
    ...(ask.keyFingerprint ? { keyFingerprint: ask.keyFingerprint } : {}),
    ...(ask.deviceLabel ? { deviceLabel: ask.deviceLabel } : {}),
  });
  console.log(
    `[JOIN_REQUEST] an unseen device ${ask.requesterDeviceId.slice(0, 12)}... of ${userId} asks to join ${short(ask.groupId)} under key ${ask.keyFingerprint ?? '(none)'}${known ? ' (its key changed since the last ask)' : ''} - a member's answer is awaited`
  );
}

/**
 * Whether the ask about ONE unseen device of a member is on screen right now, under `fingerprint` -
 * the one fact an automatic adder needs to know its decision about that device is still standing
 * (`askAboutUnseenDevice` in `actions.ts`). An ask answered, settled by a sweep or reset is not
 * shown, so the next request about the device is decided and raised again: nothing is stranded.
 */
export function isDeviceAskShown(
  groupId: string,
  userId: string,
  deviceId: string,
  fingerprint: string
): boolean {
  const entry = requests.get(keyOf(groupId, userId, { kind: 'device', deviceId }));
  return entry?.keyFingerprint === fingerprint;
}

/** What one entry IS, for a sweep: its ask's identity, or - from a server older than it - its key. */
function tokenOf(key: string, entry: JoinRequest): string {
  return entry.askId ?? `key:${key}|${entry.keyFingerprint ?? ''}`;
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

/**
 * Whether `request` is about a device of the signed-in account itself - the owner's own new device,
 * told to its owner in their own words (`join_request_device_body_own`).
 */
export function isOwnDeviceAsk(request: JoinRequest, myUserId: string | null | undefined): boolean {
  return request.kind === 'device' && !!myUserId && canonicalUserId(myUserId) === request.userId;
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
  if (live?.askId === request.askId && live?.keyFingerprint === request.keyFingerprint) {
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
  const settledBefore = request.askId !== undefined && settledAsks.has(request.askId);
  if (settledBefore) {
    forget(request);
    console.log(
      `[JOIN_REQUEST] ${answer} of ${request.userId} in ${short(request.groupId)} not run - the server already settled this ask`
    );
    return true;
  }
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
      `[JOIN_REQUEST] ${answer} of ${request.userId} in ${short(request.groupId)} threw, the ask stays: ${String(e)}`
    );
    return false;
  }
  if (!result.done) {
    if (request.askId !== undefined && settledAsks.has(request.askId)) {
      console.log(
        `[JOIN_REQUEST] ${answer} of ${request.userId} in ${short(request.groupId)} did not happen - the server settled the ask meanwhile (${result.reason})`
      );
      return true;
    }
    // An answer that did not happen is a known outcome (another device holds the add lock, the
    // network is down), named by its reason and retried by the member - a warning, not an error.
    console.warn(
      `[JOIN_REQUEST] ${answer} of ${request.userId} in ${short(request.groupId)} did not happen, the ask stays: ${result.reason}`
    );
    return false;
  }
  forget(request);
  console.log(
    `[JOIN_REQUEST] ${request.userId} ${answer === 'approve' ? 'admitted' : 'declined'} in ${short(request.groupId)}`
  );
  return true;
}

/** Forgets every ask (sign-out, tests): they belong to the account that was signed in. */
export function resetJoinRequests(): void {
  requests.clear();
  settledAsks.clear();
  // And this member's answers about unseen devices, with the sweep that would act on them.
  resetMemberDeviceAnswers();
  setMemberDeviceSweep(null);
}
