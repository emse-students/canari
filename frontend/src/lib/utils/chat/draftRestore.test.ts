import { describe, expect, it } from 'vitest';
import { restoreFailedDraft } from './draftRestore';

describe('restoreFailedDraft', () => {
  it('puts the failed text back into an empty composer', () => {
    expect(restoreFailedDraft('', 'hello')).toBe('hello');
    expect(restoreFailedDraft('   ', 'hello')).toBe('hello');
  });

  it('keeps what the member typed meanwhile, the failed text in front', () => {
    expect(restoreFailedDraft('next', 'hello')).toBe('hello\nnext');
  });

  it('does not duplicate a text the composer already holds', () => {
    expect(restoreFailedDraft('hello', 'hello')).toBe('hello');
  });
});
