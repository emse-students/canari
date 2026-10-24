/**
 * ONE RULE FOR EVERY WAY A HISTORY BUNDLE ARRIVES: what a bundle may add or change on this device,
 * decided from signatures (`restoredAuthorship.ts`) and applied by one merge.
 *
 * A bundle reaches a device two ways - live, as an MLS frame (`systemMessageHandler.ts`), and from
 * the shared archive, when an older build wrote it durably (`historySystemEvents.ts`). Both hand
 * their entries to {@link vetBundle}, then each row it names to {@link mergeVettedRow}, so a
 * message, an edit, a tombstone or a reaction is taken on the same grounds whichever way it came:
 * the author's own signature, or a relayer who IS the author and vouches for the row. Only the
 * writes differ - the live path writes each row now, the replay once per page.
 *
 * Protocol: `docs/wiki/protocols/history-reconciliation.md`, "Restored history carries its author's
 * signature".
 */

import type { AuthorKeySource, RecordedAuthorship } from '$lib/crypto/messageAuthorship';
import { canonicalUserId } from '$lib/mls-client/leafIdentity';
import { m } from '$lib/paraglide/messages';
import type { MessageReaction } from '$lib/types';
import type { StoredMessagePatch } from '$lib/db/types';
import { editSupersedes } from './editPrecedence';
import { isOwnMessage } from './messageUtils';
import { mergeReactions } from './messageReactions';
import {
  vetRestoredDelete,
  vetRestoredEdit,
  vetRestoredMessage,
  vetRestoredReactions,
  type RestoredDeleteVerdict,
  type RestoredEditVerdict,
  type RestoredMessageEntry,
  type RestoredMessageVerdict,
} from './restoredAuthorship';

/** One message of a bundle, as `serializeForBundle` writes it. Every field is a peer's claim. */
export interface BundleEntry extends RestoredMessageEntry {
  reactions?: MessageReaction[];
  isDeleted?: boolean;
  editedAt?: number;
  serverTimestamp?: number;
  deleteProof?: RecordedAuthorship;
}

/**
 * A held MARKED row a copy proves. The proven copy replaces the row ENTIRELY: an unverified row's
 * sender was a relayer's word exactly like its body, so the sender is the proven author too.
 */
export interface BundleUpgrade {
  /** The proven author, canonical. */
  senderId: string;
  content: string;
  timestamp: number;
  authorship: RecordedAuthorship;
}

/** What vetting reads of a row this device already holds. */
export interface BundleHeldRow {
  id: string;
  senderId?: string;
  content: string;
  restoredUnverified?: boolean;
  isDeleted?: boolean;
}

/** What one entry may change on its row, vetted. */
export interface BundleRowDecision {
  reactions?: MessageReaction[];
  del?: RestoredDeleteVerdict;
  edit?: RestoredEditVerdict;
}

/** A refusal: logged at ERROR and reported by the caller, which knows the conversation. */
export type ForgedReport = (
  what: 'message' | 'reaction' | 'delete' | 'edit',
  id: string,
  why: string
) => void;

/** What a bundle may do here. */
export interface VettedBundle<E extends BundleEntry> {
  /** The new messages to add, one per id - a proven copy wins over a marked one, in either order. */
  fresh: Array<{ entry: E; verdict: Exclude<RestoredMessageVerdict, { kind: 'forged' }> }>;
  /** How many of `fresh` are marked unverified. */
  unverified: number;
  /** Held MARKED rows a copy proves: their body and time from the signed bytes, the mark cleared. */
  upgrades: Map<string, BundleUpgrade>;
  /** Per row id - fresh, upgraded, or held when asked - the entry and what it may change. */
  decisions: Map<string, { entry: E; decision: BundleRowDecision }>;
}

type Log = (msg: string) => void;

/**
 * Vets a bundle relayed by `relayer`.
 *
 * @param entries Every entry of the bundle.
 * @param fresh The entries this device does not hold and may add (already through its exclusion
 *   filter).
 * @param held The rows this device holds, by id.
 * @param mutateHeld Whether the bundle may change held rows that it neither adds nor upgrades - not
 *   for an addressed answer to an ask, which may only add.
 */
