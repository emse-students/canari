import { describe, expect, it } from 'vitest';
import { REPLY_SWIPE_LOCK_PX } from '$lib/utils/messageSwipeReply';
import {
  MAIL_SWIPE_MAX_DRAG_PX,
  MAIL_SWIPE_TRIGGER_PX,
  mailSwipeAction,
  mailSwipeOffset,
  mailSwipePhase,
  mailSwipeSides,
} from './mailGestures';

/** The row swipe as arithmetic: what is drawn before letting go is what letting go does. */

describe('mailSwipeSides', () => {
  it('right archives and left trashes, in an ordinary folder', () => {
    expect(mailSwipeSides('inbox', false)).toEqual({ right: 'archive', left: 'trash' });
    expect(mailSwipeSides(null, false)).toEqual({ right: 'archive', left: 'trash' });
  });

  it('nothing to archive in the archive folder, nothing to trash in the trash or spam', () => {
    expect(mailSwipeSides(null, true)).toEqual({ right: null, left: 'trash' });
    expect(mailSwipeSides('trash', false)).toEqual({ right: 'archive', left: null });
    expect(mailSwipeSides('junk', false)).toEqual({ right: 'archive', left: null });
  });
});

describe('mailSwipePhase', () => {
  it('stays pending under the touch slop, then decides once', () => {
    const under = REPLY_SWIPE_LOCK_PX - 1;
    expect(mailSwipePhase('pending', under, under)).toBe('pending');
    expect(mailSwipePhase('pending', REPLY_SWIPE_LOCK_PX + 2, 1)).toBe('horizontal');
    expect(mailSwipePhase('pending', 2, REPLY_SWIPE_LOCK_PX + 2)).toBe('vertical');
    // A stroke decided vertical (the list's scroll) never becomes a row swipe.
    expect(mailSwipePhase('vertical', 200, 0)).toBe('vertical');
    expect(mailSwipePhase('horizontal', 0, 200)).toBe('horizontal');
  });
});

describe('mailSwipeOffset and mailSwipeAction', () => {
  const sides = mailSwipeSides('inbox', false);

  it('clamps the drawn travel, and arms each side past the trigger only', () => {
    expect(mailSwipeOffset(500, sides)).toBe(MAIL_SWIPE_MAX_DRAG_PX);
    expect(mailSwipeOffset(-500, sides)).toBe(-MAIL_SWIPE_MAX_DRAG_PX);
    expect(mailSwipeAction(MAIL_SWIPE_TRIGGER_PX - 1, sides)).toBeNull();
    expect(mailSwipeAction(MAIL_SWIPE_TRIGGER_PX, sides)).toBe('archive');
    expect(mailSwipeAction(-MAIL_SWIPE_TRIGGER_PX, sides)).toBe('trash');
  });

  it('a side with no action does not move the row, so it can never arm', () => {
    const inTrash = mailSwipeSides('trash', false);
    expect(mailSwipeOffset(-300, inTrash)).toBe(0);
    expect(mailSwipeAction(mailSwipeOffset(-300, inTrash), inTrash)).toBeNull();
    const inArchive = mailSwipeSides(null, true);
    expect(mailSwipeOffset(300, inArchive)).toBe(0);
  });
});
