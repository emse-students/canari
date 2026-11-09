// @vitest-environment happy-dom
/**
 * THE COMPOSER'S LIVE CHIP FOLLOWS THE SERVER'S LIVES KILL SWITCH (`platform_config.lives_mode`,
 * published by `/api/version`): in a build that carries lives, the chip is offered only while the
 * server says `on`, so an estate an admin closed shows no button that could only answer 404.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const ASSOS = vi.hoisted(() => [
  { id: 'asso-speaks', name: 'BDE', slug: 'bde', type: 'association' },
  { id: 'asso-admin-only', name: 'Club', slug: 'club', type: 'association' },
]);
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
  listPostAsAssociations: () => Promise.resolve(ASSOS as unknown as Association[]),
  listLiveAssociations: () => Promise.resolve([ASSOS[0]] as unknown as Association[]),
}));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  createPost: vi.fn(),
  getReelLimits: () =>
    Promise.resolve({
      maxDurationMs: 90_000,
      chatMaxDurationMs: 60_000,
      retentionDays: 30,
      warningWindowDays: 7,
    }),
}));
vi.mock('$lib/components/reels/CameraOverlay.svelte', async () => ({
  default: (await import('../reels/CameraOverlayStub.test-helper.svelte')).default,
}));

import CreatePostForm from './CreatePostForm.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import type { Association } from '$lib/associations/api';
import { emptyPostComposerDraft, savePostComposerDraft } from '$lib/posts/postComposerDraft';
import { setCurrentUserId } from '$lib/stores/userState.svelte';

afterAll(adoptTransitionAnimations());

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

const onGoLive = vi.fn();

async function open(identity = '') {
  if (identity) {
    setCurrentUserId('user-a');
    savePostComposerDraft({ ...emptyPostComposerDraft('x'), selectedAssociationId: identity });
  }
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(CreatePostForm, { target, props: { onPostCreated: vi.fn(), onGoLive } }));
  flushSync();
  for (let i = 0; i < 6; i++) await tick();
  return target;
}

describe('CreatePostForm - the Live chip and the lives kill switch', () => {
  it('offers the chip while the server says on', async () => {
    lives.mode = 'on';
    const target = await open();
    expect(target.querySelector('[data-post-live]')).not.toBeNull();
  });

  it('hands over to the parent instead of stacking the live on the composer', async () => {
    lives.mode = 'on';
    onGoLive.mockClear();
    const target = await open();
    target.querySelector<HTMLButtonElement>('[data-post-live]')!.click();
    expect(onGoLive).toHaveBeenCalledWith({ associationId: null, associationName: null });
  });

  it('offers the chip for an association the server would accept, and hands it over', async () => {
    lives.mode = 'on';
    onGoLive.mockClear();
    const target = await open('asso-speaks');
    target.querySelector<HTMLButtonElement>('[data-post-live]')!.click();
    expect(onGoLive).toHaveBeenCalledWith({ associationId: 'asso-speaks', associationName: 'BDE' });
  });

  it('offers no chip for an association the member may post as but not broadcast as', async () => {
    lives.mode = 'on';
    const target = await open('asso-admin-only');
    expect(target.querySelector('[data-post-live]')).toBeNull();
  });

  it('hides the chip while the server says off', async () => {
    lives.mode = 'off';
    const target = await open();
    expect(target.querySelector('[data-post-live]')).toBeNull();
  });
});
