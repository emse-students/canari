import { describe, expect, it } from 'vitest';
import { DESCRIBED_STACK_FRAMES, describeCaughtError } from './describeCaughtError';

describe('describeCaughtError', () => {
  it('names an Error by its name, message and first stack frames - never [object Object]', () => {
    const e = new Error('https://svelte.dev/e/effect_update_depth_exceeded');
    e.stack = [
      'Error: https://svelte.dev/e/effect_update_depth_exceeded',
      '    at a (chunk1.js:1:1)',
      '    at b (chunk2.js:2:2)',
      '    at c (chunk3.js:3:3)',
      '    at d (chunk4.js:4:4)',
    ].join('\n');
    const line = describeCaughtError(e);
    expect(line).toBe(
      'Error: https://svelte.dev/e/effect_update_depth_exceeded | at a (chunk1.js:1:1) | at b (chunk2.js:2:2) | at c (chunk3.js:3:3)'
    );
    expect(line.split(' | ')).toHaveLength(1 + DESCRIBED_STACK_FRAMES);
  });

  it('keeps a subclass name and works with a stack that does not repeat the head (Firefox, Safari)', () => {
    const e = new TypeError('x is undefined');
    e.stack = 'f@chunk.js:1:1\ng@chunk.js:2:2';
    expect(describeCaughtError(e)).toBe(
      'TypeError: x is undefined | f@chunk.js:1:1 | g@chunk.js:2:2'
    );
  });

  it('gives the head alone when there is no stack', () => {
    const e = new RangeError('too deep');
    e.stack = undefined;
    expect(describeCaughtError(e)).toBe('RangeError: too deep');
  });

  it('serialises a plain object instead of printing [object Object]', () => {
    expect(describeCaughtError({ code: 'effect_update_depth_exceeded' })).toBe(
      '{"code":"effect_update_depth_exceeded"}'
    );
  });

  it('says so when an object cannot be serialised', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(describeCaughtError(loop)).toMatch(/^unserialisable \[object Object\]/);
  });

  it('prints any other value as its string', () => {
    expect(describeCaughtError('boom')).toBe('boom');
    expect(describeCaughtError(undefined)).toBe('undefined');
  });
});
