<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { FormItem } from '$lib/forms/api';
  import { formatAmount } from '$lib/forms/fillAnswers';
  import type { ProductGridLine } from '$lib/forms/productGridContract';
  import { orderLineLabel, orderUnitCount } from '$lib/forms/productGridFill';
  import { ChevronUp } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * THE ORDER TOTAL OF A FORM HOLDING PRICED GRIDS (WP-G2): "Total : 84 EUR", how many articles, and
   * a recap that unfolds line by line ("Sweat capuche Noir M x1 28 EUR"), beside the page's own pay
   * button (`action`). Both fill pages draw it in their sticky bar; it holds no state but the fold.
   *
   * `totalCents` is the page's whole total (`fillPriceState.total`: base, supplements and the grids'
   * lines), a PREVIEW - the server recomputes the amount it charges.
   */
  interface Props {
    lines: ProductGridLine[];
    totalCents: number;
    currency?: string;
    /** The form's questions, so a one-row grid's line leaves its row label out. */
    items: FormItem[];
    /** The pay or send button. */
    action: Snippet;
  }

  let { lines, totalCents, currency = 'eur', items, action }: Props = $props();

  let open = $state(false);
  const units = $derived(orderUnitCount(lines));

  function toggle() {
    open = !open;
    Log.d('ProductGridOrderBar', `recap ${open ? 'opened' : 'closed'}: ${lines.length} line(s)`);
  }
</script>

<div
  class="border-cn-border/60 bg-cn-surface flex flex-col rounded-2xl border shadow-lg"
  data-order-bar
>
  {#if open}
    <ul
      aria-label={m.form_grid_order_detail_aria()}
      class="border-cn-border flex max-h-48 flex-col gap-1.5 overflow-y-auto border-b px-4 pt-3 pb-2 text-xs sm:px-5 sm:text-sm"
      data-order-recap
    >
      {#each lines as line (`${line.itemId}:${line.rowId}:${line.colId}`)}
        <li class="text-text-main flex gap-3">
          <span class="min-w-0 flex-1">{orderLineLabel(line, items)}</span>
          <span class="text-text-muted tabular-nums"
            >{m.form_grid_line_quantity({ quantity: line.quantity })}</span
          >
          <span class="w-16 text-right font-bold tabular-nums"
            >{formatAmount(line.lineCents, currency)}</span
          >
        </li>
      {:else}
        <li class="text-text-muted">{m.form_grid_order_empty()}</li>
      {/each}
    </ul>
  {/if}
  <div class="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3 sm:pl-5">
    <button
      type="button"
      class="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-1 text-left sm:px-0"
      aria-expanded={open}
      onclick={toggle}
      data-order-toggle
    >
      <span
        class="text-text-main text-lg font-bold whitespace-nowrap tabular-nums"
        aria-live="polite"
        >{m.form_grid_order_total({ amount: formatAmount(totalCents, currency) })}</span
      >
      <span class="text-text-muted min-w-0 flex-1 text-xs sm:flex-none"
        >{m.form_grid_order_count({ count: units })} &middot; {m.form_grid_order_detail()}</span
      >
      <ChevronUp
        size={16}
        class="text-text-muted shrink-0 transition-transform {open ? 'rotate-180' : ''}"
      />
    </button>
    <!-- Full width under the total on a phone, as in the mockup; beside it from 640px. -->
    <div class="flex *:flex-1 sm:*:flex-none">{@render action()}</div>
  </div>
</div>
