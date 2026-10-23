/**
 * What a history bundle may change on this device, decided from SIGNATURES rather than from the word
 * of whichever member relayed it.
 *
 * A bundle is written by the member that answered, and before this module its every field was taken
 * on that member's word: a message "from" anybody, a tombstone on anybody's message, a reaction in
 * anybody's name. Now each is taken on one of two grounds only:
 *
 * - the AUTHOR'S OWN SIGNATURE, relayed beside it (`$lib/crypto/messageAuthorship`) - the content,
 *   timestamp and target are then read from the signed bytes, never from the relayer's fields;
 * - or the RELAYER IS THE AUTHOR, which MLS already proved for the bundle frame itself - unless the
 *   relayer says it holds the row only as unverified (`authorUnproven`).
 *
 * A message with neither - every message an older build stored - is kept and MARKED, never refused:
 * refusing would lose real history the day this ships. A deletion, an edit or a reaction with
 * neither is DROPPED, since applying it changes something the device already holds on a third
 * party's word. A proof that does not hold is refused, logged at ERROR and reported as an integrity
 * finding.
 *
 * Protocol: `docs/wiki/protocols/history-reconciliation.md`, "Restored history carries its author's
 * signature".
 */

import {
  checkRecordedAuthorship,
  type AuthorKeySource,
  type AuthorshipCheck,
  type RecordedAuthorship,
} from '$lib/crypto/messageAuthorship';
import { applyEditToBody } from '$lib/envelope';
import { canonicalUserId } from '$lib/mls-client/leafIdentity';
import type { MessageReaction } from '$lib/types';
import { appMsgToEnvelope } from './messageUtils';

/** What a bundle entry for a message carries that matters here. */
export interface RestoredMessageEntry {
  id: string;
  senderId: string;
  content: string;
  timestamp: number;
  authorship?: RecordedAuthorship;
  /** The relayer says the message was edited since; `content` is then the edited body. */
  isEdited?: boolean;
  editProof?: RecordedAuthorship;
  /**
   * The relayer holds this row only as unverified (see {@link relayerVouches}): its own word then
   * proves nothing about the row, whoever the row names.
   */
  authorUnproven?: boolean;
}

/**
 * Whether the relayer's own word may stand for this row: it IS the claimed author, AND it does not
 * say it holds the row only as unverified. A device that restored a row from a third party with no
 * proof holds that party's word, not its own - even when the row names its own user - so relaying
 * it on (`authorUnproven`, written by `serializeForBundle`) leaves the next reader marking it too.
 * Without the second condition one relay hop through the named author's device erased the mark.
 */
function relayerVouches(
  entry: { authorUnproven?: boolean },
  claimedUserId: string,
  relayerUserId: string
): boolean {
  return entry.authorUnproven !== true && claimedUserId === relayerUserId;
}

/** What may be done with a restored message. */
export type RestoredMessageVerdict =
  /** Its author signed it: ingest THESE fields, derived from the signed bytes, and keep the proof. */
  | { kind: 'verified'; content: string; timestamp: number; authorship: RecordedAuthorship }
  /** The relaying member is its author: ingest it as relayed. */
  | { kind: 'relayer-is-author' }
  /** Nothing proves its author: ingest it as relayed, MARKED (`restoredUnverified`). */
  | { kind: 'unverified'; why: string }
  /** A proof that does not hold: refuse it. */
  | { kind: 'forged'; why: string };

type Log = (msg: string) => void;

/**
 * Decides a restored message. `relayerUserId` is the user MLS authenticated the bundle frame from.
 * Every user id is compared in its ONE canonical form (`canonicalUserId`, Rust's): a case variant
 * Rust takes for another user is another user here.
 * A proof with no trusted key to check it against is `unverified`, not `forged`: that says nothing
 * about the message, and it is kept with its proof so a later relay can still prove it.
 *
 * AN EDITED MESSAGE IS VERIFIED ONLY WITH ITS EDIT. The signed bytes are the ORIGINAL body; taking
 * them when the edit cannot be proven (no signed edit relayed, or an older build's edit) would bring
 * back a text its author retracted, looking authenticated. So an unproven edit keeps the relayed
 * (edited) body and MARKS the row instead.
 */
