// @vitest-environment happy-dom
/**
 * "ENTRE ÉTUDIANTS" IN THE COMPOSER (owner, 2026-11-04): one switch, OFF by default, offered while
 * the chosen identity is an association or a list - never an institution, never the member or
 * "anonymous" - with one line under it saying who will and will not see the post; and the payload
 * carries it only where it is offered.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import CreatePostForm from './CreatePostForm.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import { m } from '$lib/paraglide/messages';
import { setCurrentUserId } from '$lib/stores/userState.svelte';
import { emptyPostComposerDraft, savePostComposerDraft } from '$lib/posts/postComposerDraft';
import { cameraOverlayStub } from '../reels/cameraOverlayStub.test-helper';
import type { Association } from '$lib/associations/api';

const ENTITIES = vi.hoisted(() => [
  { id: 'list-1', name: 'Liste Kraken', slug: 'kraken', type: 'list' },
  { id: 'inst-1', name: 'Mines Saint-Étienne', slug: 'emse', type: 'institution' },
]);

vi.mock('$lib/moderation/muteCheck', () => ({ assertNotMuted: () => Promise.resolve() }));
vi.mock('$lib/forms/api', () => ({ getForms: () => Promise.resolve([]) }));
// The composer hands the post to the background publish queue; what it hands over is the assertion.
const enqueuePost = vi.hoisted(() => vi.fn((..._args: unknown[]) => Promise.resolve()));
vi.mock('$lib/posts/publishQueue/publishQueue.svelte', () => ({ enqueuePost }));
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  listLinkableValidatedCalendarEvents: () => Promise.resolve([]),
}));
vi.mock('$lib/posts/postIdentity', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/postIdentity')>()),
  listPostAsAssociations: () => Promise.resolve(ENTITIES as unknown as Association[]),
}));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
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

afterAll(adoptTransitionAnimations());

const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  localStorage.setItem('canari_saved_user', 'user-a');
  setCurrentUserId('user-a');
  enqueuePost.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  localStorage.clear();
});

/** Opens the composer on a draft already speaking as `identity`. */
async function openAs(identity: string) {
  savePostComposerDraft({
    ...emptyPostComposerDraft('la soirée'),
    selectedAssociationId: identity,
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(CreatePostForm, { target, props: { onPostCreated: vi.fn(), onGoLive: vi.fn() } })
  );
  flushSync();
  for (let i = 0; i < 4; i++) await tick();
  return target;
}

const switchOf = (target: HTMLElement) =>
  target.querySelector<HTMLInputElement>('[data-students-only-switch] input[type="checkbox"]');

async function publish(target: HTMLElement) {
  [...target.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent?.trim() === m.post_create_publish_button_label())!
    .click();
  for (let i = 0; i < 6; i++) await tick();
}

describe('CreatePostForm - "Entre étudiants"', () => {
  it('is offered to a list, OFF, saying who will see the post', async () => {
    const target = await openAs('list-1');
    const toggle = switchOf(target);
    expect(toggle).not.toBeNull();
    expect(toggle!.checked).toBe(false);
    expect(target.textContent).toContain(m.post_students_only_hint_off({ name: 'Liste Kraken' }));
    toggle!.click();
    flushSync();
    expect(target.textContent).toContain(m.post_students_only_hint_on({ name: 'Liste Kraken' }));
  });

  it('is sent when on, and absent from the payload when left off', async () => {
    const on = await openAs('list-1');
    switchOf(on)!.click();
    flushSync();
    await publish(on);
    expect((enqueuePost.mock.calls[0][1] as { payload: unknown }).payload).toMatchObject({
      associationId: 'list-1',
      studentsOnly: true,
    });
    unmount(mounted.pop()!);
    document.body.innerHTML = '';
    enqueuePost.mockClear();

    const off = await openAs('list-1');
    await publish(off);
    expect((enqueuePost.mock.calls[0][1] as { payload: unknown }).payload).not.toHaveProperty(
      'studentsOnly'
    );
  });

  it('is not offered to an institution, nor to a personal post', async () => {
    expect(switchOf(await openAs('inst-1'))).toBeNull();
    unmount(mounted.pop()!);
    document.body.innerHTML = '';
    expect(switchOf(await openAs(''))).toBeNull();
  });

  it('goes INTO the reel step: the camera starts from the switch as the composer holds it', async () => {
    const target = await openAs('list-1');
    switchOf(target)!.click();
    flushSync();
    target.querySelector<HTMLButtonElement>('button[data-post-camera]')!.click();
    flushSync();
    expect(cameraOverlayStub.last?.composerStart).toEqual({
      caption: 'la soirée',
      identity: 'list-1',
      studentsOnly: true,
    });
  });

  it('comes BACK from the reel step with "Garder comme post", as the step left it', async () => {
    const target = await openAs('list-1');
    target.querySelector<HTMLButtonElement>('button[data-post-camera]')!.click();
    flushSync();
    cameraOverlayStub.keepWith = { caption: 'la soirée', identity: 'list-1', studentsOnly: true };
    try {
      document.querySelector<HTMLButtonElement>('[data-camera-overlay-stub-keep]')!.click();
      flushSync();
      await tick();
    } finally {
      cameraOverlayStub.keepWith = null;
    }
    expect(switchOf(target)!.checked).toBe(true);
  });
});
