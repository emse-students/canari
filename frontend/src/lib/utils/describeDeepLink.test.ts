import { describe, expect, it } from 'vitest';
import { describeDeepLink } from './logSanitize';

describe('describeDeepLink', () => {
  it('keeps the route word of a custom-scheme link and drops the id', () => {
    const out = describeDeepLink('fr.emse.canari://post/3f2a9c1e-1111-2222-3333-444455556666');
    expect(out).toBe('fr.emse.canari://post/[1 seg]');
    expect(out).not.toContain('3f2a');
  });

  it('never prints query or fragment values, only their presence', () => {
    const out = describeDeepLink('fr.emse.canari://auth/callback?code=SECRETCODE&state=abc#tok123');
    expect(out).toBe('fr.emse.canari://auth/[1 seg] +query +fragment');
    expect(out).not.toMatch(/SECRET|abc|tok123/);
  });

  it('keeps the first segment of a web link only', () => {
    const out = describeDeepLink('https://canari.emse.fr/posts/abc123?returnTo=%2Fadmin');
    expect(out).toBe('https://canari.emse.fr/posts/... +query');
  });

  it('hides a first segment that is not a route word (a token)', () => {
    expect(describeDeepLink('https://canari.emse.fr/9f8e7d6c5b4a')).toBe(
      'https://canari.emse.fr/[seg]'
    );
  });

  it('reports a link without path or query plainly', () => {
    expect(describeDeepLink('fr.emse.canari://posts')).toBe('fr.emse.canari://posts');
  });

  it('never echoes unparseable input', () => {
    expect(describeDeepLink('not a url secret-token')).toBe('[unparseable deep link]');
  });
});
