// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * THE SALON A SERVER COUNT LEAVES ALONE IS THE ONE BEING READ, NOT THE ONE SELECTED (2026-11-02).
 *
 * Both halves, in a document: kept when it is selected, on screen and on a messaging route; handed
 * to the server's count in every other case - which is what corrects a badge for a salon read on
 * another device while this one was offline.
 */
vi.mock('$lib/utils/appVersion', () => ({ isMobileTauriRuntime: () => false }));
vi.mock('$lib/utils/viewport', () => ({ isNarrowChatLayout: () => false }));

const { conversationBeingRead } = await import('./arrivalRuntime');
const { reconcileSalonUnread, beginUnreadReconcile, resetSalonUnread } =
  await import('./salonUnread');

afterEach(() => vi.restoreAllMocks());

function screen(path: string, focused: boolean, visibility: 'visible' | 'hidden') {
  window.history.pushState({}, '', path);
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(visibility);
}

/** One salon the device counts 3 in, the server 0: what a read on another device leaves. */
function applyServerZero(selectedId: string | null) {
  resetSalonUnread();
  const conversations = new Map<string, any>([
    ['channel_s1', { id: 'channel_s1', unreadCount: 3, readWatermarks: {}, messages: [] }],
  ]);
  const token = beginUnreadReconcile();
  reconcileSalonUnread(conversations, { asOf: 5000, counts: {} }, selectedId, 'me', token);
  return conversations.get('channel_s1').unreadCount;
}

describe('conversationBeingRead', () => {
  it('keeps the salon selected, on screen and on a messaging route - its receipt effect owns it', () => {
    screen('/communities', true, 'visible');
    expect(conversationBeingRead('channel_s1')).toBe('channel_s1');
    expect(applyServerZero(conversationBeingRead('channel_s1'))).toBe(3);
  });

  it.each([
    ['on another page', '/posts', true, 'visible'],
    ['in an unfocused window', '/communities', false, 'visible'],
    ['in a hidden tab', '/communities', true, 'hidden'],
  ] as const)(
    'hands the salon to the server count when it is selected but %s',
    (_, path, focused, vis) => {
      screen(path, focused, vis);
      expect(conversationBeingRead('channel_s1')).toBeNull();
      expect(applyServerZero(conversationBeingRead('channel_s1'))).toBe(0);
    }
  );

  it('is null with nothing selected', () => {
    screen('/communities', true, 'visible');
    expect(conversationBeingRead(null)).toBeNull();
  });
});
