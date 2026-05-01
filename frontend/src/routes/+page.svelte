<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';

  onMount(() => {
    goto('/posts', { replaceState: true }).catch(() => {});
  });
</script>

<main class="min-h-screen flex items-center justify-center text-text-muted text-sm">
  Chargement...
</main>
