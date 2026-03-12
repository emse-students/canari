<div class="chat-blobs" aria-hidden="true">
  <span class="blob blob-a"></span>
  <span class="blob blob-b"></span>
  <span class="blob blob-c"></span>
  <span class="blob blob-d"></span>
  <span class="blob blob-e"></span>
  <span class="noise-overlay"></span>
</div>

<style>
  .chat-blobs {
    position: fixed;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    overflow: hidden;
    background-color: transparent;
  }

  .blob {
    position: absolute;
    border-radius: 50%;
    filter: blur(100px);
    transform: scale(1.08);
    opacity: 0.56;
    mix-blend-mode: multiply;
  }

  .blob-a {
    width: min(64vw, 760px);
    height: min(64vw, 760px);
    left: -20%;
    top: -24%;
    background: color-mix(in srgb, var(--cn-yellow) 90%, #ffd86a 10%);
  }

  .blob-b {
    width: min(54vw, 640px);
    height: min(54vw, 640px);
    right: -18%;
    top: -10%;
    background: color-mix(in srgb, #ffe084 86%, var(--cn-yellow) 14%);
  }

  .blob-c {
    width: min(58vw, 700px);
    height: min(58vw, 700px);
    left: 10%;
    bottom: -34%;
    background: color-mix(in srgb, #f6c232 78%, #ffbf3f 22%);
  }

  .blob-d {
    width: min(42vw, 520px);
    height: min(42vw, 520px);
    right: 6%;
    bottom: -14%;
    background: color-mix(in srgb, #ffd157 72%, #ffeaab 28%);
    opacity: 0.46;
  }

  .blob-e {
    width: min(36vw, 440px);
    height: min(36vw, 440px);
    left: 34%;
    top: 28%;
    background: color-mix(in srgb, #ffe6a2 66%, var(--cn-yellow) 34%);
    opacity: 0.34;
  }

  .noise-overlay {
    position: absolute;
    inset: 0;
    opacity: 0.055;
    z-index: 2;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.72' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
  }

  :global(:root[data-theme='dark']) .blob {
    opacity: 0.2;
    mix-blend-mode: screen;
  }

  :global(:root[data-theme='dark']) .blob-a {
    background: color-mix(in srgb, var(--cn-yellow) 62%, #6f520f 38%);
  }

  :global(:root[data-theme='dark']) .blob-b {
    background: color-mix(in srgb, #f0bf3b 56%, #513c0d 44%);
  }

  :global(:root[data-theme='dark']) .blob-c {
    background: color-mix(in srgb, #e6b532 52%, #4a360a 48%);
  }

  :global(:root[data-theme='dark']) .blob-d {
    background: color-mix(in srgb, #f7c84f 58%, #5a420d 42%);
    opacity: 0.16;
  }

  :global(:root[data-theme='dark']) .blob-e {
    background: color-mix(in srgb, #f8ce62 52%, #60450c 48%);
    opacity: 0.14;
  }

  :global(:root[data-theme='dark']) .noise-overlay {
    opacity: 0.035;
  }
</style>
