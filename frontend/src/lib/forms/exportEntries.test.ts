// @vitest-environment happy-dom
/**
 * A form's export offers the two grid CSVs only on a form with a priced grid, and asks the server
 * for the format picked, in this client's words.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const api = vi.hoisted(() => ({
  exportLabels: vi.fn(() => ({ date: 'Date' })),
  exportSubmissions: vi.fn(async () => new Blob(['x'])),
}));
vi.mock('$lib/forms/api', () => api);
vi.mock('$lib/utils/fileDownload', () => ({ downloadDecryptedFile: vi.fn(async () => {}) }));

import { downloadFormExport, exportEntries } from './exportEntries';
import { downloadDecryptedFile } from '$lib/utils/fileDownload';

afterEach(() => vi.clearAllMocks());

describe('exportEntries', () => {
  it('offers the workbook alone on a form without a grid', () => {
    expect(exportEntries(false).map((e) => e.format)).toEqual(['xlsx']);
  });

  it('offers the two CSVs on a grid form', () => {
    expect(exportEntries(true).map((e) => e.format)).toEqual([
      'xlsx',
      'articles-csv',
      'totals-csv',
    ]);
  });
});

describe('downloadFormExport', () => {
  it('asks for the format picked and names the file after the form', async () => {
    await downloadFormExport('f1', 'Merch: hiver', 'totals-csv');
    expect(api.exportSubmissions).toHaveBeenCalledWith('f1', { date: 'Date' }, 'totals-csv');
    expect(vi.mocked(downloadDecryptedFile).mock.calls[0][1]).toMatch(/^Merch_ hiver - .+\.csv$/);
  });
});
