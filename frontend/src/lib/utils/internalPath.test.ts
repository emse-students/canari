import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/paths', () => ({ base: '/canari' }));

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
  it('keeps an in-app path and falls back on everything else', () => {
    expect(safeInternalPath('/forms/3?x=1', '/posts')).toBe('/forms/3?x=1');
    for (const bad of [
      'foo',
      '',
      null,
      undefined,
      '//evil.com',
      `/${String.fromCharCode(92)}evil.com`,
      'https://x.y',
    ]) {
      expect(safeInternalPath(bad, '/posts')).toBe('/posts');
    }
  });
});
