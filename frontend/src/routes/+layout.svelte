<script lang="ts">
  import '../app.css';
  import BackgroundBlobs from '$lib/components/shared/BackgroundBlobs.svelte';
  import CanariBrand from '$lib/components/navigation/CanariBrand.svelte';
  import PlaceSwitcher from '$lib/components/navigation/PlaceSwitcher.svelte';
  import { page } from '$app/state';

  let { children } = $props();

  const pathname = $derived(page.url.pathname);
  const isChatRoute = $derived(
    pathname === '/chat' ||
      pathname.startsWith('/chat/') ||
      pathname === '/communities' ||
      pathname.startsWith('/communities/')
  );
</script>

<div class="relative min-h-dvh">
  <div class="fixed inset-0 z-0 pointer-events-none">
    <BackgroundBlobs />
  </div>

  {#if !isChatRoute}
    <header
      class="sticky top-0 z-20 border-b border-cn-border/70 bg-white/82 backdrop-blur-lg pt-[env(safe-area-inset-top)]"
    >
      <div
        class="mx-auto flex w-full max-w-[1180px] items-center justify-between gap-3 px-3 py-3 sm:px-5"
      >
        <CanariBrand />
        <PlaceSwitcher {pathname} />
      </div>
    </header>
  {/if}

  <div
    class="relative z-10 mx-auto flex w-full pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] {isChatRoute
      ? 'h-dvh max-w-none'
      : 'h-[calc(100dvh-4.5rem-env(safe-area-inset-top,0px))] max-w-[1180px]'}"
  >
    <div class="h-full w-full">
      {@render children?.()}
    </div>
  </div>
</div>
