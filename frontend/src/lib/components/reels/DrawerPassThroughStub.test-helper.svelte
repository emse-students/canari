<script lang="ts">
  import type { Snippet } from 'svelte';
  /** Stands in for `CommentsDrawer`: renders its body and nothing else. */
  let { children }: { children?: Snippet } = $props();
</script>

{@render children?.()}
