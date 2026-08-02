import { faviconCandidates } from './faviconCandidates';

describe('faviconCandidates', () => {
  it('puts the declared icon first, whatever its format', () => {
    const list = faviconCandidates('https://sky.mitv.fr/', 'https://sky.mitv.fr/sky.png');
    expect(list[0]).toBe('https://sky.mitv.fr/sky.png');
  });

  it('keeps trying conventional paths after the declared icon', () => {
    // A declared icon that 404s must not end the search, and neither must an
    // SPA answering index.html on /favicon.ico.
    const list = faviconCandidates('https://sky.mitv.fr/arbre', 'https://sky.mitv.fr/sky.png');
    expect(list).toEqual([
      'https://sky.mitv.fr/sky.png',
      'https://sky.mitv.fr/favicon.ico',
      'https://sky.mitv.fr/favicon.svg',
      'https://sky.mitv.fr/favicon.png',
      'https://sky.mitv.fr/apple-touch-icon.png',
    ]);
  });

  it('derives the conventions from the ORIGIN, not the current path', () => {
    const list = faviconCandidates('https://example.com/a/b/c');
    expect(list[0]).toBe('https://example.com/favicon.ico');
  });

  it('falls back to the conventions when no icon was declared', () => {
    expect(faviconCandidates('https://example.com/')).toHaveLength(4);
  });

  it('does not repeat a declared icon that is already a conventional path', () => {
    const list = faviconCandidates('https://example.com/', 'https://example.com/favicon.ico');
    expect(list).toHaveLength(4);
    expect(list[0]).toBe('https://example.com/favicon.ico');
  });

  it('refuses a non-http scheme, which reaches an <img src>', () => {
    for (const icon of ['javascript:alert(1)', 'data:text/html,<script></script>', 'file:///etc']) {
      expect(faviconCandidates('https://example.com/', icon)).not.toContain(icon);
    }
  });

  it('returns the declared icon alone when the page URL is unparseable', () => {
    expect(faviconCandidates('not a url', 'https://cdn.example.com/i.png')).toEqual([
      'https://cdn.example.com/i.png',
    ]);
  });

  it('returns an empty list when there is nothing to try', () => {
    expect(faviconCandidates('not a url')).toEqual([]);
  });
});
