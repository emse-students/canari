<script lang="ts">
  /** Test-only parent: owns the bound question list the way the two admin pages do. */
  import { untrack } from 'svelte';
  import FormQuestionsSection from './FormQuestionsSection.svelte';

  interface Props {
    initial: any[];
    onItems: (items: any[]) => void;
    reveal?: { id: string } | null;
    offerPricedGrid?: boolean;
    onPricedGridAdded?: () => void;
    onPricedGridGone?: () => void;
    gridFault?: { itemId: string; message: string } | null;
  }

  let {
    initial,
    onItems,
    reveal = null,
    offerPricedGrid = true,
    onPricedGridAdded,
    onPricedGridGone,
    gridFault = null,
  }: Props = $props();
  let items = $state(untrack(() => initial));
  $effect(() => onItems($state.snapshot(items)));
</script>

<FormQuestionsSection
  bind:items
  requiresPayment={false}
  {reveal}
  {offerPricedGrid}
  {onPricedGridAdded}
  {onPricedGridGone}
  {gridFault}
/>
