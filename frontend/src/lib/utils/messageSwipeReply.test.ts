import {
  replySwipeDragOffset,
  shouldTriggerReplySwipe,
  updateReplySwipeGesture,
} from './messageSwipeReply';

describe('messageSwipeReply', () => {
  it('locks horizontal gesture', () => {
    const state = updateReplySwipeGesture({ startX: 0, startY: 0, phase: 'pending' }, 30, 2);
    expect(state.phase).toBe('horizontal');
  });

  it('triggers reply on inbound swipe right', () => {
    expect(shouldTriggerReplySwipe(60, 4, false, 'horizontal')).toBe(true);
    expect(replySwipeDragOffset(40, false)).toBe(40);
  });

  it('triggers reply on own message swipe left', () => {
    expect(shouldTriggerReplySwipe(-60, 4, true, 'horizontal')).toBe(true);
    expect(replySwipeDragOffset(-40, true)).toBe(-40);
  });

  it('ignores wrong-direction swipes', () => {
    expect(replySwipeDragOffset(40, true)).toBeNull();
    expect(shouldTriggerReplySwipe(60, 4, true, 'horizontal')).toBe(false);
  });
});
