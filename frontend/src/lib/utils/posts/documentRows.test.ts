import { describe, it, expect } from 'vitest';
import { usesCompactDocumentRows } from './documentRows';

const file = { type: 'file' as const, mimeType: 'application/pdf' };
const image = { type: 'image' as const, mimeType: 'image/jpeg' };
const audio = { type: 'audio' as const, mimeType: 'audio/mpeg' };

describe('usesCompactDocumentRows', () => {
  it('is false for no file and for exactly one', () => {
    expect(usesCompactDocumentRows([])).toBe(false);
    expect(usesCompactDocumentRows([file])).toBe(false);
    expect(usesCompactDocumentRows([image, image, file])).toBe(false);
  });

  it('is true from two files on, with or without pictures', () => {
    expect(usesCompactDocumentRows([file, file])).toBe(true);
    expect(usesCompactDocumentRows([image, file, file, audio])).toBe(true);
  });

  it('does not count audio as a document', () => {
    expect(usesCompactDocumentRows([file, audio])).toBe(false);
  });
});