export async function vetBundle<E extends BundleEntry>(
  keys: AuthorKeySource,
  groupId: string,
  input: {
    entries: E[];
    fresh: E[];
    held: Map<string, BundleHeldRow>;
    relayer: string;
    mutateHeld: boolean;
  },
  log: Log,
  onForged: ForgedReport
): Promise<VettedBundle<E>> {
  const { entries, fresh, held, relayer, mutateHeld } = input;
  const out: VettedBundle<E> = {
    fresh: [],
    unverified: 0,
    upgrades: new Map(),
    decisions: new Map(),
  };

  // 1) New messages. ONE ROW PER ID, AND THE PROVEN COPY WINS: a bundle may carry an id twice, and
  //    whichever copy came first used to be the one added.
  const freshIndex = new Map<string, number>();
  for (const entry of fresh) {
    const verdict = await vetRestoredMessage(keys, groupId, entry, relayer, log);
    if (verdict.kind === 'forged') {
      onForged('message', entry.id, verdict.why);
      continue;
    }
    const earlier = freshIndex.get(entry.id);
    if (earlier !== undefined) {
      if (verdict.kind !== 'verified' || out.fresh[earlier].verdict.kind !== 'unverified') continue;
      out.fresh[earlier] = { entry, verdict };
      out.unverified -= 1;
      continue;
    }
    if (verdict.kind === 'unverified') out.unverified += 1;
    freshIndex.set(entry.id, out.fresh.length);
    out.fresh.push({ entry, verdict });
  }

  // 2) A HELD ROW IS UPGRADED BY PROOF, AND BY NOTHING ELSE. A marked row takes a copy whose proof
  //    verifies here; a row that is not marked is never replaced, whatever a copy carries.
  const upgradedBy = new Map<string, E>();
  for (const entry of entries) {
    const row = held.get(entry.id);
    if (!row?.restoredUnverified || row.isDeleted || !entry.authorship) continue;
    if (out.upgrades.has(entry.id)) continue;
    const verdict = await vetRestoredMessage(keys, groupId, entry, relayer, log);
    if (verdict.kind === 'forged') onForged('message', entry.id, verdict.why);
    if (verdict.kind !== 'verified') continue;
    // `verified` means the proof names this entry's sender as its signer.
    out.upgrades.set(entry.id, {
      senderId: canonicalUserId(entry.senderId),
      content: verdict.content,
      timestamp: verdict.timestamp,
      authorship: verdict.authorship,
    });
    upgradedBy.set(entry.id, entry);
  }

  // 3) What each entry may change on its row, against the row as it will stand: the one just
  //    added, the one just upgraded, or the one held. The last copy of an id speaks for a held row.
  const lastById = new Map(entries.map((e) => [e.id, e]));
  const targets = new Map<string, { entry: E; row: BundleHeldRow }>();
  if (mutateHeld) {
    for (const [id, entry] of lastById) {
      const row = held.get(id);
      if (row) targets.set(id, { entry, row: { ...row, senderId: row.senderId ?? '' } });
    }
  }
  for (const [id, up] of out.upgrades) {
    targets.set(id, {
      entry: upgradedBy.get(id)!,
      row: { id, senderId: up.senderId, content: up.content },
    });
  }
  for (const { entry, verdict } of out.fresh) {
    targets.set(entry.id, {
      entry,
      row: {
        id: entry.id,
        senderId: canonicalUserId(entry.senderId),
        content: verdict.kind === 'verified' ? verdict.content : entry.content,
      },
    });
  }
  for (const [id, { entry, row }] of targets) {
    const target = { id, senderId: row.senderId ?? '', content: row.content };
    const decision: BundleRowDecision = {};
    if (Array.isArray(entry.reactions) && entry.reactions.length > 0) {
      const outcome = await vetRestoredReactions(keys, groupId, id, entry.reactions, relayer, log);
      if (outcome.forged > 0) onForged('reaction', id, `${outcome.forged} forged`);
      decision.reactions = outcome.kept;
    }
    if (entry.isDeleted === true && !row.isDeleted) {
      decision.del = await vetRestoredDelete(keys, groupId, target, entry, relayer, log);
      if (decision.del.kind === 'forged') onForged('delete', id, decision.del.why);
    }
    if (entry.isEdited === true && !row.isDeleted) {
      decision.edit = await vetRestoredEdit(keys, groupId, target, entry, relayer, log);
      if (decision.edit.kind === 'forged') onForged('edit', id, decision.edit.why);
    }
    out.decisions.set(id, { entry, decision });
  }
  return out;
}

/** What {@link mergeVettedRow} reads and writes of a row. */
export interface MergeableRow {
  id: string;
  senderId?: string;
  content: string;
  isDeleted?: boolean;
  isEdited?: boolean;
  editedAt?: Date;
  reactions?: MessageReaction[];
  restoredUnverified?: boolean;
}

/** One row after a vetted entry was merged onto it, and what moved. */
export interface MergedRow<R extends MergeableRow> {
  next: R;
  changed: boolean;
  /** The body was replaced by an edit (written at rest with its proof, or none). */
  bodyEdited: boolean;
  /** The merged reaction set, when it moved. */
  reactions?: MessageReaction[];
  editProof?: RecordedAuthorship;
  deleteProof?: RecordedAuthorship;
}

