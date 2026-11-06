// @vitest-environment happy-dom
/**
 * The "Exporter" menu offers the two grid CSVs only on a form with a priced grid, and asks the
 * server for the format picked, in this client's words.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const api = vi.hoisted(() => ({
  exportLabels: vi.fn(() => ({ date: 'Date' })),
  exportSubmissions: vi.fn(async () => new Blob(['x'])),
}));
vi.mock('$lib/forms/api', () => api);
vi.mock('$lib/utils/fileDownload', () => ({ downloadDecryptedFile: vi.fn(async () => {}) }));

import FormExportMenu from './FormExportMenu.svelte';
import { downloadDecryptedFile } from '$lib/utils/fileDownload';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

function open(hasProductGrid: boolean) {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(FormExportMenu, {
    target,
    props: { formId: 'f1', title: 'Merch: hiver', hasProductGrid },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  target.querySelector<HTMLButtonElement>('[data-testid="form-export-menu"]')!.click();
  flushSync();
  return target;
}

describe('FormExportMenu', () => {
  it('offers the workbook alone on a form without a grid', () => {
    const items = open(false).querySelectorAll('[role="menuitem"]');
    expect(items).toHaveLength(1);
  });

  it('offers the two CSVs on a grid form, and asks for the format picked', async () => {
    const target = open(true);
    expect(target.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
    target.querySelector<HTMLButtonElement>('[data-testid="form-export-totals-csv"]')!.click();
    await vi.waitFor(() => expect(downloadDecryptedFile).toHaveBeenCalled());
    expect(api.exportSubmissions).toHaveBeenCalledWith('f1', { date: 'Date' }, 'totals-csv');
    expect(vi.mocked(downloadDecryptedFile).mock.calls[0][1]).toMatch(/^Merch_ hiver - .+\.csv$/);
  });
});
