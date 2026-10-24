// @vitest-environment happy-dom
/**
 * THE PNG BUTTON SITS NEXT TO THE PDF ONE AND CALLS THE SAME EXPORT (user, 2026-10-18: *"un bouton
 * pour un export png a cote du pdf"*). Pinned: both buttons exist behind the same admin gate, each
 * names its format, and each hands `exportCalendarMonth` the SAME month and options - only the
 * format differs, so the PNG can never be a second layout.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const exportCalendarMonth = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('$app/state', () => ({
  page: { url: new URL('https://canari.test/calendar/export?month=2026-11'), state: {} },
}));
vi.mock('$lib/stores/user', () => ({
  isGlobalAdmin: () => true,
  isAssociationSuperAdmin: () => false,
  fetchMyProfile: () => Promise.resolve(null),
}));
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  listAggregatedCalendarFeed: () => Promise.resolve([]),
  ensureAssociationSuperAdmin: () => Promise.resolve(true),
}));
vi.mock('$lib/utils/calendarExport', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/calendarExport')>()),
  exportCalendarMonth,
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  exportCalendarMonth.mockClear();
});

async function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Page, { target });
  mounted.push(() => void unmount(app));
  for (let i = 0; i < 6; i++) await tick();
  flushSync();
}

// The first mount compiles the whole settings panel on a cold worker; measured at 7 s on a slow box.
describe('the agenda export offers a PNG next to the PDF', { timeout: 30_000 }, () => {
  it('draws both buttons side by side, each named by its format and by its whole action', async () => {
    await render();
    const pdf = document.querySelector<HTMLButtonElement>('[data-testid="calendar-export-pdf"]');
    const png = document.querySelector<HTMLButtonElement>('[data-testid="calendar-export-png"]');
    // The face shows the format; the accessible name is the whole action and contains it.
    expect(pdf?.textContent?.trim()).toBe(m.calendar_export_format_pdf());
    expect(png?.textContent?.trim()).toBe(m.calendar_export_format_png());
    expect(pdf?.getAttribute('aria-label')).toBe(m.calendar_export_download_btn());
    expect(png?.getAttribute('aria-label')).toBe(m.calendar_export_download_png_btn());
    expect(png?.getAttribute('aria-label')).toContain(m.calendar_export_format_png());
    expect(png?.parentElement).toBe(pdf?.parentElement);
  });

  it('calls the one export with the same month and options, the format alone differing', async () => {
    await render();
    document.querySelector<HTMLButtonElement>('[data-testid="calendar-export-png"]')!.click();
    for (let i = 0; i < 3; i++) await tick();
    document.querySelector<HTMLButtonElement>('[data-testid="calendar-export-pdf"]')!.click();
    for (let i = 0; i < 3; i++) await tick();

    expect(exportCalendarMonth).toHaveBeenCalledTimes(2);
    const [pngCall, pdfCall] = exportCalendarMonth.mock.calls as unknown as unknown[][];
    expect(pngCall[3]).toBe('png');
    expect(pdfCall[3]).toBe('pdf');
    expect(pngCall.slice(0, 3)).toEqual(pdfCall.slice(0, 3));
  });

  it('carries the chosen cell border into the export, and offers no colour without a border', async () => {
    await render();
    const thick = document.querySelector<HTMLButtonElement>('[data-testid="cell-border-width-3"]')!;
    expect(
      document.querySelector('[data-testid="cell-border-width-2"]')?.getAttribute('aria-checked')
    ).toBe('true');
    thick.click();
    flushSync();
    expect(thick.getAttribute('aria-checked')).toBe('true');
    document.querySelector<HTMLButtonElement>('[data-testid="cell-border-color-light"]')!.click();
    flushSync();
    document.querySelector<HTMLButtonElement>('[data-testid="calendar-export-png"]')!.click();
    for (let i = 0; i < 3; i++) await tick();
    const opts = (exportCalendarMonth.mock.calls as unknown as unknown[][])[0][2] as Record<
      string,
      unknown
    >;
    expect(opts.cellBorderWidth).toBe(3);
    expect(opts.cellBorderColor).toBe('light');

    document.querySelector<HTMLButtonElement>('[data-testid="cell-border-width-0"]')!.click();
    flushSync();
    expect(document.querySelector('[data-testid="cell-border-color-dark"]')).toBeNull();
  });
});
