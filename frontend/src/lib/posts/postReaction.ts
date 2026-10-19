/**
 * ONE PATH FOR A REACTION ON A POST, WHOEVER ASKS FOR IT: the card's reaction picker and badges,
 * a double tap on the card, and a double tap on a reel in the full-screen viewer (user,
 * 2026-10-19: "liker un CanaReel en double cliquant dessus, et pareil pour tous les posts").
 *
 * The viewer holds its reels outside any `PostCard`, so the card's own handler could not serve it;
 * what both need - the optimistic map, the refusal known before any request, and the request
 * itself behind `assertNotMuted` - lives here once. WHERE the state is kept and HOW a failure is
 * said stay with each caller (the card's ledger and inline line, the viewer's array and toast),
 * because those genuinely differ.
 *
 * A like made in the viewer is announced to the cards on screen ({@link publishPostReactions}),
 * or closing the viewer would show the reel's card without the heart just given to it.
 */
import { addReaction, removeReaction } from '$lib/posts/api';
import { assertNotMuted, cachedMuteStatus } from '$lib/moderation/muteCheck';
import type { ReactionType } from '$lib/posts/reactions';

/**
 * The reaction a double tap gives: "J'aime", drawn as the heart. A double tap only ever ADDS it,
 * and only to a post the reader has not reacted to yet - it never removes nor replaces a reaction
 * (Instagram's rule; the picker stays the way to change or take one back).
 */
export const DOUBLE_TAP_REACTION: ReactionType = "J'aime";

/** A post's reactions: one reaction type per user id. */
export type PostReactions = Record<string, string>;

/**
 * The reactions after `userId` toggles `type`: the same type again takes it back, any other
 * replaces theirs. Pure - the caller applies it on the tap and keeps `reactions` for a rollback.
 */
export function toggledReactions(
  reactions: PostReactions,
  userId: string,
  type: string
): { next: PostReactions; wasReacted: boolean } {
  const wasReacted = reactions[userId] === type;
  const next = { ...reactions };
  if (wasReacted) delete next[userId];
  else next[userId] = type;
  return { next, wasReacted };
}

/**
 * True when this reader's reactions are refused by a moderation mute ALREADY KNOWN on this device.
 * Such a tap changes nothing and sends nothing; a mute not yet known never holds the tap - the
 * request asks behind it ({@link sendPostReaction}).
 */
export function reactionRefusedLocally(): boolean {
  return cachedMuteStatus()?.isMuted === true;
}

/**
 * Sends the reaction the caller has already drawn: removes it when `wasReacted`, adds `type`
 * otherwise. Resolves to the server's map; rejects with `MutedError` for a refusal by moderation
 * and with whatever the transport threw otherwise (`publishFailureMessage` tells them apart).
 */
export async function sendPostReaction(
  postId: string,
  type: string,
  wasReacted: boolean
): Promise<PostReactions> {
  await assertNotMuted();
  const result = wasReacted ? await removeReaction(postId) : await addReaction(postId, type);
  return result.reactions;
}

type ReactionsListener = (reactions: PostReactions) => void;
/** Cards listening for reactions given elsewhere, by post id. */
const listeners = new Map<string, Set<ReactionsListener>>();

/**
 * Tells every card showing `postId` the reactions the server answered to a reaction given outside
 * it (the reel viewer). A listener that throws is logged and does not stop the others.
 */
export function publishPostReactions(postId: string, reactions: PostReactions): void {
  for (const listener of listeners.get(postId) ?? []) {
    try {
      listener(reactions);
    } catch (err) {
      console.error(`[post-reaction] a card failed to take the reactions of ${postId}`, err);
    }
  }
}

/** Listens for {@link publishPostReactions} on `postId`. Returns the unsubscribe. */
export function onPostReactions(postId: string, listener: ReactionsListener): () => void {
  let set = listeners.get(postId);
  if (!set) {
    set = new Set();
    listeners.set(postId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(postId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(postId);
  };
}
