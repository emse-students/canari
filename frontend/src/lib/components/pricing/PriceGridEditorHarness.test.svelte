<script lang="ts">
  /** Test-only parent: owns the bound grid the way the form page does, and reports each change. */
  import { untrack } from 'svelte';
  import type { FormItem } from '$lib/forms/api';
  import type { PriceMatrix } from '$lib/pricing/priceMatrix';
  import PriceGridEditor from './PriceGridEditor.svelte';

  interface Props {
    initial: PriceMatrix;
    items?: FormItem[];
    isPublic?: boolean;
    onChange: (matrix: PriceMatrix | null) => void;
  }

  let { initial, items = [], isPublic = false, onChange }: Props = $props();

  // The prop is a SEED read once, which `untrack` says out loud.
  let matrix = $state<PriceMatrix | null>(untrack(() => structuredClone(initial)));

  $effect(() => {
    onChange($state.snapshot(matrix) as PriceMatrix | null);
  });
</script>

<PriceGridEditor
  bind:matrix
  basePrice={0}
  tiers={[]}
  formations={[{ value: 'ICM', count: 3 }]}
  {items}
  hasCotisation={false}
  {isPublic}
/>
