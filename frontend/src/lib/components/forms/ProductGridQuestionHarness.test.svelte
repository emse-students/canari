<script lang="ts">
  /** Test-only parent: owns the bound order the way a fill page does, and reports each change. */
  import { untrack } from 'svelte';
  import type { FormItem } from '$lib/forms/api';
  import type { ProductGridView, ProductGridViewerPrices } from '$lib/forms/productGridContract';
  import ProductGridQuestion from './ProductGridQuestion.svelte';

  interface Props {
    item: FormItem;
    grid: ProductGridView;
    initial: unknown;
    onChange: (value: unknown) => void;
    gridPrices?: ProductGridViewerPrices;
    error?: string | null;
  }

  let { item, grid, initial, onChange, gridPrices, error }: Props = $props();

  // A deep `$state`, as `selections` is on the page. The props are a SEED read once.
  let selections = $state<Record<string, any>>(
    untrack(() => ({ [item.id]: structuredClone(initial) }))
  );

  $effect(() => {
    onChange($state.snapshot(selections[item.id]));
  });
</script>

<ProductGridQuestion
  {item}
  {grid}
  bind:value={selections[item.id]}
  disabled={false}
  prices={gridPrices}
  {error}
/>
