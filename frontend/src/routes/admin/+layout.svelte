<script lang="ts">
  import { goto } from '$app/navigation';
  import { isGlobalAdmin } from '$lib/stores/user';

  let { children } = $props();

  $effect(() => {
    if (typeof window === 'undefined') return;
    if (!isGlobalAdmin()) {
      void goto('/', { replaceState: true });
    }
  });
</script>

{#if isGlobalAdmin()}
  {@render children()}
{/if}
