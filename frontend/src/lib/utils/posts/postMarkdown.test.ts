import { normalizePostLineBreaks, preprocessPostMarkdown } from './postMarkdown';

import { EXAMPLE_MENTION_USER_ID } from '../mentions';

describe('normalizePostLineBreaks', () => {
  it('turns a single newline into a markdown hard break', () => {
    expect(normalizePostLineBreaks('ligne 1\nligne 2')).toBe('ligne 1  \nligne 2');
  });

  it('keeps paragraph breaks (double newline) unchanged', () => {
    expect(normalizePostLineBreaks('para 1\n\npara 2')).toBe('para 1\n\npara 2');
  });

  it('normalizes CRLF', () => {
    expect(normalizePostLineBreaks('a\r\nb')).toBe('a  \nb');
  });
});

describe('preprocessPostMarkdown', () => {
  it('preserves line breaks after uuid mention processing', () => {
    const out = preprocessPostMarkdown(`Bonjour\n@[${EXAMPLE_MENTION_USER_ID}]`);
    expect(out).toContain('Bonjour  \n');
    expect(out).toContain(`](#mention-${EXAMPLE_MENTION_USER_ID})`);
  });

  it('linkifies a whitelisted bare domain (WP-LINK-1), sharing the whitelist with chat', () => {
    expect(preprocessPostMarkdown('voir canari-emse.fr stp')).toContain(
      '[canari-emse.fr](https://canari-emse.fr)'
    );
    expect(preprocessPostMarkdown('photos sur gallery.mitv.fr')).toContain(
      '[gallery.mitv.fr](https://gallery.mitv.fr)'
    );
  });

  it('linkifies any subdomain of emse.fr, and the bare apex itself', () => {
    expect(preprocessPostMarkdown('voir emse.fr')).toContain('[emse.fr](https://emse.fr)');
    expect(preprocessPostMarkdown('voir portail.emse.fr')).toContain(
      '[portail.emse.fr](https://portail.emse.fr)'
    );
  });

  it('does not linkify a bare domain outside the whitelist', () => {
    for (const text of ['example.fr', 'canari-emse.com']) {
      expect(preprocessPostMarkdown(text)).toBe(text);
    }
  });

  it('does not linkify French inclusive writing that looks like a bare domain', () => {
    for (const text of ['auteur.rice', 'cher.e.s', 'Bonjour.Comment']) {
      expect(preprocessPostMarkdown(text)).toBe(text);
    }
  });

  it('does not nest markdown link syntax around a hand-written link label', () => {
    const md = '[canari-emse.fr](https://canari-emse.fr)';
    expect(preprocessPostMarkdown(md)).toBe(md);
  });

  it('does not re-linkify the host inside an already-schemed URL', () => {
    const md = 'voir https://canari-emse.fr/chat stp';
    expect(preprocessPostMarkdown(md)).toBe(md);
  });
});
