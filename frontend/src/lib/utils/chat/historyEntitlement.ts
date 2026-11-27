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
 * **AN ANSWER IS FILTERED ON ITS READER'S OWN WINDOWS, BECAUSE IT HAS ONE READER (step A,
 * docs/wiki/protocols/history-answer-addressing.md).** The server routes every history answer to the
 * device that asked ({@link readerHistorySelection}). Before that a bundle was a group broadcast every
 * member ingested, and the filter had to be the union of every member's windows; that is still what
 * a server predating addressed answers gets ({@link entitledHistorySelection}).
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
 * That span cannot join a union - it would withhold everything older than the newest member, from
 * everyone - so it is applied for ONE person at a time: the reader of an addressed answer, the
 * INVITEE of a legacy broadcast push (`invitee` below), and this device's own user on receipt. The
 * legacy broadcast (an older client, or a server predating addressed answers) is filtered on the
 * union of gaps and, on receipt, on the receiver's own windows.
 *
 * Design and what it does not cover: docs/wiki/protocols/history-reconciliation.md.
 */
import {
  WithheldUnsupportedError,
  type ExclusionWindow,
  type GroupExclusions,
} from '$lib/mls-client/mlsDeliveryApi';
import type { IMlsService } from '$lib/mlsService';
import { liftArrivalSpan } from './historyGrant';

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

/** What a read of one person's own windows needs - the receiver. */
type WithheldDeps = {
  mlsService: Pick<IMlsService, 'getGroupWithheld' | 'getGroupExclusions'>;
  log: (msg: string) => void;
};

/** What a withheld read answers when the server predates the field (see below). */
const SERVER_PREDATES_WITHHELD = Symbol('server-predates-withheld');

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
 * The part of `messages` a BROADCAST history answer in `groupId` may carry, or `null` when that cannot
 * be established - the server's windows could not be read, and the caller then carries NO message.
 *
 * Reached only through {@link readerHistorySelection}, for a server that predates addressed answers:
 * every member then reads the answer, so the filter is the union of every member's windows. (It also
 * took the invitee's own windows for the inviter's push until 2026-11-17; the push carries no message
 * since, so nothing reaches this with one.)
 */
