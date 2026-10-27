import { canonicalIdentity } from '$lib/mls-client/leafIdentity';

/**
 * A MEMBER'S ANSWER ABOUT A DEVICE THIS DEVICE NEVER SAW, OF A USER ALREADY IN THE CONVERSATION.
 *
 * A user holding a leaf proves the USER, not the device: nothing this device can verify yet says a
 * further device is theirs (`automaticAdmission` in `actions.ts`). Until a device of the same user
 * can vouch for it by a signature (the design in `docs/wiki/protocols/mls-protocol.md`, "An unseen
 * device of a member"), its FIRST admission is a member's gesture, as a new person's is. SEEN means a
 * leaf in THAT group's tree, or this member's approval below - never a pin of its key, which any
 * merged tree writes, in any group.
 *
 * ONE ANSWER PER DEVICE, BOUND TO ITS KEY. The member is shown one entry per device - its name, its
 * account and the fingerprint of the signature key its KeyPackage carries - and the approval records
 * that fingerprint ({@link approveMemberDevice}). Every Add made on it checks the package it is built
 * from against it (`approvedKeyHolds` in `actions.ts`): a package under another key is refused and
 * asked about anew. One tap never approves a set of devices.
 *
 * THE APPROVAL IS ABOUT THE DEVICE, NOT ONE CONVERSATION: it lets this device's sweep add that device
 * under that key to every conversation this device shares with its owner, so the owner's own new
 * phone costs one tap, not one per conversation. A DECLINE IS PER CONVERSATION AND DEVICE, and can be
 * undone ({@link undoMemberDeviceDecline}). Both hold for the session: a restart asks again, which
 * never adds anything silently. Declining withdraws nothing on the server - the device may be the
 * owner's own, and another member may know it.
 */

/** The approved devices, by canonical identity, each with the key fingerprint it was approved under. */
const approved = new Map<string, string>();
/** The declined devices, by `groupId|identity`. */
const declined = new Set<string>();
/**
 * What an ask about each device showed: its key fingerprint and its name, read once per session from
 * one fetched KeyPackage, so a sweep does not spend a package per pass while the ask waits.
 */
const askedKeys = new Map<string, AskedDeviceKey>();

/** The key and name an ask about one device shows (`JoinApprovalRequest.keyFingerprint`). */
export interface AskedDeviceKey {
  fingerprint: string;
  label?: string;
}

/** What runs the pending-invitation sweep now, registered by the session (`setMemberDeviceSweep`). */
let sweep: (() => Promise<void>) | null = null;
/**
 * A sweep an answer asked for while another was running: that one may have passed the row already,
 * so one more runs when it ends (`processDeviceInvitationsLocally`). Kept HERE so a sign-out's
 * {@link resetMemberDeviceAnswers} forgets it with the answers it was owed for.
 */
let sweepOwed = false;

/** Records that one more sweep is owed after the running one ({@link takeOwedSweep}). */
export function markSweepOwed(): void {
  sweepOwed = true;
}

/** Whether a sweep is owed, and forgets it: at most one more runs, however many asked. */
export function takeOwedSweep(): boolean {
  const owed = sweepOwed;
  sweepOwed = false;
  return owed;
}

function identityOf(userId: string, deviceId: string): string {
  return canonicalIdentity(`${userId}:${deviceId}`) ?? `${userId}:${deviceId}`;
}

function short(groupId: string): string {
  return `${groupId.slice(0, 8)}...`;
}

/**
 * This member's answer about `userId:deviceId` in `groupId` this session: `approved` with the key
 * fingerprint it was approved under (for every conversation), `declined` in this one, or `null`.
 */
export function memberDeviceAnswer(
  groupId: string,
  userId: string,
  deviceId: string
): { kind: 'approved'; fingerprint: string } | { kind: 'declined' } | null {
  const identity = identityOf(userId, deviceId);
  if (declined.has(`${groupId}|${identity}`)) return { kind: 'declined' };
  const fingerprint = approved.get(identity);
  return fingerprint === undefined ? null : { kind: 'approved', fingerprint };
}

/** The key and name already read for an ask about `userId:deviceId` this session, if any. */
export function askedDeviceKey(userId: string, deviceId: string): AskedDeviceKey | undefined {
  return askedKeys.get(identityOf(userId, deviceId));
}

/** Records the key and name an ask about `userId:deviceId` shows ({@link askedDeviceKey}). */
export function rememberAskedDeviceKey(userId: string, deviceId: string, key: AskedDeviceKey) {
  askedKeys.set(identityOf(userId, deviceId), key);
}

/** Registers what runs the sweep that adds an approved device; `null` unregisters (sign-out). */
export function setMemberDeviceSweep(next: (() => Promise<void>) | null): void {
  sweep = next;
}

/**
 * Starts the sweep and does not wait for it: an answer resolves on the tap, and the sweep - which may
 * be long, or already running and owing a pass - adds the device and says in its log why it cannot.
 */
function startSweep(why: string): void {
  if (!sweep) {
    console.warn(`[JOIN_REQUEST] no sweep registered - ${why} is acted on by the next one`);
    return;
  }
  void sweep().catch((e: unknown) =>
    console.error(`[JOIN_REQUEST] the sweep started for ${why} failed: ${String(e).slice(0, 160)}`)
  );
}

/**
 * Records the member's approval of ONE device under the key fingerprint the ask showed, then starts
 * the sweep that adds it - the same Add as any member device's, with its locks, races and Welcome
 * (`processPendingInvitations`), refused for a package under any other key.
 */
export function approveMemberDevice(userId: string, deviceId: string, fingerprint: string): void {
  const identity = identityOf(userId, deviceId);
  approved.set(identity, fingerprint);
  // A DECLINE IN ANOTHER CONVERSATION STANDS: it is that conversation's answer, and an approval
  // given here never overrides it (`memberDeviceAnswer` reads the decline first).
  console.log(
    `[JOIN_REQUEST] unseen device ${identity.slice(0, 24)}... approved by this member under key ${fingerprint} - the sweep adds it`
  );
  startSweep('an approved device');
}

/**
 * Withdraws an approval whose key a fetched package contradicted: the device is asked about anew,
 * under the key it now shows, and the ask's cached key is forgotten so it is read again.
 */
export function withdrawMemberDeviceApproval(userId: string, deviceId: string): void {
  const identity = identityOf(userId, deviceId);
  approved.delete(identity);
  askedKeys.delete(identity);
}

/** Records the member's refusal of ONE device in ONE conversation: not added, not asked again there. */
export function declineMemberDevice(groupId: string, userId: string, deviceId: string): void {
  const identity = identityOf(userId, deviceId);
  declined.add(`${groupId}|${identity}`);
  console.log(
    `[JOIN_REQUEST] unseen device ${identity.slice(0, 24)}... declined in ${short(groupId)} by this member - not added there, not asked again this session`
  );
}

/** Lifts a decline ({@link declineMemberDevice}): the device is asked about again by the next sweep. */
export function undoMemberDeviceDecline(groupId: string, userId: string, deviceId: string): void {
  const identity = identityOf(userId, deviceId);
  if (!declined.delete(`${groupId}|${identity}`)) return;
  console.log(
    `[JOIN_REQUEST] decline of ${identity.slice(0, 24)}... in ${short(groupId)} undone - asked again`
  );
  startSweep('an undone decline');
}

/** Forgets every answer (sign-out, tests): they were the leaving account's member's. */
export function resetMemberDeviceAnswers(): void {
  approved.clear();
  declined.clear();
  askedKeys.clear();
  sweepOwed = false;
}
