import { DOUBLE_TAP_REACTION } from '$lib/posts/postReaction';

/**
 * WHAT THE CANAREELS RAIL'S HEART MEANS (user, 2026-10-19: Instagram's rail - like, comment, send).
 *
 * A Canari post carries reactions of several kinds, one per reader, and the rail has room for one
 * heart. So the heart says "I reacted": it is FILLED when the reader holds a reaction of any kind,
 * its number is every reaction on the post, and a tap on it takes the reader's reaction back if
 * they have one and gives "J'aime" if they do not. Changing to another kind stays the card's picker.
 * A double tap (`doubleTapLike`, PR #2113) only ever gives "J'aime" and never takes one back.
 */

/**
 * What the rail's three buttons do, and who is reading: handed by the viewer (`ReelViewer`) to each
 * page (`ReelSlide`). Absent - a conversation's reel, which is not a post - no rail is drawn.
 */
export interface ReelRailActions {
  readerId: string;
  onHeart: () => void;
  /** The reader picked a reaction in the heart's drawer (long press): the card's toggle of that kind. */
  onReact: (type: string) => void;
  onComments: () => void;
  onSend: () => void;
}

/** The reaction a tap on the heart sends, and whether it is a removal: the input of `toggledReactions`. */
export function railHeartToggle(
  reactions: Record<string, string>,
  userId: string
): { type: string; wasReacted: boolean } {
  const mine = reactions[userId];
  return mine ? { type: mine, wasReacted: true } : { type: DOUBLE_TAP_REACTION, wasReacted: false };
}

/** The input of `toggledReactions` for a pick in the drawer: the same kind again takes it back. */
export function pickedReactionToggle(
  reactions: Record<string, string>,
  userId: string,
  type: string
): { type: string; wasReacted: boolean } {
  return { type, wasReacted: reactions[userId] === type };
}

/** Every reaction on the post: the heart's number. */
export function reactionTotal(reactions: Record<string, string> | undefined): number {
  return Object.keys(reactions ?? {}).length;
}

/**
 * A count as the rail prints it: `1,2 k` / `1.2K` past a thousand, in the reader's language, as
 * Instagram prints `131K` under its heart. Zero prints nothing - an empty heart says it.
 */
export function compactCount(count: number, locale: string): string {
  if (count <= 0) return '';
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(
    count
  );
}
