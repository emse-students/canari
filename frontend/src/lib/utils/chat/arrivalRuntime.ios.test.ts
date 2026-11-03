// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * ON AN iPHONE, A CONVERSATION LEFT OPEN IS NOT "BEING READ" ONCE THE APP IS OFF SCREEN (2026-11-02).
 *
 * The mobile branch of `arrivalContextNow` asks `isAppInForeground()`, which answered `true` on iOS
 * for ever because the shell never wrote the flag: a frame processed in the seconds before
 * suspension counted as read on arrival. The shell now writes it (`canari_ios.mm`,
 * `appForeground.contract.test.ts`); this pins what the page then decides from it.
 */
vi.mock('$lib/utils/appVersion', () => ({ isMobileTauriRuntime: () => true }));
vi.mock('$lib/utils/viewport', () => ({ isNarrowChatLayout: () => true }));

const { isReadingConversationNow, conversationBeingRead } = await import('./arrivalRuntime');

const setFlag = (v: boolean) => {
  (window as unknown as Record<string, unknown>).__canariForeground = v;
};

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__canariForeground;
});

describe('an iOS app and the conversation left open', () => {
  it('is read while on screen, and not once the shell says it left', () => {
    window.history.pushState({}, '', '/chat');
    setFlag(true);
    expect(isReadingConversationNow('g1', 'g1')).toBe(true);
    expect(conversationBeingRead('g1')).toBe('g1');

    setFlag(false);
    expect(isReadingConversationNow('g1', 'g1')).toBe(false);
    expect(conversationBeingRead('g1')).toBeNull();
  });
});
