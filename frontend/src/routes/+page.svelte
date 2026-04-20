<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { currentUserId } from '$lib/stores/user';

  onMount(() => {
    // Only redirect to /posts when authenticated.
    // The layout auth guard handles the redirect to /login when no user exists.
    if (currentUserId()) {
      goto('/posts', { replaceState: true }).catch(() => {});
    }
  });
</script>

<main class="min-h-screen flex items-center justify-center text-text-muted text-sm">
  Redirection vers les posts...
</main>
