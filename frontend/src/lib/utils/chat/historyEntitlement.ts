/**
 * A REMOVE HOLDS AGAINST A LATER RE-ADD (user, 2026-10-14).
 *
 * A member removed from a group conversation and added back keeps what preceded their removal and
 * NEVER receives what was sent while they were out. Live delivery already honours that - a removed
 * member is out of the MLS tree - so the roads back to those messages are a HISTORY ANSWER (a peer
 * re-sending its own store as `history_bundle` frames) and a REPLY quoting one of them. This module
 * is the control on both, and it runs on the device that SENDS, because a requester asking politely
 * is not a control.
 *
 * **THE WITHHELD SET IS THE UNION OF EVERY CURRENT MEMBER'S WINDOWS, NOT THE ASKER'S.** A bundle is
 * an MLS group broadcast: every member decrypts it whoever it is addressed to, and the receiver
 * ingests answers meant for others (`systemMessageHandler`, `history_bundle`). Filtering on the
 * asker alone would hand a window to a re-admitted member reading a continuous member's answer.
 *
 * **THE CLOCK IS THE SERVER'S.** A window is two instants of chat-delivery's clock; a message is
 * placed by its `serverTimestamp`, the receive time of that same clock (`queued_message.createdAt`
 * on a recipient's copy, the `receivedAt` the send answered on the sender's own copy).
 *
 * **A MESSAGE WITH NO SERVER TIME** - a copy stored before the send answered `receivedAt` - is placed
 * by its sender-stamped `timestamp` against every window WIDENED by {@link UNDATED_SKEW_MARGIN_MS} on
 * both sides: held back inside, released outside. One with no usable timestamp at all is held back.
 * When no current member has a window nothing is filtered, and every answer is exactly what it was
 * before this module - a new member and a new device of a continuous member included.
 *
 * Design and what it does not cover: docs/wiki/protocols/history-reconciliation.md.
 */
import type { ExclusionWindow, GroupExclusions } from '$lib/mls-client/mlsDeliveryApi';
import type { IMlsService } from '$lib/mlsService';

/**
 * How far a CLIENT clock is trusted, either way, when it is the only date a message has: one hour.
 *
 * It covers what a sender-stamped `timestamp` honestly differs from the server's receive time by - a
 * phone clock that is minutes off, and an outbox that held the message for a while before the
 * network took it. It does not cover a device whose clock is wrong by more than that, or a message
 * composed offline more than an hour before it was sent: such a message may land outside the
 * widened window while having been delivered inside it. Only copies written before the server
 * started answering `receivedAt` are undated, so that residue shrinks to nothing as they age out.
 * Wider costs little - a held-back message is served by any member holding it dated - so the margin
 * errs wide.
 */
export const UNDATED_SKEW_MARGIN_MS = 60 * 60 * 1000;

/** What placing a message needs: the server time when the copy has one, and the sender's otherwise. */
export type PlaceableMessage = { serverTimestamp?: number; timestamp: number | Date };

/** The server instant a message was delivered at, or `null` when this copy carries none. */
export function messageServerTime(m: { serverTimestamp?: number }): number | null {
  const at = m.serverTimestamp;
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null;
}

/** Whether `at` falls inside one of `windows` - start included, end excluded (the re-add instant is a member's). */
export function isInsideExclusion(
  at: number,
  windows: readonly ExclusionWindow[],
  margin = 0
): boolean {
  return windows.some((w) => at >= w.from - margin && (w.until === null || at < w.until + margin));
}

/** Why a message is held back from `windows`, or `null` when it may go. */
export type WithholdReason = 'window' | 'undated-near-window' | 'undatable';

/** The one placement rule, shared by every sender and the receiver so the two cannot disagree. */
export function withholdReason(
  m: PlaceableMessage,
  windows: readonly ExclusionWindow[]
): WithholdReason | null {
  if (windows.length === 0) return null;
  const server = messageServerTime(m);
  if (server !== null) return isInsideExclusion(server, windows) ? 'window' : null;
  const client = m.timestamp instanceof Date ? m.timestamp.getTime() : Number(m.timestamp);
  if (!Number.isFinite(client) || client <= 0) return 'undatable';
  return isInsideExclusion(client, windows, UNDATED_SKEW_MARGIN_MS) ? 'undated-near-window' : null;
}

