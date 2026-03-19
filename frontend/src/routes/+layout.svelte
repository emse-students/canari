<script lang="ts">
  import '../app.css';
  import BackgroundBlobs from '$lib/components/BackgroundBlobs.svelte';
</script>

<div class="relative min-h-dvh overflow-hidden">
  <div class="fixed inset-0 z-0 pointer-events-none">
    <BackgroundBlobs />
  </div>

  <nav class="fixed right-4 top-4 z-20 flex items-center gap-2">
    <a
      href="/chat"
      class="rounded-full border border-cn-border bg-white/85 px-3 py-1.5 text-xs font-medium text-text-main hover:bg-white"
    >
      Chat
    </a>
    <a
      href="/posts"
      class="rounded-full border border-cn-border bg-white/85 px-3 py-1.5 text-xs font-medium text-text-main hover:bg-white"
    >
      Posts
    </a>
  </nav>

  <div
    class="relative z-10 flex h-dvh w-full pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
  >
    <div class="h-full w-full">
      <slot />
    </div>
  </div>
</div>
