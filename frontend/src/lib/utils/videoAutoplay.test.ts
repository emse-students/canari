/**
 * A REFUSED AUTOPLAY IS CLASSIFIED FROM ITS NAME AND ONE FACT READ AT THE THROW (iPhone report,
 * 2026-11-04).
 *
 * Pinned: a refusal is final whatever the sound (a refusal never mutes - lead decision 2026-11-04);
 * an abort on a changed source waits for that source's load; an abort on the same source is a pause
 * somebody decided, final; anything else is final.
 */
import { describe, expect, it } from 'vitest';
import { decideAutoplayRejection, playRejectionName } from './videoAutoplay';

describe('decideAutoplayRejection', () => {
  it('is final when the engine refuses the autoplay, and never asks to mute', () => {
    expect(decideAutoplayRejection('NotAllowedError', { sourceChanged: false })).toEqual({
      kind: 'blocked',
      cause: 'refused',
    });
  });

  it('waits for the new load when the source changed under the ask', () => {
    expect(decideAutoplayRejection('AbortError', { sourceChanged: true })).toEqual({
      kind: 'ask-at-next-load',
    });
  });

  it('is final when a pause interrupted the ask on the same source', () => {
    expect(decideAutoplayRejection('AbortError', { sourceChanged: false })).toEqual({
      kind: 'blocked',
      cause: 'interrupted',
    });
  });

  it('is final on any other failure', () => {
    expect(decideAutoplayRejection('NotSupportedError', { sourceChanged: true })).toEqual({
      kind: 'blocked',
      cause: 'errored',
    });
  });
});

describe('playRejectionName', () => {
  it('reads the DOMException name, never the message', () => {
    expect(playRejectionName(new DOMException('whatever text', 'AbortError'))).toBe('AbortError');
    expect(playRejectionName('odd')).toBe('odd');
  });
});
