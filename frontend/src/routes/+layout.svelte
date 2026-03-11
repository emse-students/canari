<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
</script>

<div class="route-shell">
  {#if $page.url.pathname.startsWith('/chat')}
    <div class="chat-blobs" aria-hidden="true">
      <span class="blob blob-a"></span>
      <span class="blob blob-b"></span>
      <span class="blob blob-c"></span>
    </div>
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

  .chat-blobs {
    position: fixed;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    overflow: hidden;
  }

  .blob {
    position: absolute;
    border-radius: 9999px;
    filter: blur(52px);
    opacity: 0.68;
    mix-blend-mode: screen;
  }

  .blob-a {
    width: min(48vw, 420px);
    height: min(48vw, 420px);
    left: -10%;
    top: -12%;
    background: color-mix(in srgb, var(--cn-yellow) 82%, #0b0f18 18%);
  }

  .blob-b {
    width: min(42vw, 360px);
    height: min(42vw, 360px);
    right: -8%;
    top: 12%;
    background: color-mix(in srgb, #4da7ff 78%, #0b0f18 22%);
    animation-delay: -5s;
  }

  .blob-c {
    width: min(52vw, 460px);
    height: min(52vw, 460px);
    right: 12%;
    bottom: -20%;
    background: color-mix(in srgb, #33d4a4 68%, #0b0f18 32%);
    animation-delay: -9s;
  }

</style>
