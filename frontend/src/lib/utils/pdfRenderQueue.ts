/**
 * The PDF reader's render scheduling, as pure decisions: what to render, in which order, at which
 * scale, and which bitmaps to drop - with the DOM and pdf.js injected, so all of it is testable.
 *
 * Why it exists (measured on a Mi 9T, 2026-10-11, an 81-page scanned magazine): the reader used to
 * start a render for EVERY page an `IntersectionObserver` reported, never cancelled one, kept every
 * bitmap for ever and re-rendered every nearby page on each zoom step. A fling to the end of the
 * document queued 57 renders and left the page the reader landed on white for 26 s; three zoom
 * clicks froze the page for a minute and took the renderer from 198 MB to 1.98 GB. The rules below
 * are what bounds each of those: a concurrency limit, cancellation of what left the window, a
 * per-page pixel cap and a byte budget with farthest-first eviction.
 */

/** Largest bitmap one page may have, in device pixels (about 24 MB of RGBA). */
export const PAGE_PIXEL_BUDGET = 6_000_000;

/** Bytes all sharp page bitmaps together may hold before the farthest ones are dropped. */
export const VIEWER_BYTE_BUDGET = 96 * 1024 * 1024;

/**
 * Pixel size of a page's PREVIEW, the cheap bitmap shown until the sharp one lands and kept after
 * that one is evicted, so a page the reader scrolls back to is blurry rather than blank. About a
 * quarter of a phone's fit-width scale in each dimension (~205 x 290 for A4), ~240 KB a page.
 */
export const PREVIEW_PIXEL_BUDGET = 60_000;

/**
 * Bytes all previews together may hold - about 100 pages' worth - before the farthest are dropped.
 *
 * Previews are cheap, not free: a 600-page document would hold ~140 MB of them. On an iPhone every
 * canvas counts against WebKit's canvas memory limit (Safari's console names 384 MB when a page
 * exceeds it, and the canvas then draws nothing), so the three pools are sized to stay well under
 * it together: this, {@link VIEWER_BYTE_BUDGET} and {@link RENDER_CONCURRENCY} renders in flight
 * at {@link PAGE_PIXEL_BUDGET} each.
 */
export const PREVIEW_BYTE_BUDGET = 24 * 1024 * 1024;

/** WebKit's canvas memory limit on iOS, the ceiling every budget above must stay under together. */
export const WEBKIT_CANVAS_MEMORY_LIMIT = 384 * 1024 * 1024;

/** Renders running at once. pdf.js parses on ONE worker and paints on the main thread, so more
 *  than two only interleaves work and delays every page instead of finishing the first. */
export const RENDER_CONCURRENCY = 2;

/** Upper bound on the render scale, so a tiny page box cannot ask for an absurd zoom. */
export const MAX_PDF_RENDER_SCALE = 4;

/**
 * The scale at which to rasterise a page: fit `cssWidth` at the device pixel ratio, but never more
 * than `maxPixels` in total nor more than {@link MAX_PDF_RENDER_SCALE}.
 *
 * The pixel cap is what makes a zoom affordable: at x3 a phone asked for a 2381 x 3367 bitmap
 * (8 MP, 32 MB) per page. Above the cap the browser stretches the bitmap, which at that size is
 * already beyond what the screen can show at once.
 *
 * @param baseWidth - Page width at scale 1, in PDF points.
 * @param baseHeight - Page height at scale 1, in PDF points.
 * @param cssWidth - CSS width the page is displayed at.
 * @param dpr - Device pixel ratio.
 * @param maxPixels - Pixel cap for this bitmap.
 */
export function renderScale(
  baseWidth: number,
  baseHeight: number,
  cssWidth: number,
  dpr: number,
  maxPixels: number = PAGE_PIXEL_BUDGET
): number {
  if (!(baseWidth > 0) || !(baseHeight > 0) || !(cssWidth > 0)) return 1;
  const fit = (cssWidth * (dpr > 0 ? dpr : 1)) / baseWidth;
  const capped = Math.sqrt(maxPixels / (baseWidth * baseHeight));
  return Math.min(fit, capped, MAX_PDF_RENDER_SCALE);
}

/** Bytes an RGBA bitmap of this size holds. */
export function bitmapBytes(width: number, height: number): number {
  return Math.max(0, width) * Math.max(0, height) * 4;
}

/** The pages currently intersecting the viewport, as an inclusive 0-based range. */
export interface VisibleRange {
  first: number;
  last: number;
}

/**
 * How far a page is from what the reader sees, in pages: 0 inside the visible range.
 * An empty range (`first > last`) makes every page equally far, which keeps the order stable.
 */
export function pageDistance(index: number, visible: VisibleRange): number {
  if (visible.first > visible.last) return 0;
  if (index < visible.first) return visible.first - index;
  if (index > visible.last) return index - visible.last;
  return 0;
}

/** One page bitmap held in memory. */
export interface ResidentBitmap {
  index: number;
  bytes: number;
}

/**
 * Which bitmaps to drop so the rest fit in `budget`, farthest from the visible range first.
 *
 * A visible page is never evicted, even over budget: dropping what the reader is looking at would
 * swap it for its blurry preview under their eyes, and the visible set is at most a few pages.
 *
 * @returns 0-based page indices to evict, in eviction order.
 */
export function planEviction(
  resident: readonly ResidentBitmap[],
  budget: number,
  visible: VisibleRange
): number[] {
  let total = resident.reduce((sum, r) => sum + r.bytes, 0);
  if (total <= budget) return [];
  const candidates = resident
    .filter((r) => pageDistance(r.index, visible) > 0)
    .sort((a, b) => pageDistance(b.index, visible) - pageDistance(a.index, visible));
  const evict: number[] = [];
  for (const c of candidates) {
    if (total <= budget) break;
    evict.push(c.index);
    total -= c.bytes;
  }
  return evict;
}

