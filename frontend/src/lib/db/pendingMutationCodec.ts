import type { RecordedAuthorship } from '$lib/crypto/messageAuthorship';
import { deviceKeyTag } from '$lib/encryption';
import type { PendingMutation, PendingMutationKind } from './types';

/**
 * How a {@link PendingMutation} is laid out at rest, the same on both backends.
 *
 * CLEAR: the conversation (message rows name theirs in clear too), the kind and its eviction tier,
 * and the two numbers the store decides on without opening anything - `rank`, compared in the write
 * itself, and `at`, the eviction order.
 *
 * TAGGED: the message id, the sender and the slot (a reaction's emoji) - the rest of the key - are
 * stored only as tags under the device key (`deviceKeyTag`), so the store can look an entry up and
 * compare two of them without anything at rest saying who reacted with what to which message. A
 * message row seals its sender and its reactions; an entry is held to the same standard.
 *
 * SEALED under the device key: those three again, in full, and what the mutation SAYS - an edit's
 * text, a reaction taken back, the author's proof.
 */

/** The sealed half of an entry. */
export interface PendingMutationSealed {
  messageId: string;
  sender: string;
  slot: string;
  text?: string;
  removed?: boolean;
  proof?: RecordedAuthorship;
}

/** The tagged part of an entry's key. */
export interface PendingMutationTags {
  messageTag: string;
  senderTag: string;
  slotTag: string;
}

/**
 * The eviction tier: a reaction is evicted before a deletion or an edit of the same sender, because
 * losing one costs an emoji while losing the others puts back a text its author took away.
 */
export type PendingMutationTier = 0 | 1;

/** The clear and tagged columns of an entry, as both stores key and order it. */
export interface PendingMutationRowKey extends PendingMutationTags {
  conversationId: string;
  kind: PendingMutationKind;
  tier: PendingMutationTier;
  rank: number;
  at: number;
}

/** The kinds an entry may carry; a row naming anything else was not written by this code. */
const KINDS: ReadonlySet<string> = new Set<PendingMutationKind>(['delete', 'edit', 'reaction']);

/** The tier of `kind` ({@link PendingMutationTier}). */
export function pendingMutationTier(kind: PendingMutationKind): PendingMutationTier {
  return kind === 'reaction' ? 0 : 1;
}

/** The tag of a message id - what a lookup by message is keyed on. */
export function pendingMessageTag(deviceKeyB64: string, messageId: string): Promise<string> {
  return deviceKeyTag(deviceKeyB64, 'pending-mutation/message', messageId);
}

/** The three tags of an entry's key under `deviceKeyB64`. */
export async function pendingMutationTags(
  entry: Pick<PendingMutation, 'messageId' | 'sender' | 'slot'>,
  deviceKeyB64: string
): Promise<PendingMutationTags> {
  const [messageTag, senderTag, slotTag] = await Promise.all([
    pendingMessageTag(deviceKeyB64, entry.messageId),
    deviceKeyTag(deviceKeyB64, 'pending-mutation/sender', entry.sender),
    deviceKeyTag(deviceKeyB64, 'pending-mutation/slot', entry.slot),
  ]);
  return { messageTag, senderTag, slotTag };
}

/** Splits `entry` into its row key (clear and tagged) and what is sealed. */
export async function splitPendingMutation(
  entry: PendingMutation,
  deviceKeyB64: string
): Promise<{ key: PendingMutationRowKey; sealed: PendingMutationSealed }> {
  const { conversationId, messageId, sender, kind, slot, rank, at, text, removed, proof } = entry;
  return {
    key: {
      conversationId,
      kind,
      tier: pendingMutationTier(kind),
      rank,
      at,
      ...(await pendingMutationTags(entry, deviceKeyB64)),
    },
    sealed: {
      messageId,
      sender,
      slot,
      ...(text !== undefined ? { text } : {}),
      ...(removed ? { removed: true } : {}),
      ...(proof ? { proof } : {}),
    },
  };
}

/**
 * Rebuilds an entry from its clear columns and its opened payload, or `null` when the row names a
 * kind this code never writes or its payload lacks the key it was tagged with - a row it cannot
 * interpret is never applied.
 */
export function joinPendingMutation(
  clear: Pick<PendingMutationRowKey, 'conversationId' | 'kind' | 'rank' | 'at'>,
  sealed: Record<string, unknown>
): PendingMutation | null {
  if (!KINDS.has(clear.kind)) return null;
  if (
    typeof sealed.messageId !== 'string' ||
    typeof sealed.sender !== 'string' ||
    typeof sealed.slot !== 'string'
  ) {
    return null;
  }
  return {
    conversationId: String(clear.conversationId),
    messageId: sealed.messageId,
    sender: sealed.sender,
    kind: clear.kind,
    slot: sealed.slot,
    rank: Number(clear.rank),
    at: Number(clear.at),
    ...(typeof sealed.text === 'string' ? { text: sealed.text } : {}),
    ...(sealed.removed === true ? { removed: true } : {}),
    ...(sealed.proof ? { proof: sealed.proof as RecordedAuthorship } : {}),
  };
}

/** The primary key of an entry, in the order both stores key it. */
export function pendingMutationPrimaryKey(
  key: Pick<
    PendingMutationRowKey,
    'conversationId' | 'messageTag' | 'senderTag' | 'kind' | 'slotTag'
  >
): [string, string, string, string, string] {
  return [key.conversationId, key.messageTag, key.senderTag, key.kind, key.slotTag];
}
