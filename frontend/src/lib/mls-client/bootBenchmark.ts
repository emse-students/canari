/**
 * Cold-start boot timing: from the page's navigation start to `MLS ready`.
 *
 * This is NOT {@link ./catchupBenchmark} with a different label, and the difference is the whole
 * reason it is a second file. The catch-up bench answers "how long did the sync take, per message,
 * per conversation" - it carries message counters, it measures DURATIONS with `Date.now()`, and it
 * holds one phase at a time. This one answers "at what moment in this page's life did each boot
 * step run", which needs the opposite of all three:
 *
 *  - every mark is an OFFSET FROM `performance.timeOrigin` (navigation start), so a line here and a
 *    line in a browser's HAR export are on the same clock and can be laid side by side. Reading a
 *    duration-only bench against a HAR is what turned a 94 ms origin round trip into a "56-60% of
 *    cold start" claim that was really 7%;
 *  - phases OVERLAP by design here. The gateway handshake is started ~200 ms before it is awaited
 *    and the revocation answer is deliberately held, so a single-active-phase model would close
 *    spans that are still running and report the concurrency as if it were sequence;
 *  - it carries no message counters, because none of them are evidence for this question.
 *
 * IT RECORDS UNCONDITIONALLY AND LOGS ONLY WHEN ASKED. The cost is a handful of numbers, and the
 * measurement that matters most - the FIRST cold start on a real device - is precisely the one that
 * cannot be captured by a flag that needs a reload to take effect. So the report is always there:
 *
 *   window.__canariBootBench.get()      // the report as JSON, on any build, no reload
 *   window.__canariBootBench.table()    // the same, as a console table
 *
 * To also print one summary line per boot:
 *   localStorage.setItem('canari_boot_bench', '1')
 */

/** A point in time during boot, as an offset in ms from navigation start. */
export interface BootBenchMark {
  name: string;
  /** Offset from `performance.timeOrigin`, i.e. the same zero a HAR uses. */
  atMs: number;
}

/** A timed span during boot. Spans may overlap: concurrency here is deliberate, not an artifact. */
export interface BootBenchSpan {
  name: string;
  /** Offset from navigation start at which the span opened. */
  startMs: number;
  /** Offset from navigation start at which the span closed; null while it is still running. */
  endMs: number | null;
  /** `endMs - startMs`, or null while the span is still running. */
  durationMs: number | null;
  meta?: Record<string, number | string | boolean>;
}

/**
 * What the browser itself did before the app ran a line, in the same units as everything else.
 *
 * This is here so the report answers the WHOLE question alone. The previous cold-start breakdown
 * needed a HAR export pulled out of a browser by hand and read against console timestamps, which is
 * both a thing to ask a person for and a second clock to get wrong. These four numbers are the ones
 * that breakdown actually used, and `PerformanceNavigationTiming` has been giving them away the
 * whole time.
 */
export interface BootBenchNavigation {
  /** Request sent -> first byte of the document. The origin round trip. */
  ttfbMs: number;
  /** First byte -> last byte of the document. */
  documentDownloadMs: number;
  /** Navigation start -> DOM parsed, i.e. when the module graph could start executing. */
  domContentLoadedMs: number;
  /** Navigation start -> `load`. Null when it has not fired yet, which is the usual case here. */
  loadEventMs: number | null;
}

/** One cold start, from navigation start to `MLS ready`. */
export interface BootBenchReport {
  /** True once `finishBootBench` has run; a report read before that is a boot in progress. */
  complete: boolean;
  /** Offset from navigation start at which `MLS ready` was reached, or null while booting. */
  mlsReadyAtMs: number | null;
  /** Wall-clock epoch ms of navigation start, so a report can be aligned with a server log. */
  timeOrigin: number;
  /** Null in a runtime with no navigation entry (a worker, or an unsupported engine). */
  navigation: BootBenchNavigation | null;
  marks: BootBenchMark[];
  spans: BootBenchSpan[];
}

const marks: BootBenchMark[] = [];
const spans: BootBenchSpan[] = [];
const openSpans = new Map<string, BootBenchSpan>();
let mlsReadyAtMs: number | null = null;
let devToolsInstalled = false;

/** Offset from navigation start, rounded to a tenth of a ms. */
function nowMs(): number {
  if (typeof performance === 'undefined') return 0;
  return Math.round(performance.now() * 10) / 10;
}

/** True when a boot summary line should also be printed to the console. */
function isBootBenchLogEnabled(): boolean {
  if (typeof localStorage !== 'undefined' && localStorage.getItem('canari_boot_bench') === '1') {
    return true;
  }
  return import.meta.env.DEV;
}

/**
 * Records a point event during boot.
 *
 * Use this for a boundary with no duration of its own - the first line the app executes, the moment
 * a route's data is in hand - where what matters is WHEN it happened relative to the document, not
 * how long it took.
 */
export function markBoot(name: string): void {
  if (mlsReadyAtMs !== null) return;
  marks.push({ name, atMs: nowMs() });
}

/**
 * Opens a named boot span. Overlapping spans are expected and are kept apart by name; opening a
 * name that is already open replaces it, because a boot step running twice before it closes means
 * the caller is naming two different things the same way.
 */
