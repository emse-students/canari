// @vitest-environment happy-dom
/**
 * A viewer that throws while it mounts must still give the live's sound session back: "a live is open"
 * would otherwise stay true for good and no sound choice would be saved again (round-3 review,
 * 2026-11-19). The release is the teardown of an effect created at init, so the destroyed branch runs it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import LiveViewerBoundary from './LiveViewerBoundary.test-helper.svelte';
import { VIDEO_SOUND_KEY, videoSound } from '$lib/stores/videoSound.svelte';
import type { LiveLimits, LiveListItem } from '$lib/live/types';

vi.mock('./LiveReactionBar.svelte', () => ({
  default: () => {
    throw new Error('boom');
  },
}));
vi.mock('$lib/components/shared/Avatar.svelte', async () => ({
  default: (await import('../reels/AvatarStub.test-helper.svelte')).default,
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: () => '',
  resolveUserDisplayName: async () => 'Ada',
}));
vi.mock('$lib/utils/historyOverlayStack', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/historyOverlayStack')>()),
  pushHistoryOverlay: vi.fn(),
}));

const LIVE: LiveListItem = {
  id: '0b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b',
  broadcasterId: 'u1',
  associationId: null,
  startedAt: '2026-10-19T10:00:00.000Z',
};

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, 'userActivation', {
    value: { hasBeenActive: true },
    configurable: true,
  });
});
afterEach(() => {
  Reflect.deleteProperty(navigator, 'userActivation');
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('LiveViewer whose template throws', () => {
  it('releases the live session, so a sound choice is written again', async () => {
    videoSound.setMuted(false);
    const start = vi.spyOn(videoSound, 'startForLive');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(LiveViewerBoundary, {
      target,
      props: {
        live: LIVE,
        onClose: vi.fn(),
        fetchLimits: async () =>
          ({ chatMessageMaxChars: 300, reactionTapsPerWindow: 10 }) as LiveLimits,
      },
    });
    await Promise.resolve();
    expect(start, 'the live session was taken').toHaveBeenCalled();
    expect(
      document.querySelector('[data-boundary-failed]'),
      'the boundary caught it'
    ).not.toBeNull();
    videoSound.setMuted(true);
    expect(localStorage.getItem(VIDEO_SOUND_KEY), 'a choice is written again').toBe('off');
    unmount(app);
  });
});
