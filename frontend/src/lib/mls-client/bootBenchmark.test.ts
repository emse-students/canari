import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginBootSpan,
  endBootSpan,
  finishBootBench,
  formatBootBenchSummary,
  getBootReport,
  markBoot,
  resetBootBench,
  timeBootSpan,
} from './bootBenchmark';

/**
 * NO DURATION IS ASSERTED HERE, and that is deliberate: every number in this module comes from
 * `performance.now()`, so asserting one would be asserting a wall clock. What is asserted is the
 * SHAPE - which spans exist, which are open, what order they rank in - because that is what the
 * report's readers reason about and what a refactor could silently break.
 */
describe('bootBenchmark', () => {
  beforeEach(() => {
    resetBootBench();
  });

  it('keeps overlapping spans apart by name instead of closing the previous one', () => {
    // This is the property the catch-up bench does NOT have, and the reason boot timing is a second
    // module: the gateway handshake and the MLS init genuinely run at the same time, and a
    // single-active-phase model would report that concurrency as a sequence.
    beginBootSpan('outer');
    beginBootSpan('inner');
    endBootSpan('inner');
    endBootSpan('outer');

    const { spans } = getBootReport();
    expect(spans.map((s) => s.name)).toEqual(['outer', 'inner']);
    expect(spans.every((s) => s.endMs !== null)).toBe(true);
    expect(spans.find((s) => s.name === 'inner')?.startMs).toBeGreaterThanOrEqual(
      spans.find((s) => s.name === 'outer')?.startMs ?? 0
    );
  });

  it('leaves a span that was still running open rather than closing it at MLS ready', () => {
    // A span closed by `finishBootBench` would report a wait that never happened. An unfinished
    // step is a fact about the boot, not a gap in the instrument.
    beginBootSpan('finished');
    endBootSpan('finished');
    beginBootSpan('still-running');

    const report = finishBootBench();
    const running = report.spans.find((s) => s.name === 'still-running');
    expect(running?.endMs).toBeNull();
    expect(running?.durationMs).toBeNull();
    expect(report.spans.find((s) => s.name === 'finished')?.endMs).not.toBeNull();
    expect(report.complete).toBe(true);
    expect(report.mlsReadyAtMs).not.toBeNull();
  });

  it('records nothing for a span that was never opened', () => {
    // A span with no start has no offset. Inventing one would be indistinguishable from a real
    // measurement in the report, which is worse than the missing row.
    endBootSpan('never-opened');
    expect(getBootReport().spans).toHaveLength(0);
  });

  it('ignores marks and spans opened after the boot window has closed', () => {
    markBoot('during');
    finishBootBench();
    markBoot('after');
    beginBootSpan('after');

    const { marks, spans } = getBootReport();
    expect(marks.map((m) => m.name)).toEqual(['during']);
    expect(spans).toHaveLength(0);
  });

  it('reports a boot in progress as incomplete', () => {
    markBoot('login-start');
    const report = getBootReport();
    expect(report.complete).toBe(false);
    expect(report.mlsReadyAtMs).toBeNull();
    expect(formatBootBenchSummary(report)).toContain('(running)');
  });

  it('ranks the summary by duration so the most expensive step is read first', () => {
    // The summary exists to be pasted into a conversation, so the order is the message.
    const report = {
      complete: true,
      mlsReadyAtMs: 580,
      timeOrigin: 0,
      navigation: null,
      marks: [],
      spans: [
        { name: 'cheap', startMs: 0, endMs: 5, durationMs: 5 },
        { name: 'expensive', startMs: 5, endMs: 405, durationMs: 400 },
        { name: 'open', startMs: 10, endMs: null, durationMs: null },
      ],
    };

    const summary = formatBootBenchSummary(report);
    expect(summary.indexOf('expensive')).toBeLessThan(summary.indexOf('cheap'));
    expect(summary).toContain('580ms to MLS ready');
    // An unfinished span has no duration to rank on and is left out of the ranking.
    expect(summary).not.toContain('open');
  });

  it('states both anchors so an idle tab cannot be read as a half-hour cold start', () => {
    // `loginImpl` also runs when someone types their PIN into a tab left open for half an hour.
    // Rather than pick a threshold past which a boot "is not really a boot", the summary prints the
    // offset from navigation AND the offset from the moment login began; on an idle tab the two are
    // wildly apart and the reader can see it.
    const idle = {
      complete: true,
      mlsReadyAtMs: 1_800_580,
      timeOrigin: 0,
      navigation: null,
      marks: [{ name: 'login-start', atMs: 1_800_000 }],
      spans: [],
    };

    const summary = formatBootBenchSummary(idle);
    expect(summary).toContain('1800580ms to MLS ready');
    expect(summary).toContain('580ms of it after login-start');
  });

  it('copies spans out of the report so a later close cannot rewrite a report already read', () => {
    beginBootSpan('held');
    const before = getBootReport();
    endBootSpan('held');

    expect(before.spans[0].endMs).toBeNull();
    expect(getBootReport().spans[0].endMs).not.toBeNull();
  });

  it('times a promise without changing what the caller receives', async () => {
    const value = await timeBootSpan('work', Promise.resolve('the caller sees this'));

    expect(value).toBe('the caller sees this');
    const [span] = getBootReport().spans;
    expect(span.name).toBe('work');
    expect(span.durationMs).not.toBeNull();
  });

  it('closes the span on a rejection and re-throws the original error', async () => {
    const boom = new Error('init failed');

    await expect(timeBootSpan('failing', Promise.reject(boom))).rejects.toBe(boom);

    const [span] = getBootReport().spans;
    expect(span.durationMs).not.toBeNull();
    expect(span.meta).toEqual({ rejected: true });
  });

  it('leaves a span OPEN when its promise is still running at MLS ready', async () => {
    // THE FIRE-AND-FORGET WRITE IS THE REASON THIS SHAPE EXISTS. `TauriMlsService` starts the
    // snapshot write and never awaits it, so a report that closed it at `MLS ready` would claim a
    // duration the boot never waited for. Open is the honest answer.
    let release: (() => void) | undefined;
    const never = new Promise<void>((resolve) => {
      release = resolve;
    });
    void timeBootSpan('write', never);
    finishBootBench();

    const report = getBootReport();
    expect(report.spans.find((s) => s.name === 'write')?.endMs).toBeNull();
    expect(formatBootBenchSummary(report)).not.toContain('write');

    release?.();
    await never;
  });

  it('records nothing for work started after the boot is over', async () => {
    finishBootBench();
    await timeBootSpan('late', Promise.resolve(1));

    expect(getBootReport().spans).toHaveLength(0);
  });
});
