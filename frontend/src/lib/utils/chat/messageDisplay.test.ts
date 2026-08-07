import { extractFirstUrl, isAngleBracketAutolink, splitTextWithLinks } from './messageDisplay';

describe('isAngleBracketAutolink', () => {
  it('detects <url> wrapper', () => {
    const text = 'voir <https://example.com> ici';
    const start = text.indexOf('https');
    const end = start + 'https://example.com'.length;
    expect(isAngleBracketAutolink(text, start, end)).toBe(true);
  });
});

describe('extractFirstUrl', () => {
  it('returns bare URLs', () => {
    expect(extractFirstUrl('https://example.com/path')).toBe('https://example.com/path');
  });

  it('skips angle-bracket autolinks', () => {
    expect(extractFirstUrl('lien <https://example.com> fin')).toBe(null);
  });

  it('returns first bare URL when autolink precedes it', () => {
    expect(extractFirstUrl('<https://a.com> puis https://b.com')).toBe('https://b.com');
  });

  it('keeps a closing parenthesis that belongs to the URL', () => {
    // The case that broke in production: the preview endpoint answered 400 and the rendered
    // href pointed at a page that does not exist.
    expect(extractFirstUrl('https://fr.wikipedia.org/wiki/Signal_(application)')).toBe(
      'https://fr.wikipedia.org/wiki/Signal_(application)'
    );
  });

  it('drops a closing parenthesis that wraps the URL', () => {
    expect(extractFirstUrl('voir (https://example.com) fin')).toBe('https://example.com');
  });

  it('drops trailing sentence punctuation after a balanced URL', () => {
    expect(extractFirstUrl('https://en.wikipedia.org/wiki/Cat_(x)!')).toBe(
      'https://en.wikipedia.org/wiki/Cat_(x)'
    );
  });
});

describe('splitTextWithLinks', () => {
  it('marks autolink URLs with noEmbed', () => {
    const segments = splitTextWithLinks('x <https://example.com> y');
    const link = segments.find((s) => s.type === 'link');
    expect(link).toMatchObject({ value: 'https://example.com', noEmbed: true });
  });

  it('keeps normal links embeddable', () => {
    const segments = splitTextWithLinks('https://example.com');
    expect(segments).toContainEqual({ type: 'link', value: 'https://example.com' });
  });

  it('does not swallow the punctuation it trims off a URL', () => {
    // Resuming after the raw match instead of after the link deleted the character from the
    // rendered message entirely - the reader lost the full stop, not just the link.
    const segments = splitTextWithLinks('voir https://example.com. fin');
    expect(segments).toContainEqual({ type: 'link', value: 'https://example.com' });
    expect(segments.map((s) => (s.type === 'text' ? s.value : '')).join('')).toContain('. fin');
  });

  it('links a URL with balanced parentheses and keeps the sentence intact', () => {
    const segments = splitTextWithLinks('voir (https://x.com/a_(b)) fin');
    expect(segments).toContainEqual({ type: 'link', value: 'https://x.com/a_(b)' });
    expect(segments.map((s) => (s.type === 'text' ? s.value : '')).join('')).toContain(') fin');
  });

  it('linkifies the whitelisted canari-emse.fr with no scheme', () => {
    const segments = splitTextWithLinks('voir canari-emse.fr stp');
    expect(segments).toContainEqual({ type: 'link', value: 'https://canari-emse.fr' });
  });

  it('linkifies the whitelisted gallery.mitv.fr with no scheme', () => {
    const segments = splitTextWithLinks('photos sur gallery.mitv.fr merci');
    expect(segments).toContainEqual({ type: 'link', value: 'https://gallery.mitv.fr' });
  });

  it('linkifies any subdomain of emse.fr, and the bare apex itself', () => {
    for (const domain of ['emse.fr', 'portail.emse.fr', 'chat.portail.emse.fr']) {
      const segments = splitTextWithLinks(`voir ${domain} stp`);
      expect(segments).toContainEqual({ type: 'link', value: `https://${domain}` });
    }
  });

  it('does not linkify a bare domain outside the whitelist, even with a common TLD', () => {
    for (const text of ['example.fr', 'canari-emse.com', 'notemse.fr']) {
      const segments = splitTextWithLinks(text);
      expect(segments.some((s) => s.type === 'link')).toBe(false);
    }
  });

  it('does not linkify French inclusive writing that looks like a bare domain', () => {
    for (const text of ['auteur.rice', 'cher.e.s', 'Bonjour.Comment']) {
      const segments = splitTextWithLinks(text);
      expect(segments.some((s) => s.type === 'link')).toBe(false);
    }
  });

  it('does not re-linkify the host of an already-schemed URL', () => {
    const segments = splitTextWithLinks('https://canari-emse.fr/chat');
    const links = segments.filter((s) => s.type === 'link');
    expect(links).toEqual([{ type: 'link', value: 'https://canari-emse.fr/chat' }]);
  });
});
