import type { SvelteMap } from 'svelte/reactivity';
import type { IStorage } from '$lib/db';
import type { Conversation, MessageReaction } from '$lib/types';
import type { RecordedAuthorship } from '$lib/crypto/messageAuthorship';
import { applyReaction } from '$lib/utils/chat/messageReactions';

/** What applying a reaction frame reads and writes. */
export interface ReactionFrameDeps {
  storage: IStorage | null;
  deviceKey: () => string;
  conversations: SvelteMap<string, Conversation>;
  messageReactions: SvelteMap<string, MessageReaction[]>;
  log: (msg: string) => void;
}

/** The reaction a frame carries, as decoded. */
export interface ReactionFrame {
  messageId?: string | null;
  emoji?: string | null;
  at?: number | string | { toString(): string } | null;
  removed?: boolean | null;
}

/**
 * Applies one reaction frame (`ReactionMsg`) wherever its message is - shown, stored but not shown,
 * or not on this device yet (2026-11-02, the same window defect as `applyDeletion`).
 *
 * The reaction always lands in `messageReactions`, which is what the screen draws. A shown row and a
 * stored one take it at rest; a message that is neither keeps it there until its body arrives, and
 * the seam that materialises the body writes it with the body (`takeHeldMutations`,
 * `useMessaging.svelte.ts`).
 */
export async function applyReactionFrame(
  deps: ReactionFrameDeps,
  convoKey: string,
  sender: string,
  reaction: ReactionFrame,
  authorship: RecordedAuthorship | undefined
): Promise<void> {
  const { storage, deviceKey, conversations, messageReactions, log } = deps;
  const msgId = reaction.messageId ?? '';
  const emoji = reaction.emoji ?? '';
  const shownConvo = conversations.get(convoKey);
  const shown = shownConvo?.messages.some((m) => m.id === msgId) === true;
  // NOT SHOWN, BUT MAYBE STORED: memory is a window (`applyDeletion` in the system handler says
  // why), so a reaction to a stored row that memory does not hold is merged into THAT row. A
  // target in neither place keeps its reaction in `messageReactions`, which the seam that
  // materialises the body reads when it arrives (`useMessaging.svelte.ts`).
  const stored =
    !shown && storage && msgId
      ? await storage
          .getMessagesByIds([msgId], deviceKey())
          .then((found) => found.rows.get(msgId) ?? null)
          .catch((e: unknown) => {
            log(`[REACTION] stored row of ${msgId.slice(0, 8)} could not be read: ${String(e)}`);
            return null;
          })
      : null;
  const reactions = messageReactions.get(msgId) ?? stored?.reactions ?? [];
  // Both legs arrive here: `removed` says which. A frame from before the field existed carries
  // false, which is what it meant - it could only ever place a reaction.
  // `at` is the sender's clock; an undated frame reads as 0 and loses to anything dated.
  const updated = applyReaction(
    reactions,
    sender,
    emoji,
    Number(reaction.at ?? 0),
    reaction.removed === true,
    authorship
  );
  if (updated) {
    messageReactions.set(msgId, updated);
    const c = conversations.get(convoKey);
    if (stored && storage) {
      log(`[REACTION] ${msgId.slice(0, 8)} is stored, not shown - merged into its row`);
      await storage
        .updateMessage(msgId, { reactions: updated }, deviceKey())
        .catch((e: unknown) =>
          log(`[REACTION] reaction on ${msgId.slice(0, 8)} not persisted: ${String(e)}`)
        );
    } else if (!shown) {
      log(
        `[REACTION] ${msgId.slice(0, 8)} is not on this device yet - the reaction is held for its message`
      );
    }
    if (c) {
      const idx = c.messages.findIndex((m) => m.id === msgId);
      if (idx !== -1) {
        const next = [...c.messages];
        next[idx] = { ...next[idx], reactions: updated };
        conversations.set(convoKey, { ...c, messages: next });
        if (storage) {
          // A reaction changes the reactions. Writing the whole row here used to clear the
          // delete/edit flags, so reacting to an edited message resurrected the original body
          // on the next reload.
          await storage
            .updateMessage(next[idx].id, { reactions: updated }, deviceKey())
            .catch((e: unknown) =>
              log(`[REACTION] reaction on ${msgId.slice(0, 8)} not persisted: ${String(e)}`)
            );
        }
      }
    }
  }
}
