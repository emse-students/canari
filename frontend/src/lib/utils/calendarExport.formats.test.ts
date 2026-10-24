// @vitest-environment happy-dom
/**
 * THE PDF AND THE PNG ARE ONE SHEET (2026-10-18). Pinned: `exportCalendarMonth` builds the sheet
 * once per call through `withRenderedSheet`, and the PDF writer and the PNG rasteriser receive the
 * SAME markup - so the two files cannot disagree on layout. The PNG is saved through the same
 * `downloadDecryptedFile` as the PDF (the OS save dialog on a phone), named by month and year, at a
 * raster scale that follows the screen and never exceeds what the PDF already costs.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  pdf: vi.fn((el: HTMLElement, opts: { filename: string; rasterScale?: number }) => {
    calls.pdfHtml = el.innerHTML;
    calls.pdfOpts = opts;
    return Promise.resolve();
  }),
  raster: vi.fn((el: HTMLElement, opts: { scale?: number }) => {
    calls.pngHtml = el.innerHTML;
    calls.pngScale = opts.scale;
    return Promise.resolve({ width: 10, height: 7 } as HTMLCanvasElement);
  }),
  save: vi.fn((_blob: Blob, _name: string) => Promise.resolve()),
  pdfHtml: '',
  pngHtml: '',
  pdfOpts: null as null | { filename: string; rasterScale?: number },
  pngScale: undefined as number | undefined,
}));

vi.mock('$lib/pdf/searchableRaster', () => ({ exportSearchablePdf: calls.pdf }));
vi.mock('$lib/utils/pdfRaster', () => ({
  rasterizeElementToCanvas: calls.raster,
  canvasToPngBlob: () => Promise.resolve(new Blob(['png'], { type: 'image/png' })),
}));
vi.mock('$lib/utils/fileDownload', () => ({ downloadDecryptedFile: calls.save }));

import {
  calendarExportFilename,
  exportCalendarMonth,
  pngRasterScale,
  PNG_MAX_RASTER_SCALE,
} from './calendarExport';

afterEach(() => {
  calls.pdf.mockClear();
  calls.raster.mockClear();
  calls.save.mockClear();
  document.body.innerHTML = '';
});

describe('one render path for both formats', () => {
  it('hands the PDF writer and the PNG rasteriser the same sheet', async () => {
    const november = new Date(2026, 10, 1);
    await exportCalendarMonth([], november, {}, 'pdf');
    expect(calls.pdfOpts?.filename).toBe('canari-agenda-2026-11');
    expect(calls.pdfOpts?.rasterScale).toBe(3);
    await exportCalendarMonth([], november, {}, 'png');

    expect(calls.pdf).toHaveBeenCalledTimes(1);
    expect(calls.raster).toHaveBeenCalledTimes(1);
    expect(calls.pngHtml).not.toBe('');
    expect(calls.pngHtml).toBe(calls.pdfHtml);
    // The offscreen sheet is removed whichever format was written.
    expect(document.body.children).toHaveLength(0);
  });

  it('saves the PNG through the download path, named by month and year', async () => {
    await exportCalendarMonth([], new Date(2026, 10, 1), {}, 'png');
    expect(calls.save).toHaveBeenCalledTimes(1);
    const [blob, name] = calls.save.mock.calls[0];
    expect(name).toBe('canari-agenda-2026-11.png');
    expect(blob.type).toBe('image/png');
    expect(calendarExportFilename(2026, 10)).toBe('canari-agenda-2026-11');
    expect(calls.pngScale).toBe(pngRasterScale(window.devicePixelRatio));
  });

  it('removes the sheet even when the writer throws', async () => {
    calls.raster.mockImplementationOnce(() => Promise.reject(new Error('too big')));
    await expect(exportCalendarMonth([], new Date(2026, 10, 1), {}, 'png')).rejects.toThrow(
      'too big'
    );
    expect(document.body.children).toHaveLength(0);
    expect(calls.save).not.toHaveBeenCalled();
  });
});

describe('the PNG resolution', () => {
  it('is twice the screen density, capped at the scale the PDF already pays for', () => {
    expect(pngRasterScale(1)).toBe(2);
    expect(pngRasterScale(1.25)).toBe(2.5);
    expect(pngRasterScale(3)).toBe(PNG_MAX_RASTER_SCALE);
    expect(PNG_MAX_RASTER_SCALE).toBe(3);
    // A screen that reports nothing usable is read as density 1, never as 0 or NaN.
    expect(pngRasterScale(Number.NaN)).toBe(2);
    expect(pngRasterScale(0)).toBe(2);
  });
});
