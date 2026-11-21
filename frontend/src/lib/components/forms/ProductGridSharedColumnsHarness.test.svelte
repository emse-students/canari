<script lang="ts">
  /** Test-only parent: owns several grid questions as `$state`, as the form editor does. */
  import { untrack } from 'svelte';
  import ProductGridEditor from './ProductGridEditor.svelte';
  import type { ColumnSetQuestion } from '$lib/forms/productGridColumnSets';
  import type { EditorProductGrid } from '$lib/forms/productGridEditor';

  interface Props {
    initial: ColumnSetQuestion[];
    onItems: (items: ColumnSetQuestion[]) => void;
    ordered?: Record<string, string[]>;
  }

  let { initial, onItems, ordered = {} }: Props = $props();
  let items = $state(untrack(() => initial));
  $effect(() => onItems($state.snapshot(items) as ColumnSetQuestion[]));
</script>

{#each items as item (item.id)}
  <section data-q={item.id}>
    <ProductGridEditor
      grid={item.productGrid as EditorProductGrid}
      orderedCells={ordered[item.id] ?? []}
      questions={items}
      questionId={item.id}
      orderedByQuestion={ordered}
    />
  </section>
{/each}