export async function vetRestoredMessage(
  mls: AuthorKeySource,
  groupId: string,
  entry: RestoredMessageEntry,
  relayerUserId: string,
  log: Log
): Promise<RestoredMessageVerdict> {
  const relayer = canonicalUserId(relayerUserId);
  const claimed = canonicalUserId(entry.senderId);
  const vouched = relayerVouches(entry, claimed, relayer);
  if (!entry.authorship) {
    if (vouched) return { kind: 'relayer-is-author' };
    return {
      kind: 'unverified',
      why:
        claimed === relayer
          ? 'no author proof, and its relayer holds it only as unverified'
          : 'no author proof, relayed by another member',
    };
  }
  const check = await checkRecordedAuthorship(mls, groupId, entry.authorship);
  if (check.kind === 'unproven') {
    log(`[AUTHORSHIP] restored ${entry.id.slice(0, 8)} not provable here: ${check.why}`);
    return vouched ? { kind: 'relayer-is-author' } : { kind: 'unverified', why: check.why };
  }
  if (check.kind === 'forged') return { kind: 'forged', why: check.why };
  if (check.group !== groupId) {
    // A real signature, but for another conversation: a row that moved here (a merged DM, a re-key)
    // or a replay. Either way it proves nothing about THIS conversation - as if it had no proof.
    log(`[AUTHORSHIP] restored ${entry.id.slice(0, 8)} carries a proof signed in another group`);
    return vouched
      ? { kind: 'relayer-is-author' }
      : { kind: 'unverified', why: 'the proof was signed in another conversation' };
  }
  if ((check.message.messageId ?? '') !== entry.id) {
    return { kind: 'forged', why: 'the signed message carries another id' };
  }
  if (check.authorUserId !== claimed) {
    return { kind: 'forged', why: `signed by ${check.authorUserId}, relayed as ${claimed}'s` };
  }
  const envelope = appMsgToEnvelope(check.message);
  if (!envelope) return { kind: 'forged', why: 'the signed bytes are not a displayable message' };
  if (entry.isEdited === true) {
    const edit = await vetRestoredEdit(
      mls,
      groupId,
      { id: entry.id, senderId: claimed, content: envelope.content },
      entry,
      relayer,
      log
    );
    if (edit.kind === 'forged') return { kind: 'forged', why: `its edit: ${edit.why}` };
    if (edit.kind === 'relayer') return { kind: 'relayer-is-author' };
    if (edit.kind === 'none') {
      log(
        `[AUTHORSHIP] restored ${entry.id.slice(0, 8)} is edited and its edit is not proven - the relayed body is kept, marked`
      );
      return { kind: 'unverified', why: 'edited, and the edit carries no proof' };
    }
    // A proven edit: the original is verified here, and the merge applies the signed edit to it.
  }
  const signedAt = envelope.options.timestamp?.getTime();
  if (signedAt === undefined) {
    // NO SIGNED DATE: verified, the row would carry the relayer's timestamp under the author's
    // name. So it proves no more than a row with no proof - its author relaying it still vouches.
    log(
      `[AUTHORSHIP] restored ${entry.id.slice(0, 8)} is signed without a timestamp - not verified`
    );
    return vouched
      ? { kind: 'relayer-is-author' }
      : { kind: 'unverified', why: 'the signed message carries no timestamp' };
  }
  return {
    kind: 'verified',
    content: envelope.content,
    timestamp: signedAt,
    authorship: entry.authorship,
  };
}

/**
 * Checks a relayed proof of a SYSTEM event about `targetId` signed by `targetAuthor`, returning the
 * event's parsed data or why it was refused. Shared by the edit and the delete.
 */
async function signedEventAbout(
  mls: AuthorKeySource,
  groupId: string,
  proof: RecordedAuthorship,
  event: 'edit_message' | 'delete_message',
  targetId: string,
  targetAuthor: string
): Promise<
  { kind: 'ok'; data: Record<string, unknown> } | { kind: 'refused'; why: string; forged: boolean }
> {
  const check: AuthorshipCheck = await checkRecordedAuthorship(mls, groupId, proof);
  if (check.kind === 'unproven') return { kind: 'refused', why: check.why, forged: false };
  if (check.kind === 'forged') return { kind: 'refused', why: check.why, forged: true };
  if (check.group !== groupId) {
    return { kind: 'refused', why: 'the proof was signed in another conversation', forged: false };
  }
  if (check.authorUserId !== canonicalUserId(targetAuthor)) {
    return {
      kind: 'refused',
      why: `signed by ${check.authorUserId}, not the author`,
      forged: true,
    };
  }
  if (check.message.system?.event !== event) {
    return { kind: 'refused', why: `the signed frame is not a ${event}`, forged: true };
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(check.message.system.data ?? '{}') as Record<string, unknown>;
  } catch {
    return { kind: 'refused', why: 'the signed event data does not parse', forged: true };
  }
  if (data.messageId !== targetId) {
    return { kind: 'refused', why: 'the signed event names another message', forged: true };
  }
  return { kind: 'ok', data };
}

/** What may be done with a restored edit of a message this device holds. */
export type RestoredEditVerdict =
  /** The author's signed edit: write THIS body and time, and keep the proof. */
  | { kind: 'apply'; content: string; editedAt: number; editProof: RecordedAuthorship }
  /** No proof, and the relayer is the author: the existing author's-own-bundle rule decides. */
  | { kind: 'relayer' }
  /** No proof from a third party, or one not provable now: change nothing. */
  | { kind: 'none' }
  | { kind: 'forged'; why: string };

