import {
  parseCanariLinkTarget,
  postAuthorDisplayName,
  postPreviewTitle,
} from './canariLinkPreviewFormat';
import { setLocale } from '$lib/paraglide/runtime';
import type { PostEntity, PostMediaRef } from '$lib/posts/api';

vi.mock('$lib/posts/api', () => ({ getPost: vi.fn() }));

const { getPost } = await import('$lib/posts/api');
const getPostMock = getPost as unknown as ReturnType<typeof vi.fn>;
const { fetchCanariLinkPreview } = await import('./canariLinkPreview');

function post(overrides: Partial<PostEntity>): PostEntity {
  return {
    id: '1',
    markdown: 'hello',
    mentions: [],
    links: [],
    images: [],
    media: [],
    polls: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as PostEntity;
}

describe('parseCanariLinkTarget', () => {
  // Expected labels are French, so the locale is PINNED rather than inherited: the resolution
  // order ends in `preferredLanguage`, and happy-dom prefers English - which made these
  // assertions depend on a dependency's default instead of on the code.
  beforeEach(() => setLocale('fr', { reload: false }));

  it('detects posts, forms, associations, and profiles', () => {
    expect(parseCanariLinkTarget('https://canari-emse.fr/posts/abc')).toEqual({
      kind: 'post',
      postId: 'abc',
    });
    expect(parseCanariLinkTarget('https://canari-emse.fr/forms/f1')).toEqual({
      kind: 'form',
      formId: 'f1',
    });
    expect(parseCanariLinkTarget('https://canari-emse.fr/associations/bde')).toEqual({
      kind: 'association',
      slug: 'bde',
    });
    expect(parseCanariLinkTarget('/profile/user-1')).toEqual({
      kind: 'profile',
      userId: 'user-1',
    });
  });

  it('carries a plain route as a title label, not as a category', () => {
    // `label` is what the card puts on its TITLE line; the badge is the brand. The
    // field was once named categoryLabel and fed both, which printed it twice.
    expect(parseCanariLinkTarget('https://canari-emse.fr/')).toEqual({
      kind: 'route',
      label: 'Accueil',
    });
  });
});

describe('postPreviewTitle', () => {
  it('strips markdown to a short plain title', () => {
    const post = {
      id: '1',
      markdown: '# Hello\n\n**world**',
      mentions: [],
      links: [],
      images: [],
      media: [],
      polls: [],
      createdAt: '',
      updatedAt: '',
    } as PostEntity;
    expect(postPreviewTitle(post)).toBe('Hello world');
  });
});

describe('postAuthorDisplayName', () => {
  it('prefers association name', () => {
    const post = {
      id: '1',
      markdown: '',
      association: { id: 'a', name: 'BDE', slug: 'bde', logoUrl: null },
      mentions: [],
      links: [],
      images: [],
      media: [],
      polls: [],
      createdAt: '',
      updatedAt: '',
    } as PostEntity;
    expect(postAuthorDisplayName(post)).toBe('BDE');
  });
});

describe('fetchCanariLinkPreview (post) - the small logo slot and the own-photo banner', () => {
  beforeEach(() => {
    getPostMock.mockReset();
  });

  it("carries the post's own image separately from the association logo", async () => {
    const media: PostMediaRef = {
      type: 'image',
      mediaId: 'm1',
      key: 'k',
      iv: 'i',
      mimeType: 'image/webp',
      size: 10,
    };
    getPostMock.mockResolvedValue(
      post({
        association: { id: 'a', name: 'BDE', slug: 'bde', logoUrl: '/api/media/public/logo' },
        media: [media],
      })
    );
    const preview = await fetchCanariLinkPreview('https://canari-emse.fr/posts/p1');
    // The small thumbnail stays the association logo...
    expect(preview?.imageUrl).toContain('/api/media/public/logo');
    // ...and the post's own (still-encrypted) photo is a distinct field, untouched.
    expect(preview?.postImage).toEqual(media);
  });

  it('has no postImage when the post carries none', async () => {
    getPostMock.mockResolvedValue(post({}));
    const preview = await fetchCanariLinkPreview('https://canari-emse.fr/posts/p2');
    expect(preview?.postImage).toBeNull();
  });

  it('ignores a non-image attachment (e.g. a video) for the banner', async () => {
    const media: PostMediaRef = {
      type: 'video',
      mediaId: 'm2',
      key: 'k',
      iv: 'i',
      mimeType: 'video/mp4',
      size: 10,
    };
    getPostMock.mockResolvedValue(post({ media: [media] }));
    const preview = await fetchCanariLinkPreview('https://canari-emse.fr/posts/p3');
    expect(preview?.postImage).toBeNull();
  });
});
