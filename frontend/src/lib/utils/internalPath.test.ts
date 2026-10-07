import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/paths', () => ({ base: '/canari' }));

import { appPathFromPathname, loginReturningTo, safeInternalPath } from './internalPath';

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
