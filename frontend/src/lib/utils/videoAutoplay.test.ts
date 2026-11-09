/**
 * A REFUSED AUTOPLAY IS CLASSIFIED FROM ITS NAME AND ONE FACT READ AT THE THROW (iPhone report,
 * 2026-11-04).
 *
 * Pinned: a refusal is final whatever the sound (a refusal never mutes - lead decision 2026-11-04);
 * an abort on a changed source waits for that source's load; an abort on the same source is a pause
 * somebody decided, final; anything else is final.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideAutoplayRejection, logRefusedPlay, playRejectionName } from './videoAutoplay';

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

describe('logRefusedPlay - an abort is never a warning', () => {
  afterEach(() => vi.restoreAllMocks());

  const abort = new DOMException('interrupted', 'AbortError');
  const spies = () => ({
    debug: vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
  });

  it('an abort on a changed source is debug', () => {
    const c = spies();
    logRefusedPlay('t', abort, { src: 'b', muted: true }, 'a');
    expect(c.debug).toHaveBeenCalledOnce();
    expect(c.warn).not.toHaveBeenCalled();
  });

  it('an abort on the same source is info', () => {
    const c = spies();
    logRefusedPlay('t', abort, { src: 'a', muted: true }, 'a');
    expect(c.info).toHaveBeenCalledOnce();
    expect(c.warn).not.toHaveBeenCalled();
  });

  it('a policy refusal and a decoder failure still warn', () => {
    const c = spies();
    logRefusedPlay('t', new DOMException('x', 'NotAllowedError'), { src: 'a', muted: false }, 'a');
    logRefusedPlay(
      't',
      new DOMException('x', 'NotSupportedError'),
      { src: 'a', muted: false },
      'a'
    );
    expect(c.warn).toHaveBeenCalledTimes(2);
  });
});
