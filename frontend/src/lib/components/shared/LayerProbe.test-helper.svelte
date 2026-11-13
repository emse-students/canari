<script lang="ts">
  /**
   * A bare overlay for the layer tests: `open` shows it, and `dep` is a second signal `isOpen` reads
   * (a dropdown's result count) that may change while the answer stays true. `outro` keeps the node
   * in the DOM after `open` goes false, as a `transition:` does.
   */
  import { useOverlayLayer } from '$lib/utils/overlayLayer.svelte';

  let { open, dep = 1, outro = false }: { open: boolean; dep?: number; outro?: boolean } = $props();

  const layer = useOverlayLayer(() => open && dep > 0, 'probe');
  let rendered = $state(false);
  $effect(() => {
    if (open) rendered = true;
  });
</script>

{#if open || (outro && rendered)}
  <div data-probe style:z-index={layer.z}>probe</div>
{/if}
