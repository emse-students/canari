import { canonicalIdentity } from '$lib/mls-client/leafIdentity';

/**
 * A MEMBER'S ANSWER ABOUT A DEVICE THIS DEVICE NEVER SAW, OF A USER ALREADY IN THE CONVERSATION.
 *
 * A user holding a leaf proves the USER, not the device: nothing this device can verify yet says a
 * further device is theirs (`automaticAdmission` in `actions.ts`). Until a
 * device of the same user can vouch for it by a signature (the cross-signing design in
 * `docs/wiki/protocols/mls-protocol.md`, "An unseen device of a member"), its FIRST admission is a
 * member's gesture, as a new person's is. A device this one has already seen - a pin of its
 * signature key, written from a merged signed commit or a joined tree - is still added
 * automatically: a lost Welcome, a re-add under the same key.
 *
 * THE ANSWER IS ABOUT THE DEVICE, NOT ONE CONVERSATION: approving it lets this device's sweep add it
 * to every conversation this device shares with its owner, so the owner's own new phone costs them
 * one tap, not one per conversation. It is held for the session only: an answer forgotten by a
 * restart is asked again, which never adds anything silently. Declining adds nothing and withdraws
 * nothing on the server - the device may be the owner's own, and another member may know it.
 */

const approved = new Set<string>();
const declined = new Set<string>();

/** What runs the pending-invitation sweep now, registered by the session (`setMemberDeviceSweep`). */
let sweep: (() => Promise<void>) | null = null;

function keyOf(userId: string, deviceId: string): string {
  return canonicalIdentity(`${userId}:${deviceId}`) ?? `${userId}:${deviceId}`;
}

/** This member's answer about `userId:deviceId` this session, or `null` when none was given. */
export function memberDeviceAnswer(
  userId: string,
  deviceId: string
): 'approved' | 'declined' | null {
  const key = keyOf(userId, deviceId);
  if (approved.has(key)) return 'approved';
  if (declined.has(key)) return 'declined';
  return null;
}

/** Registers what runs the sweep that adds an approved device; `null` unregisters (sign-out). */
export function setMemberDeviceSweep(next: (() => Promise<void>) | null): void {
  sweep = next;
}

/**
 * Records the member's approval of each device, then runs the sweep that adds them - the same Add
 * as any member device's, with its locks, races and Welcome (`processPendingInvitations`).
 *
 * @returns whether the sweep ran: an approval with no sweep registered is still recorded, and the
 *   next sweep adds the device.
 */
export async function approveMemberDevices(
  userId: string,
  deviceIds: readonly string[]
): Promise<boolean> {
  for (const deviceId of deviceIds) {
    const key = keyOf(userId, deviceId);
    declined.delete(key);
    approved.add(key);
  }
  console.log(
    `[JOIN_REQUEST] ${deviceIds.length} unseen device(s) of ${userId} approved by this member - the sweep adds them`
  );
  if (!sweep) {
    console.warn(
      '[JOIN_REQUEST] no sweep registered - the approved device is added by the next one'
    );
    return false;
  }
  await sweep();
  return true;
}

/** Records the member's refusal of each device: not added, not asked again this session. */
export function declineMemberDevices(userId: string, deviceIds: readonly string[]): void {
  for (const deviceId of deviceIds) {
    const key = keyOf(userId, deviceId);
    approved.delete(key);
    declined.add(key);
  }
  console.log(
    `[JOIN_REQUEST] ${deviceIds.length} unseen device(s) of ${userId} declined by this member - not added, not asked again this session`
  );
}

/** Forgets every answer (sign-out, tests): they were the leaving account's member's. */
export function resetMemberDeviceAnswers(): void {
  approved.clear();
  declined.clear();
}
