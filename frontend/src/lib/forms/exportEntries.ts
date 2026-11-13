import { exportLabels, exportSubmissions, type SubmissionsExportFormat } from '$lib/forms/api';
import { downloadDecryptedFile } from '$lib/utils/fileDownload';
import { showToast } from '$lib/stores/toast.svelte';
import { Log } from '$lib/utils/Log';
import { m } from '$lib/paraglide/messages';

/** One thing a form's export menu section offers: the format asked of the server and its words. */
export interface ExportEntry {
  format: SubmissionsExportFormat;
  label: string;
  hint: string;
}

/**
 * WHAT A FORM'S "EXPORTER" OFFERS (WP-G4): the workbook, and - on a form with a priced grid - its two
 * grid sheets as CSV, "Articles" (one line per ordered cell) and "Totaux" (the supplier order).
 *
 * A form without a grid is offered the workbook only: the server refuses a grid CSV of it
 * (`EXPORT_FORMAT_NEEDS_PRODUCT_GRID`), so the menu never asks.
 */
export function exportEntries(hasProductGrid: boolean): ExportEntry[] {
  return [
    {
      format: 'xlsx',
      label: m.form_responses_export_xlsx(),
      hint: hasProductGrid
        ? m.form_responses_export_xlsx_grid_hint()
        : m.form_responses_export_xlsx_hint(),
    },
    ...(hasProductGrid
      ? [
          {
            format: 'articles-csv' as const,
            label: m.form_responses_export_articles(),
            hint: m.form_responses_export_articles_hint(),
          },
          {
            format: 'totals-csv' as const,
            label: m.form_responses_export_totals(),
            hint: m.form_responses_export_totals_hint(),
          },
        ]
      : []),
  ];
}

/** The file name: the form's title, the sheet for a CSV, characters a file system refuses cut. */
export function exportFileName(
  formId: string,
  title: string,
  format: SubmissionsExportFormat
): string {
  const base = title.replace(/[\\/:*?"<>|]+/g, '_').trim() || formId;
  if (format === 'articles-csv') return `${base} - ${m.form_export_grid_articles_sheet()}.csv`;
  if (format === 'totals-csv') return `${base} - ${m.form_export_grid_totals_sheet()}.csv`;
  return `${base}.xlsx`;
}

/**
 * Downloads one export of a form. Every file is written by social-service in this client's words
 * (`exportLabels()`), and a CSV is the SAME sheet the workbook holds - one writer, so the three
 * files cannot disagree. A failure is logged and toasted; it never throws to the caller.
 */
export async function downloadFormExport(
  formId: string,
  title: string,
  format: SubmissionsExportFormat
): Promise<void> {
  Log.d('formExport', `export form=${formId.slice(0, 8)} format=${format}`);
  try {
    await downloadDecryptedFile(
      await exportSubmissions(formId, exportLabels(), format),
      exportFileName(formId, title, format)
    );
  } catch (e) {
    console.error(`[FORMS] export form=${formId.slice(0, 8)} format=${format} failed:`, e);
    showToast(m.form_list_error_export());
  }
}
