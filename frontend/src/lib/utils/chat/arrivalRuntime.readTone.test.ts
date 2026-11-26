// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE READ TRILL FOLLOWS THE SCREEN, NOT THE SELECTION: `selectedContact` stays set when the reader
 * leaves the chat route, so a read mark arriving over a feed or a profile must stay silent.
 */
vi.mock('$lib/utils/appVersion', () => ({ isMobileTauriRuntime: () => false }));
vi.mock('$lib/utils/viewport', () => ({ isNarrowChatLayout: () => false }));

const { readToneOwed } = await import('./arrivalRuntime');
const { windowAttention } = await import('$lib/utils/windowAttention.svelte');

beforeEach(() => {
  windowAttention.reset();
  windowAttention.noteGesture();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readToneOwed', () => {
  it('plays for another reader in the conversation on screen', () => {
    window.history.pushState({}, '', '/chat');
    expect(readToneOwed('bob', 'me', 'g1', 'g1')).toBe(true);
  });

  it('stays silent once the reader navigated away while the conversation stays selected', () => {
    window.history.pushState({}, '', '/chat');
    expect(readToneOwed('bob', 'me', 'g1', 'g1')).toBe(true);
    window.history.pushState({}, '', '/feed');
    expect(readToneOwed('bob', 'me', 'g1', 'g1')).toBe(false);
  });

  it('stays silent for a read on another conversation and for my own read', () => {
    window.history.pushState({}, '', '/chat');
    expect(readToneOwed('bob', 'me', 'g2', 'g1')).toBe(false);
    expect(readToneOwed('me', 'me', 'g1', 'g1')).toBe(false);
  });
});
