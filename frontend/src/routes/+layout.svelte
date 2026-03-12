<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import BackgroundBlobs from '$lib/components/BackgroundBlobs.svelte';
</script>

<div class="route-shell">
  {#if $page.url.pathname.startsWith('/chat')}
    <BackgroundBlobs />
  {/if}
  <div class="route-content"><slot /></div>
</div>

<style>
  .route-shell {
    position: relative;
    min-height: 100dvh;
  }

  .route-content {
    position: relative;
    z-index: 2;
    min-height: 100dvh;
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
    padding-left: env(safe-area-inset-left);
    padding-right: env(safe-area-inset-right);
  }
</style>
