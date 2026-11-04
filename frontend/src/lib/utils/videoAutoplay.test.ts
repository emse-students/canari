/**
 * A REFUSED AUTOPLAY IS CLASSIFIED FROM ITS NAME AND TWO FACTS (iPhone report, 2026-11-04).
 *
 * Pinned: an audible refusal is retried muted (and a muted refusal is final, so the retry
 * terminates); an abort after a new load waits for that load; an abort with no new load is a pause
 * somebody decided, final; anything else is final.
 */
import { describe, expect, it } from 'vitest';
import { decideAutoplayRejection, playRejectionName } from './videoAutoplay';

describe('decideAutoplayRejection', () => {
  it('retries muted when an audible autoplay is refused', () => {
    expect(decideAutoplayRejection('NotAllowedError', { muted: false, reloaded: false })).toEqual({
      kind: 'retry-muted',
    });
  });

  it('is final when a MUTED autoplay is refused, so the muted retry terminates', () => {
    expect(decideAutoplayRejection('NotAllowedError', { muted: true, reloaded: false })).toEqual({
      kind: 'blocked',
      cause: 'refused',
    });
  });

  it('waits for the new load when a new load interrupted the ask', () => {
    expect(decideAutoplayRejection('AbortError', { muted: true, reloaded: true })).toEqual({
      kind: 'ask-at-next-load',
    });
  });

  it('is final when a pause interrupted the ask and no new load follows', () => {
    expect(decideAutoplayRejection('AbortError', { muted: true, reloaded: false })).toEqual({
      kind: 'blocked',
      cause: 'interrupted',
    });
  });

  it('is final on any other failure', () => {
    expect(decideAutoplayRejection('NotSupportedError', { muted: false, reloaded: true })).toEqual({
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