/** Decides a restored edit of `target` (which this device holds). */
export async function vetRestoredEdit(
  mls: AuthorKeySource,
  groupId: string,
  target: { id: string; senderId: string; content: string },
  entry: { editProof?: RecordedAuthorship; authorUnproven?: boolean },
  relayerUserId: string,
  log: Log
): Promise<RestoredEditVerdict> {
  if (!entry.editProof) {
    return relayerVouches(entry, canonicalUserId(target.senderId), canonicalUserId(relayerUserId))
      ? { kind: 'relayer' }
      : { kind: 'none' };
  }
  const signed = await signedEventAbout(
    mls,
    groupId,
    entry.editProof,
    'edit_message',
    target.id,
    target.senderId
  );
  if (signed.kind === 'refused') {
    if (signed.forged) return { kind: 'forged', why: signed.why };
    log(`[AUTHORSHIP] restored edit of ${target.id.slice(0, 8)} not provable now: ${signed.why}`);
    return { kind: 'none' };
  }
  const { newContent, editedAt } = signed.data;
  if (typeof newContent !== 'string' || typeof editedAt !== 'number' || editedAt <= 0) {
    return { kind: 'forged', why: 'the signed edit carries no text or time' };
  }
  return {
    kind: 'apply',
    content: applyEditToBody(target.content, newContent),
    editedAt,
    editProof: entry.editProof,
  };
}

/** What may be done with a restored tombstone on a message this device holds. */
export type RestoredDeleteVerdict =
  | { kind: 'apply'; deleteProof?: RecordedAuthorship }
  | { kind: 'none' }
  | { kind: 'forged'; why: string };

/** Decides a restored deletion of `target` (which this device holds). */
export async function vetRestoredDelete(
  mls: AuthorKeySource,
  groupId: string,
  target: { id: string; senderId: string },
  entry: { deleteProof?: RecordedAuthorship },
  relayerUserId: string,
  log: Log
): Promise<RestoredDeleteVerdict> {
  if (entry.deleteProof) {
    const signed = await signedEventAbout(
      mls,
      groupId,
      entry.deleteProof,
      'delete_message',
      target.id,
      target.senderId
    );
    if (signed.kind === 'ok') return { kind: 'apply', deleteProof: entry.deleteProof };
    if (signed.forged) return { kind: 'forged', why: signed.why };
    log(
      `[AUTHORSHIP] restored deletion of ${target.id.slice(0, 8)} not provable now: ${signed.why}`
    );
  }
  if (canonicalUserId(relayerUserId) === canonicalUserId(target.senderId)) return { kind: 'apply' };
  log(
    `[AUTHORSHIP] dropped a tombstone on ${target.id.slice(0, 8)} relayed by ${relayerUserId.slice(0, 8)} - its author did not sign it`
  );
  return { kind: 'none' };
}

/** The reactions of a bundle entry this device may merge, and how many it may not. */
export interface RestoredReactions {
  kept: MessageReaction[];
  /** Third-party pairs with no proof, dropped. */
  unproven: number;
  /** Pairs with a proof that does not hold, refused. */
  forged: number;
}

/**
 * Keeps a relayed `(user, emoji)` state when the relayer IS that user, or when the reactor's signed
 * frame proves exactly that state on exactly this message.
 */
export async function vetRestoredReactions(
  mls: AuthorKeySource,
  groupId: string,
  messageId: string,
  reactions: MessageReaction[],
  relayerUserId: string,
  log: Log
): Promise<RestoredReactions> {
  const relayer = canonicalUserId(relayerUserId);
  const out: RestoredReactions = { kept: [], unproven: 0, forged: 0 };
  for (const r of reactions) {
    if (!r?.userId || !r.emoji) continue;
    if (canonicalUserId(r.userId) === relayer) {
      out.kept.push(r);
      continue;
    }
    if (!r.proof) {
      out.unproven += 1;
      continue;
    }
    const check = await checkRecordedAuthorship(mls, groupId, r.proof);
    if (check.kind === 'unproven' || (check.kind === 'verified' && check.group !== groupId)) {
      out.unproven += 1;
      continue;
    }
    const reaction = check.kind === 'verified' ? check.message.reaction : null;
    const holds =
      check.kind === 'verified' &&
      check.authorUserId === canonicalUserId(r.userId) &&
      reaction != null &&
      reaction.messageId === messageId &&
      reaction.emoji === r.emoji &&
      Number(reaction.at ?? 0) === (r.at ?? 0) &&
      (reaction.removed === true) === (r.removed === true);
    if (holds) out.kept.push(r);
    else out.forged += 1;
  }
  if (out.unproven > 0) {
    log(
      `[AUTHORSHIP] ${out.unproven} reaction(s) on ${messageId.slice(0, 8)} relayed by ${relayer.slice(0, 8)} in another member's name dropped - unproven`
    );
  }
  return out;
}
