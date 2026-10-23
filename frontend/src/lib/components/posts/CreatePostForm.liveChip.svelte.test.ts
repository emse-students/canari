// @vitest-environment happy-dom
/**
 * THE COMPOSER'S LIVE CHIP FOLLOWS THE SERVER'S LIVES KILL SWITCH (`platform_config.lives_mode`,
 * published by `/api/version`): in a build that carries lives, the chip is offered only while the
 * server says `on`, so an estate an admin closed shows no button that could only answer 404.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const lives = vi.hoisted(() => ({ mode: 'off' as 'off' | 'on' }));

vi.mock('$lib/features', async (orig) => ({
  ...(await orig<typeof import('$lib/features')>()),
  LIVE_ENABLED: true,
}));
vi.mock('$lib/stores/appVersionCheck.svelte', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/appVersionCheck.svelte')>()),
  serverLivesMode: () => lives.mode,
}));
vi.mock('$lib/moderation/muteCheck', () => ({ assertNotMuted: () => Promise.resolve() }));
vi.mock('$lib/forms/api', () => ({ getForms: () => Promise.resolve([]) }));
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  listLinkableValidatedCalendarEvents: () => Promise.resolve([]),
}));
vi.mock('$lib/posts/postIdentity', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/postIdentity')>()),
  listPostAsAssociations: () => Promise.resolve([]),
}));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  createPost: vi.fn(),
  getReelLimits: () =>
    Promise.resolve({ maxDurationMs: 90_000, retentionDays: 30, warningWindowDays: 7 }),
}));
vi.mock('$lib/components/reels/CameraOverlay.svelte', async () => ({
  default: (await import('../reels/CameraOverlayStub.test-helper.svelte')).default,
}));

import CreatePostForm from './CreatePostForm.svelte';

const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  localStorage.setItem('canari_saved_user', 'user-a');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

async function open() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(CreatePostForm, { target, props: { onPostCreated: vi.fn() } }));
  flushSync();
  await tick();
  return target;
}

describe('CreatePostForm - the Live chip and the lives kill switch', () => {
  it('offers the chip while the server says on', async () => {
    lives.mode = 'on';
    const target = await open();
    expect(target.querySelector('[data-post-live]')).not.toBeNull();
  });

  it('hides the chip while the server says off', async () => {
    lives.mode = 'off';
    const target = await open();
    expect(target.querySelector('[data-post-live]')).toBeNull();
  });
});
