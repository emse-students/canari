<script lang="ts">
  /** A root layout reduced to what SvelteKit's root renders a route node through: its children. */
  import type { Snippet } from 'svelte';
  let { children }: { children?: Snippet } = $props();
</script>

<div data-testid="layout">{@render children?.()}</div>
