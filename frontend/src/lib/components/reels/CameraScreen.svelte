<script lang="ts">
  import { resolve } from '$app/paths';
  /**
   * The CanaReels camera tab (C5): the app's own preview - never the system camera - in the ONE reel frame (`ReelFrame`, 9:16),
   * so the recorded file has the ratio the review, the editor and the viewer draw.
   *
   * It owns the preview and the three states around it (opening, refused, live); recording is the
   * `controls` snippet's, so the shutter can be built and tested apart from the device.
   */
  import { onDestroy, onMount, untrack, type Snippet } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import { CAMERA_DEFAULT_ORIGIN, cameraOriginFrom } from '$lib/reels/cameraOrigin';
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
    shouldMirrorCapture,
    takeFramedPhoto,
    takeFramedThumbnail,
    type CameraCapture,
    type FrameSource,
    type PreviewBox,
  } from '$lib/reels/framedCapture';
  import { themeStore } from '$lib/stores/themeStore.svelte';
  import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';
  import { m } from '$lib/paraglide/messages';
  import { previewDoubleTap } from '$lib/reels/previewDoubleTap';
  import ReelFrame from './ReelFrame.svelte';

  interface Props {
    /** The session, injectable for tests; the route lets the component make its own. */
    session?: CameraSession;
    /**
     * True during a take: the close button stands down, and a lens flip keeps the take's microphone
     * and recorder (`CameraSession.flipDuringTake`) instead of reopening everything.
     */
    recording?: boolean;
    /**
     * Whether the capture lets the lens flip now (`lensFlipAllowed`): the button and the preview's
     * double tap both stand down while a press is being decided or a take is finishing, where a
     * reopen would release the microphone under the recorder. Default true (no capture around it).
     */
    flipAllowed?: boolean;
    /** What sits over the live preview at the bottom: the shutter and its neighbours. */
    controls?: Snippet;
    /**
     * What the refusal screen offers beside its retry: a way on that needs no camera (the reel
     * tab's gallery), so a member who refused the camera is not left at a dead end.
     */
    faultActions?: Snippet;
    /** What a capture can take, handed to the owner of the shutter (bind it). */
    capture?: CameraCapture;
    /**
     * Holds the camera OFF while true - a take under review needs no preview, and an open camera
     * would keep the phone's privacy dot lit for nothing. Turning it false opens the camera again.
     */
    paused?: boolean;
    /**
     * Holds a STOPPED camera stopped, without closing a live one: the owner has handed the screen to
     * something that will decide what comes next (the gallery picker, whose answer may be a review
     * that needs no camera). On Android the picker backgrounds the app, so its return would reopen
     * the camera for the fraction of a second before the pick lands in a review (Mi 9T, 2026-10-28).
     * A live camera is left alone: a picker that does not hide the page (a desktop browser) keeps
     * its preview. Turning it false opens a stopped camera again, as `paused` does.
     */
    deferOpen?: boolean;
    /**
     * THE WAY OUT OF A DEFERRAL NOBODY ENDS. The owner lifts `deferOpen` when the picker answers, and
     * some pickers never do: an engine with no `cancel` event on a file input (Chromium < 113, Safari
     * < 16.4) or a native dismissal its plugin never settles. So while the camera is stopped, the
     * open deferred and the page on screen, the stand-in offers to open the camera, and this is the
     * member's tap on it: the owner lifts the deferral. A gesture, never a clock.
     */
    onreopen?: () => void;
    /**
     * Called just before the app's going to the background takes the camera away, so a take in
     * progress can be ended - and kept - while its tracks still flow.
     */
    onBeforeRelease?: () => void;
    /**
     * Closes the camera when it was opened as an OVERLAY (a composer's camera, `CameraOverlay`): the
     * owner unmounts it. Absent on the tab, where close navigates back to the origin tab.
     */
    onclose?: () => void;
    /**
     * The open asks for the MICROPHONE in the lens's own request (the reel tab), so a refusal may be
     * either and the refusal text names both. A chat camera never asks for it and a post camera asks
     * it apart (`postCameraOpener`), so their refusal is the camera's alone.
     */
    microphoneAsked?: boolean;
  }

  let {
    session = new CameraSession(),
    recording = false,
    flipAllowed = true,
    controls,
    faultActions,
    paused = false,
    deferOpen = false,
    onreopen,
    onBeforeRelease,
    onclose,
    microphoneAsked = true,
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

  /** The page is on screen: the member can see, and tap, what the stand-in offers. */
  let onScreen = $state(typeof document === 'undefined' || document.visibilityState !== 'hidden');

  /**
   * The camera is stopped because the owner deferred its open, and the member is looking at it: the
   * stand-in's "opening" would be a lie, so it offers the open instead (`onreopen`).
   */
  const reopenOffered = $derived(
    !!onreopen && deferOpen && !paused && onScreen && session.phase === 'stopped'
  );

  /** The member asked for the camera while its open was deferred: the owner lifts the deferral. */
  function reopen() {
    console.debug('[camera] reopen tapped while the open was deferred: the owner lifts it');
    onreopen?.();
  }

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
      mirror: shouldMirrorCapture(session.facing),
      zoom: digitalZoom,
    };
  }

  /**
   * The DIGITAL zoom the preview is enlarged by (`cameraZoom.ts`), 1 on a lens zoomed by its hardware
   * (its frame arrives zoomed). The preview scales by it about its centre and every capture draws the
   * same centred part (`PreviewBox.zoom`), so the file shows what the preview shows.
   */
  const digitalZoom = $derived(session.zoomRange.mode === 'digital' ? session.zoom : 1);

  /**
   * The other lens: outside a take the session reopens everything; DURING one only the lens is
   * replaced and the microphone and the recorder run on (`flipDuringTake`). The flip resets the zoom.
   */
  function flip() {
    if (!flipAllowed || !session.canSwitch) {
      console.debug('[camera] flip asked while it is forbidden or there is one camera - ignored');
      return;
    }
    console.debug(`[camera] flip ${recording ? 'during a take' : 'outside a take'}`);
    void (recording ? session.flipDuringTake() : session.switchFacing());
  }

  /**
   * What the shutter can take. Both captures are the PREVIEW'S crop, drawn mirrored on the front lens
   * exactly as the preview is (the CSS mirror is invisible to a canvas read, so the capture does it).
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
    thumbnail() {
      if (!video || !frameReady) {
        console.warn('[camera] a thumbnail was asked for before the first frame');
        return null;
      }
      return takeFramedThumbnail(video, previewBox(video));
    },
    startFramedStream() {
      if (!video || !frameReady) {
        console.warn('[camera] a take was asked for before the first frame');
        return null;
      }
      // The take reads its frame from WHATEVER element shows the current lens, every frame: a flip
      // during the take replaces the element (keyed by the stream), and until the new lens has a
      // decoded frame there is nothing to read, so the take holds its last picture.
      const source: FrameSource = () =>
        session.flipping || !frameReady || !video ? null : { video, box: previewBox(video) };
      return FramedStream.start(source, session.stream?.getAudioTracks() ?? []);
    },
  };

  /** The tab this camera was opened from (see {@link cameraOriginFrom}). */
  let origin = CAMERA_DEFAULT_ORIGIN;
  afterNavigate(({ from, shallow, type }) => {
    // A SHALLOW navigation (SvelteKit 3 runs the lifecycle hooks for them too) is a tab or query
    // change on the same page: not a page the hook is about.
    if (shallow && type === 'goto') return;
    origin = cameraOriginFrom(from?.url);
  });

  /**
   * Back to the tab the member came from, by name and as a REPLACE of the camera's entry, so Back
   * from that tab does not reopen the camera. Not `history.back()`: its target is whatever entry
   * sits below, which landed on the Dashboard (Mi 9T, 2026-10-06).
   */
  function close() {
    session.stop();
    if (onclose) {
      console.debug('[camera] close, overlay');
      onclose();
      return;
    }
    console.debug(`[camera] close, back to ${origin}`);
    void goto(resolve(origin as '/'), { replace: true });
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
    onScreen = document.visibilityState !== 'hidden';
    if (!onScreen) {
      console.debug('[camera] app hidden - releasing the camera');
      onBeforeRelease?.();
      // `suspend`, not `stop`: the permission dialog backgrounds the app, and its answer is awaited.
      session.suspend();
    } else if (paused || deferOpen) {
      // The owner holds the camera off (a review, a screen being left, a pick in flight): the
      // return is not a reason to open it.
      console.debug(`[camera] app visible, ${paused ? 'paused' : 'open deferred'} - not reopened`);
    } else {
      console.debug('[camera] app visible');
      session.resume();
    }
  }

  // Opens the camera on arrival and after a pause, and closes it for one. Only `paused` and
  // `deferOpen` are read here: the session's own state is read untracked, or every phase change
  // would re-run this.
  $effect(() => {
    const hold = paused;
    const defer = deferOpen;
    untrack(() => {
      if (hold) {
        if (session.phase !== 'stopped') session.stop();
      } else if (session.phase !== 'stopped' || document.visibilityState === 'hidden') {
        return;
      } else if (defer) {
        console.debug('[camera] stopped with the open deferred by the owner - not started');
      } else {
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
    denied: {
      title: m.reels_camera_denied_title,
      body: () =>
        microphoneAsked ? m.reels_camera_denied_body() : m.reels_camera_denied_body_camera_only(),
    },
    unavailable: { title: m.reels_camera_unavailable_title, body: m.reels_camera_unavailable_body },
    busy: { title: m.reels_camera_busy_title, body: m.reels_camera_busy_body },
    interrupted: {
      title: m.reels_camera_interrupted_title,
      body: m.reels_camera_interrupted_body,
    },
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

<!-- A DOUBLE TAP ON THE PREVIEW FLIPS THE LENS, during a take too (previewDoubleTap.ts), never
     while the capture forbids it (`flipAllowed`). -->
<section
  class="relative h-full w-full overflow-hidden bg-black text-white"
  use:previewDoubleTap={{
    onDoubleTap: flip,
    enabled: session.phase === 'live' && flipAllowed && session.canSwitch,
  }}
  aria-label={m.reels_camera_title()}
  data-camera-phase={session.phase}
  data-camera-fault={session.fault ?? undefined}
>
  <!-- The front lens is mirrored as every camera app shows it; the saved photo and take are drawn
       mirrored too (a canvas read of the decoded frame ignores this CSS transform, framedCapture.ts).
       THE ELEMENT IS KEYED BY THE STREAM: WKWebView keeps a <video> element's media layer at the size
       of its FIRST layout, so an element handed a second stream after the app came back from the
       background drew a ~65 % letterboxed rectangle while its CSS box stayed 390x844 and
       `object-fit: cover` - any style change healed it, a fresh element never had it (iPhone 12,
       2026-10-02, reproduced 5 of 5 on a home-and-return, 0 of 40 without). One element per stream
       is the state the engine gets right. -->
  <ReelFrame>
    {#key session.stream}
      <video
        bind:this={video}
        class="absolute inset-0 h-full w-full object-cover {session.facing === 'user'
          ? '-scale-x-100'
          : ''} {session.phase === 'live' && frameReady
          ? 'opacity-100'
          : 'opacity-0'} transition-opacity duration-200 motion-reduce:transition-none"
        style:transform={digitalZoom > 1 ? `scale(${digitalZoom})` : undefined}
        data-camera-zoom={session.zoom.toFixed(2)}
        poster={TRANSPARENT_VIDEO_POSTER}
        onloadeddata={onFrame}
        onplaying={onFrame}
        onresize={(e) =>
          console.debug(
            `[camera] preview resolution ${e.currentTarget.videoWidth}x${e.currentTarget.videoHeight}`
          )}
        autoplay
        muted
        playsinline
        aria-hidden="true"
      ></video>
    {/key}
  </ReelFrame>

  <!-- Canari's stand-in for everything between the swipe and the first frame: a dark surface of the
       app's own, so the engine's placeholder is never seen. It stays mounted and fades out as the
       preview fades in, so the two cross-fade instead of cutting. -->
  <div
    class="from-cn-ink to-cn-scrim pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-linear-to-b text-white/70 transition-opacity duration-200 motion-reduce:transition-none {standInShown
      ? 'opacity-100'
      : 'opacity-0'}"
    role={standInShown && !reopenOffered ? 'status' : undefined}
    aria-hidden={!standInShown || reopenOffered}
    data-camera-standin={standInShown ? 'shown' : 'gone'}
  >
    {#if !reopenOffered}
      <Camera size={40} strokeWidth={1.5} class="motion-safe:animate-pulse" />
      <p class="text-sm">{m.reels_camera_starting()}</p>
    {/if}
  </div>

  <!-- A deferred open that nothing ended (a picker that never said it closed): the member's tap is
       the way back, on the stand-in's own surface. -->
  {#if reopenOffered}
    <div class="absolute inset-0 flex items-center justify-center">
      <button
        type="button"
        class="inline-flex flex-col items-center gap-3 rounded-lg px-6 py-4 text-sm font-semibold text-white/90 outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-amber-500"
        data-camera-reopen
        onclick={reopen}
      >
        <Camera size={40} strokeWidth={1.5} />
        {m.reels_camera_reopen()}
      </button>
    </div>
  {/if}

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
      {#if faultActions}
        {@render faultActions()}
      {/if}
    </div>
  {/if}

  <!-- The top row: close on the left, the lens controls on the right - Instagram's arrangement. -->
  <!-- No close during a take: it is a history entry of its own, so a step back would end the take,
       not leave the tab - the shutter and Back are what end it. -->
  <div
    class="absolute inset-x-0 top-0 flex items-start justify-between p-3 pt-[calc(var(--safe-area-inset-top,0px)+0.75rem)]"
  >
    {#if recording}
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
        {#if session.canSwitch}
          <button
            type="button"
            class="ui-icon-button rounded-full bg-black/30 outline-none hover:bg-black/50 focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-40"
            aria-label={m.reels_camera_switch()}
            title={m.reels_camera_switch()}
            disabled={session.flipping || !flipAllowed}
            onclick={flip}
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
    <!-- The shutter row is never part of the preview's double tap: the finger holding a take is
         down here for the whole take. -->
    <div
      class="absolute inset-x-0 bottom-0 pb-[calc(var(--safe-area-inset-bottom,0px)+1.5rem)]"
      data-no-double-tap
    >
      {@render controls()}
    </div>
  {/if}
</section>
