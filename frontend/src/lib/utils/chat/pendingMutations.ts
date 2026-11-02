/**
 * Mutations whose message is not on this device yet - a deletion, an edit or a reaction that arrived
 * before its message (2026-11-02, the owner's deleted-message report).
 *
 * A device that was away receives a message and what happened to it in ONE catch-up drain, and the
 * drain buffers message bodies until it ends (`beginBulkMessageIngest`) while it handles a mutation at
 * once: the body is in neither memory nor the store yet. A body may also reach the device only later,
 * through a history bundle or the archive replay. A mutation dropped then is lost for good - its frame
 * is consumed and never replays - so it is KEPT, in its own durable local store (`PendingMutation`,
 * `IStorage.putPendingMutation`), and settled when the body arrives.
 *
 * **Its own store, never a message row.** An entry is never shown, never in memory as a message,
 * never in the reconciliation's digest or state key, and never relayed in a bundle. An earlier design
 * kept a deletion that came first as a tombstone ROW under the target's id, and that row was all of
 * those things: a peer relayed it as an ordinary tombstone, a new member saw "message deleted" for a
 * message from before their arrival, and a non-author's row stood in front of the author's own.
 *
 * **Settled against the AUTHOR only** ({@link settleAgainstPending}). The body names its author - the
 * MLS-authenticated sender of a live frame, the claimed sender of a relayed copy - and only that
 * author's deletion and edit apply; everybody else's are discarded and logged. A non-author's entry
 * can therefore neither block nor displace the author's: each sender's entries are kept apart (the
 * key holds the sender) and only one sender's are ever read. Reactions are everyone's, each
 * authenticated as its own sender.
 */
import type { MessageReaction } from '$lib/types';
import type { PendingMutation } from '$lib/db/types';
import type { RecordedAuthorship } from '$lib/crypto/messageAuthorship';
import { canonicalUserId } from '$lib/mls-client/leafIdentity';
import { applyEditToBody } from '$lib/envelope';
import { editSupersedes } from './editPrecedence';
import { applyReaction } from './messageReactions';
import { m } from '$lib/paraglide/messages';

/**
 * The most entries one conversation keeps; past it the sender holding the most loses its lowest
 * entry (reactions first, then the oldest by the frame's server time), and the evictions are counted
 * and said at warn ({@link PENDING_MUTATIONS_PER_SENDER} bounds each sender first). A count, never a clock: an entry is
 * not wrong because it is old - its message may still come - only because the store must be bounded.
 *
 * 1000 because the entries a correct device needs are those of mutations whose message is in flight:
 * the same catch-up drain (settled when that drain flushes), or a bundle or replay that follows it.
 * One conversation would need over a thousand deletions, edits and reaction states of messages it
 * has not yet received for a live entry to be evicted - while what the cap is FOR, entries whose
 * message never comes (a message from before this device's arrival, an id nobody sent), is bounded
 * at a size the store holds without cost: an entry is a few hundred bytes. See
 * `docs/wiki/protocols/history-reconciliation.md#mutations-that-arrive-before-their-message`.
 */
export const PENDING_MUTATIONS_PER_CONVERSATION = 1000;

/**
 * The most entries ONE SENDER keeps in one conversation; past it that sender loses its own lowest -
 * a reaction before a deletion or an edit, then the oldest. A member flooding mutations of ids that
 * never arrive therefore evicts only their own entries, never another member's deletion.
 *
 * 200 because a sender's live entries are the mutations of their own in-flight messages (deletions
 * and edits) and their reactions to everyone's: a fifth of the conversation bound, so at least five
 * senders fill the conversation before the larger bound has anything to choose between.
 */
export const PENDING_MUTATIONS_PER_SENDER = 200;

/** The two bounds, as `IStorage.putPendingMutation` takes them. */
export const PENDING_MUTATION_LIMITS = {
  perSender: PENDING_MUTATIONS_PER_SENDER,
  perConversation: PENDING_MUTATIONS_PER_CONVERSATION,
} as const;

