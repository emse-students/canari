<script lang="ts">
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import { currentUserId } from '$lib/stores/user';

  let { children } = $props();

  // The guard tests for an ACCOUNT session, not `session.isLoggedIn` (which means "MLS is
  // ready"). Those two diverge whenever the OIDC session is valid but MLS init failed, and
  // bouncing to /login there produced an endless ping-pong: the login page saw a live refresh
  // cookie and sent the user straight back. Sections that need MLS handle its absence
  // themselves. It lives in the layout so the hub and every section share the ONE guard.
  onMount(() => {
    if (!currentUserId()) {
      const back = encodeURIComponent(page.url.pathname);
      void goto(resolve(`/login?returnTo=${back}`), { replaceState: true });
    }
  });
</script>

<PageContainer>
  {@render children?.()}
</PageContainer>
