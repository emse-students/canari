// @vitest-environment happy-dom
/**
 * THE REACH OF AN INSTITUTION POST, EDITED AFTER PUBLISHING (owner, 2026-11-10: both ways): the
 * form starts from the served reach, a changed and complete reach is sent, an incomplete one holds
 * the save, and an untouched one is never named - absent leaves the stored reach alone.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import EditPostForm from './EditPostForm.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import { m } from '$lib/paraglide/messages';
import type { PostEntity } from '$lib/posts/api';
import type { InstitutionReach } from '$lib/posts/institutionReach';

const updatePost = vi.hoisted(() =>
  vi.fn((_id: string, _payload: unknown) => Promise.resolve({ id: 'p1' }))
);
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  updatePost,
  getInstitutionReachOptions: () =>
    Promise.resolve({
      spaces: [
        { formation: 'ICM', campus: 'saint-etienne' },
        { formation: 'ISMIN', campus: 'saint-etienne' },
      ],
    }),
}));
vi.mock('$lib/stores/auth', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/auth')>()),
  getToken: () => Promise.resolve('tok'),
}));
vi.mock('$lib/forms/api', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/api')>()),
  getForms: () => Promise.resolve([]),
  getForm: () => Promise.resolve(null),
}));
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  listLinkableValidatedCalendarEvents: () => Promise.resolve([]),
}));

afterAll(adoptTransitionAnimations());

const mounted: Record<string, unknown>[] = [];

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  updatePost.mockClear();
});

async function open(reach: InstitutionReach | null) {
  const post = {
    id: 'p1',
    markdown: 'le communiqué',
    mentions: [],
    links: [],
    media: [],
    images: [],
    polls: [],
    associationId: 'inst-1',
    association: { id: 'inst-1', name: 'Mines', slug: 'emse', logoUrl: null, type: 'institution' },
    reach,
    createdAt: new Date().toISOString(),
    publishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as PostEntity;
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(EditPostForm, { target, props: { post, onSaved: vi.fn(), onCancel: vi.fn() } })
  );
  flushSync();
  for (let i = 0; i < 6; i++) await tick();
  return target;
}

const save = (target: HTMLElement) =>
  [...target.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === m.post_edit_save_button()
  )!;

function press(target: HTMLElement, selector: string) {
  target.querySelector<HTMLInputElement>(selector)!.click();
  flushSync();
}

async function submit(target: HTMLElement) {
  save(target).click();
  for (let i = 0; i < 6; i++) await tick();
}

describe('EditPostForm - the reach of an institution post', () => {
  it('starts from the served reach, and leaves it out of a save that did not change it', async () => {
    const target = await open({
      spaces: [{ formation: 'ICM', campus: 'saint-etienne' }],
      public: 'students',
    });
    expect(
      target.querySelector<HTMLInputElement>('[data-reach-space="ICM|saint-etienne"]')?.checked
    ).toBe(true);
    expect(target.querySelector<HTMLInputElement>('[data-reach-public="students"]')?.checked).toBe(
      true
    );
    await submit(target);
    expect(updatePost.mock.calls[0][1]).not.toHaveProperty('reach');
  });

  it('widens it, and holds the save while the choice is incomplete', async () => {
    const target = await open({
      spaces: [{ formation: 'ICM', campus: 'saint-etienne' }],
      public: 'students',
    });
    press(target, '[data-reach-space="ICM|saint-etienne"]');
    expect(save(target).disabled).toBe(true);
    press(target, '[data-reach-campus="saint-etienne"]');
    press(target, '[data-reach-public="all"]');
    expect(save(target).disabled).toBe(false);
    await submit(target);
    expect(updatePost.mock.calls[0][1]).toMatchObject({
      reach: {
        spaces: [
          { formation: 'ICM', campus: 'saint-etienne' },
          { formation: 'ISMIN', campus: 'saint-etienne' },
        ],
        public: 'all',
      },
    });
  });

  it('a ticked space the audience no longer holds is pruned by the picker, and that alone sends no reach', async () => {
    const target = await open({
      spaces: [
        { formation: 'ICM', campus: 'saint-etienne' },
        { formation: 'ISMIN', campus: 'gardanne' },
      ],
      public: 'all',
    });
    // The picker dropped ISMIN|gardanne on its own: not the author's choice (review of #3314).
    expect(target.querySelector('[data-reach-space="ISMIN|gardanne"]')).toBeNull();
    await submit(target);
    expect(updatePost.mock.calls[0][1]).not.toHaveProperty('reach');
  });

  it('on a post published before the reach existed, saves without one until a choice is complete', async () => {
    const target = await open(null);
    expect(target.querySelector('[data-institution-reach-picker]')).not.toBeNull();
    expect(save(target).disabled).toBe(false);
    await submit(target);
    expect(updatePost.mock.calls[0][1]).not.toHaveProperty('reach');
  });
});
