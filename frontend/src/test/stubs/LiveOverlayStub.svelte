<script lang="ts">
  /**
   * A test stand-in for `LiveOverlay`: a marker, the button that ends the live, and how many times
   * the target it was given changed under it (`data-retargets`: 0 when the feed never re-targets a
   * mounted screen).
   */
  import { untrack } from 'svelte';

  let { onclose, associationId = null }: { onclose: () => void; associationId?: string | null } =
    $props();

  let reads = $state(0);
  $effect(() => {
    void associationId;
    untrack(() => reads++);
  });
</script>

<div data-stub="live-overlay" data-retargets={Math.max(0, reads - 1)}>
  <button type="button" data-stub="live-overlay-end" onclick={onclose}>end</button>
</div>
