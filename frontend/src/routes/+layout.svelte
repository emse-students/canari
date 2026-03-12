<script lang="ts">
  import '../app.css';
  import BackgroundBlobs from '$lib/components/BackgroundBlobs.svelte';
</script>

<div class="relative min-h-dvh overflow-hidden">
  <div class="fixed inset-0 z-0 pointer-events-none">
    <BackgroundBlobs />
  </div>

  <div
    class="relative z-10 flex h-screen w-full pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
  >
    <div class="h-full w-full">
      <slot />
    </div>
  </div>
</div>
