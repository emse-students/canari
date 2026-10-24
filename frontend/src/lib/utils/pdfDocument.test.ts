// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A pdf.js stand-in: the page's `getPage` and `render` settle only when a test says so, so a cancel
 * can be placed before the page loads, during the render, or after it.
 */
class FakeCancelled extends Error {}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const state = {
  getPage: deferred<unknown>(),
  render: deferred<void>(),
  renderCalls: 0,
  renderCancels: 0,
  cleanupResult: true,
  cleanups: 0,
};

/** A text item as pdf.js gives it: `str`, a baseline transform, a width in page units, `hasEOL`. */
const textItem = (str: string, hasEOL: boolean) => ({
  str,
  hasEOL,
  width: str.length * 6,
  transform: [10, 0, 0, 10, 50, 700],
});

const page = {
  getViewport: ({ scale }: { scale: number }) => ({
    width: 600 * scale,
    height: 800 * scale,
    transform: [scale, 0, 0, -scale, 0, 800 * scale],
  }),
  getTextContent: async () => ({
    items: [
      textItem('les', true),
      textItem('autres', false),
      textItem('Grandes Ecoles', false),
      textItem('', true),
      { type: 'beginMarkedContent' },
      textItem('fin', false),
    ],
  }),
  render: () => {
    state.renderCalls += 1;
    return {
      promise: state.render.promise,
      cancel: () => {
        state.renderCancels += 1;
        // pdf.js rejects the render promise with its own exception type when cancelled.
        state.render.reject(new FakeCancelled('Rendering cancelled'));
      },
    };
  },
  cleanup: () => {
    state.cleanups += 1;
    return state.cleanupResult;
  },
};

/** Every worker pdf.js was asked to start, and the worker each `getDocument` was handed. */
const workers = {
  created: [] as FakeWorker[],
  handed: [] as unknown[],
  failNext: false,
};
class FakeWorker {
  promise: Promise<void>;
  port = new EventTarget();
  destroyed = false;
  destroy() {
    this.destroyed = true;
  }
  constructor() {
    workers.created.push(this);
    this.promise = workers.failNext
      ? Promise.reject(new Error('worker failed'))
      : Promise.resolve();
    workers.failNext = false;
  }
}

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  RenderingCancelledException: FakeCancelled,
  PDFWorker: FakeWorker,
  getDocument: (params: { worker?: unknown }) => {
    workers.handed.push(params.worker);
    return {
      promise: Promise.resolve({ numPages: 3, getPage: () => state.getPage.promise }),
      destroy: async () => {},
    };
  },
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'worker.mjs' }));

import { openPdfDocument, PdfRenderCancelled } from './pdfDocument';
import { flushMacrotask } from '../../test/flush';

beforeEach(() => {
  state.getPage = deferred();
  state.render = deferred();
  state.renderCalls = 0;
  state.renderCancels = 0;
  state.cleanupResult = true;
  state.cleanups = 0;
});

/** Lets every pending microtask run. */
const flush = () => flushMacrotask();

