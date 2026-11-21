/**
 * The claim is narrow: nothing a peer sends can end a log line and start another.
 *
 * The split into two `replace` passes was made for a TOOL - CodeQL cannot see through a `\p{Cc}`
 * property escape - so the first thing these pin is that the split changed no behaviour.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeForLog, MAX_LOGGED_VALUE_LENGTH, pathWithoutFragment } from './logSanitize';

describe('sanitizeForLog', () => {
  it('leaves an ordinary value exactly as it is', () => {
    expect(sanitizeForLog('a1b2c3d4-user-42')).toBe('a1b2c3d4-user-42');
  });

  it('cannot be made to start a second log line', () => {
    // The attack, stated as an input: a display name, id or frame type that closes the real entry
    // and writes a plausible one after it.
    const forged = 'alice\n[MLS] group 0000 healed successfully';
    expect(sanitizeForLog(forged)).not.toContain('\n');
    expect(sanitizeForLog(forged)).toBe('alice [MLS] group 0000 healed successfully');
  });

  it.each([
    ['carriage return', 'a\rb'],
    ['line feed', 'a\nb'],
    ['CRLF', 'a\r\nb'],
    ['tab', 'a\tb'],
    ['NUL', 'a\u0000b'],
    ['escape', 'a\u001bb'],
    ['delete', 'a\u007fb'],
  ])('replaces a %s with a space', (_what, input) => {
    expect(sanitizeForLog(input)).toMatch(/^a +b$/);
  });

  it('truncates, so one value cannot become a screen', () => {
    const long = 'x'.repeat(MAX_LOGGED_VALUE_LENGTH + 50);
    expect(sanitizeForLog(long)).toHaveLength(MAX_LOGGED_VALUE_LENGTH);
  });

  it('truncates AFTER stripping, so a padded newline cannot survive the cut', () => {
    // Getting this order wrong is the subtle way to keep the defect: strip a 250-char value first
    // and the newline at index 240 is gone; truncate first and it is still there at 240... which
    // is past the cut. The case that separates them is a newline INSIDE the kept prefix.
    const value = `${'x'.repeat(10)}\n${'y'.repeat(MAX_LOGGED_VALUE_LENGTH)}`;
    const out = sanitizeForLog(value);
    expect(out).not.toContain('\n');
    expect(out).toHaveLength(MAX_LOGGED_VALUE_LENGTH);
  });

  it('is unchanged by the two-pass split it was rewritten into', () => {
    // The single-class form this replaced, kept here as the oracle rather than as prose.
    const oneClass = (v: string) => v.replace(/[\r\n\t\p{Cc}]/gu, ' ').slice(0, 200);
    for (const sample of [
      '',
      'plain',
      'a\r\n\t\u0000\u001f b',
      'e'.repeat(400),
      'mixed\nlines\tand\u0007bells',
    ]) {
      expect(sanitizeForLog(sample)).toBe(oneClass(sample));
    }
  });

  it('accepts an empty string rather than throwing on one', () => {
    expect(sanitizeForLog('')).toBe('');
  });
});

describe('pathWithoutFragment - a group invite name never reaches a log', () => {
  it('replaces the fragment by its presence', () => {
    expect(pathWithoutFragment('/g/join/tok#name=Bureau+des+arts')).toBe('/g/join/tok +fragment');
  });

  it('leaves a path with no fragment unchanged', () => {
    expect(pathWithoutFragment('/chat?x=1')).toBe('/chat?x=1');
  });
});
