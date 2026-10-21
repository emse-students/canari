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
 * before this module - a new device of a continuous member included.
 *
 * **A NEW MEMBER OF A GROUP CONVERSATION READS NOTHING FROM BEFORE THEIR ARRIVAL (user, 2026-10-21).**
 * That span cannot join the union above - it would withhold everything older than the newest member,
 * from everyone - so it is applied for ONE person at a time, where that person is known: the
 * INVITEE of the push an inviter sends (`invitee` below; every other member is entitled to a
 * superset, so the broadcast stays safe), and this device's own user on receipt. What it leaves open
 * until answers are addressed: a newcomer can still read pre-arrival messages from broadcast answers
 * meant for others' new devices.
 *
 * Design and what it does not cover: docs/wiki/protocols/history-reconciliation.md.
 */
import {
  WithheldUnsupportedError,
  type ExclusionWindow,
  type GroupExclusions,
} from '$lib/mls-client/mlsDeliveryApi';
import type { IMlsService } from '$lib/mlsService';

/**
 * How far a CLIENT clock is trusted, either way, when it is the only date a message has: one hour.
 *
 * It covers what a sender-stamped `timestamp` honestly differs from the server's receive time by - a
 * phone clock that is minutes off, and an outbox that held the message for a while before the
 * network took it. It does not cover a device whose clock is wrong by more than that, or a message
 * composed offline more than an hour before it was sent: such a message may land outside the
 * widened window while having been delivered inside it. Undated copies are those written before the
 * server answered `receivedAt`, AND every copy the native background sender delivers - it reads no
 * answer field yet - so this residue does NOT shrink to nothing on its own. Wider costs little - a held-back message is served by any member holding it dated - so the margin
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

/** What a read of one person's own windows needs - the receiver, and the push to an invitee. */
type WithheldDeps = {
  mlsService: Pick<IMlsService, 'getGroupWithheld' | 'getGroupExclusions'>;
  log: (msg: string) => void;
};

/** Logs, once, that the windows of `groupId` could not be established and what that costs. */
function cannotRead(groupId: string, log: (msg: string) => void, consequence: string, why: string) {
  log(
    `[HISTORY_ENTITLEMENT] Cannot read the exclusion windows of ${groupId.slice(0, 8)}… - ${consequence}: ${why.slice(0, 120)}`
  );
}

/**
 * ONE person's withheld windows in `groupId`, or `null` (logged) when they cannot be established.
 *
 * **A MISSING ENTRY IS A REFUSAL, NOT AN EMPTY SET.** The server names every person it counts, an
 * empty entry included, so a missing key means the person was not counted at all - an enrolment that
 * failed, an admit that was dropped - and reading it as "nothing withheld" would hand them everything.
 */
function personalWindows(
  groupId: string,
  withheld: GroupExclusions,
  userId: string,
  log: (msg: string) => void,
  consequence: string
): readonly ExclusionWindow[] | null {
  const own = withheld.get(userId.toLowerCase());
  if (own === undefined) {
    cannotRead(groupId, log, consequence, `the server does not count ${userId.slice(0, 8)}`);
    return null;
  }
  return own;
}

/**
 * The part of `messages` a history answer in `groupId` may carry, or `null` when that cannot be
 * established - the server's windows could not be read, and the caller then carries NO message.
 *
 * Every history sender passes its selection through here (`sendBundleChunks`), so no answer path can
 * forget it.
 *
 * @param invitee the user the answer is PUSHED to when it is the inviter's push to a member being
 *   added: their own withheld windows - the span before their arrival included - join the union.
 *   Absent for an answer to a request, which reaches every member and has no one person to filter for.
 */
export async function entitledHistorySelection<M extends PlaceableMessage>(
  groupId: string,
  messages: readonly M[],
  deps: EntitlementDeps & { mlsService: Pick<IMlsService, 'getGroupWithheld'> },
  invitee?: string
): Promise<M[] | null> {
  if (messages.length === 0) return [];
  // Both read at once, for the same person: one request behind them (`readGroupWindows`), one answer,
  // and one line when it fails.
  let exclusions: GroupExclusions;
  let inviteeWindows: readonly ExclusionWindow[] = [];
  try {
    const [union, withheld] = await Promise.all([
      deps.mlsService.getGroupExclusions(groupId, invitee),
      invitee === undefined ? null : deps.mlsService.getGroupWithheld(groupId, invitee),
    ]);
    exclusions = union;
    if (invitee !== undefined && withheld !== null) {
      const own = personalWindows(groupId, withheld, invitee, deps.log, 'sending no message');
      if (own === null) return null;
      inviteeWindows = own;
    }
  } catch (e) {
    cannotRead(groupId, deps.log, 'sending no message', String(e));
    return null;
  }
  const windows = [...allWindows(exclusions), ...inviteeWindows];
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
    `[HISTORY_ENTITLEMENT] ${groupId.slice(0, 8)}… - ${exclusions.size} member(s) with an exclusion window${invitee === undefined ? '' : `, invitee ${invitee.slice(0, 8)} with ${inviteeWindows.length}`}: withheld ${held.window} sent while a member was out or before the invitee arrived, ${held['undated-near-window']} undated within ${UNDATED_SKEW_MARGIN_MS / 60_000} min of one, ${held.undatable} undatable; kept ${kept.length}`
  );
  return kept;
}