/** Every window of every member, flattened - what a broadcast must respect. */
function allWindows(exclusions: GroupExclusions): ExclusionWindow[] {
  return [...exclusions.values()].flat();
}

type EntitlementDeps = {
  mlsService: Pick<IMlsService, 'getGroupExclusions'>;
  log: (msg: string) => void;
};

/** The server's windows for `groupId`, or `null` (logged) when they cannot be read. */
async function readExclusions(
  groupId: string,
  { mlsService, log }: EntitlementDeps,
  consequence: string
): Promise<GroupExclusions | null> {
  try {
    return await mlsService.getGroupExclusions(groupId);
  } catch (e) {
    log(
      `[HISTORY_ENTITLEMENT] Cannot read the exclusion windows of ${groupId.slice(0, 8)}… - ${consequence}: ${String(e).slice(0, 120)}`
    );
    return null;
  }
}

/**
 * The part of `messages` a history answer in `groupId` may carry, or `null` when that cannot be
 * established - the server's windows could not be read, and the caller then carries NO message.
 *
 * Every history sender passes its selection through here (`sendBundleChunks`), so no answer path can
 * forget it.
 */
export async function entitledHistorySelection<M extends PlaceableMessage>(
  groupId: string,
  messages: readonly M[],
  deps: EntitlementDeps
): Promise<M[] | null> {
  if (messages.length === 0) return [];
  const exclusions = await readExclusions(groupId, deps, 'sending no message');
  if (exclusions === null) return null;

  const windows = allWindows(exclusions);
  if (windows.length === 0) return [...messages];

  const held: Record<WithholdReason, number> = {
    window: 0,
    'undated-near-window': 0,
    undatable: 0,
  };
  const kept = messages.filter((m) => {
    const reason = withholdReason(m, windows);
    if (reason) held[reason]++;
    return reason === null;
  });
  deps.log(
    `[HISTORY_ENTITLEMENT] ${groupId.slice(0, 8)}… - ${exclusions.size} member(s) with an exclusion window: withheld ${held.window} sent while a member was out, ${held['undated-near-window']} undated within ${UNDATED_SKEW_MARGIN_MS / 60_000} min of one, ${held.undatable} undatable; kept ${kept.length}`
  );
  return kept;
}

/**
 * Receiver hygiene: the messages of an arriving bundle that fall inside OUR OWN windows, by the same
 * rule a sender applies ({@link withholdReason}), dropped before they are stored. NOT a control - the
 * answering peer is - but a well-behaved client does not keep what the decision says it never
 * receives. Each drop is logged by id.
 *
 * Returns `null` when our windows cannot be read; the caller then ingests no message of this frame
 * and says so (the comparison runs again on the next connection).
 */
export async function dropOwnExcludedMessages<M extends PlaceableMessage & { id: string }>(
  groupId: string,
  selfUserId: string,
  messages: readonly M[],
  deps: EntitlementDeps
): Promise<M[] | null> {
  if (messages.length === 0) return [];
  const exclusions = await readExclusions(groupId, deps, 'ingesting none of these messages');
  if (exclusions === null) return null;
  const own = exclusions.get(selfUserId.toLowerCase()) ?? [];
  if (own.length === 0) return [...messages];

  return messages.filter((m) => {
    const reason = withholdReason(m, own);
    if (reason === null) return true;
    deps.log(
      `[HISTORY_ENTITLEMENT] Dropped ${m.id.slice(0, 8)} in ${groupId.slice(0, 8)}… (${reason}) - we were out of the group when it was sent`
    );
    return false;
  });
}

/**
 * Whether a reply may carry the TEXT of the message it quotes into `groupId`. A reply reaches every
 * current member live and rides every later bundle, so a quote of a message from inside any
 * member's window would hand that member its words; the reply then carries the quoted id only.
 *
 * `false` when the windows cannot be read, for the same reason a history answer sends nothing then.
 */
export async function quotePreviewEntitled(
  groupId: string,
  quoted: PlaceableMessage,
  deps: EntitlementDeps
): Promise<boolean> {
  const exclusions = await readExclusions(groupId, deps, 'quoting by id only');
  if (exclusions === null) return false;
  const reason = withholdReason(quoted, allWindows(exclusions));
  if (reason !== null) {
    deps.log(
      `[HISTORY_ENTITLEMENT] Reply in ${groupId.slice(0, 8)}… quotes a message a member is not entitled to (${reason}) - quoting by id only`
    );
  }
  return reason === null;
}
