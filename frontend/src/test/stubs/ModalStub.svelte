<script lang="ts">
  /** A test stand-in for `Modal`: draws its children only while `open`. */
  import type { Snippet } from 'svelte';
  let { open = false, children }: { open?: boolean; children?: Snippet } = $props();
</script>

{#if open}
  <div data-stub="modal">{@render children?.()}</div>
{/if}
