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
});
