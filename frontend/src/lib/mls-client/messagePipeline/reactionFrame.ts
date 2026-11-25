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
 * What applying one frame established - what the frame trigger of a reaction notification reads
 * (`reactionNotification.ts`), so it never re-reads the store this function already read.
 */
export interface ReactionFrameOutcome {
  /** Whether the frame changed the reactions held - false for a replay or an older state. */
  changed: boolean;
  /** The reacted-to message's author as this device holds it, null when it holds no copy. */
  messageAuthorId: string | null;
  /**
   * Whether the store could NOT answer for the row (a read that threw, a row sealed under a key this
   * device cannot open) - so a null author is a real unknown, not an absence.
   */
  storeFailed: boolean;
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
 * @returns what the frame changed, and whose message it landed on
 */
export async function applyReactionFrame(
  deps: ReactionFrameDeps,
  convoKey: string,
  sender: string,
  reaction: ReactionFrame,
  authorship: RecordedAuthorship | undefined,
  serverAt: number | undefined
): Promise<ReactionFrameOutcome> {
  const { storage, deviceKey, conversations, messageReactions, log } = deps;
  const msgId = reaction.messageId ?? '';
  const emoji = reaction.emoji ?? '';
  if (!msgId || !emoji) {
    log(
      `[REACTION] A reaction frame from ${sender.slice(0, 8)} names no message or no emoji - ignored`
    );
    return { changed: false, messageAuthorId: null, storeFailed: false };
  }
  // `at` is the sender's clock; an undated frame reads as 0 and loses to anything dated. A frame
  // from before `removed` existed carries false, which is what it meant.
  const at = Number(reaction.at ?? 0);
  const removed = reaction.removed === true;
  const shownMessage = conversations.get(convoKey)?.messages.find((m) => m.id === msgId);
  const shown = shownMessage !== undefined;

  // Looked up at rest even when shown: memory is a window (`applyDeletion` in the system handler says
  // why), and a writer shows a message BEFORE it stores it (`keepUntilStored` there).
  let stored: { reactions?: MessageReaction[]; senderId?: string } | null = null;
  let sealedElsewhere = false;
  let storeFailed = false;
  if (storage) {
    try {
      // Scoped to THIS conversation: a frame of one conversation never reaches a row of another.
      const found = await storage.getMessagesByIds(convoKey, [msgId], deviceKey());
      if (found.unreadable.has(msgId)) {
        console.warn(
          `[REACTION] ${msgId.slice(0, 8)} is stored under a key this device cannot open - left as it is`
        );
        if (!shown) return { changed: false, messageAuthorId: null, storeFailed: true };
        sealedElsewhere = true;
      }
      stored = found.rows.get(msgId) ?? null;
    } catch (e) {
      storeFailed = true;
      // Not read is not absent: keeping the reaction for a message that may be stored would only
      // delay it, while dropping it would lose it - so it is kept, and settled on the next look.
      log(`[REACTION] stored row of ${msgId.slice(0, 8)} could not be read: ${String(e)}`);
    }
  }
  const keep = (why?: string) =>
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
      serverAt,
      why
    );

  if (!shown && !stored) {
    await keep();
    return { changed: false, messageAuthorId: null, storeFailed };
  }
  const messageAuthorId = shownMessage?.senderId ?? stored?.senderId ?? null;

  const updated = applyReaction(
    messageReactions.get(convoKey, msgId) ?? stored?.reactions ?? [],
    sender,
    emoji,
    at,
    removed,
    authorship
  );
  if (!updated) return { changed: false, messageAuthorId, storeFailed };
  messageReactions.set(convoKey, msgId, updated);
  const c = conversations.get(convoKey);
  const idx = c ? c.messages.findIndex((m) => m.id === msgId) : -1;
  if (c && idx !== -1) {
    const next = [...c.messages];
    next[idx] = { ...next[idx], reactions: updated };
    conversations.set(convoKey, { ...c, messages: next });
  } else {
    log(`[REACTION] ${msgId.slice(0, 8)} is stored, not shown - merged into its row`);
  }
  const outcome = { changed: true, messageAuthorId, storeFailed };
  if (!storage || sealedElsewhere) return outcome;
  if (!stored) {
    log(
      `[PENDING] ${msgId.slice(0, 8)} is shown and not stored yet - its reaction is kept for the write`
    );
    await keep();
    return outcome;
  }
  // A reaction changes the reactions. Writing the whole row here used to clear the delete/edit
  // flags, so reacting to an edited message resurrected the original body on the next reload.
  // Folded into the row as it stands AT THE WRITE (a compare-and-set): a reaction another frame
  // stored since the read above is kept, never overwritten by the copy read before it.
  try {
    await storage.mergeMessages(
      convoKey,
      [msgId],
      (current) => {
        const folded = applyReaction(
          current.reactions ?? [],
          sender,
          emoji,
          at,
          removed,
          authorship
        );
        return folded ? { ...current, reactions: folded } : null;
      },
      deviceKey()
    );
  } catch (e) {
    // KEPT, NEVER ONLY LOGGED (review of #3851): the frame is acknowledged and its generation spent,
    // so a reaction shown and not written was lost at the next reload. Parked as a pending mutation,
    // it is written onto its row at the next look; a store that refuses the park too says so at ERROR
    // (`parkPendingMutation`).
    console.error(
      `[REACTION] reaction on ${msgId.slice(0, 8)} not written to its row - kept as a pending mutation:`,
      e
    );
    await keep('could not be written onto its stored row');
  }
  return outcome;
}
