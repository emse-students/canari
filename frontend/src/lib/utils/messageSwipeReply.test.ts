import {
  canStartReplySwipe,
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

describe('canStartReplySwipe - the gate that was switched off', () => {
  const touching = {
    coarsePointer: true,
    pointerType: 'touch',
    isDeleted: false,
    isSystem: false,
    hasReplyHandler: true,
  };

  it('lets a finger start a swipe on an ordinary message', () => {
    expect(canStartReplySwipe(touching)).toBe(true);
  });

  it('REFUSES when the pointer is not coarse - this is the one that was always false', () => {
    // `MessageBubble` held this as `supportsHover`, initialised to `true` and assigned by nothing,
    // so the gate answered "no" on every device for six months while every function in this file
    // stayed green. The value now comes from `isCoarsePointerDevice()`, and this case is what
    // proves the predicate can say yes at all.
    expect(canStartReplySwipe({ ...touching, coarsePointer: false })).toBe(false);
  });

  it('refuses a mouse even on a machine whose primary pointer is coarse', () => {
    expect(canStartReplySwipe({ ...touching, pointerType: 'mouse' })).toBe(false);
  });

  it('refuses a tombstone, a system notice, and a surface with no reply handler', () => {
    expect(canStartReplySwipe({ ...touching, isDeleted: true })).toBe(false);
    expect(canStartReplySwipe({ ...touching, isSystem: true })).toBe(false);
    expect(canStartReplySwipe({ ...touching, hasReplyHandler: false })).toBe(false);
  });

  it('accepts an event carrying no pointerType at all - a raw TouchEvent has none', () => {
    expect(canStartReplySwipe({ ...touching, pointerType: undefined })).toBe(true);
  });
});
