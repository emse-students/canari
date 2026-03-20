<script lang="ts">
  import '../app.css';
  import BackgroundBlobs from '$lib/components/BackgroundBlobs.svelte';
  import { page } from '$app/state';

  let { children } = $props();

  const pathname = $derived(page.url.pathname);

  function isActive(path: string): boolean {
    return pathname === path || pathname.startsWith(`${path}/`);
  }

  function navClass(path: string): string {
    return isActive(path)
      ? 'rounded-2xl border border-cn-dark bg-cn-dark px-4 py-2 text-sm font-semibold text-white shadow-sm'
      : 'rounded-2xl border border-cn-border bg-white/75 px-4 py-2 text-sm font-medium text-text-main hover:bg-white';
  }
</script>

<div class="relative min-h-dvh overflow-hidden">
  <div class="fixed inset-0 z-0 pointer-events-none">
    <BackgroundBlobs />
  </div>

  <header class="sticky top-0 z-20 border-b border-cn-border/70 bg-white/82 backdrop-blur-lg">
    <div class="mx-auto flex w-full max-w-[1180px] items-center justify-between gap-3 px-3 py-3 sm:px-5">
      <a href="/chat" class="flex items-center gap-2 text-text-main">
        <span class="inline-flex h-9 w-9 items-center justify-center rounded-2xl bg-cn-dark text-sm font-black text-white"
          >C</span
        >
        <div class="leading-tight">
          <p class="text-sm font-black tracking-[0.08em] uppercase">Canari</p>
          <p class="text-[11px] text-text-muted">messagerie + fil social</p>
        </div>
      </a>

      <nav class="flex items-center gap-2" aria-label="Navigation principale">
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
    </div>
  </header>

  <div
    class="relative z-10 mx-auto flex h-[calc(100dvh-4.5rem)] w-full max-w-[1180px] px-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
  >
    <div class="h-full w-full">
      {@render children?.()}
    </div>
  </div>
</div>
