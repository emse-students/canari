<script lang="ts">
  import { Download } from '@lucide/svelte';
  import { clickOutside } from '$lib/actions/clickOutside';
  import { exportLabels, exportSubmissions, type SubmissionsExportFormat } from '$lib/forms/api';
  import { downloadDecryptedFile } from '$lib/utils/fileDownload';
  import { showToast } from '$lib/stores/toast.svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';
  import { useOverlayLayer } from '$lib/utils/overlayLayer.svelte';

  /**
   * THE "EXPORTER" MENU OF ONE FORM (WP-G4): the workbook, and - on a form with a priced grid - its
   * two grid sheets as CSV, "Articles" (one line per ordered cell) and "Totaux" (the supplier order).
   *
   * Every file is written by social-service in this client's words (`exportLabels()`, which carries
   * the grid's sixteen since #3085), and a CSV is the SAME sheet the workbook holds - one writer, so
   * the three files cannot disagree. A form without a grid is offered the workbook only: the server
   * refuses a grid CSV of it (`EXPORT_FORMAT_NEEDS_PRODUCT_GRID`), so the menu never asks.
   */
  interface Props {
    formId: string;
    /** The form's title: what the downloaded file is named after. */
    title: string;
    /** Whether the form has a priced grid, which is what the two CSVs are sheets of. */
    hasProductGrid: boolean;
  }

  let { formId, title, hasProductGrid }: Props = $props();

  let open = $state(false);
  const layer = useOverlayLayer(() => open, 'FormExportMenu');
  let busy = $state<SubmissionsExportFormat | null>(null);
  let opener = $state<HTMLButtonElement | null>(null);

  const entries = $derived<{ format: SubmissionsExportFormat; label: string; hint: string }[]>([
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
  ]);

  /** The file name: the form's title, the sheet for a CSV, characters a file system refuses cut. */
  function fileName(format: SubmissionsExportFormat): string {
    const base = title.replace(/[\\/:*?"<>|]+/g, '_').trim() || formId;
    if (format === 'articles-csv') return `${base} - ${m.form_export_grid_articles_sheet()}.csv`;
    if (format === 'totals-csv') return `${base} - ${m.form_export_grid_totals_sheet()}.csv`;
    return `${base}.xlsx`;
  }

  async function download(format: SubmissionsExportFormat) {
    open = false;
    busy = format;
    Log.d('FormExportMenu', `export form=${formId.slice(0, 8)} format=${format}`);
    try {
      await downloadDecryptedFile(
        await exportSubmissions(formId, exportLabels(), format),
        fileName(format)
      );
    } catch (e) {
      console.error(`[FORMS] export form=${formId.slice(0, 8)} format=${format} failed:`, e);
      showToast(m.form_list_error_export());
    } finally {
      busy = null;
    }
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (open && e.key === 'Escape') {
      open = false;
      opener?.focus();
    }
  }}
/>

<div
  class="sm:relative"
  use:clickOutside={{ enabled: open, callback: () => (open = false), ignore: () => opener }}
>
  <button
    bind:this={opener}
    type="button"
    onclick={() => (open = !open)}
    disabled={busy !== null}
    aria-haspopup="menu"
    aria-expanded={open}
    class="ui-icon-button border-cn-border text-text-main hover:border-accent/40 rounded-xl border-2 bg-(--cn-surface) transition-colors disabled:opacity-50"
    aria-label={m.form_list_export_button()}
    title={m.form_list_export_button()}
    data-testid="form-export-menu"
  >
    <Download size={16} />
  </button>
  {#if open}
    <div
      role="menu"
      style:z-index={layer.z}
      class="bg-cn-popover absolute top-full right-0 mt-2 flex w-72 flex-col rounded-lg p-1.5 shadow-lg"
    >
      {#each entries as entry (entry.format)}
        <button
          type="button"
          role="menuitem"
          onclick={() => void download(entry.format)}
          class="hover:bg-control-fill flex min-h-13 flex-col items-start justify-center rounded-lg px-2.5 py-1.5 text-left"
          data-testid="form-export-{entry.format}"
        >
          <span class="text-text-main text-sm font-bold">{entry.label}</span>
          <span class="text-text-muted text-xs">{entry.hint}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
