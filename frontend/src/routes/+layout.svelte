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
    z-index: 1;
    min-height: 100dvh;
  }

  .chat-blobs {
    position: fixed;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    overflow: hidden;
  }

  .blob {
    position: absolute;
    border-radius: 9999px;
    filter: blur(40px);
    opacity: 0.45;
    animation: drift 16s ease-in-out infinite;
  }

  .blob-a {
    width: min(48vw, 420px);
    height: min(48vw, 420px);
    left: -10%;
    top: -12%;
    background: color-mix(in srgb, var(--cn-yellow) 70%, white 30%);
  }

  .blob-b {
    width: min(42vw, 360px);
    height: min(42vw, 360px);
    right: -8%;
    top: 12%;
    background: color-mix(in srgb, #8bc4ff 72%, white 28%);
    animation-delay: -5s;
  }

  .blob-c {
    width: min(52vw, 460px);
    height: min(52vw, 460px);
    right: 12%;
    bottom: -20%;
    background: color-mix(in srgb, #9de6c1 60%, white 40%);
    animation-delay: -9s;
  }

  @keyframes drift {
    0% {
      transform: translate3d(0, 0, 0) scale(1);
    }
    50% {
      transform: translate3d(10px, -12px, 0) scale(1.04);
    }
    100% {
      transform: translate3d(0, 0, 0) scale(1);
    }
  }
</style>
