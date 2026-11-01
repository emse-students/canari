/// <reference types="jest" />

import { escapeRedisGlob } from './erasure-redis';

/**
 * The escaper ITSELF, asserted on its output. The in-memory Redis of the erasure specs does not
 * implement `[...]` classes, so a glob test there could not tell an escaped bracket from a missed
 * one: the string Redis receives is the only thing worth pinning.
 */
describe('escapeRedisGlob', () => {
  it('escapes every glob metacharacter a minted user id may carry', () => {
    // A user id is visible ASCII with no ':', so `*`, `?`, `[`, `]`, `^` and `\` are all legal.
    expect(escapeRedisGlob('a*b?c[d]e^f\\g')).toBe('a\\*b\\?c\\[d\\]e\\^f\\\\g');
  });

  it('escapes the backslash first-class, so an escape in the id cannot neutralise the next one', () => {
    // `\*` in the id must become `\\\*`: a literal backslash, then a literal star.
    expect(escapeRedisGlob('\\*')).toBe('\\\\\\*');
  });

  it('leaves an ordinary 64-hex id untouched', () => {
    const id = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);
    expect(escapeRedisGlob(id)).toBe(id);
  });
});
