<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { currentUserId } from '$lib/stores/user';

  onMount(() => {
    if (currentUserId()) {
      goto('/posts', { replaceState: true }).catch(() => {});
    } else {
      goto('/login', { replaceState: true }).catch(() => {});
    }
  });
</script>

<main class="min-h-screen flex items-center justify-center text-text-muted text-sm">
  Chargement...
</main>
