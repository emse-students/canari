// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AN ARRIVAL IN AN IDLE WEB WINDOW IS NOT READ ON ARRIVAL (owner, 2026-11-11): visible and focused,
 * with no gesture yet, the conversation counts unread and the notification is owed; one gesture
 * later it is being read again, and two minutes after that gesture it is not.
 */
vi.mock('$lib/utils/appVersion', () => ({ isMobileTauriRuntime: () => false }));
vi.mock('$lib/utils/viewport', () => ({ isNarrowChatLayout: () => false }));

const { isReadingConversationNow, canSeeArrivalNow } = await import('./arrivalRuntime');
const { windowAttention, ATTENTION_WINDOW_MS } = await import('$lib/utils/windowAttention.svelte');

beforeEach(() => {
  // The singleton reads `Date.now`: a fake one, moved by the test.
  vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
  windowAttention.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the web arrival predicate and the attention signal', () => {
  it('is not reading in a window in front nobody has touched, is after a gesture, and lapses', () => {
    window.history.pushState({}, '', '/chat');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');

    expect(isReadingConversationNow('g1', 'g1')).toBe(false);
    expect(canSeeArrivalNow('g1', 'g1')).toBe(false);

    windowAttention.noteGesture();
    expect(isReadingConversationNow('g1', 'g1')).toBe(true);
    expect(canSeeArrivalNow('g1', 'g1')).toBe(true);

    vi.setSystemTime(1_000_000 + ATTENTION_WINDOW_MS);
    expect(isReadingConversationNow('g1', 'g1')).toBe(false);
  });
});