/** The part of a message a settlement reads: its author and the state the entries may change. */
export interface SettleTarget {
  id: string;
  senderId: string;
  content: string;
  isDeleted?: boolean;
  isEdited?: boolean;
  editedAt?: Date | number | null;
  reactions?: MessageReaction[];
  /**
   * The body came from a bundle with no proof of its author: its `senderId` is a CLAIM. A deletion
   * or an edit by someone else is then not refused for good - it may be the real author's - so it is
   * RETAINED, neither applied nor consumed, until a proven copy of the body settles it.
   */
  restoredUnverified?: boolean;
}

/** What settling a message's pending entries changes on it. */
export interface SettledFields {
  isDeleted?: true;
  content?: string;
  /** Purged with the body on a deletion, as the live handler does. */
  authorship?: null;
  editProof?: RecordedAuthorship | null;
  deleteProof?: RecordedAuthorship;
  isEdited?: true;
  editedAt?: number;
  reactions?: MessageReaction[];
}

/** The outcome of {@link settleAgainstPending}. */
export interface Settlement {
  /** The fields to write onto the message, or `null` when the entries change nothing. */
  fields: SettledFields | null;
  /** The deletions and edits refused for good: their sender is not the PROVEN author. */
  discarded: PendingMutation[];
  /**
   * The deletions and edits by someone other than an UNPROVEN author (`restoredUnverified`): not
   * applied, and not consumed - they wait for a proven copy of the body.
   */
  retained: PendingMutation[];
  /** Every entry this settlement disposed of - applied or discarded; what a writer may remove. */
  consumed: PendingMutation[];
}

/**
 * Settles `entries` - all waiting for `target` - against the target's AUTHOR, in a fixed order:
 * the author's deletion (a tombstone is final, so nothing after it rewrites the body), else the
 * author's latest edit (`editSupersedes`, against the edit the target may already carry), then every
 * reaction (`applyReaction`, last write wins per reactor and emoji). Pure, and independent of the
 * order the entries are given in.
 */
export function settleAgainstPending(
  target: SettleTarget,
  entries: readonly PendingMutation[]
): Settlement {
  const author = canonicalUserId(target.senderId);
  const discarded: PendingMutation[] = [];
  const retained: PendingMutation[] = [];
  let deletion: PendingMutation | null = null;
  const edits: PendingMutation[] = [];
  const reactions: PendingMutation[] = [];
  for (const entry of entries) {
    if (entry.kind === 'reaction') reactions.push(entry);
    else if (canonicalUserId(entry.sender) !== author) {
      (target.restoredUnverified ? retained : discarded).push(entry);
    } else if (entry.kind === 'delete') deletion = deletion ?? entry;
    else edits.push(entry);
  }

  const fields: SettledFields = {};
  if (!target.isDeleted && deletion) {
    fields.isDeleted = true;
    fields.content = m.chat_system_message_deleted();
    fields.authorship = null;
    fields.editProof = null;
    if (deletion.proof) fields.deleteProof = deletion.proof;
  } else if (!target.isDeleted) {
    let current: { editedAt?: Date | number | null; content: string } = {
      editedAt: target.isEdited ? target.editedAt : null,
      content: target.content,
    };
    let winner: PendingMutation | null = null;
    for (const edit of edits) {
      if (edit.text === undefined) continue;
      if (!editSupersedes({ editedAt: edit.rank, content: edit.text }, current)) continue;
      winner = edit;
      current = { editedAt: edit.rank, content: applyEditToBody(target.content, edit.text) };
    }
    if (winner) {
      fields.content = current.content;
      fields.isEdited = true;
      fields.editedAt = winner.rank;
      fields.editProof = winner.proof ?? null;
    }
  }

  let folded = target.reactions ?? [];
  let reacted = false;
  for (const entry of reactions) {
    const next = applyReaction(
      folded,
      entry.sender,
      entry.slot,
      entry.rank,
      entry.removed === true,
      entry.proof
    );
    if (next) {
      folded = next;
      reacted = true;
    }
  }
  if (reacted) fields.reactions = folded;

  const kept = new Set(retained);
  return {
    fields: Object.keys(fields).length > 0 ? fields : null,
    discarded,
    retained,
    consumed: entries.filter((entry) => !kept.has(entry)),
  };
}
