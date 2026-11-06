<script lang="ts">
  import { Monitor, Smartphone } from '@lucide/svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import { productGridAxisKey } from '$lib/forms/productGridContract';
  import { isCellClosed, priceOf, type EditorProductGrid } from '$lib/forms/productGridEditor';
  import { formatAmount } from '$lib/forms/fillAnswers';
  import { m } from '$lib/paraglide/messages';

  /**
   * WHAT A BUYER SEES OF THE GRID BEING EDITED, at one category's prices: the desktop table (a
   * stepper per cell, a checkbox when the cap is 1, a closed cell struck through) or the phone's
   * cards (one per row with its price, the columns as pills, no horizontal scroll).
   *
   * A static drawing, inert: the respondent component of WP-G2 (`ProductGridQuestion.svelte`) is
   * not in this build yet, so this draws the same layout from the same grid. It replaces this file
   * when it lands.
   */
  interface Props {
    grid: EditorProductGrid;
    /** The category whose prices are drawn. */
    tierId: string;
    /** That category's name, or empty for a grid with one price list. */
    tierName: string;
  }

  let { grid, tierId, tierName }: Props = $props();

  let view = $state<'desktop' | 'phone'>('desktop');

  /** A cell's unit price as text, or empty while it is blank. */
  function unitText(rowId: string, colId: string): string {
    const euros = priceOf(grid, tierId, productGridAxisKey(grid.pricing.mode, rowId, colId));
    return euros === null ? '' : formatAmount(Math.round(euros * 100));
  }

  /** A row card's price: its own, or "from" the cheapest open column when columns differ. */
  function rowPriceText(rowId: string): string {
    const prices = grid.columns
      .filter((c) => !isCellClosed(grid, rowId, c.id))
      .map((c) => priceOf(grid, tierId, productGridAxisKey(grid.pricing.mode, rowId, c.id)))
      .filter((p): p is number => p !== null);
    if (prices.length === 0) return '';
    const min = Math.min(...prices);
    const text = formatAmount(Math.round(min * 100));
    return prices.some((p) => p !== min) ? m.form_pgrid_preview_from({ price: text }) : text;
  }
</script>

<section
  class="space-y-3 border-t border-black/10 pt-4 dark:border-white/10"
  aria-label={m.form_pgrid_preview_aria()}
>
  <div class="flex flex-wrap items-center gap-3">
    <span class="text-text-main flex-1 text-sm font-bold">
      {tierName
        ? m.form_pgrid_preview_title_tier({ tier: tierName })
        : m.form_pgrid_preview_title()}
    </span>
    <SegmentedControl
      label={m.form_pgrid_preview_size_aria()}
      value={view}
      onSelect={(key) => (view = key)}
      items={[
        { key: 'desktop', label: m.form_pgrid_preview_desktop(), icon: Monitor },
        { key: 'phone', label: m.form_pgrid_preview_phone(), icon: Smartphone },
      ]}
      class="w-full sm:w-64"
    />
  </div>

  <div class="bg-cn-bg rounded-lg p-4" inert data-testid="grid-preview-{view}">
    {#if view === 'desktop'}
      <div class="overflow-x-auto">
        <table class="bg-cn-surface overflow-hidden rounded-lg text-xs">
          <thead>
            <tr>
              <th class="w-32"></th>
              {#each grid.columns as column (column.id)}
                <th class="text-text-main w-24 px-1 py-2 text-center font-bold">{column.label}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each grid.rows as row, ri (row.id)}
              <tr class={ri % 2 ? 'bg-cn-surface-alt' : ''}>
                <th class="text-text-main px-2.5 py-1.5 text-left font-semibold">{row.label}</th>
                {#each grid.columns as column (column.id)}
                  {@const closed = isCellClosed(grid, row.id, column.id)}
                  <td class="p-1 text-center">
                    {#if closed}
                      <span class="text-text-muted line-through">{column.label}</span>
                    {:else if grid.maxPerCell === 1}
                      <span
                        class="border-text-muted inline-block h-4.5 w-4.5 rounded border-2 align-middle"
                        title={unitText(row.id, column.id)}
                      ></span>
                    {:else}
                      <span
                        class="border-cn-border text-text-muted inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5"
                        title={unitText(row.id, column.id)}>-<b class="text-text-main">0</b>+</span
                      >
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <div class="mx-auto flex max-w-sm flex-col gap-2">
        {#each grid.rows as row (row.id)}
          <div class="bg-cn-surface flex flex-col gap-2 rounded-2xl p-3">
            <div class="text-text-main flex justify-between gap-2 text-sm font-bold">
              <span class="min-w-0 break-words">{row.label}</span>
              <span class="shrink-0">{rowPriceText(row.id)}</span>
            </div>
            <div class="flex flex-wrap gap-1.5">
              {#each grid.columns as column (column.id)}
                {@const closed = isCellClosed(grid, row.id, column.id)}
                <span
                  class="flex h-9 min-w-11 items-center justify-center rounded-full px-2.5 text-xs {closed
                    ? 'border-text-muted text-text-muted border border-dashed line-through'
                    : 'text-text-main border border-black/20 font-bold dark:border-white/20'}"
                  >{column.label}</span
                >
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</section>
