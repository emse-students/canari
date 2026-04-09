<script lang="ts">
  import '../app.css';
  import { goto } from '$app/navigation';
  import BackgroundBlobs from '$lib/components/shared/BackgroundBlobs.svelte';
  import ChatBackgroundService from '$lib/components/layout/ChatBackgroundService.svelte';
  import Navbar from '$lib/components/navigation/Navbar.svelte';
  import { currentUserId } from '$lib/stores/user';
  import { page } from '$app/state';

  let { children } = $props();

  const pathname = $derived(page.url.pathname);
  const isChatRoute = $derived(
    pathname === '/chat' ||
      pathname.startsWith('/chat/') ||
      pathname === '/communities' ||
      pathname.startsWith('/communities/')
  );
  const isAuthRoute = $derived(
    pathname === '/login' ||
      pathname.startsWith('/login') ||
      pathname === '/auth/callback' ||
      pathname.startsWith('/auth/')
  );

  // ── Auth guard ────────────────────────────────────────────────────────────
  $effect(() => {
    if (typeof window === 'undefined') return;
    if (isAuthRoute) return;
    if (!currentUserId()) {
      void goto(`/login?returnTo=${encodeURIComponent(pathname)}`, { replaceState: true });
    }
  });
</script>

<div class="relative flex flex-col {isAuthRoute ? 'min-h-dvh' : 'h-dvh'}">
  <ChatBackgroundService />

  <div class="fixed inset-0 z-0 pointer-events-none">
    <BackgroundBlobs />
  </div>

  {#if !isAuthRoute}
    <Navbar />
  {/if}

  <div
    class="relative z-10 mx-auto flex flex-1 min-h-0 w-full pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] {isChatRoute
      ? 'max-w-none'
      : isAuthRoute
        ? 'max-w-none'
        : 'max-w-[1400px]'}"
  >
    <div class="h-full w-full">
      {@render children?.()}
    </div>
  </div>
</div>
