<script lang="ts">
  /**
   * The CanaReels camera tab (C5): a full-screen preview, the app's own - never the system camera.
   *
   * It owns the preview and the three states around it (opening, refused, live); recording is the
   * `controls` snippet's, so the shutter can be built and tested apart from the device.
   */
  import { onDestroy, onMount, untrack, type Snippet } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import {
    Camera,
    CameraOff,
    RefreshCcw,
    Settings,
    SwitchCamera,
    X,
    Zap,
    ZapOff,
  } from '@lucide/svelte';
  import { hasNativeGallery, openAppSettings } from '$lib/reels/gallery';
  import { CameraSession } from '$lib/reels/cameraSession.svelte';
  import type { CameraFault } from '$lib/reels/cameraAccess';
  import {
    FramedStream,
    takeFramedPhoto,
    type CameraCapture,
    type PreviewBox,
  } from '$lib/reels/framedCapture';
  import { themeStore } from '$lib/stores/themeStore.svelte';
  import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The session, injectable for tests; the route lets the component make its own. */
    session?: CameraSession;
    /**
     * True during a take: the lens cannot change (a recorder cannot swap a track mid-file) and the
     * close button stands down.
     */
    lensLocked?: boolean;
    /** What sits over the live preview at the bottom: the shutter and its neighbours. */
    controls?: Snippet;
    /** What a capture can take, handed to the owner of the shutter (bind it). */
    capture?: CameraCapture;
    /**
     * Holds the camera OFF while true - a take under review needs no preview, and an open camera
     * would keep the phone's privacy dot lit for nothing. Turning it false opens the camera again.
     */
    paused?: boolean;
    /**
     * Called just before the app's going to the background takes the camera away, so a take in
     * progress can be ended - and kept - while its tracks still flow.
     */
    onBeforeRelease?: () => void;
  }

  let {
    session = new CameraSession(),
    lensLocked = false,
    controls,
    paused = false,
    onBeforeRelease,
    capture = $bindable(),
  }: Props = $props();

  let video = $state<HTMLVideoElement | null>(null);

  /**
   * The element holds a decoded frame of the CURRENT stream. `live` only says a track is in hand: from
   * there to the first frame the element draws the engine's own placeholder (Android: a grey glyph),
   * so the preview stays transparent and Canari's stand-in stays up until this is true - a fact the
   * element reports (`loadeddata` / `playing` with a real picture), never a delay.
   */
  let frameReady = $state(false);

  /** Up from the swipe to the first frame; the refusal screen has its own and replaces it. */
  const standInShown = $derived(
    session.phase !== 'error' && !(session.phase === 'live' && frameReady)
  );

  function onFrame() {
    if (!video || video.videoWidth === 0 || frameReady) return;
    console.debug(`[camera] first frame ${video.videoWidth}x${video.videoHeight}`);
    frameReady = true;
  }

  /** The preview element's layout box: the rectangle a capture must reproduce (framedCapture.ts). */
  function previewBox(el: HTMLVideoElement): PreviewBox {
    return {
      width: el.clientWidth,
      height: el.clientHeight,
      dpr: window.devicePixelRatio || 1,
    };
  }

  /**
   * What the shutter can take. Both captures are the PREVIEW'S crop and are never mirrored (the
   * mirror is a CSS transform on the element, which a canvas read of its frame ignores).
   */
  capture = {
    get ready() {
      return frameReady && session.phase === 'live';
    },
    photo() {
      if (!video || !frameReady) {
        console.warn('[camera] photo asked for before the first frame');
        return Promise.resolve(null);
      }
      return takeFramedPhoto(video, previewBox(video));
    },
    startFramedStream() {
      if (!video || !frameReady) {
        console.warn('[camera] a take was asked for before the first frame');
        return null;
      }
      return FramedStream.start(video, previewBox(video), session.stream?.getAudioTracks() ?? []);
    },
  };

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
  // `muted` is set as a PROPERTY too: the template is cloned, and a cloned element does not take its
  // muted STATE from the attribute, so the live microphone played through the speaker (an echo).
  $effect(() => {
    frameReady = false;
    if (!video) return;
    video.muted = true;
    video.srcObject = session.stream;
  });

  /**
   * THE CAMERA IS GIVEN BACK WHEN THE APP LEAVES THE SCREEN and taken again when it returns: a phone
   * that keeps a camera open in the background shows its privacy dot over every other app, and
   * Android takes the device from a backgrounded holder anyway.
   */
  function onVisibility() {
    if (document.visibilityState === 'hidden') {
      console.debug('[camera] app hidden - releasing the camera');
      onBeforeRelease?.();
      session.stop();
    } else if (session.phase === 'stopped' && !paused) {
      console.debug('[camera] app visible - reopening the camera');
      void session.start();
    }
  }

  // Opens the camera on arrival and after a pause, and closes it for one. Only `paused` is read
  // here: the session's own state is read untracked, or every phase change would re-run this.
  $effect(() => {
    const hold = paused;
    untrack(() => {
      if (hold) {
        if (session.phase !== 'stopped') session.stop();
      } else if (session.phase === 'stopped' && document.visibilityState !== 'hidden') {
        void session.start();
      }
    });
  });

  onMount(() => {
    document.addEventListener('visibilitychange', onVisibility);
    // The preview runs under the status bar, so its icons stay light in the light theme too.
    const releaseBar = themeStore.holdNativeBar('dark');
    return () => releaseBar();
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

  /**
   * THE DENIED STATE NAMES THE PHONE'S SETTINGS, SO IT OFFERS THEM. On the phone apps a refused
   * camera or microphone is given back on the app's page in the system settings, and a retry alone
   * would only meet the same refusal (iOS never asks twice). The web has no such page to open.
   */
  const canOpenSettings = hasNativeGallery();

  async function openSettings() {
    try {
      await openAppSettings();
    } catch (err) {
      console.error('[camera] the settings page did not open', err);
    }
  }
</script>

<section
  class="relative h-full w-full overflow-hidden bg-black text-white"
  aria-label={m.reels_camera_title()}
  data-camera-phase={session.phase}
  data-camera-fault={session.fault ?? undefined}
>
  <!-- The front lens is mirrored as every camera app shows it; the saved photo and take are not (they
       are drawn from the decoded frame, which this CSS transform never touches, framedCapture.ts).
       THE ELEMENT IS KEYED BY THE STREAM: WKWebView keeps a <video> element's media layer at the size
       of its FIRST layout, so an element handed a second stream after the app came back from the
       background drew a ~65 % letterboxed rectangle while its CSS box stayed 390x844 and
       `object-fit: cover` - any style change healed it, a fresh element never had it (iPhone 12,
       2026-10-02, reproduced 5 of 5 on a home-and-return, 0 of 40 without). One element per stream
       is the state the engine gets right. -->
  {#key session.stream}
    <video
      bind:this={video}
      class="absolute inset-0 h-full w-full object-cover {session.facing === 'user'
        ? '-scale-x-100'
        : ''} {session.phase === 'live' && frameReady
        ? 'opacity-100'
        : 'opacity-0'} transition-opacity duration-200 motion-reduce:transition-none"
      poster={TRANSPARENT_VIDEO_POSTER}
      onloadeddata={onFrame}
      onplaying={onFrame}
      autoplay
      muted
      playsinline
      aria-hidden="true"
    ></video>
  {/key}

  <!-- Canari's stand-in for everything between the swipe and the first frame: a dark surface of the
       app's own, so the engine's placeholder is never seen. It stays mounted and fades out as the
       preview fades in, so the two cross-fade instead of cutting. -->
  <div
    class="from-cn-ink to-cn-scrim pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-linear-to-b text-white/70 transition-opacity duration-200 motion-reduce:transition-none {standInShown
      ? 'opacity-100'
      : 'opacity-0'}"
    role={standInShown ? 'status' : undefined}
    aria-hidden={!standInShown}
    data-camera-standin={standInShown ? 'shown' : 'gone'}
  >
    <Camera size={40} strokeWidth={1.5} class="motion-safe:animate-pulse" />
    <p class="text-sm">{m.reels_camera_starting()}</p>
  </div>

  {#if session.phase === 'error' && session.fault}
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
      {#if session.fault === 'denied' && canOpenSettings}
        <button
          type="button"
          class="text-cn-ink inline-flex items-center gap-2 rounded-full bg-amber-500 px-5 py-2.5 text-sm font-semibold outline-none hover:bg-amber-400 focus-visible:ring-2 focus-visible:ring-white"
          onclick={() => void openSettings()}
          data-camera-open-settings
        >
          <Settings size={16} strokeWidth={2.5} />
          {m.reels_open_settings()}
        </button>
      {/if}
    </div>
  {/if}

  <!-- The top row: close on the left, the lens controls on the right - Instagram's arrangement. -->
  <!-- No close during a take: it is a history entry of its own, so a step back would end the take,
       not leave the tab - the shutter and Back are what end it. -->
  <div
    class="absolute inset-x-0 top-0 flex items-start justify-between p-3 pt-[calc(var(--safe-area-inset-top,0px)+0.75rem)]"
  >
    {#if lensLocked}
      <span></span>
    {:else}
      <button
        type="button"
        class="ui-icon-button rounded-full bg-black/30 outline-none hover:bg-black/50 focus-visible:ring-2 focus-visible:ring-amber-500"
        aria-label={m.reels_camera_close()}
        title={m.reels_camera_close()}
        onclick={close}
      >
        <X size={24} strokeWidth={2.5} />
      </button>
    {/if}

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
      {@render controls()}
    </div>
  {/if}
</section>
