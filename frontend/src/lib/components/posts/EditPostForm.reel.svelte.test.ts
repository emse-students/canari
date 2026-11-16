// @vitest-environment happy-dom
/**
 * A REEL'S CAPTION IS THE ONLY THING ITS EDIT SENDS (docs/wiki/services/reels.md): the form used to
 * send the reel's own video back as `media`, and the server answers that with a 400. An ordinary post
 * with media still sends its media.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import EditPostForm from './EditPostForm.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import { m } from '$lib/paraglide/messages';
import type { PostEntity } from '$lib/posts/api';

const updatePost = vi.hoisted(() =>
  vi.fn((_id: string, _payload: unknown) => Promise.resolve({ id: 'p1' }))
);
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  updatePost,
  getInstitutionReachOptions: () => Promise.resolve({ spaces: [] }),
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

const video = {
  mediaId: 'm1',
  iv: 'iv',
  key: 'k',
  type: 'video',
  mimeType: 'video/mp4',
  width: 720,
  height: 1280,
};

async function open(kind: 'reel' | 'post') {
  const post = {
    id: 'p1',
    kind,
    markdown: 'legende',
    mentions: [],
    links: [],
    // An ordinary post's strip would fetch a video's thumbnail: a document draws from its metadata.
    media:
      kind === 'reel'
        ? [video]
        : [
            {
              mediaId: 'f1',
              iv: 'iv',
              key: 'k',
              type: 'file',
              mimeType: 'application/pdf',
              fileName: 'a.pdf',
            },
          ],
    images: [],
    polls: [],
    createdAt: new Date().toISOString(),
    publishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as PostEntity;
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(EditPostForm, { target, props: { post, onSaved: vi.fn(), onCancel: vi.fn() } })
  );
  flushSync();
  for (let i = 0; i < 6; i++) await tick();
  return target;
}

async function save(target: HTMLElement) {
  [...target.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent?.trim() === m.post_edit_save_button())!
    .click();
  for (let i = 0; i < 6; i++) await tick();
}

describe('EditPostForm - a reel', () => {
  it('sends the caption alone: no media, no schedule, no form, no poll', async () => {
    const target = await open('reel');
    await save(target);
    const payload = updatePost.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).toEqual({ markdown: 'legende' });
    expect(target.querySelector('[role="list"]')).toBeNull();
    expect(target.querySelector('[data-chip-row]')).toBeNull();
  });

  it('keeps sending the media of an ordinary post', async () => {
    const target = await open('post');
    await save(target);
    const payload = updatePost.mock.calls[0][1] as { media?: unknown[] };
    expect(payload.media).toHaveLength(1);
    expect(target.querySelector('[data-chip-row]')).not.toBeNull();
  });
});
