import type { RecordedAuthorship } from '$lib/crypto/messageAuthorship';
import type { PendingMutation, PendingMutationKind } from './types';

/**
 * How a {@link PendingMutation} is laid out at rest, the same on both backends.
 *
 * CLEAR: the key (`conversationId`, `messageId`, `sender`, `kind`, `slot`) and the two numbers the
 * store decides on without opening anything - `rank`, compared in the write itself, and `at`, the
 * eviction order. SEALED under the device key: what the mutation SAYS - an edit's text, a reaction
 * taken back, the author's proof - exactly as a message row seals its body.
 */

/** The sealed half of an entry. */
export interface PendingMutationSealed {
  text?: string;
  removed?: boolean;
  proof?: RecordedAuthorship;
}

/** The clear half of an entry, as both stores key and order it. */
export type PendingMutationClear = Pick<
  PendingMutation,
  'conversationId' | 'messageId' | 'sender' | 'kind' | 'slot' | 'rank' | 'at'
>;

/** The kinds an entry may carry; a row naming anything else was not written by this code. */
const KINDS: ReadonlySet<string> = new Set<PendingMutationKind>(['delete', 'edit', 'reaction']);

/** Splits `entry` into what is stored in clear and what is sealed. */
export function splitPendingMutation(entry: PendingMutation): {
  clear: PendingMutationClear;
  sealed: PendingMutationSealed;
} {
  const { conversationId, messageId, sender, kind, slot, rank, at, text, removed, proof } = entry;
  return {
    clear: { conversationId, messageId, sender, kind, slot, rank, at },
    sealed: {
      ...(text !== undefined ? { text } : {}),
      ...(removed ? { removed: true } : {}),
      ...(proof ? { proof } : {}),
    },
  };
}

/**
 * Rebuilds an entry from its two halves, or `null` when the clear half names a kind this code never
 * writes - a row it cannot interpret is never applied.
 */
export function joinPendingMutation(
  clear: PendingMutationClear,
  sealed: Record<string, unknown>
): PendingMutation | null {
  if (!KINDS.has(clear.kind)) return null;
  return {
    conversationId: String(clear.conversationId),
    messageId: String(clear.messageId),
    sender: String(clear.sender),
    kind: clear.kind,
    slot: String(clear.slot),
    rank: Number(clear.rank),
    at: Number(clear.at),
    ...(typeof sealed.text === 'string' ? { text: sealed.text } : {}),
    ...(sealed.removed === true ? { removed: true } : {}),
    ...(sealed.proof ? { proof: sealed.proof as RecordedAuthorship } : {}),
  };
}

/** The key of an entry, in the order both stores key it. */
export function pendingMutationKey(
  entry: Pick<PendingMutation, 'conversationId' | 'messageId' | 'sender' | 'kind' | 'slot'>
): [string, string, string, string, string] {
  return [entry.conversationId, entry.messageId, entry.sender, entry.kind, entry.slot];
}
