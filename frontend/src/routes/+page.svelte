<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';

  onMount(() => {
    void goto('/posts', { replaceState: true });
  });
</script>

<main class="min-h-screen flex items-center justify-center text-text-muted text-sm">
  Redirection vers les posts...
</main>
