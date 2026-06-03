import { describe, expect, it } from 'vitest';
import {
  parseCanariLinkTarget,
  postAuthorDisplayName,
  postPreviewTitle,
} from './canariLinkPreviewFormat';
import type { PostEntity } from '$lib/posts/api';

describe('parseCanariLinkTarget', () => {
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
});

describe('postPreviewTitle', () => {
  it('strips markdown to a short plain title', () => {
    const post = {
      id: '1',
      markdown: '# Hello\n\n**world**',
      mentions: [],
      links: [],
      images: [],
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
      polls: [],
      createdAt: '',
      updatedAt: '',
    } as PostEntity;
    expect(postAuthorDisplayName(post)).toBe('BDE');
  });
});