/** What a page needs rendered, as the viewer knows it at one moment. */
export interface PageNeed {
  index: number;
  /** Whether a preview bitmap exists. */
  hasPreview: boolean;
  /** CSS width the sharp bitmap was rendered for, or `null` if there is none. */
  sharpWidth: number | null;
}

/** One render the viewer wants. */
export interface RenderJob {
  /** Identity: a job with the same key is the same render, so it is never started twice. */
  key: string;
  index: number;
  kind: 'preview' | 'sharp';
  /** CSS width a sharp render is for; 0 for a preview, which has a fixed pixel budget. */
  width: number;
  /** Lower runs first. */
  priority: number;
}

/**
 * The renders wanted right now, for the pages within the observer's margin.
 *
 * Order: a visible page's preview, then its sharp render, then the same for the next page out -
 * so whatever the reader looks at is never blank for longer than one cheap preview pass.
 *
 * A page outside the visible range gets a sharp render only at the base zoom. Zoomed in, a sharp
 * bitmap is several times larger and slower, so it is spent on visible pages only; the others
 * keep showing their current bitmap, stretched, until they scroll into view.
 */
export function wantedJobs(
  near: readonly PageNeed[],
  visible: VisibleRange,
  width: number,
  isBaseZoom: boolean
): RenderJob[] {
  const jobs: RenderJob[] = [];
  for (const page of near) {
    const distance = pageDistance(page.index, visible);
    if (!page.hasPreview) {
      jobs.push({
        key: `p${page.index}`,
        index: page.index,
        kind: 'preview',
        width: 0,
        priority: distance * 2,
      });
    }
    if (page.sharpWidth !== width && (distance === 0 || isBaseZoom)) {
      jobs.push({
        key: `s${page.index}@${width}`,
        index: page.index,
        kind: 'sharp',
        width,
        priority: distance * 2 + 1,
      });
    }
  }
  return jobs.sort((a, b) => a.priority - b.priority);
}

/** A render in flight, as {@link RenderQueue} sees it. */
export interface RunningRender {
  /** Stops the render; `done` then settles (normally by rejecting). */
  cancel(): void;
  /** Settles when the render is over, whatever the outcome. */
  done: Promise<unknown>;
}

/**
 * Runs at most `concurrency` renders, always the highest-priority wanted ones, and cancels a
 * running render the moment it stops being wanted.
 *
 * The caller states WHAT it wants with {@link RenderQueue.want}, every time the view changes;
 * the queue works out what to start, keep or cancel. That is what makes a fling cheap: the pages
 * flown past are wanted for a few frames, and are cancelled or never started.
 */
export class RenderQueue {
  private pending: RenderJob[] = [];
  private readonly running = new Map<string, RunningRender>();

  /**
   * @param start - Begins one render. Must not throw; a failure belongs in `done`.
   * @param concurrency - Renders allowed at once.
   */
  constructor(
    private readonly start: (job: RenderJob) => RunningRender,
    private readonly concurrency: number = RENDER_CONCURRENCY
  ) {}

  /** Replaces the wanted set: unwanted pending jobs are dropped, unwanted running ones cancelled. */
  want(jobs: readonly RenderJob[]): void {
    const keys = new Set(jobs.map((j) => j.key));
    for (const [key, run] of this.running) {
      if (!keys.has(key)) {
        this.running.delete(key);
        run.cancel();
      }
    }
    this.pending = jobs
      .filter((j) => !this.running.has(j.key))
      .sort((a, b) => a.priority - b.priority);
    this.pump();
  }

  /** Cancels everything, running and pending. */
  clear(): void {
    this.pending = [];
    for (const run of this.running.values()) run.cancel();
    this.running.clear();
  }

  /** Keys of the renders in flight, for tests and logs. */
  get runningKeys(): string[] {
    return [...this.running.keys()];
  }

  /** Keys of the renders waiting, in start order. */
  get pendingKeys(): string[] {
    return this.pending.map((j) => j.key);
  }

  private pump(): void {
    while (this.running.size < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      const run = this.start(job);
      this.running.set(job.key, run);
      const settle = () => {
        // Only remove what is still THIS run: a cancelled key may already be re-wanted and running.
        if (this.running.get(job.key) === run) this.running.delete(job.key);
        this.pump();
      };
      run.done.then(settle, settle);
    }
  }
}

/**
 * The render width the queue may act on: the live width, but only once it has stopped moving.
 *
 * A zoom click changes the live width at once, and each step of a walk 1 -> 1.5 -> 2 -> 3 would
 * otherwise start - and then cancel - a round of sharp renders at a width nobody stays at. Only
 * this object's timer writes {@link SettledWidth.value}, and the scheduler reads nothing else. The
 * FIRST width is taken at once: there is nothing on screen yet to stretch, so waiting would only
 * delay the first page.
 */
export class SettledWidth {
  private settled: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param delayMs - How long the width must stay put.
   * @param onSettle - Called with the new settled width, from the timer (or at once the first time).
   */
  constructor(
    private readonly delayMs: number,
    private readonly onSettle: (width: number) => void
  ) {}

  /** The width renders are for; `null` until a first width was proposed. */
  get value(): number | null {
    return this.settled;
  }

  /** Reports the live width; settles at once the first time, after `delayMs` of quiet after that. */
  propose(width: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.settled === null) {
      this.settled = width;
      this.onSettle(width);
      return;
    }
    if (width === this.settled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.settled = width;
      this.onSettle(width);
    }, this.delayMs);
  }

  /** Drops a pending settle. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
