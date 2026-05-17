import { describe, expect, it } from 'vitest';
import { normalizePostLineBreaks, preprocessPostMarkdown } from './postMarkdown';

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
  it('preserves line breaks after mention processing', () => {
    expect(preprocessPostMarkdown('Bonjour\n@alice')).toBe('Bonjour  \n[@alice](#mention-alice)');
  });
});
