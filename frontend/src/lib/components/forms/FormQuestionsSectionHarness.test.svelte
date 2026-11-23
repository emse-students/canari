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
    offerBlocks?: boolean;
    imageUploadFn?: (file: File) => Promise<string>;
    transmittedFields?: ('lastName' | 'firstName' | 'email' | 'cursus' | 'status' | 'campus')[];
  }

  let {
    initial,
    onItems,
    reveal = null,
    offerPricedGrid = true,
    onPricedGridAdded,
    onPricedGridGone,
    gridFault = null,
    offerBlocks = true,
    imageUploadFn,
    transmittedFields = [],
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
  {offerBlocks}
  {imageUploadFn}
  {transmittedFields}
/>
