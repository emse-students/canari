// ---------------------------------------------------------------------------
// When THIS tab last delivered a Welcome to a (group, device) - whichever path sent it.
//
// Four paths send a Welcome: a pending invitation, a group's creation fan-out, a Graine admission
// and a `welcome_request`. Only the last one used to remember it, so a device that asked for a
// Welcome seconds after a creation fan-out had sent one was read as "never welcomed from here":
// its fresh leaf was kicked and re-added, and the kick line named the wrong cause. Recording at
// the ONE place every path goes through (`BaseMlsService.sendWelcome`) makes the welcome_request
// cooldown and the kick line true for all four.
//
// In memory on purpose: it answers "did THIS session just send one", which a reload genuinely
// forgets - a Welcome sent before the reload is one the requester has had time to lose.
// ---------------------------------------------------------------------------

const sentAt = new Map<string, number>();

function key(groupId: string, deviceId: string): string {
  return `${groupId}:${deviceId}`;
}

/** Records that a Welcome for `groupId` was just delivered to `deviceId`. */
export function recordWelcomeSent(groupId: string, deviceId: string): void {
  sentAt.set(key(groupId, deviceId), Date.now());
}

/**
 * The instant this tab last delivered a Welcome for `groupId` to `deviceId`, or `undefined` when it
 * delivered none this session. Read by `handleWelcomeRequest` to tell a device still joining from
 * one that lost its Welcome.
 */
export function welcomeSentAt(groupId: string, deviceId: string): number | undefined {
  return sentAt.get(key(groupId, deviceId));
}

/** Drops every record (session teardown, logout, test cleanup). */
export function resetWelcomeSent(): void {
  sentAt.clear();
}
