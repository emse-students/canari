// @vitest-environment happy-dom
/**
 * THE REACH OF AN INSTITUTION'S POST IN THE COMPOSER (owner, 2026-11-10): offered while the chosen
 * identity is an institution and nowhere else, with NOTHING pre-selected - "Publier" stays disabled
 * until a space and a public are chosen, a line says what is missing, then who will see the post;
 * the campus chip ticks the whole campus; the payload carries the reach only where it is offered.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import CreatePostForm from './CreatePostForm.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import { m } from '$lib/paraglide/messages';
import { setCurrentUserId } from '$lib/stores/userState.svelte';
import { emptyPostComposerDraft, savePostComposerDraft } from '$lib/posts/postComposerDraft';
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
  listLiveAssociations: () => Promise.resolve([]),
}));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  getInstitutionReachOptions: () =>
    Promise.resolve({
      spaces: [
        { formation: 'ICM', campus: 'saint-etienne' },
        { formation: 'ISMIN', campus: 'saint-etienne' },
        { formation: 'ISMIN', campus: 'gardanne' },
      ],
    }),
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
    ...emptyPostComposerDraft('le communiqué'),
    selectedAssociationId: identity,
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(CreatePostForm, { target, props: { onPostCreated: vi.fn(), onGoLive: vi.fn() } })
  );
  flushSync();
  for (let i = 0; i < 6; i++) await tick();
  return target;
}

const publishButton = (target: HTMLElement) =>
  [...target.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === m.post_create_publish_button_label()
  )!;

/** The chips of `selector` whose input is checked. */
const ticked = (target: HTMLElement, selector: string) =>
  [...target.querySelectorAll<HTMLInputElement>(selector)].filter((i) => i.checked);

function press(target: HTMLElement, selector: string) {
  target.querySelector<HTMLInputElement>(selector)!.click();
  flushSync();
}

describe('CreatePostForm - the reach of an institution post', () => {
  it('is offered to an institution, with nothing chosen and "Publier" disabled', async () => {
    const target = await openAs('inst-1');
    expect(target.querySelector('[data-institution-reach-picker]')).not.toBeNull();
    expect(ticked(target, '[data-reach-space]')).toHaveLength(0);
    expect(ticked(target, '[data-reach-public]')).toHaveLength(0);
    expect(target.querySelector('[data-reach-hint]')?.textContent?.trim()).toBe(
      m.post_reach_missing_both()
    );
    expect(publishButton(target).disabled).toBe(true);
  });

  it('enables "Publier" only once a space AND a public are chosen, and says who will see it', async () => {
    const target = await openAs('inst-1');
    press(target, '[data-reach-space="ICM|saint-etienne"]');
    expect(target.querySelector('[data-reach-hint]')?.textContent?.trim()).toBe(
      m.post_reach_missing_public()
    );
    expect(publishButton(target).disabled).toBe(true);
    press(target, '[data-reach-public="students"]');
    expect(target.querySelector('[data-reach-hint]')?.textContent?.trim()).toBe(
      m.post_reach_hint_students({ name: 'Mines Saint-Étienne' })
    );
    expect(publishButton(target).disabled).toBe(false);
  });

  it('a campus chip ticks and unticks the whole campus; a shared formation has its own chip', async () => {
    const target = await openAs('inst-1');
    press(target, '[data-reach-campus="saint-etienne"]');
    expect(
      [...ticked(target, '[data-reach-space]')].map((b) => b.getAttribute('data-reach-space'))
    ).toEqual(['ICM|saint-etienne', 'ISMIN|saint-etienne']);
    press(target, '[data-reach-campus="saint-etienne"]');
    expect(ticked(target, '[data-reach-space]')).toHaveLength(0);
    // ISMIN is on both campuses, ICM on one: only ISMIN earns a whole-formation chip.
    expect(target.querySelector('[data-reach-formation="ICM"]')).toBeNull();
    press(target, '[data-reach-formation="ISMIN"]');
    expect(
      [...ticked(target, '[data-reach-space]')].map((b) => b.getAttribute('data-reach-space'))
    ).toEqual(['ISMIN|saint-etienne', 'ISMIN|gardanne']);
  });

  it('sends the reach chosen with the post', async () => {
    const target = await openAs('inst-1');
    press(target, '[data-reach-space="ISMIN|gardanne"]');
    press(target, '[data-reach-public="staff"]');
    publishButton(target).click();
    for (let i = 0; i < 6; i++) await tick();
    expect((enqueuePost.mock.calls[0][1] as { payload: unknown }).payload).toMatchObject({
      associationId: 'inst-1',
      reach: { spaces: [{ formation: 'ISMIN', campus: 'gardanne' }], public: 'staff' },
    });
  });

  it('is offered to no association, list or personal post, and never sent from one', async () => {
    const list = await openAs('list-1');
    expect(list.querySelector('[data-institution-reach-picker]')).toBeNull();
    publishButton(list).click();
    for (let i = 0; i < 6; i++) await tick();
    expect((enqueuePost.mock.calls[0][1] as { payload: unknown }).payload).not.toHaveProperty(
      'reach'
    );
    unmount(mounted.pop()!);
    document.body.innerHTML = '';
    expect((await openAs('')).querySelector('[data-institution-reach-picker]')).toBeNull();
  });
});
