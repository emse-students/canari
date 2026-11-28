/**
 * The repair of a call's group proven stuck (`CallGroupStuckError`, calls.md, "The answer joins on
 * its own group"), handed from the session that owns the recovery ladders to the call service that
 * found it.
 *
 * ONE WRITER: the session registers it when its watchdog starts (`startSyncWatchdogImpl`), which is
 * where the recovery deps exist, and removes it at sign-out (`forgetAccount`), so a repair asked
 * after the account left is refused, said, rather than run on the next account's ladders.
 */
import { appendLog } from '$lib/utils/sessionLog';

/** Asks the group's repair: forget + re-add for a held group behind, re-add for one not held. */
export type CallGroupRepair = (groupId: string) => void;

let repair: CallGroupRepair | null = null;

/** Registers the session's repair, or removes it (`null`, sign-out). */
export function setCallGroupRepair(fn: CallGroupRepair | null): void {
  repair = fn;
}

/**
 * Asks the session to repair `groupId`. With no session to ask (signed out meanwhile) it is said at
 * WARN: the group's own watchdog finds it at the next session.
 */
export function repairStuckCallGroup(groupId: string): void {
  const short = groupId.slice(0, 8);
  if (!repair) {
    appendLog(
      `[Call] WARN group ${short} stuck, and no session to repair it - signed out meanwhile`
    );
    return;
  }
  appendLog(`[Call] group ${short} stuck - its repair is asked for`);
  repair(groupId);
}
