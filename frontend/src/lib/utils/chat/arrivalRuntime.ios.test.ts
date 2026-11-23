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

const { isReadingConversationNow, conversationBeingRead, canSeeArrivalNow } =
  await import('./arrivalRuntime');

const setFlag = (v: boolean) => {
  (window as unknown as Record<string, unknown>).__canariForeground = v;
};

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__canariForeground;
  delete (window as unknown as Record<string, unknown>).__canariActive;
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

/**
 * THE APP IS NO LONGER IN FRONT OF THE READER AT `willResignActive`, NOT AT `didEnterBackground`
 * (iPhone 12, `1.8.0-alpha.1`, dev logs): a frame routed and ACKed eight seconds before the page's own
 * `disconnect` - the home gesture had left the app inactive while it was still "in the foreground".
 * ACKed, it was owed no push; judged seen, it raised no notification. Announced zero times.
 */
describe('an iOS app that is no longer active', () => {
  const setActive = (v: boolean) => {
    (window as unknown as Record<string, unknown>).__canariActive = v;
  };

  it('owes the notification for an arrival it holds the socket for, the conversation open or not', () => {
    window.history.pushState({}, '', '/chat');
    setFlag(true);
    setActive(true);
    expect(canSeeArrivalNow('g1', 'g1')).toBe(true);
    expect(canSeeArrivalNow('g2', '')).toBe(true);

    setActive(false);
    expect(canSeeArrivalNow('g1', 'g1')).toBe(false);
    expect(canSeeArrivalNow('g2', '')).toBe(false);
  });

  it('does not read on arrival, and reads again once active - a fact, not a clock', () => {
    window.history.pushState({}, '', '/chat');
    setFlag(true);
    setActive(false);
    expect(isReadingConversationNow('g1', 'g1')).toBe(false);
    expect(conversationBeingRead('g1')).toBeNull();

    setActive(true);
    expect(isReadingConversationNow('g1', 'g1')).toBe(true);
  });

  it('is in front wherever no shell writes the flag (Android: its onPause already ends the foreground)', () => {
    window.history.pushState({}, '', '/chat');
    setFlag(true);
    expect(canSeeArrivalNow('g1', 'g1')).toBe(true);
  });
});