/**
 * Receiver hygiene: the messages of an arriving bundle that fall inside OUR OWN withheld windows -
 * our gaps and, in a group conversation, everything before we arrived - by the same rule a sender
 * applies ({@link withholdReason}), dropped before they are stored. NOT a control - the answering
 * peer is - but a well-behaved client does not keep what the decision says it never receives, and
 * this is what keeps an honest newcomer from storing a broadcast answer meant for another member's
 * new device. Each drop is logged by id.
 *
 * Returns `null` when our windows cannot be read; the caller then ingests no message of this frame
 * and says so (the comparison runs again on the next connection).
 */
export async function dropOwnExcludedMessages<M extends PlaceableMessage & { id: string }>(
  groupId: string,
  selfUserId: string,
  messages: readonly M[],
  deps: WithheldDeps
): Promise<M[] | null> {
  if (messages.length === 0) return [];
  const consequence = 'ingesting none of these messages';
  let withheld: GroupExclusions;
  try {
    withheld = await deps.mlsService.getGroupWithheld(groupId);
  } catch (e) {
    if (!(e instanceof WithheldUnsupportedError)) {
      cannotRead(groupId, deps.log, consequence, String(e));
      return null;
    }
    // A SERVER THAT PREDATES `withheld` keeps the rule it had: our own gaps, read from the union
    // field. Not a fallback for a failure - the server ANSWERED, and has nothing newer to say. Shim
    // recorded in docs/wiki/legacy-compatibility.md, gone once production serves the field.
    try {
      withheld = await deps.mlsService.getGroupExclusions(groupId);
    } catch (e2) {
      cannotRead(groupId, deps.log, consequence, String(e2));
      return null;
    }
    // The union names only people WITH a gap, so here (and only here) absent is "no gap".
    const gaps = withheld.get(selfUserId.toLowerCase()) ?? [];
    deps.log(
      `[HISTORY_ENTITLEMENT] ${groupId.slice(0, 8)}… - the server predates the withheld windows; filtering on our ${gaps.length} gap(s) only`
    );
    return gaps.length === 0 ? [...messages] : dropInside(groupId, messages, gaps, deps.log);
  }
  const own = personalWindows(groupId, withheld, selfUserId, deps.log, consequence);
  if (own === null) return null;
  if (own.length === 0) return [...messages];
  return dropInside(groupId, messages, own, deps.log);
}

/** `messages` minus those inside `windows`, each drop logged by id. */
function dropInside<M extends PlaceableMessage & { id: string }>(
  groupId: string,
  messages: readonly M[],
  windows: readonly ExclusionWindow[],
  log: (msg: string) => void
): M[] {
  return messages.filter((m) => {
    const reason = withholdReason(m, windows);
    if (reason === null) return true;
    log(
      `[HISTORY_ENTITLEMENT] Dropped ${m.id.slice(0, 8)} in ${groupId.slice(0, 8)}… (${reason}) - sent before we arrived or while we were out`
    );
    return false;
  });
}

/**
 * Whether a reply may carry the TEXT of the message it quotes into `groupId`. A reply reaches every
 * current member live and rides every later bundle, so a quote of a message from inside any
 * member's window would hand that member its words; the reply then carries the quoted id only.
 *
 * Asked by the outbox at the SEND, not when the reply is composed: the windows are the ones in
 * force when the frame leaves, and composing costs no round trip.
 *
 * **THROWS when the windows cannot be read** - it never answers `false` for a failure. Blanking is
 * permanent (the frame and the stored copy lose the text for good), so it is decided only on an
 * answer; a failed read leaves the reply queued for the next attempt. `quoted` is `null` when this
 * device holds no copy of the quoted message: with a window in force it cannot be placed, so it is
 * quoted by id only, as an undatable message is withheld from a bundle.
 */
export async function quotePreviewEntitled(
  groupId: string,
  quoted: PlaceableMessage | null,
  deps: EntitlementDeps
): Promise<boolean> {
  const exclusions = await deps.mlsService.getGroupExclusions(groupId);
  const windows = allWindows(exclusions);
  if (windows.length === 0) return true;
  const reason = quoted === null ? 'undatable' : withholdReason(quoted, windows);
  if (reason !== null) {
    deps.log(
      `[HISTORY_ENTITLEMENT] Reply in ${groupId.slice(0, 8)}… quotes a message a member is not entitled to (${reason}) - quoting by id only`
    );
  }
  return reason === null;
}
