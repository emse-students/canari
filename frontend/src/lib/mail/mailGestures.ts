import { REPLY_SWIPE_LOCK_PX } from '$lib/utils/messageSwipeReply';
import type { FolderRole } from './mailTypes';

/**
 * THE MAIL LIST'S ROW GESTURES, AS ARITHMETIC (docs/wiki/mail-client-transport.md#as-built---lot-3).
 *
 * A shared gesture is shared as arithmetic (durable rules): the row component only feeds pointer
 * positions in and paints what these functions answer, so what the reader sees before letting go is,
 * by construction, what letting go does - and every mapping is a test.
 *
 * - A swipe RIGHT archives (the row slides off and "Archiver" is revealed under it), a swipe LEFT
 *   puts the conversation in the trash - the conventional mapping of the big mail apps.
 * - In the archive folder a right swipe has nothing to do; in the trash and junk folders a left swipe
 *   has nothing to do (deleting for good is a deliberate press, never a slip of the thumb).
 * - The stroke's direction is decided ONCE, under the engines' touch slop
 *   ({@link REPLY_SWIPE_LOCK_PX}, the reply swipe's measured value): a mostly vertical stroke is the
 *   list's scroll and never moves a row.
 */

/** What a completed swipe does. */
export type MailSwipeAction = 'archive' | 'trash';

/** Horizontal travel past which letting go acts. */
export const MAIL_SWIPE_TRIGGER_PX = 96;
/** Past this the row stops following the finger (it is armed long before). */
export const MAIL_SWIPE_MAX_DRAG_PX = 160;

/** Where a stroke stands. */
export type MailSwipePhase = 'pending' | 'horizontal' | 'vertical';

/** The two actions a list's rows offer, by side, for the folder listed. */
export interface MailSwipeSides {
  right: MailSwipeAction | null;
  left: MailSwipeAction | null;
}

/** The actions the rows of a folder offer (`isArchive`: the archive folder is listed). */
export function mailSwipeSides(role: FolderRole | null, isArchive: boolean): MailSwipeSides {
  return {
    right: isArchive ? null : 'archive',
    left: role === 'trash' || role === 'junk' ? null : 'trash',
  };
}

/** The phase after a move of (`dx`, `dy`) from the stroke's start. Decided once, then kept. */
export function mailSwipePhase(phase: MailSwipePhase, dx: number, dy: number): MailSwipePhase {
  if (phase !== 'pending') return phase;
  if (Math.abs(dx) < REPLY_SWIPE_LOCK_PX && Math.abs(dy) < REPLY_SWIPE_LOCK_PX) return 'pending';
  return Math.abs(dy) > Math.abs(dx) ? 'vertical' : 'horizontal';
}

/** The row's drawn offset for a horizontal travel `dx`: 0 toward a side with no action. */
export function mailSwipeOffset(dx: number, sides: MailSwipeSides): number {
  if (dx > 0 && sides.right === null) return 0;
  if (dx < 0 && sides.left === null) return 0;
  return Math.max(-MAIL_SWIPE_MAX_DRAG_PX, Math.min(MAIL_SWIPE_MAX_DRAG_PX, dx));
}

/** The action letting go NOW does, for a drawn offset; `null` while it is not armed. */
export function mailSwipeAction(offset: number, sides: MailSwipeSides): MailSwipeAction | null {
  if (offset >= MAIL_SWIPE_TRIGGER_PX) return sides.right;
  if (offset <= -MAIL_SWIPE_TRIGGER_PX) return sides.left;
  return null;
}
