import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE LEAVE FLUSH IS HELD BY AN iOS BACKGROUND TASK FROM BEFORE IT STARTS TO AFTER IT SETTLES
 * (2026-11-02). Order, not time: every assertion is about what was called before what.
 */
let ios = true;
vi.mock('$lib/utils/appVersion', () => ({ isIosTauriRuntime: () => ios }));
const calls: string[] = [];
let grant: number | null = 7;
const invoke = vi.fn(async (command: string, args: Record<string, unknown>) => {
  calls.push(`${command}:${JSON.stringify(args)}`);
  if (command === 'begin_background_flush') return grant;
  return undefined;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (c: string, a: any) => invoke(c, a) }));

const { holdWhileLeaving } = await import('./backgroundFlush');

beforeEach(() => {
  ios = true;
  grant = 7;
  calls.length = 0;
  invoke.mockClear();
});

describe('holdWhileLeaving', () => {
  it('asks for the hold BEFORE the work and ends it AFTER the work settled', async () => {
    await holdWhileLeaving('read mark', async () => {
      calls.push('work');
    });
    expect(calls).toEqual([
      'begin_background_flush:{"reason":"read mark"}',
      'work',
      'end_background_flush:{"hold":7,"outcome":"done"}',
    ]);
  });

  it('ends the hold as failed when the work throws, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await holdWhileLeaving('read mark', async () => {
      throw new Error('offline');
    });
    expect(calls.at(-1)).toBe('end_background_flush:{"hold":7,"outcome":"failed"}');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('ends nothing when iOS refused the hold - the work still runs', async () => {
    grant = null;
    let ran = false;
    await holdWhileLeaving('read mark', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(calls).toEqual(['begin_background_flush:{"reason":"read mark"}']);
  });

  it('asks nothing native off iOS', async () => {
    ios = false;
    let ran = false;
    await holdWhileLeaving('read mark', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("is what MainChatPage's off-screen edge runs, around the mark's delivery and the outbox flush", () => {
    const source = readFileSync('src/lib/components/MainChatPage.svelte', 'utf8');
    const start = source.indexOf('const offScreenChange = onAppScreenChange(');
    const handler = source.slice(start, source.indexOf('\n    });', start));
    const hold = handler.indexOf('holdWhileLeaving(');
    expect(hold).toBeGreaterThan(-1);
    const inside = handler.slice(hold);
    expect(inside).toContain('readMarks.flush();');
    expect(inside).toContain('flushOwedSalonMarks(reader)');
    expect(inside).toContain('getOutbox()?.flush()');
  });
});
