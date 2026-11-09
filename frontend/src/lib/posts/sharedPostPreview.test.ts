import { describe, it, expect, vi, beforeEach } from 'vitest';

const getPost = vi.fn();
vi.mock('$lib/posts/api', () => ({
  getPost: (id: string) => getPost(id),
  isReel: (p: { kind?: string }) => p.kind === 'reel',
}));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'viewer-1' }));
vi.mock('$lib/paraglide/messages', () => ({ m: { post_anonymous_label: () => 'Anonyme' } }));

import {
  clearSharedPostPreviews,
  fetchSharedPostPreview,
  sharedPostAspect,
  sharedPostReady,
  SHARED_REEL_ASPECT,
} from './sharedPostPreview';

const image = { type: 'image', mediaId: 'm1', width: 800, height: 800 };

function post(over: Record<string, unknown> = {}) {
  return { id: 'p1', markdown: 'Hello **world**', media: [], authorFirstName: 'Ada', ...over };
}

beforeEach(() => {
  getPost.mockReset();
  clearSharedPostPreviews();
});

describe('sharedPostReady', () => {
  it('takes the first picture and a plain caption', () => {
    const r = sharedPostReady(post({ media: [image] }) as never);
    expect(r.mediaKind).toBe('image');
    expect(r.caption).toBe('Hello world');
    expect(r.authorName).toBe('Ada');
    expect(r.isReel).toBe(false);
  });

  it('is text-only when the first media is a file', () => {
    const r = sharedPostReady(post({ media: [{ type: 'file', mediaId: 'f' }] }) as never);
    expect(r.media).toBeNull();
  });

  it('makes a reel the tall card and hands its post to the viewer', () => {
    const r = sharedPostReady(
      post({
        kind: 'reel',
        media: [{ type: 'video', mediaId: 'v', width: 1920, height: 1080 }],
      }) as never
    );
    expect(r.aspect).toBe(SHARED_REEL_ASPECT);
    expect(r.reelPost?.id).toBe('p1');
  });

  it('names an anonymous post "Anonyme", never its author', () => {
    const r = sharedPostReady(post({ anonymous: true, authorFirstName: 'Ada' }) as never);
    expect(r.authorName).toBe('Anonyme');
  });
});

describe('sharedPostAspect', () => {
  it('clamps a panorama and a very tall picture to the feed crop', () => {
    expect(sharedPostAspect(false, { width: 4000, height: 500 })).toBeCloseTo(16 / 9);
    expect(sharedPostAspect(false, { width: 500, height: 4000 })).toBeCloseTo(4 / 5);
    expect(sharedPostAspect(false, {})).toBe(1);
  });
});

describe('fetchSharedPostPreview', () => {
  it('reads a post once however many bubbles ask, and caches it', async () => {
    getPost.mockResolvedValue(post());
    const [a, b] = await Promise.all([fetchSharedPostPreview('p1'), fetchSharedPostPreview('p1')]);
    await fetchSharedPostPreview('p1');
    expect(a).toBe(b);
    expect(getPost).toHaveBeenCalledTimes(1);
  });

  it('caches a verdict (404) as unavailable and carries nothing of the post', async () => {
    const { ApiRefusalError } = await import('$lib/utils/apiRefusalError');
    getPost.mockRejectedValue(new ApiRefusalError(404, null, 'gone'));
    expect(await fetchSharedPostPreview('p2')).toEqual({ state: 'unavailable' });
    await fetchSharedPostPreview('p2');
    expect(getPost).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a failure that is no verdict: the next mount asks again', async () => {
    getPost.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(post());
    expect((await fetchSharedPostPreview('p3')).state).toBe('unavailable');
    expect((await fetchSharedPostPreview('p3')).state).toBe('ready');
  });
});
