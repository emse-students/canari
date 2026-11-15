// @vitest-environment happy-dom
/**
 * What a debug line must carry for a reader that is not DevTools.
 *
 * These assert the ONE property the logger exists for outside a browser panel: the payload has to be
 * IN the line. The regression they pin is a line reading `[tag] Object` - which is what every text
 * consumer of `console.debug(msg, payload)` receives, the cross-client harness included, and which
 * cost seven DEL rows a clean window on 2026-09-05.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relativeTo, sourceFiles } from '../../test/sourceTree';
import { Log } from './Log';

/** The rendered part of the one console.debug call, with the `[timestamp] [tag] ` prefix removed. */
function payloadOf(spy: ReturnType<typeof vi.spyOn>): string {
  expect(spy).toHaveBeenCalledTimes(1);
  const first = String(spy.mock.calls[0][0]);
  return first.replace(/^\[[^\]]+\] ?/, '');
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

  it('writes no timestamp of its own - the console stamps the line', () => {
    Log.d('CHANNEL', 'x');
    expect(String(debug.mock.calls[0][0])).toBe('[CHANNEL] x');
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

  it('renders bytes as their size, never their content - a key would be spelled out', () => {
    Log.d('key', { cek: new Uint8Array([201, 202, 203]), raw: new ArrayBuffer(16) });
    expect(payloadOf(debug)).toBe('{"cek":"[bytes:3]","raw":"[bytes:16]"}');
  });

  it('renders a value JSON cannot express rather than dropping the payload', () => {
    Log.d('fn', () => 1);
    expect(payloadOf(debug)).toContain('=>');
  });
});

describe('Log with a message and a detail', () => {
  it('renders `[tag] message detail` for all three levels, the two-argument form unchanged', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      Log.d('dir', 'search failed', { n: 2 });
      Log.i('dir', 'search failed', { n: 2 });
      Log.w('dir', 'search failed', { n: 2 });
      expect(debug.mock.calls[0]).toEqual(['[dir] search failed {"n":2}']);
      expect(info.mock.calls[0]).toEqual(['[dir] search failed {"n":2}']);
      expect(warn.mock.calls[0]).toEqual(['[dir] search failed {"n":2}']);

      Log.d('dir', 'search failed');
      Log.d('dir');
      expect(debug.mock.calls[1]).toEqual(['[dir] search failed']);
      expect(debug.mock.calls[2]).toEqual(['[dir]']);
    } finally {
      debug.mockRestore();
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it('hands an Error detail to the console as the same object, so its stack survives', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const err = new RangeError('boom');
      Log.d('cal', 'link candidates failed', err);
      expect(debug.mock.calls[0][0]).toBe('[cal] link candidates failed RangeError: boom');
      expect(debug.mock.calls[0][1]).toBe(err);
      // The tag is never the sentence: the first bracket pair closes right after the tag.
      expect(String(debug.mock.calls[0][0])).not.toMatch(/^\[\[/);
      Log.w('cal', 'link candidates failed', err);
      expect(warn.mock.calls[0][0]).toBe('[cal] link candidates failed RangeError: boom');
    } finally {
      debug.mockRestore();
      warn.mockRestore();
    }
  });
});

// Read from the run's shared source snapshot at module scope, never walked in a test body.
const APP_SOURCES = sourceFiles({
  under: 'src',
  extensions: ['ts', 'svelte'],
  tests: 'exclude',
  skipDirs: ['proto'],
}).map(({ path, text }) => ({ file: relativeTo(path, 'src'), text }));

/** Files calling `Log.d|i|w('[...` : the tag is the FIRST argument and Log wraps it in brackets itself. */
function bracketedTagCalls(files: ReadonlyArray<{ file: string; text: string }>) {
  return files.filter((f) => /\bLog\.[diw]\(\s*['"`]\[/.test(f.text)).map((f) => f.file);
}

describe('no Log call writes its own brackets', () => {
  it("finds none in the source (`Log.d('[tag] text')` renders `[[tag] text]`)", () => {
    expect(APP_SOURCES.length).toBeGreaterThan(100);
    expect(bracketedTagCalls(APP_SOURCES)).toEqual([]);
  });

  it('names the file of a planted offender', () => {
    const planted = [
      { file: 'bad.ts', text: "Log.d('[tag] text');" },
      { file: 'bad2.ts', text: "Log.w(\n  '[tag] text', err);" },
      { file: 'good.ts', text: "Log.d('tag', 'text', err);" },
    ];
    expect(bracketedTagCalls(planted)).toEqual(['bad.ts', 'bad2.ts']);
  });
});
