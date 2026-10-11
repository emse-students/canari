import { describe, expect, it } from 'vitest';
import {
  bitmapBytes,
  MAX_PDF_RENDER_SCALE,
  PAGE_PIXEL_BUDGET,
  pageDistance,
  planEviction,
  RenderQueue,
  renderScale,
  wantedJobs,
  type RenderJob,
  type RunningRender,
} from './pdfRenderQueue';

/** A4 in PDF points. */
const A4 = { w: 595, h: 842 };

describe('renderScale', () => {
  it('fits the CSS width at the device pixel ratio below the cap', () => {
    // The Mi 9T's fit-width page: 420 CSS px at dpr 2.475 is ~1040 device px.
    const scale = renderScale(A4.w, A4.h, 420, 2.475);
    expect(Math.round(A4.w * scale)).toBe(1040);
  });

  it('caps the bitmap at the per-page pixel budget when zoomed in', () => {
    // x3 on the same phone asked for 2381 x 3367 (8 MP) before the cap.
    const scale = renderScale(A4.w, A4.h, 1260, 2.475);
    const pixels = A4.w * scale * (A4.h * scale);
    expect(pixels).toBeLessThanOrEqual(PAGE_PIXEL_BUDGET + 1);
    expect(pixels).toBeGreaterThan(PAGE_PIXEL_BUDGET * 0.99);
  });

  it('honours a smaller budget, which is what a preview is', () => {
    const scale = renderScale(A4.w, A4.h, 420, 2.475, 60_000);
    expect(A4.w * scale * (A4.h * scale)).toBeLessThanOrEqual(60_001);
  });

  it('never exceeds the absolute scale cap on a tiny page', () => {
    expect(renderScale(10, 10, 2000, 3)).toBe(MAX_PDF_RENDER_SCALE);
  });

  it('answers 1 rather than NaN or Infinity for a degenerate box', () => {
    expect(renderScale(0, 842, 420, 2)).toBe(1);
    expect(renderScale(595, 842, 0, 2)).toBe(1);
    expect(renderScale(Number.NaN, 842, 420, 2)).toBe(1);
  });
});

describe('pageDistance', () => {
  const visible = { first: 4, last: 6 };
  it('is 0 inside the visible range and counts pages outside it', () => {
    expect(pageDistance(5, visible)).toBe(0);
    expect(pageDistance(4, visible)).toBe(0);
    expect(pageDistance(2, visible)).toBe(2);
    expect(pageDistance(9, visible)).toBe(3);
  });
  it('treats every page alike when nothing is visible yet', () => {
    expect(pageDistance(40, { first: 0, last: -1 })).toBe(0);
  });
});

describe('planEviction', () => {
  const page = bitmapBytes(1040, 1470);
  const resident = [0, 1, 2, 3, 10, 11, 12].map((index) => ({ index, bytes: page }));

  it('evicts nothing under budget', () => {
    expect(planEviction(resident, page * 7, { first: 10, last: 11 })).toEqual([]);
  });

  it('evicts the farthest pages first, until the rest fit', () => {
    expect(planEviction(resident, page * 5, { first: 10, last: 11 })).toEqual([0, 1]);
  });

  it('never evicts a visible page, even when that leaves the budget exceeded', () => {
    const evict = planEviction(resident, 0, { first: 10, last: 11 });
    expect(evict).not.toContain(10);
    expect(evict).not.toContain(11);
    expect(evict).toHaveLength(5);
  });
});

describe('wantedJobs', () => {
  const visible = { first: 3, last: 3 };

  it('orders a visible preview, then its sharp render, then the neighbours', () => {
    const jobs = wantedJobs(
      [
        { index: 4, hasPreview: false, sharpWidth: null },
        { index: 3, hasPreview: false, sharpWidth: null },
      ],
      visible,
      420,
      true
    );
    expect(jobs.map((j) => j.key)).toEqual(['p3', 's3@420', 'p4', 's4@420']);
  });

  it('asks for nothing a page already has', () => {
    expect(
      wantedJobs([{ index: 3, hasPreview: true, sharpWidth: 420 }], visible, 420, true)
    ).toEqual([]);
  });

  it('re-renders sharp for the visible page only once zoomed in', () => {
    const jobs = wantedJobs(
      [
        { index: 3, hasPreview: true, sharpWidth: 420 },
        { index: 4, hasPreview: true, sharpWidth: 420 },
      ],
      visible,
      1260,
      false
    );
    expect(jobs.map((j) => j.key)).toEqual(['s3@1260']);
  });
});

/** A controllable fake render: settles when the test says so, records cancels. */
function harness(concurrency = 2) {
  const started: string[] = [];
  const cancelled: string[] = [];
  const finish = new Map<string, () => void>();
  const queue = new RenderQueue((job: RenderJob): RunningRender => {
    started.push(job.key);
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    finish.set(job.key, resolve);
    return {
      cancel: () => {
        cancelled.push(job.key);
        reject(new Error('cancelled'));
      },
      done,
    };
  }, concurrency);
  return { queue, started, cancelled, finish };
}

const job = (index: number, priority = index): RenderJob => ({
  key: `s${index}@420`,
  index,
  kind: 'sharp',
  width: 420,
  priority,
});

describe('RenderQueue', () => {
  it('runs at most `concurrency` renders, highest priority first', () => {
    const h = harness(2);
    h.queue.want([job(5, 2), job(1, 0), job(3, 1)]);
    expect(h.started).toEqual(['s1@420', 's3@420']);
    expect(h.queue.pendingKeys).toEqual(['s5@420']);
  });

  it('starts the next one when a render finishes', async () => {
    const h = harness(1);
    h.queue.want([job(1), job(2)]);
    h.finish.get('s1@420')!();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.started).toEqual(['s1@420', 's2@420']);
  });

  it('cancels a running render that is no longer wanted, and drops unwanted pending ones', () => {
    const h = harness(1);
    h.queue.want([job(1), job(2), job(3)]);
    // A fling: the reader is now at page 40.
    h.queue.want([job(40, 0)]);
    expect(h.cancelled).toEqual(['s1@420']);
    expect(h.started).toEqual(['s1@420', 's40@420']);
    expect(h.queue.pendingKeys).toEqual([]);
  });

  it('never starts a job twice while it is running', () => {
    const h = harness(2);
    h.queue.want([job(1)]);
    h.queue.want([job(1), job(2)]);
    expect(h.started).toEqual(['s1@420', 's2@420']);
  });

  it('keeps a re-wanted key running when the cancelled run of the same key settles late', async () => {
    const h = harness(1);
    h.queue.want([job(1)]);
    h.queue.want([]);
    h.queue.want([job(1)]);
    // The first run's rejection lands now; the second, still-running one must stay accounted for.
    await Promise.resolve();
    await Promise.resolve();
    expect(h.queue.runningKeys).toEqual(['s1@420']);
  });

  it('clear cancels everything', () => {
    const h = harness(2);
    h.queue.want([job(1), job(2), job(3)]);
    h.queue.clear();
    expect(h.cancelled).toEqual(['s1@420', 's2@420']);
    expect(h.queue.runningKeys).toEqual([]);
    expect(h.queue.pendingKeys).toEqual([]);
  });
});
