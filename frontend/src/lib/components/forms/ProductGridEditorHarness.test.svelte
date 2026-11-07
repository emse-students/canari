<script lang="ts">
  /** Test-only parent: owns the grid as a `$state` proxy, as a question card does. */
  import { untrack } from 'svelte';
  import ProductGridEditor from './ProductGridEditor.svelte';
  import type { EditorProductGrid, ProductGridTierDimension } from '$lib/forms/productGridEditor';

  interface Props {
    initial: EditorProductGrid;
    onGrid: (grid: EditorProductGrid) => void;
    orderedCells?: string[];
    formTiers?: ProductGridTierDimension | null;
    isPublic?: boolean;
  }

  let { initial, onGrid, orderedCells = [], formTiers = null, isPublic = false }: Props = $props();
  let grid = $state(untrack(() => initial));
  $effect(() => onGrid($state.snapshot(grid) as EditorProductGrid));
</script>

<ProductGridEditor {grid} {orderedCells} {formTiers} {isPublic} />
