<script lang="ts">
  /**
   * The CanaReels camera tab (C5): a full-screen preview, the app's own - never the system camera.
   *
   * It owns the preview and the three states around it (opening, refused, live); recording is the
   * `controls` snippet's, so the shutter can be built and tested apart from the device.
   */
  import { onDestroy, onMount, type Snippet } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import { Camera, CameraOff, RefreshCcw, SwitchCamera, X, Zap, ZapOff } from '@lucide/svelte';
  import { CameraSession } from '$lib/reels/cameraSession.svelte';
  import type { CameraFault } from '$lib/reels/cameraAccess';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The session, injectable for tests; the route lets the component make its own. */
    session?: CameraSession;
    /** Whether the lens may change - false while the recorder holds the tracks. */
    lensLocked?: boolean;
    /** What sits over the live preview at the bottom: the shutter and its neighbours. */
    controls?: Snippet<[CameraSession]>;
  }

  let { session = new CameraSession(), lensLocked = false, controls }: Props = $props();

  let video = $state<HTMLVideoElement | null>(null);

  /** Whether this tab was reached from inside the app - then closing it is a step back. */
  let cameFromApp = false;
  afterNavigate(({ from }) => {
    cameFromApp = !!from;
  });

  /**
   * Back to where the member came from. A history step when there is one, so the feed comes back
   * with its scroll; a REPLACE onto the feed when the camera was the first page (a cold link), so
   * Back from the feed does not reopen the camera.
   */
  function close() {
    console.debug(`[camera] close (from app: ${cameFromApp})`);
    session.stop();
    if (cameFromApp) history.back();
    else void goto('/posts', { replaceState: true });
  }

  // The element follows the session's stream; `srcObject` is a property, not an attribute.
  $effect(() => {
    if (video) video.srcObject = session.stream;
  });

  /**
   * THE CAMERA IS GIVEN BACK WHEN THE APP LEAVES THE SCREEN and taken again when it returns: a phone
   * that keeps a camera open in the background shows its privacy dot over every other app, and
   * Android takes the device from a backgrounded holder anyway.
   */
  function onVisibility() {
    if (document.visibilityState === 'hidden') {
      console.debug('[camera] app hidden - releasing the camera');
      session.stop();
    } else if (session.phase === 'stopped') {
      console.debug('[camera] app visible - reopening the camera');
      void session.start();
    }
  }

  onMount(() => {
    void session.start();
    document.addEventListener('visibilitychange', onVisibility);
  });

  onDestroy(() => {
    document.removeEventListener('visibilitychange', onVisibility);
    session.stop();
  });

  const FAULT_TEXT: Record<CameraFault, { title: () => string; body: () => string }> = {
    denied: { title: m.reels_camera_denied_title, body: m.reels_camera_denied_body },
    unavailable: { title: m.reels_camera_unavailable_title, body: m.reels_camera_unavailable_body },
    busy: { title: m.reels_camera_busy_title, body: m.reels_camera_busy_body },
  };
</script>

<section
  class="relative h-full w-full overflow-hidden bg-black text-white"
  aria-label={m.reels_camera_title()}
  data-camera-phase={session.phase}
  data-camera-fault={session.fault ?? undefined}
>
  <!-- The front lens is mirrored as every camera app shows it; the recording is not (the track is). -->
  <video
    bind:this={video}
    class="absolute inset-0 h-full w-full object-cover {session.facing === 'user'
      ? '-scale-x-100'
      : ''} {session.phase === 'live' ? 'opacity-100' : 'opacity-0'}"
    autoplay
    muted
    playsinline
    aria-hidden="true"
  ></video>

  {#if session.phase === 'starting' || session.phase === 'stopped'}
    <div
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/70"
      role="status"
    >
      <Camera size={40} strokeWidth={1.5} />
      <p class="text-sm">{m.reels_camera_starting()}</p>
    </div>
  {:else if session.phase === 'error' && session.fault}
    {@const text = FAULT_TEXT[session.fault]}
    <div
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center"
      role="alert"
    >
      <CameraOff size={40} strokeWidth={1.5} class="text-white/70" />
      <h2 class="text-base font-bold">{text.title()}</h2>
      <p class="text-sm text-white/70">{text.body()}</p>
      <button
        type="button"
        class="mt-2 inline-flex items-center gap-2 rounded-full bg-white/15 px-5 py-2.5 text-sm font-semibold outline-none hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-amber-500"
        onclick={() => void session.start()}
      >
        <RefreshCcw size={16} strokeWidth={2.5} />
        {m.reels_camera_retry()}
      </button>
    </div>
  {/if}

  <!-- The top row: close on the left, the lens controls on the right - Instagram's arrangement. -->
  <div class="absolute inset-x-0 top-0 flex items-start justify-between p-3">
    <button
      type="button"
      class="ui-icon-button rounded-full bg-black/30 outline-none hover:bg-black/50 focus-visible:ring-2 focus-visible:ring-amber-500"
      aria-label={m.reels_camera_close()}
      title={m.reels_camera_close()}
      onclick={close}
    >
      <X size={24} strokeWidth={2.5} />
    </button>

    {#if session.phase === 'live'}
      <div class="flex flex-col gap-3">
        {#if !lensLocked}
          <button
            type="button"
            class="ui-icon-button rounded-full bg-black/30 outline-none hover:bg-black/50 focus-visible:ring-2 focus-visible:ring-amber-500"
            aria-label={m.reels_camera_switch()}
            title={m.reels_camera_switch()}
            onclick={() => void session.switchFacing()}
          >
            <SwitchCamera size={22} strokeWidth={2.25} />
          </button>
        {/if}
        {#if session.torchAvailable}
          <button
            type="button"
            class="ui-icon-button rounded-full bg-black/30 outline-none hover:bg-black/50 focus-visible:ring-2 focus-visible:ring-amber-500"
            aria-label={session.torchOn ? m.reels_camera_torch_off() : m.reels_camera_torch_on()}
            aria-pressed={session.torchOn}
            title={session.torchOn ? m.reels_camera_torch_off() : m.reels_camera_torch_on()}
            onclick={() => void session.toggleTorch()}
          >
            {#if session.torchOn}
              <Zap size={22} strokeWidth={2.25} class="text-amber-400" />
            {:else}
              <ZapOff size={22} strokeWidth={2.25} />
            {/if}
          </button>
        {/if}
      </div>
    {/if}
  </div>

  {#if controls && session.phase === 'live'}
    <div class="absolute inset-x-0 bottom-0 pb-[calc(var(--safe-area-inset-bottom,0px)+1.5rem)]">
      {@render controls(session)}
    </div>
  {/if}
</section>
