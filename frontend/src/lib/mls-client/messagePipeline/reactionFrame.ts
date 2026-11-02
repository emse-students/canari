import type { RecordedAuthorship } from '$lib/crypto/messageAuthorship';
import type { MessageReaction } from '$lib/types';
import { applyReaction } from '$lib/utils/chat/messageReactions';
import {
  keepPendingMutation,
  type PendingMutationDeps,
} from '$lib/utils/chat/pendingMutationStore';

/** What applying a reaction frame reads and writes. */
export type ReactionFrameDeps = PendingMutationDeps;

/** The reaction a frame carries, as decoded. */
export interface ReactionFrame {
  messageId?: string | null;
  emoji?: string | null;
  at?: number | string | { toString(): string } | null;
  removed?: boolean | null;
}

/**
 * Applies one reaction - a `ReactionMsg`, or the legacy `remove_reaction` event - wherever its
 * message is: shown, stored but not shown, or not on this device yet (2026-11-02, the same window
 * defect as `applyDeletion`).
 *
 * A shown or stored message takes it in memory (`messageReactions`, what the screen draws) and at
 * rest. A message that is neither gets it KEPT as a pending mutation (`keepPendingMutation`), never
 * held in memory: it is written with the body when the body arrives (`pendingMutations.ts`).
 *
 * @param serverAt the frame's server time - the order a kept entry is evicted in
 */
export async function applyReactionFrame(
  deps: ReactionFrameDeps,
  convoKey: string,
  sender: string,
  reaction: ReactionFrame,
  authorship: RecordedAuthorship | undefined,
  serverAt: number | undefined
): Promise<void> {
  const { storage, deviceKey, conversations, messageReactions, log } = deps;
  const msgId = reaction.messageId ?? '';
  const emoji = reaction.emoji ?? '';
  if (!msgId || !emoji) {
    log(
      `[REACTION] A reaction frame from ${sender.slice(0, 8)} names no message or no emoji - ignored`
    );
    return;
  }
  // `at` is the sender's clock; an undated frame reads as 0 and loses to anything dated. A frame
  // from before `removed` existed carries false, which is what it meant.
  const at = Number(reaction.at ?? 0);
  const removed = reaction.removed === true;
  const shown = conversations.get(convoKey)?.messages.some((m) => m.id === msgId) === true;

  // Looked up at rest even when shown: memory is a window (`applyDeletion` in the system handler says
  // why), and a writer shows a message BEFORE it stores it (`keepUntilStored` there).
  let stored: { reactions?: MessageReaction[] } | null = null;
  let sealedElsewhere = false;
  if (storage) {
    try {
      const found = await storage.getMessagesByIds([msgId], deviceKey());
      if (found.unreadable.has(msgId)) {
        console.warn(
          `[REACTION] ${msgId.slice(0, 8)} is stored under a key this device cannot open - left as it is`
        );
        if (!shown) return;
        sealedElsewhere = true;
      }
      stored = found.rows.get(msgId) ?? null;
    } catch (e) {
      // Not read is not absent: keeping the reaction for a message that may be stored would only
      // delay it, while dropping it would lose it - so it is kept, and settled on the next look.
      log(`[REACTION] stored row of ${msgId.slice(0, 8)} could not be read: ${String(e)}`);
    }
  }
  const keep = () =>
    keepPendingMutation(
      deps,
      {
        conversationId: convoKey,
        messageId: msgId,
        sender,
        kind: 'reaction',
        slot: emoji,
        rank: at,
        ...(removed ? { removed: true } : {}),
        ...(authorship ? { proof: authorship } : {}),
      },
      serverAt
    );

  if (!shown && !stored) {
    await keep();
    return;
  }

  const updated = applyReaction(
    messageReactions.get(msgId) ?? stored?.reactions ?? [],
    sender,
    emoji,
    at,
    removed,
    authorship
  );
  if (!updated) return;
  messageReactions.set(msgId, updated);
  const c = conversations.get(convoKey);
  const idx = c ? c.messages.findIndex((m) => m.id === msgId) : -1;
  if (c && idx !== -1) {
    const next = [...c.messages];
    next[idx] = { ...next[idx], reactions: updated };
    conversations.set(convoKey, { ...c, messages: next });
  } else {
    log(`[REACTION] ${msgId.slice(0, 8)} is stored, not shown - merged into its row`);
  }
  if (!storage || sealedElsewhere) return;
  if (!stored) {
    log(
      `[PENDING] ${msgId.slice(0, 8)} is shown and not stored yet - its reaction is kept for the write`
    );
    await keep();
    return;
  }
  // A reaction changes the reactions. Writing the whole row here used to clear the delete/edit
  // flags, so reacting to an edited message resurrected the original body on the next reload.
  await storage
    .updateMessage(msgId, { reactions: updated }, deviceKey())
    .catch((e: unknown) =>
      log(`[REACTION] reaction on ${msgId.slice(0, 8)} not persisted: ${String(e)}`)
    );
}
