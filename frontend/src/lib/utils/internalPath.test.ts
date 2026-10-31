import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/paths', () => ({ resolve: (pathname: string) => `/canari/${pathname}` }));

import {
  appPathFromPathname,
  loginAfterSessionExpiry,
  loginReturningTo,
  safeInternalPath,
} from './internalPath';

describe('internalPath under a base path', () => {
  it('strips the base a browser pathname carries, so resolve adds it once', () => {
    expect(appPathFromPathname('/canari/forms/3')).toBe('/forms/3');
    expect(appPathFromPathname('/canari')).toBe('/');
    expect(appPathFromPathname('/canarix/forms')).toBe('/canarix/forms');
  });

  it('builds a returnTo that is base-less', () => {
    expect(loginReturningTo('/canari/forms/3', '?a=1', '#h')).toBe(
      `/login?returnTo=${encodeURIComponent('/forms/3?a=1#h')}`
    );
  });
});

describe('loginAfterSessionExpiry', () => {
  it('carries the page the user was going to, base-less', () => {
    expect(loginAfterSessionExpiry({ pathname: '/canari/post/p1', search: '?x=1', hash: '' })).toBe(
      `/login?returnTo=${encodeURIComponent('/post/p1?x=1')}`
    );
  });

  it('stays bare when there is nothing worth returning to', () => {
    for (const pathname of [
      '/canari',
      '/canari/login',
      '/canari/auth/callback',
      '/canari/legal/cgu',
    ]) {
      expect(loginAfterSessionExpiry({ pathname, search: '', hash: '' })).toBe('/login');
    }
    expect(loginAfterSessionExpiry(null)).toBe('/login');
    expect(loginAfterSessionExpiry(undefined)).toBe('/login');
  });
});

describe('safeInternalPath', () => {
  const BS = String.fromCharCode(92);
  const TAB = String.fromCharCode(9);
  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);

  it('keeps every in-app path unchanged: query, hash and encoded characters included', () => {
    for (const good of [
      '/',
      '/forms/3?x=1',
      '/posts#comments',
      '/c/abc/a1?tab=a%20b#m-2',
      '/search?q=%C3%A9t%C3%A9',
      '/login?returnTo=%2Fchat',
      '/%09/x.example',
      '/%2F%2Fx.example',
      '/%5Cx.example',
      `/forms/${String.fromCharCode(0xe9)}t${String.fromCharCode(0xe9)}`,
    ]) {
      expect(safeInternalPath(good, '/posts')).toBe(good);
    }
  });

  it('falls back on an empty, relative or absolute value', () => {
    for (const bad of [
      '',
      null,
      undefined,
      'foo',
      ' /posts',
      'https://x.example',
      'HTTPS://x.example/posts',
      'javascript:void(0)',
      'data:text/html,x',
      'mailto:a@x.example',
    ]) {
      expect(safeInternalPath(bad, '/posts')).toBe('/posts');
    }
  });

  it('falls back on a value that resolves to another origin', () => {
    for (const bad of ['//x.example', '//x.example/posts', '///x.example', `/${BS}x.example`]) {
      expect(safeInternalPath(bad, '/posts')).toBe('/posts');
    }
  });

  it('falls back on a control character or a backslash at any position', () => {
    for (const bad of [
      `/${TAB}/x.example/p`,
      `/${LF}/x.example`,
      `/${CR}/x.example`,
      `/${TAB}${BS}x.example`,
      // Same-origin once parsed, so only the character check refuses these two.
      `/forms${TAB}/3`,
      `/forms${BS}3`,
      `/posts${String.fromCharCode(0)}`,
      `/posts${String.fromCharCode(0x7f)}`,
      `/posts${String.fromCharCode(0x85)}`,
      `/posts${String.fromCharCode(0x9f)}`,
      `/posts${String.fromCharCode(0x2028)}`,
      `/posts${String.fromCharCode(0x2029)}`,
    ]) {
      expect(safeInternalPath(bad, '/posts')).toBe('/posts');
    }
  });

  it('falls back on a value that is not a string', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of [42, {}, ['/posts'], true]) {
      expect(safeInternalPath(bad as unknown as string, '/posts')).toBe('/posts');
    }
  });

  it('returns only values a browser resolves on the page they are read on', () => {
    const page = 'https://canari.test/forms/create';
    for (const value of [
      '/.//x.example',
      '/..//x.example',
      '/./..//x.example/p',
      '/%2e%2e//x.example',
      '/@x.example',
      '/x.example@y.example',
      ' javascript:void(0)',
      `${TAB}javascript:void(0)`,
      '/javascript:void(0)',
    ]) {
      const kept = safeInternalPath(value, '/posts');
      expect(new URL(kept, page).origin).toBe('https://canari.test');
    }
  });
});