export function beginBootSpan(name: string): void {
  if (mlsReadyAtMs !== null) return;
  const span: BootBenchSpan = { name, startMs: nowMs(), endMs: null, durationMs: null };
  openSpans.set(name, span);
  spans.push(span);
}

/**
 * Closes a named boot span, optionally attaching what the step decided. A name that was never
 * opened is ignored rather than invented: a span with no start has no offset, and a fabricated one
 * would be indistinguishable from a real measurement in the report.
 */
export function endBootSpan(name: string, meta?: Record<string, number | string | boolean>): void {
  const span = openSpans.get(name);
  if (!span) return;
  openSpans.delete(name);
  span.endMs = nowMs();
  span.durationMs = Math.round((span.endMs - span.startMs) * 10) / 10;
  if (meta) span.meta = meta;
}

/**
 * Closes the boot measurement at `MLS ready`. Spans still open at this point keep `endMs: null` -
 * they really had not finished, and closing them here would report a wait that never happened.
 */
export function finishBootBench(): BootBenchReport {
  if (mlsReadyAtMs === null) mlsReadyAtMs = nowMs();
  const report = getBootReport();
  if (isBootBenchLogEnabled()) {
    try {
      console.info('[BOOT][BENCH]', formatBootBenchSummary(report));
    } catch {
      /* ignore */
    }
  }
  return report;
}

/** Reads the document's own timings, or null when this runtime exposes no navigation entry. */
function readNavigation(): BootBenchNavigation | null {
  if (typeof performance === 'undefined' || !performance.getEntriesByType) return null;
  const [nav] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
  if (!nav) return null;
  const round = (n: number): number => Math.round(n * 10) / 10;
  return {
    ttfbMs: round(nav.responseStart - nav.requestStart),
    documentDownloadMs: round(nav.responseEnd - nav.responseStart),
    domContentLoadedMs: round(nav.domContentLoadedEventEnd),
    // `loadEventEnd` is 0 until the event has fired, and boot routinely finishes first. Zero would
    // read as "instant", which is the opposite of "has not happened".
    loadEventMs: nav.loadEventEnd > 0 ? round(nav.loadEventEnd) : null,
  };
}

/** The boot report as it stands; readable mid-boot, in which case `complete` is false. */
export function getBootReport(): BootBenchReport {
  return {
    complete: mlsReadyAtMs !== null,
    mlsReadyAtMs,
    timeOrigin: typeof performance === 'undefined' ? 0 : Math.round(performance.timeOrigin),
    navigation: readNavigation(),
    marks: marks.slice(),
    spans: spans.map((s) => ({ ...s })),
  };
}

/**
 * Discards the current boot measurement. Exists for tests and for a second login inside one page
 * life; a boot is a property of a page load, so the ordinary path never calls this.
 */
export function resetBootBench(): void {
  marks.length = 0;
  spans.length = 0;
  openSpans.clear();
  mlsReadyAtMs = null;
}

/**
 * One line naming the total and the spans that make it up, longest first.
 *
 * IT PRINTS TWO TOTALS, AND THAT IS NOT REDUNDANCY. `loginImpl` also runs when someone enters their
 * PIN into a tab that has been open for half an hour, and the navigation-anchored total would then
 * read as a thirty-minute cold start. Rather than guess a threshold past which a boot "is not really
 * a boot" - a clock deciding the meaning of its own measurement - both anchors are stated: the
 * offset from navigation start, and the offset from the moment login actually began. On a cold start
 * they are close; on an idle tab they are wildly apart, and the reader can see which they are
 * holding without anything here having to decide it for them.
 */
export function formatBootBenchSummary(report: BootBenchReport): string {
  if (report.mlsReadyAtMs === null) return '(running)';
  const loginStart = report.marks.find((mk) => mk.name === 'login-start')?.atMs ?? null;
  const total =
    loginStart === null
      ? `${report.mlsReadyAtMs}ms to MLS ready`
      : `${report.mlsReadyAtMs}ms to MLS ready (${Math.round((report.mlsReadyAtMs - loginStart) * 10) / 10}ms of it after login-start @${loginStart})`;
  const ranked = report.spans
    .filter((s) => s.durationMs !== null)
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .map((s) => `${s.name} ${s.durationMs}ms @${s.startMs}`)
    .join(' | ');
  return ranked ? `${total} - ${ranked}` : total;
}

/**
 * Exposes the report on `window`, unconditionally. A cold start cannot be re-run with a flag set:
 * by the time anyone knows they wanted the measurement, the boot being asked about is over.
 */
export function installBootBenchDevTools(): void {
  if (devToolsInstalled || typeof window === 'undefined') return;
  devToolsInstalled = true;
  (window as unknown as Record<string, unknown>).__canariBootBench = {
    get: (): BootBenchReport => getBootReport(),
    summary: (): string => formatBootBenchSummary(getBootReport()),
    table: (): void => {
      console.table(getBootReport().spans);
      console.table(getBootReport().marks);
    },
    reset: resetBootBench,
  };
}
