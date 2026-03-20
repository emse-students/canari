<script lang="ts">
  import '../app.css';
  import BackgroundBlobs from '$lib/components/BackgroundBlobs.svelte';
  import { page } from '$app/stores';

  $: pathname = $page.url.pathname;

  function isActive(path: string): boolean {
    return pathname === path || pathname.startsWith(`${path}/`);
  }

  function navClass(path: string): string {
    return isActive(path)
      ? 'rounded-full border border-cn-dark bg-cn-dark px-3 py-1.5 text-xs font-semibold text-white shadow-sm'
      : 'rounded-full border border-cn-border bg-white/85 px-3 py-1.5 text-xs font-medium text-text-main hover:bg-white';
  }
</script>

<div class="relative min-h-dvh overflow-hidden">
  <div class="fixed inset-0 z-0 pointer-events-none">
    <BackgroundBlobs />
  </div>

  <nav class="fixed right-4 top-4 z-20 hidden items-center gap-2 md:flex">
    <a
      href="/chat"
      class={navClass('/chat')}
      aria-current={isActive('/chat') ? 'page' : undefined}
    >
      Messagerie
    </a>
    <a
      href="/posts"
      class={navClass('/posts')}
      aria-current={isActive('/posts') ? 'page' : undefined}
    >
      Fil
    </a>
  </nav>

  <nav
    class="fixed inset-x-4 bottom-3 z-20 flex items-center justify-center gap-2 rounded-2xl border border-cn-border bg-white/90 p-2 shadow-lg backdrop-blur-sm md:hidden"
    aria-label="Navigation principale"
  >
    <a
      href="/chat"
      class="min-w-32 rounded-xl border px-4 py-2 text-center text-sm font-semibold transition-colors {isActive('/chat') ? 'border-cn-dark bg-cn-dark text-white' : 'border-cn-border bg-white text-text-main hover:bg-cn-bg'}"
      aria-current={isActive('/chat') ? 'page' : undefined}
    >
      Messagerie
    </a>
    <a
      href="/posts"
      class="min-w-20 rounded-xl border px-4 py-2 text-center text-sm font-semibold transition-colors {isActive('/posts') ? 'border-cn-dark bg-cn-dark text-white' : 'border-cn-border bg-white text-text-main hover:bg-cn-bg'}"
      aria-current={isActive('/posts') ? 'page' : undefined}
    >
      Fil
    </a>
  </nav>

  <div
    class="relative z-10 flex h-dvh w-full pt-[env(safe-area-inset-top)] pb-[calc(env(safe-area-inset-bottom)+5.5rem)] md:pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
  >
    <div class="h-full w-full">
      <slot />
    </div>
  </div>
</div>