/**
 * Merges one vetted entry onto its row. Only what {@link vetBundle} allowed moves:
 *
 * - reactions, pair by pair, larger timestamp wins (D3) - only the pairs vetted;
 * - a tombstone REPLACES the body (D5), on the author's word or signature;
 * - the author's SIGNED edit, from whoever relays it, ordered by `editSupersedes` as the live path;
 * - the edited body from a relayer who IS the author and vouches for the row - `editSupersedes`
 *   decides which of two edits wins, never who may edit;
 * - the edit flag and time, which only a bundle can supply (the sender's own edit is never echoed
 *   back over MLS) - on the same grounds as the edit, or onto a row already marked unverified.
 *
 * @param heldReactions The reactions this device holds for the row now, if any.
 */
export function mergeVettedRow<R extends MergeableRow>(
  existing: R,
  entry: BundleEntry,
  decision: BundleRowDecision,
  relayer: string,
  heldReactions: MessageReaction[] | undefined
): MergedRow<R> {
  const out: MergedRow<R> = { next: existing, changed: false, bodyEdited: false };
  let next = existing;
  if (decision.reactions && decision.reactions.length > 0) {
    const merged = mergeReactions(heldReactions ?? next.reactions ?? [], decision.reactions);
    if (merged) {
      next = { ...next, reactions: merged };
      out.reactions = merged;
      out.changed = true;
    }
  }
  if (entry.isDeleted === true && !next.isDeleted && decision.del?.kind === 'apply') {
    next = { ...next, isDeleted: true, content: m.chat_system_message_deleted() };
    if (decision.del.deleteProof) out.deleteProof = decision.del.deleteProof;
    out.changed = true;
  }
  if (
    decision.edit?.kind === 'apply' &&
    !next.isDeleted &&
    editSupersedes({ editedAt: decision.edit.editedAt, content: decision.edit.content }, next)
  ) {
    next = {
      ...next,
      content: decision.edit.content,
      isEdited: true,
      editedAt: new Date(decision.edit.editedAt),
    };
    out.editProof = decision.edit.editProof;
    out.bodyEdited = true;
    out.changed = true;
  }
  if (
    decision.edit?.kind === 'relayer' &&
    entry.isEdited === true &&
    !next.isDeleted &&
    typeof entry.content === 'string' &&
    entry.content !== next.content &&
    typeof entry.editedAt === 'number' &&
    entry.editedAt > 0 &&
    canonicalUserId(existing.senderId ?? '') === canonicalUserId(relayer) &&
    editSupersedes({ editedAt: entry.editedAt, content: entry.content }, next)
  ) {
    next = { ...next, content: entry.content, isEdited: true, editedAt: new Date(entry.editedAt) };
    out.bodyEdited = true;
    out.changed = true;
  }
  // The flag and the time are the edit's too: taken from the author (signed, or relaying a row it
  // vouches for), or onto a row already marked unverified, whose relayed body they describe - never
  // set on a proven row by a third party.
  const editTaken =
    decision.edit?.kind === 'apply' ||
    decision.edit?.kind === 'relayer' ||
    existing.restoredUnverified === true;
  if (!editTaken) {
    out.next = next;
    return out;
  }
  if (entry.isEdited === true && !next.isEdited) {
    next = { ...next, isEdited: true };
    out.changed = true;
  }
  if (typeof entry.editedAt === 'number' && entry.editedAt > 0 && next.editedAt == null) {
    next = { ...next, editedAt: new Date(entry.editedAt) };
    out.changed = true;
  }
  out.next = next;
  return out;
}

/** What {@link upgradedRow} reads and rewrites of an in-memory row. */
export interface UpgradableRow {
  senderId: string;
  content: string;
  timestamp: Date;
  isOwn?: boolean;
  restoredUnverified?: boolean;
  isEdited?: boolean;
  editedAt?: Date;
}

/**
 * The in-memory row after an upgrade: sender, body and time from the proof, the mark and the
 * unproven edit state gone (a verified EDITED message carries its signed edit, which the merge then
 * applies to the original as to any held row).
 */
export function upgradedRow<R extends UpgradableRow>(row: R, up: BundleUpgrade, userId: string): R {
  if (canonicalUserId(row.senderId) !== up.senderId) {
    console.warn('[AUTHORSHIP] upgrade changed the claimed sender of a restored message');
  }
  const next: R = {
    ...row,
    senderId: up.senderId,
    content: up.content,
    timestamp: new Date(up.timestamp),
    ...('isOwn' in row ? { isOwn: isOwnMessage(up.senderId, userId) } : {}),
  };
  delete next.restoredUnverified;
  delete next.isEdited;
  delete next.editedAt;
  return next;
}

/** The stored-row patch of an upgrade: the same as {@link upgradedRow}, at rest. */
export function upgradePatch(up: BundleUpgrade): StoredMessagePatch {
  return {
    senderId: up.senderId,
    content: up.content,
    timestamp: up.timestamp,
    authorship: up.authorship,
    restoredUnverified: false,
    isEdited: false,
    editedAt: null,
    editProof: null,
  };
}
