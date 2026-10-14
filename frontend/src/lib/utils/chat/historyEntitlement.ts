/**
 * A REMOVE HOLDS AGAINST A LATER RE-ADD (user, 2026-10-14).
 *
 * A member removed from a group conversation and added back keeps what preceded their removal and
 * NEVER receives what was sent while they were out. Live delivery already honours that - a removed
 * member is out of the MLS tree - so the only road back to those messages is a HISTORY ANSWER: a
 * peer re-sending its own store as `history_bundle` frames. This module is the control on that road,
 * and it runs on the ANSWERING device, because a requester asking politely is not a control.
 *
 * **THE WITHHELD SET IS THE UNION OF EVERY CURRENT MEMBER'S WINDOWS, NOT THE ASKER'S.** A bundle is
 * an MLS group broadcast: every member decrypts it whoever it is addressed to, and the receiver
 * ingests answers meant for others (`systemMessageHandler`, `history_bundle`). Filtering on the
 * asker alone would hand a window to a re-admitted member reading a continuous member's answer.
 *
 * **THE CLOCK IS THE SERVER'S.** A window is two database instants; a message is placed by its
 * `serverTimestamp`, the `queued_message.createdAt` its copy was delivered with - the same database
 * clock. The sender-stamped `timestamp` is never used: it is a client clock, and a window is decided
 * to the second.
 *
 * **A MESSAGE WITH NO SERVER TIME IS WITHHELD whenever any window exists**, because it cannot be
 * shown to fall outside one. That is mostly THIS device's own messages (a sender never receives its
 * own frame back, so its copy carries no delivery time): other members hold those with a server
 * time and can serve them. When no current member has a window, nothing is filtered and every
 * answer is exactly what it was before this module - a new member and a new device of a continuous
 * member included.
 *
 * Design and what it does not cover: docs/wiki/protocols/history-reconciliation.md.
 */
import type { StoredMessage } from '$lib/db';
import type { ExclusionWindow, GroupExclusions } from '$lib/mls-client/mlsDeliveryApi';
import type { IMlsService } from '$lib/mlsService';

/** The server instant a message was delivered at, or `null` when this copy carries none. */
export function messageServerTime(m: Pick<StoredMessage, 'serverTimestamp'>): number | null {
  const at = m.serverTimestamp;
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null;
}

/** Whether `at` falls inside one of `windows` - start included, end excluded (the re-add instant is a member's). */
export function isInsideExclusion(at: number, windows: readonly ExclusionWindow[]): boolean {
  return windows.some((w) => at >= w.from && (w.until === null || at < w.until));
}

/** Every window of every member, flattened - what a broadcast must respect. */
function allWindows(exclusions: GroupExclusions): ExclusionWindow[] {
  return [...exclusions.values()].flat();
}

/**
 * The part of `messages` a history answer in `groupId` may carry, or `null` when that cannot be
 * established - the server's windows could not be read, and the caller then sends NOTHING, the same
 * silence an unreadable store produces, so another member or the next connection answers instead.
 *
 * Every history sender passes its selection through here (`sendBundleChunks`), so no answer path can
 * forget it.
 */
export async function entitledHistorySelection<M extends Pick<StoredMessage, 'serverTimestamp'>>(
  groupId: string,
  messages: readonly M[],
  deps: { mlsService: Pick<IMlsService, 'getGroupExclusions'>; log: (msg: string) => void }
): Promise<M[] | null> {
  const { mlsService, log } = deps;
  const short = groupId.slice(0, 8);
  if (messages.length === 0) return [];

  let exclusions: GroupExclusions;
  try {
    exclusions = await mlsService.getGroupExclusions(groupId);
  } catch (e) {
    log(
      `[HISTORY_ENTITLEMENT] Cannot read the exclusion windows of ${short}… - sending nothing: ${String(e).slice(0, 120)}`
    );
    return null;
  }

  const windows = allWindows(exclusions);
  if (windows.length === 0) return [...messages];

  let inWindow = 0;
  let undated = 0;
  const kept = messages.filter((m) => {
    const at = messageServerTime(m);
    if (at === null) {
      undated++;
      return false;
    }
    if (isInsideExclusion(at, windows)) {
      inWindow++;
      return false;
    }
    return true;
  });
  log(
    `[HISTORY_ENTITLEMENT] ${short}… - ${exclusions.size} member(s) with an exclusion window: withheld ${inWindow} sent while a member was out and ${undated} with no server time, kept ${kept.length}`
  );
  return kept;
}

/**
 * Receiver hygiene: the messages of an arriving bundle that fall inside OUR OWN windows, dropped
 * before they are stored. NOT a control - the answering peer is - but a well-behaved client does
 * not keep what the decision says it never receives. Each drop is logged by id.
 *
 * Returns `null` when our windows cannot be read; the caller then ingests no message of this frame
 * and says so (the comparison runs again on the next connection).
 */
export async function dropOwnExcludedMessages<M extends { id: string; serverTimestamp?: number }>(
  groupId: string,
  selfUserId: string,
  messages: readonly M[],
  deps: { mlsService: Pick<IMlsService, 'getGroupExclusions'>; log: (msg: string) => void }
): Promise<M[] | null> {
  const { mlsService, log } = deps;
  const short = groupId.slice(0, 8);
  if (messages.length === 0) return [];

  let exclusions: GroupExclusions;
  try {
    exclusions = await mlsService.getGroupExclusions(groupId);
  } catch (e) {
    log(
      `[HISTORY_ENTITLEMENT] Cannot read our exclusion windows in ${short}… - ingesting none of this bundle: ${String(e).slice(0, 120)}`
    );
    return null;
  }
  const own = exclusions.get(selfUserId.toLowerCase()) ?? [];
  if (own.length === 0) return [...messages];

  return messages.filter((m) => {
    const at = messageServerTime(m);
    if (at === null || !isInsideExclusion(at, own)) return true;
    log(
      `[HISTORY_ENTITLEMENT] Dropped ${m.id.slice(0, 8)} in ${short}… - sent at ${new Date(at).toISOString()}, while we were out of the group`
    );
    return false;
  });
}
