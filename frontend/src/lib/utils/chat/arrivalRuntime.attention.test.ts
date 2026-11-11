// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * AN ARRIVAL IN AN IDLE WEB WINDOW IS NOT READ ON ARRIVAL (owner, 2026-11-11): visible and focused,
 * with no gesture yet, the conversation counts unread and the notification is owed; one gesture
 * later it is being read again.
 */
vi.mock('$lib/utils/appVersion', () => ({ isMobileTauriRuntime: () => false }));
vi.mock('$lib/utils/viewport', () => ({ isNarrowChatLayout: () => false }));

const { isReadingConversationNow, canSeeArrivalNow } = await import('./arrivalRuntime');
const { windowAttention } = await import('$lib/utils/windowAttention.svelte');

afterEach(() => vi.restoreAllMocks());

describe('the web arrival predicate and the attention signal', () => {
  it('is not reading in a visible, focused window nobody has touched, and is after a gesture', () => {
    window.history.pushState({}, '', '/chat');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');

    expect(isReadingConversationNow('g1', 'g1')).toBe(false);
    expect(canSeeArrivalNow('g1', 'g1')).toBe(false);

    windowAttention.noteGesture();
    expect(isReadingConversationNow('g1', 'g1')).toBe(true);
    expect(canSeeArrivalNow('g1', 'g1')).toBe(true);
  });
});