export async function entitledHistorySelection<M extends PlaceableMessage>(
  groupId: string,
  messages: readonly M[],
  deps: EntitlementDeps
): Promise<M[] | null> {
  if (messages.length === 0) return [];
  let exclusions: GroupExclusions;
  try {
    exclusions = await deps.mlsService.getGroupExclusions(groupId);
  } catch (e) {
    cannotRead(groupId, deps.log, 'sending no message', String(e));
    return null;
  }
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

/** What a reader-filtered read needs: the windows, and whether the server routes an addressed answer. */
type ReaderDeps = {
  mlsService: Pick<
    IMlsService,
    'getGroupWithheld' | 'getGroupExclusions' | 'getAddressedAnswersSupported'
  >;
  log: (msg: string) => void;
};

/**
 * How a history answer is sent and what it may carry: `addressed` to its one reader and filtered on
 * that reader's own windows, or - from a server that predates addressed answers - `broadcast` and
 * filtered as before this step.
 */
export type ReaderSelection<M> = { mode: 'addressed' | 'broadcast'; kept: M[] };

/** Whether this session has already accused a server that predates addressed answers. */
let warnedServerPredatesAddressing = false;

/**
 * STEP A (docs/wiki/protocols/history-answer-addressing.md, rule 2): the part of `messages` a history
 * answer to ONE reader may carry, or `null` when that cannot be established - nothing is then sent.
 *
 * The answer is addressed, so the only person who reads it is `reader`, and the filter is THEIR OWN
 * `withheld` windows - their gaps and, in a group conversation, everything before their first
 * arrival - no longer the union of every member's. Read again per chunk by the caller, like the union
 * was, so a window opened mid-answer holds for the chunks sealed after it.
 *
 * **A READER THE SERVER DOES NOT NAME** (`?for=` answers only for a person with a device added since
 * the caller arrived) is filtered on the union of every member's gaps plus OUR OWN withheld windows -
 * which is every entry `withheld` holds, since it names only the caller and the person asked for.
 * That is a superset of the reader's windows, by the server's own rule: a reader it does not name has
 * every device row older than our arrival, so they arrived before us and their before-arrival span is
 * inside ours, and their gaps are in the union. An empty `withheld` - the server counts neither of us
 * - sends nothing.
 *
 * **A SERVER THAT PREDATES ADDRESSED ANSWERS** answers without `addressedAnswers`: the answer is then
 * the broadcast this step replaces, filtered by {@link entitledHistorySelection} (the union), and the
 * residual of step C stands. A fallback is a signal: it
 * accuses once per session at error, and is recorded in docs/wiki/legacy-compatibility.md.
 *
 * **AN ANSWER UNDER A HISTORY GRANT** (`grantSince`, owner 2026-11-25, `historyGrant.ts`) lifts ONE
 * window of the reader's own: the span before their first arrival starts at the grant's date
 * ({@link liftArrivalSpan}); every gap stays withheld. Only for a reader the server names - a reader
 * older than us is no newcomer, and keeps the superset below unlifted.
 *
 * @param reader the user id of the device the answer is for.
 * @param grantSince the start date of the grant this answer is made under, when it is one.
 */
export async function readerHistorySelection<M extends PlaceableMessage>(
  groupId: string,
  messages: readonly M[],
  deps: ReaderDeps,
  reader: string,
  grantSince?: number
): Promise<ReaderSelection<M> | null> {
  let supported: boolean;
  let exclusions: GroupExclusions;
  let withheld: GroupExclusions | typeof SERVER_PREDATES_WITHHELD;
  try {
    // One request behind the three (`readGroupWindows` shares it), one line when it fails.
    [supported, exclusions, withheld] = await Promise.all([
      deps.mlsService.getAddressedAnswersSupported(groupId, reader),
      deps.mlsService.getGroupExclusions(groupId, reader),
      deps.mlsService
        .getGroupWithheld(groupId, reader)
        .catch((e: unknown): typeof SERVER_PREDATES_WITHHELD => {
          if (e instanceof WithheldUnsupportedError) return SERVER_PREDATES_WITHHELD;
          throw e;
        }),
    ]);
  } catch (e) {
    cannotRead(groupId, deps.log, 'sending no message', String(e));
    return null;
  }

  if (!supported) {
    if (!warnedServerPredatesAddressing) {
      warnedServerPredatesAddressing = true;
      console.error(
        `[HISTORY_ENTITLEMENT] the delivery service predates addressed history answers - answers are broadcast to the whole group and filtered on the union of gaps`
      );
    }
    const kept = await entitledHistorySelection(groupId, messages, deps);
    return kept === null ? null : { mode: 'broadcast', kept };
  }
  if (withheld === SERVER_PREDATES_WITHHELD) {
    // Addressed answers came after `withheld`, so a server claiming the first without the second
    // is answering something this build cannot read.
    cannotRead(
      groupId,
      deps.log,
      'sending no message',
      'addressed answers without withheld windows'
    );
    return null;
  }

  const own = withheld.get(reader.toLowerCase());
  let windows: ExclusionWindow[];
  let basis: string;
  if (own !== undefined && grantSince !== undefined) {
    windows = liftArrivalSpan(own, grantSince);
    basis = `the reader's ${own.length} window(s), arrival span lifted from ${grantSince > 0 ? new Date(grantSince).toISOString() : 'the beginning'} by a grant`;
  } else if (own !== undefined) {
    windows = [...own];
    basis = `the reader's ${own.length} window(s)`;
  } else if (withheld.size > 0) {
    windows = [...allWindows(exclusions), ...allWindows(withheld)];
    basis = `the reader is older than us - the union of gaps and our own windows, ${windows.length}`;
  } else {
    cannotRead(
      groupId,
      deps.log,
      'sending no message',
      'the server counts neither the reader nor us'
    );
    return null;
  }
  if (messages.length === 0) return { mode: 'addressed', kept: [] };
  if (windows.length === 0) return { mode: 'addressed', kept: [...messages] };

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
    `[HISTORY_ENTITLEMENT] ${groupId.slice(0, 8)}… - answer addressed to ${reader.slice(0, 8)}, filtered on ${basis}: withheld ${held.window}, ${held['undated-near-window']} undated within ${UNDATED_SKEW_MARGIN_MS / 60_000} min of one, ${held.undatable} undatable; kept ${kept.length}`
  );
  return { mode: 'addressed', kept };
}

/**
 * Receiver hygiene: the messages of an arriving bundle that fall inside OUR OWN withheld windows -
 * our gaps and, in a group conversation, everything before we arrived - by the same rule a sender
 * applies ({@link withholdReason}), dropped before they are stored. NOT a control - the answering
 * peer is - but a well-behaved client does not keep what the decision says it never receives, and
 * this is what keeps an honest newcomer from storing a broadcast answer meant for another member's
 * new device. Each drop is logged by id.
 *
 * **AN ANSWER TO OUR GRANT ASK, FROM ITS GRANTER** (`grantSince`, `historyGrant.ts`) is checked
 * against our windows with the arrival span lifted from the grant's date, and that answer only: the
 * caller passes it once the ask was taken for the granting device (`takeAddressedAsk`), never for
 * any other frame. Our gaps still drop.
 *
 * Returns `null` when our windows cannot be read; the caller then ingests no message of this frame
 * and says so (the comparison runs again on the next connection).
 */
export async function dropOwnExcludedMessages<M extends PlaceableMessage & { id: string }>(
  groupId: string,
  selfUserId: string,
  messages: readonly M[],
  deps: WithheldDeps,
  grantSince?: number
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
  const personal = personalWindows(groupId, withheld, selfUserId, deps.log, consequence);
  if (personal === null) return null;
  const own = grantSince === undefined ? personal : liftArrivalSpan(personal, grantSince);
  if (grantSince !== undefined) {
    deps.log(
      `[HISTORY_GRANT] ${groupId.slice(0, 8)}… - a granted answer: our arrival span lifted from ${grantSince > 0 ? new Date(grantSince).toISOString() : 'the beginning'}, ${own.length} window(s) still withheld`
    );
  }
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