describe('PdfDocument.renderPage', () => {
  it('resolves with the canvas, sized by the render scale', async () => {
    const doc = await openPdfDocument('blob:x');
    const handle = doc.renderPage(1, { cssWidth: 300 });
    state.getPage.resolve(page);
    await flush();
    state.render.resolve();
    const rendered = await handle.promise;
    expect(rendered.canvas.width).toBe(rendered.width);
    expect(rendered.width).toBeGreaterThan(0);
  });

  it('a cancel BEFORE the page loads never starts the render, and rejects as cancelled', async () => {
    const doc = await openPdfDocument('blob:x');
    const handle = doc.renderPage(1, { cssWidth: 300 });
    handle.cancel();
    state.getPage.resolve(page);
    await expect(handle.promise).rejects.toBeInstanceOf(PdfRenderCancelled);
    expect(state.renderCalls).toBe(0);
  });

  it('a cancel DURING the render cancels the pdf.js task and frees the canvas', async () => {
    const created: HTMLCanvasElement[] = [];
    const create = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = create(tag);
      if (tag === 'canvas') created.push(el as HTMLCanvasElement);
      return el;
    }) as typeof document.createElement);
    const doc = await openPdfDocument('blob:x');
    const handle = doc.renderPage(1, { cssWidth: 300 });
    spy.mockRestore();
    state.getPage.resolve(page);
    await flush();
    expect(state.renderCalls).toBe(1);
    expect(created[0].width).toBeGreaterThan(0);
    handle.cancel();
    await expect(handle.promise).rejects.toBeInstanceOf(PdfRenderCancelled);
    expect(state.renderCancels).toBe(1);
    expect(created[0].width).toBe(0);
    expect(created[0].height).toBe(0);
  });

  it("types pdf.js's own cancellation as PdfRenderCancelled even without our cancel", async () => {
    const doc = await openPdfDocument('blob:x');
    const handle = doc.renderPage(1, { cssWidth: 300 });
    state.getPage.resolve(page);
    await flush();
    state.render.reject(new FakeCancelled('cancelled elsewhere'));
    await expect(handle.promise).rejects.toBeInstanceOf(PdfRenderCancelled);
  });

  it('passes a real failure through untyped, so the caller reports it', async () => {
    const doc = await openPdfDocument('blob:x');
    const handle = doc.renderPage(1, { cssWidth: 300 });
    state.getPage.resolve(page);
    await flush();
    state.render.reject(new Error('broken page'));
    await expect(handle.promise).rejects.toThrow('broken page');
    await expect(handle.promise).rejects.not.toBeInstanceOf(PdfRenderCancelled);
  });

  it('refuses to render from a destroyed document', async () => {
    const doc = await openPdfDocument('blob:x');
    await doc.destroy();
    await expect(doc.renderPage(1, { cssWidth: 300 }).promise).rejects.toThrow('already destroyed');
  });

  it('a second cancel is harmless', async () => {
    const doc = await openPdfDocument('blob:x');
    const handle = doc.renderPage(1, { cssWidth: 300 });
    state.getPage.resolve(page);
    await flush();
    handle.cancel();
    handle.cancel();
    await expect(handle.promise).rejects.toBeInstanceOf(PdfRenderCancelled);
    expect(state.renderCancels).toBe(1);
  });
});

describe('PdfDocument.releasePage', () => {
  it("drops the page's pdf.js caches", async () => {
    const doc = await openPdfDocument('blob:x');
    state.getPage.resolve(page);
    doc.releasePage(2);
    await flush();
    expect(state.cleanups).toBe(1);
  });

  it('does nothing on a destroyed document', async () => {
    const doc = await openPdfDocument('blob:x');
    await doc.destroy();
    state.getPage.resolve(page);
    doc.releasePage(2);
    await flush();
    expect(state.cleanups).toBe(0);
  });
});

describe('PdfDocument.getPageText', () => {
  it('keeps where each line ends, so a copy does not join two lines ("lesautres")', async () => {
    const doc = await openPdfDocument('blob:x');
    state.getPage.resolve(page);
    const runs = await doc.getPageText(1);
    expect(runs.map((run) => [run.text, run.eol])).toEqual([
      ['les', true],
      ['autres', false],
      // An EMPTY item that ends a line gives its line end to the run before it.
      ['Grandes Ecoles', true],
      ['fin', false],
    ]);
  });
});

describe('the pdf.js worker', () => {
  it('is ONE for every document, and outlives each document destroyed on it', async () => {
    vi.resetModules();
    workers.created = [];
    workers.handed = [];
    const fresh = await import('./pdfDocument');
    // Three thumbnails and a reader, opened and closed the way a salon with PDFs does.
    for (let i = 0; i < 4; i += 1) {
      const doc = await fresh.openPdfDocument(`blob:${i}`);
      await doc.destroy();
    }
    expect(workers.created).toHaveLength(1);
    expect(workers.handed).toHaveLength(4);
    expect(new Set(workers.handed)).toEqual(new Set([workers.created[0]]));
  });

  it('is dropped and torn down when it raises an error after start-up', async () => {
    vi.resetModules();
    workers.created = [];
    workers.handed = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fresh = await import('./pdfDocument');
    await fresh.openPdfDocument('blob:a');
    await flush();
    workers.created[0].port.dispatchEvent(new Event('error'));
    await fresh.openPdfDocument('blob:b');
    expect(workers.created).toHaveLength(2);
    expect(workers.created[0].destroyed).toBe(true);
    expect(workers.handed).toEqual([workers.created[0], workers.created[1]]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('raised an error'),
      expect.anything()
    );
    warn.mockRestore();
  });

  it('is not kept when its start-up failed, so the next document starts another', async () => {
    vi.resetModules();
    workers.created = [];
    workers.handed = [];
    workers.failNext = true;
    const fresh = await import('./pdfDocument');
    await fresh.openPdfDocument('blob:a');
    await flush();
    await fresh.openPdfDocument('blob:b');
    expect(workers.created).toHaveLength(2);
    expect(workers.handed).toEqual([workers.created[0], workers.created[1]]);
  });
});
