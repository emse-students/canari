/**
 * What a debug line must carry for a reader that is not DevTools.
 *
 * These assert the ONE property the logger exists for outside a browser panel: the payload has to be
 * IN the line. The regression they pin is a line reading `[tag] Object` - which is what every text
 * consumer of `console.debug(msg, payload)` receives, the cross-client harness included, and which
 * cost seven DEL rows a clean window on 2026-09-05.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Log } from './Log';

/** The rendered part of the one console.debug call, with the `[timestamp] [tag] ` prefix removed. */
function payloadOf(spy: ReturnType<typeof vi.spyOn>): string {
  expect(spy).toHaveBeenCalledTimes(1);
  const first = String(spy.mock.calls[0][0]);
  return first.replace(/^\[[^\]]+\] \[[^\]]+\] ?/, '');
}

describe('Log.d', () => {
  let debug: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => {
    debug.mockRestore();
  });

  it('renders an object payload into the line rather than beside it', () => {
    Log.d('blocks.isBlockedWith', { userId: 'abc', blocked: false });
    expect(payloadOf(debug)).toBe('{"userId":"abc","blocked":false}');
    // The regression itself: nothing may reach a reader as the bare word `Object`.
    expect(debug.mock.calls[0].join(' ')).not.toContain('[object Object]');
  });

  it('passes a string payload through unchanged', () => {
    Log.d('CHANNEL', 'history visibility set to members');
    expect(payloadOf(debug)).toBe('history visibility set to members');
  });

  it('renders an Error as its own text, and still hands the object over for the stack', () => {
    const err = new TypeError('nope');
    Log.d('PostCard.reportFailed', err);
    expect(payloadOf(debug)).toBe('TypeError: nope');
    // `JSON.stringify(new Error())` is `{}`; an empty object about a failure is worse than nothing.
    expect(payloadOf(debug)).not.toBe('{}');
    expect(debug.mock.calls[0][1]).toBe(err);
  });

  it('logs the tag alone when there is no payload', () => {
    Log.d('blocks.listBlockedUsers');
    expect(payloadOf(debug)).toBe('');
    expect(debug.mock.calls[0]).toHaveLength(1);
  });

  it('survives a circular payload instead of throwing inside a log call', () => {
    const cycle: Record<string, unknown> = { name: 'a' };
    cycle.self = cycle;
    expect(() => Log.d('cycle', cycle)).not.toThrow();
    expect(payloadOf(debug)).toContain('[circular]');
  });

  it('truncates a payload that would push the tag out of a capture window', () => {
    Log.d('big', { blob: 'x'.repeat(1000) });
    const rendered = payloadOf(debug);
    expect(rendered).toContain('chars)');
    expect(rendered.length).toBeLessThan(300);
  });

  it('renders a value JSON cannot express rather than dropping the payload', () => {
    Log.d('fn', () => 1);
    expect(payloadOf(debug)).toContain('=>');
  });
});
