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
  }
</style>
