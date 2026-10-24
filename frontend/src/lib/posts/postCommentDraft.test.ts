// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearPostCommentDraft,
  loadPostCommentDraft,
  postCommentDraftKey,
  savePostCommentDraft,
} from './postCommentDraft';
import { buildCommentsSearchParams } from './api';

function signIn(id: string): void {
  localStorage.setItem('canari_saved_user', id);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  signIn('user-a');
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('post comment draft', () => {
  it('round-trips per post and per reply target', () => {
    savePostCommentDraft('p1', { text: 'hello', parentId: 'c9' });
    expect(loadPostCommentDraft('p1')).toEqual({ text: 'hello', parentId: 'c9' });
    expect(loadPostCommentDraft('p2')).toBeNull();
  });

  it('belongs to the account: another one reads nothing', () => {
    savePostCommentDraft('p1', { text: 'mine', parentId: null });
    signIn('user-b');
    expect(loadPostCommentDraft('p1')).toBeNull();
    expect(localStorage.getItem(postCommentDraftKey('user-a', 'p1'))).not.toBeNull();
  });

  it('an emptied field clears the draft', () => {
    savePostCommentDraft('p1', { text: 'x', parentId: null });
    savePostCommentDraft('p1', { text: '   ', parentId: null });
    expect(loadPostCommentDraft('p1')).toBeNull();
  });

  it('drops an unreadable value and says so', () => {
    localStorage.setItem(postCommentDraftKey('user-a', 'p1'), '{nope');
    expect(loadPostCommentDraft('p1')).toBeNull();
    expect(localStorage.getItem(postCommentDraftKey('user-a', 'p1'))).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('clear removes it', () => {
    savePostCommentDraft('p1', { text: 'x', parentId: null });
    clearPostCommentDraft('p1');
    expect(loadPostCommentDraft('p1')).toBeNull();
  });

  it('touches nothing when nobody is signed in', () => {
    localStorage.clear();
    savePostCommentDraft('p1', { text: 'x', parentId: null });
    expect(localStorage.length).toBe(0);
  });
});

describe('buildCommentsSearchParams', () => {
  it('sends only what was given, a zero cursor included', () => {
    expect(buildCommentsSearchParams({})).toBe('');
    expect(buildCommentsSearchParams({ cursor: 0, limit: 20, order: 'oldest' })).toBe(
      '?cursor=0&limit=20&order=oldest'
    );
    expect(buildCommentsSearchParams({ cursor: null })).toBe('');
  });
});
