// @vitest-environment happy-dom
/**
 * "Mes notes" is titled with the own name and a suffix: with the own name not resolved yet the header
 * must neither double the suffix (the title it was handed is already complete) nor draw " (Notes)".
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { writable } from 'svelte/store';
import ChatHeader from './ChatHeader.svelte';

vi.mock('$lib/mobile/glassChrome', () => ({ usesGlassChrome: () => false }));
vi.mock('$lib/stores/presenceStore', () => ({
  presenceMap: writable({}),
  watchUsers: () => {},
  unwatchUsers: () => {},
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: () => 'Camille DUPONT',
  resolveUserDisplayName: async () => null,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplay: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplay: () => {},
}));
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());
afterEach(() => {
  document.body.innerHTML = '';
});

describe('ChatHeader on "Mes notes"', () => {
  it('names it once with the own name, whatever title the page handed down', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(ChatHeader, {
      target,
      props: {
        contactName: '',
        displayName: 'Camille DUPONT (Notes)',
        isReady: true,
        isSelfConversation: true,
        currentUserId: 'me',
      },
    });
    flushSync();
    const heading = document.querySelector('header h2')!.textContent!.trim();
    expect(heading).toBe('Camille DUPONT (Notes)');
    unmount(app);
  });
});
