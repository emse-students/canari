<script lang="ts">
  /**
   * Test helper: a `LiveViewer` inside the boundary the app puts around its screens, so a viewer
   * whose template throws is DESTROYED (its effects torn down) instead of rethrown unhandled.
   */
  import LiveViewer from './LiveViewer.svelte';
  import type { ComponentProps } from 'svelte';

  let props: ComponentProps<typeof LiveViewer> = $props();
</script>

<svelte:boundary>
  <LiveViewer {...props} />
  {#snippet failed()}
    <p data-boundary-failed>failed</p>
  {/snippet}
</svelte:boundary>
