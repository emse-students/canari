// @vitest-environment happy-dom
/**
 * AN ANONYMOUS POST CARRIES NO FORM (2026-11-14): a form names who manages it, and a personal post
 * may only attach a form its author manages, so the form would point to the author the post hides.
 * The server refuses it (`FORM_NOT_ON_ANONYMOUS_POST`); the composer never offers it - no form chip
 * under the anonymous identity, and a form chosen before switching to it is replaced by a note and
 * left out of the publish.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const FORM = vi.hoisted(() => ({
  id: 'form-mine',
  title: 'Gala',
  items: [],
  status: 'published',
  associationId: null,
}));

vi.mock('$lib/moderation/muteCheck', () => ({ assertNotMuted: () => Promise.resolve() }));
vi.mock('$lib/forms/api', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/api')>()),
  getForms: () => Promise.resolve([FORM]),
}));
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  listLinkableValidatedCalendarEvents: () => Promise.resolve([]),
}));
vi.mock('$lib/posts/postIdentity', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/postIdentity')>()),
  listPostAsAssociations: () => Promise.resolve([]),
  listLiveAssociations: () => Promise.resolve([]),
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
import {
  ANONYMOUS_POST_IDENTITY,
  emptyPostComposerDraft,
  savePostComposerDraft,
} from '$lib/posts/postComposerDraft';
import { setCurrentUserId } from '$lib/stores/userState.svelte';
import { m } from '$lib/paraglide/messages';

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

async function open(identity: string, withForm: boolean) {
  setCurrentUserId('user-a');
  savePostComposerDraft({
    ...emptyPostComposerDraft('x'),
    selectedAssociationId: identity,
    ...(withForm ? { includeForm: true, selectedFormId: FORM.id } : {}),
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(CreatePostForm, { target, props: { onPostCreated: vi.fn() } }));
  flushSync();
  for (let i = 0; i < 6; i++) await tick();
  return target;
}

/** The composer bar's form chip, found by its label. */
const formChip = (target: HTMLElement) =>
  [...target.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === m.post_form_fallback_title()
  );

describe('CreatePostForm - an anonymous post carries no form', () => {
  it('offers the form chip to a personal post', async () => {
    const target = await open('', false);
    expect(formChip(target)).toBeDefined();
  });

  it('offers no form chip under the anonymous identity', async () => {
    const target = await open(ANONYMOUS_POST_IDENTITY, false);
    expect(formChip(target)).toBeUndefined();
  });

  it('replaces a form chosen before the switch by a note', async () => {
    const target = await open(ANONYMOUS_POST_IDENTITY, true);
    expect(target.textContent).toContain(m.post_form_not_on_anonymous_note());
    const personal = await open('', true);
    expect(personal.textContent).not.toContain(m.post_form_not_on_anonymous_note());
  });
});
