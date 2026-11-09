import { describe, it, expect, vi, beforeEach } from 'vitest';

const getPost = vi.fn();
vi.mock('$lib/posts/api', () => ({
  getPost: (id: string) => getPost(id),
  isReel: (p: { kind?: string }) => p.kind === 'reel',
}));
let viewer: string | null = 'viewer-1';
vi.mock('$lib/stores/user', () => ({ currentUserId: () => viewer }));
vi.mock('$lib/paraglide/messages', () => ({ m: { post_anonymous_label: () => 'Anonyme' } }));
vi.mock('$lib/utils/users/displayName', () => ({ getUserDisplayNameSync: () => 'Utilisateur' }));

import {
  cachedSharedPostPreview,
  clearSharedPostPreviews,
  fetchSharedPostPreview,
  sharedPostAspect,
  sharedPostReady,
  SHARED_REEL_ASPECT,
} from './sharedPostPreview';

const image = { type: 'image', mediaId: 'm1', width: 800, height: 800 };
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const P3 = '33333333-3333-4333-8333-333333333333';

function post(over: Record<string, unknown> = {}) {
  return { id: P1, markdown: 'Hello **world**', media: [], authorFirstName: 'Ada', ...over };
}

beforeEach(() => {
  viewer = 'viewer-1';
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
    expect(r.reelPost?.id).toBe(P1);
  });

  it('names an anonymous post "Anonyme", never its author', () => {
    const r = sharedPostReady(post({ anonymous: true, authorFirstName: 'Ada' }) as never);
    expect(r.authorName).toBe('Anonyme');
  });

  it('names an association post by the association, as the post header does', () => {
    const r = sharedPostReady(
      post({ association: { id: 'a', name: 'BDE', slug: 'bde', logoUrl: null } }) as never
    );
    expect(r.authorName).toBe('BDE');
  });

  it('never names the author by their id when the post carries no name', () => {
    const r = sharedPostReady(
      post({ authorFirstName: undefined, authorId: 'u-123456789' }) as never
    );
    expect(r.authorName).toBe('Utilisateur');
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
    const [a, b] = await Promise.all([fetchSharedPostPreview(P1), fetchSharedPostPreview(P1)]);
    await fetchSharedPostPreview(P1);
    expect(a).toBe(b);
    expect(getPost).toHaveBeenCalledTimes(1);
  });

  it('caches a verdict (404) as unavailable and carries nothing of the post', async () => {
    const { ApiRefusalError } = await import('$lib/utils/apiRefusalError');
    getPost.mockRejectedValue(new ApiRefusalError(404, null, 'gone'));
    expect(await fetchSharedPostPreview(P2)).toEqual({ state: 'unavailable' });
    await fetchSharedPostPreview(P2);
    expect(getPost).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a failure that is no verdict, and does not call it unavailable', async () => {
    getPost.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(post());
    expect((await fetchSharedPostPreview(P3)).state).toBe('failed');
    expect((await fetchSharedPostPreview(P3)).state).toBe('ready');
    expect(getPost).toHaveBeenCalledTimes(2);
  });

  it('treats a 401 as a session question, never as a verdict on the post', async () => {
    const { ApiRefusalError } = await import('$lib/utils/apiRefusalError');
    getPost.mockRejectedValueOnce(new ApiRefusalError(401, null, 'expired'));
    getPost.mockResolvedValueOnce(post());
    expect((await fetchSharedPostPreview(P3)).state).toBe('failed');
    expect((await fetchSharedPostPreview(P3)).state).toBe('ready');
  });

  it('clears the in-flight read on a failure, so a later mount is not handed the dead promise', async () => {
    let fail: (e: unknown) => void = () => {};
    getPost.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    getPost.mockResolvedValueOnce(post());
    const first = fetchSharedPostPreview(P3);
    fail(new TypeError('offline'));
    expect((await first).state).toBe('failed');
    expect((await fetchSharedPostPreview(P3)).state).toBe('ready');
  });

  it('keeps one answer per viewer: an account switch on the install asks again', async () => {
    const { ApiRefusalError } = await import('$lib/utils/apiRefusalError');
    getPost.mockRejectedValueOnce(new ApiRefusalError(404, null, 'gone'));
    getPost.mockResolvedValueOnce(post());
    expect((await fetchSharedPostPreview(P1)).state).toBe('unavailable');
    viewer = 'viewer-2';
    expect(cachedSharedPostPreview(P1)).toBeNull();
    expect((await fetchSharedPostPreview(P1)).state).toBe('ready');
    viewer = 'viewer-1';
    expect(cachedSharedPostPreview(P1)?.state).toBe('unavailable');
    expect(getPost).toHaveBeenCalledTimes(2);
  });

  it('keeps nothing with no signed-in viewer', async () => {
    viewer = null;
    getPost.mockResolvedValue(post());
    await fetchSharedPostPreview(P1);
    await fetchSharedPostPreview(P1);
    expect(getPost).toHaveBeenCalledTimes(2);
    expect(cachedSharedPostPreview(P1)).toBeNull();
  });

  it('asks nothing for an id that is no UUID: the server refuses that shape on every mount', async () => {
    expect(await fetchSharedPostPreview('not-a-post')).toEqual({ state: 'unavailable' });
    expect(await fetchSharedPostPreview('..')).toEqual({ state: 'unavailable' });
    expect(getPost).not.toHaveBeenCalled();
  });
});
