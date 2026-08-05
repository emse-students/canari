<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  /**
   * Nothing renders here in practice.
   *
   * When nginx serves this page's prerendered HTML during a `frontend-ssr` outage, the URL in the
   * browser is still the one that was asked for, so the SPA router resolves THAT route and this
   * component never mounts. It only runs when someone navigates to `/app-shell` on purpose, and
   * the honest answer to that is the home feed.
   */
  onMount(() => {
    void goto('/posts', { replaceState: true });
  });
</script>
