import {
  parseCanariLinkTarget,
  postAuthorDisplayName,
  postPreviewTitle,
} from './canariLinkPreviewFormat';
import { setLocale } from '$lib/paraglide/runtime';
import type { PostEntity } from '$lib/posts/api';

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
