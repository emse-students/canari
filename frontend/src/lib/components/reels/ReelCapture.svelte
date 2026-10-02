<script lang="ts">
  /**
   * The CanaReels capture screen (R3): the camera tab's preview, a shutter that films up to the cap
   * (C4), the gallery bottom-left, the take's review, and its publish step (`ReelPublishSheet`).
   *
   * THE CAP IS THE SERVER'S. `GET /api/posts/reel-limits` is the one copy of the 90 s, so the shutter
   * stays disabled until it has answered - an installed app never films to a stale number - and says
   * which of two things happened when it has not: nobody answered, or the server answered with an
   * error (`classifyLimitsFault`).
   *
   * A TAKE IS A HISTORY ENTRY from its first frame to its review's end, so Android's Back (and iOS's
   * edge swipe) ends a recording or discards a review before it leaves the camera, and the tab swipe
   * stands down meanwhile (`isSwipeNavActive` reads the overlay depth).
   */
  import { onDestroy, onMount } from 'svelte';
  import { Images, RefreshCcw } from '@lucide/svelte';
  import CameraScreen from './CameraScreen.svelte';
  import ReelShutter from './ReelShutter.svelte';
  import ReelReview from './ReelReview.svelte';
  import ReelPublishSheet from './ReelPublishSheet.svelte';
  import { CameraSession } from '$lib/reels/cameraSession.svelte';
  import {
    captureReducer,
    classifyLimitsFault,
    formatTakeTime,
    ringFraction,
    type CaptureEvent,
    type CaptureState,
    type LimitsFault,
  } from '$lib/reels/reelCapture';
  import { ReelRecorder, ReelRecorderError } from '$lib/reels/reelRecorder';
  import { readVideoDurationMs } from '$lib/reels/videoDuration';
  import { getReelLimits, type ReelLimits } from '$lib/posts/api';
  import type { PublishReelDeps } from '$lib/reels/publishReel';
  import { refusalStatus } from '$lib/utils/apiRefusal';
  import { isIosTauriRuntime } from '$lib/utils/appVersion';
  import { closeHistoryOverlayFromUi, pushHistoryOverlay } from '$lib/utils/historyOverlayStack';
  import { showToast } from '$lib/stores/toast.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The session, injectable for tests. */
    session?: CameraSession;
    /** The publish step's services, injectable for tests. */
    publishDeps?: PublishReelDeps;
  }

  let { session = new CameraSession(), publishDeps }: Props = $props();

  let capture = $state<CaptureState>({ kind: 'ready' });
  let limits = $state<ReelLimits | null>(null);
  let limitsFault = $state<LimitsFault | null>(null);
  let elapsedMs = $state(0);
  /** The publish step is open over the review (its own history entry, above the take's). */
  let publishOpen = $state(false);

  let recorder: ReelRecorder | null = null;
  let limitTimer: ReturnType<typeof setTimeout> | null = null;
  let frame: number | null = null;
  /** The history entry a take holds; its close discards whatever the take has become. */
  let takeEntry: (() => void) | null = null;
  let picker = $state<HTMLInputElement | null>(null);

  const ios = isIosTauriRuntime();

  async function loadLimits() {
    limitsFault = null;
    try {
      limits = await getReelLimits();
      console.debug(`[reel-capture] cap ${limits.maxDurationMs} ms`);
    } catch (err) {
      limitsFault = classifyLimitsFault(refusalStatus(err));
      console.error(`[reel-capture] the reel limits could not be read (${limitsFault})`, err);
    }
  }

  onMount(() => void loadLimits());

  /** Feeds one event to the reducer and carries out what the transition owes. */
  function send(event: CaptureEvent) {
    const before = capture;
    const after = captureReducer(before, event);
    if (after === before) return;
    console.debug(`[reel-capture] ${before.kind} -> ${after.kind} on ${event.type}`);
    capture = after;
    if (before.kind === 'ready' && after.kind === 'recording') beginTake();
    if (before.kind === 'recording' && after.kind === 'finishing') void endTake();
    if (before.kind === 'ready' && after.kind === 'review') holdTakeEntry();
    if (after.kind === 'ready') {
      publishOpen = false;
      releaseTakeEntry();
    }
  }

  function holdTakeEntry() {
    if (takeEntry) return;
    takeEntry = () => {
      // Back (or the X) while a take exists: a recording is thrown away, a review discarded.
      takeEntry = null;
      console.debug('[reel-capture] the take was dismissed');
      abandonRecording();
      publishOpen = false;
      if (capture.kind !== 'ready') capture = { kind: 'ready' };
    };
    pushHistoryOverlay(takeEntry);
  }

  function releaseTakeEntry() {
    const entry = takeEntry;
    if (entry) closeHistoryOverlayFromUi(entry);
  }

  function beginTake() {
    const stream = session.stream;
    if (!stream || !limits) {
      console.warn('[reel-capture] a take was asked for with no stream or no cap');
      send({ type: 'failed' });
      return;
    }
    try {
      recorder = ReelRecorder.start(stream, ios);
    } catch (err) {
      const fault = err instanceof ReelRecorderError ? err.fault : 'start';
      console.error(`[reel-capture] the take could not start (${fault})`, err);
      showToast(m.reels_capture_record_error(), 'error');
      recorder = null;
      send({ type: 'failed' });
      return;
    }
    holdTakeEntry();
    elapsedMs = 0;
    // THE CAP IS THE PRODUCT'S RULE (C4), so it is a deadline by definition: the ring is full when
    // the take is as long as the server allows, and that ends it exactly as a second tap would.
    limitTimer = setTimeout(() => send({ type: 'limit' }), limits.maxDurationMs);
    const tick = () => {
      if (!recorder) return;
      elapsedMs = Math.min(recorder.elapsedMs, limits?.maxDurationMs ?? recorder.elapsedMs);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  function stopClock() {
    if (limitTimer) clearTimeout(limitTimer);
    limitTimer = null;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  async function endTake() {
    stopClock();
    const ending = recorder;
    recorder = null;
    if (!ending) {
      send({ type: 'failed' });
      return;
    }
    try {
      const blob = await ending.stop();
      send({ type: 'stopped', clip: { blob, source: 'camera' } });
    } catch (err) {
      const fault = err instanceof ReelRecorderError ? err.fault : 'record';
      console.error(`[reel-capture] the take could not be kept (${fault})`, err);
      showToast(m.reels_capture_record_error(), 'error');
      send({ type: 'failed' });
    }
  }

  function abandonRecording() {
    stopClock();
    recorder?.abort();
    recorder = null;
  }

  /** A video from the gallery, refused at once when it is over the cap. */
  async function onPicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !limits) return;
    if (!file.type.startsWith('video/')) {
      console.warn(`[reel-capture] picked a ${file.type || 'typeless'} file, not a video`);
      showToast(m.reels_capture_not_a_video(), 'error');
      return;
    }
    const durationMs = await readVideoDurationMs(file);
    if (durationMs !== null && durationMs > limits.maxDurationMs) {
      console.warn(`[reel-capture] picked ${durationMs} ms, over ${limits.maxDurationMs}`);
      showToast(
        m.reels_capture_too_long({ seconds: Math.round(limits.maxDurationMs / 1000) }),
        'error'
      );
      return;
    }
    send({ type: 'picked', clip: { blob: file, source: 'gallery' } });
  }

  /** The take is about to lose its camera (the app is going to the background): end it, keep it. */
  function onBeforeRelease() {
    if (capture.kind === 'recording') send({ type: 'limit' });
  }

  onDestroy(() => {
    abandonRecording();
    const entry = takeEntry;
    takeEntry = null;
    if (entry) closeHistoryOverlayFromUi(entry);
  });

  const recording = $derived(capture.kind === 'recording' || capture.kind === 'finishing');
  const fraction = $derived(limits ? ringFraction(elapsedMs, limits.maxDurationMs) : 0);
</script>

<div class="relative h-full w-full">
  <CameraScreen
    {session}
    lensLocked={recording}
    paused={capture.kind === 'review'}
    {onBeforeRelease}
  >
    {#snippet controls()}
      <div class="grid grid-cols-3 items-end px-6">
        <div class="flex justify-start pb-6">
          {#if !recording}
            <button
              type="button"
              class="flex h-11 w-11 items-center justify-center rounded-lg border-2 border-white/80 bg-black/30 outline-none hover:bg-black/50 focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-40"
              aria-label={m.reels_capture_gallery()}
              title={m.reels_capture_gallery()}
              disabled={!limits}
              data-swipe-nav-ignore
              onclick={() => picker?.click()}
            >
              <Images size={22} strokeWidth={2} />
            </button>
            <input
              bind:this={picker}
              type="file"
              accept="video/*"
              class="hidden"
              onchange={onPicked}
            />
          {/if}
        </div>
        <div class="flex justify-center">
          <ReelShutter
            {recording}
            {fraction}
            timeLabel={formatTakeTime(elapsedMs)}
            disabled={!limits || capture.kind === 'finishing'}
            onpress={(at) => send({ type: 'press', at })}
            onrelease={(at) => send({ type: 'release', at })}
          />
        </div>
        <div></div>
      </div>
      {#if limitsFault}
        <div class="mt-3 flex justify-center" role="alert" data-reel-limits-fault={limitsFault}>
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-full bg-black/50 px-4 py-2 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            onclick={() => void loadLimits()}
          >
            <RefreshCcw size={14} strokeWidth={2.5} />
            {limitsFault === 'unreachable'
              ? m.reels_capture_limits_error()
              : m.reels_capture_limits_refused()}
          </button>
        </div>
      {/if}
    {/snippet}
  </CameraScreen>

  {#if capture.kind === 'review'}
    {@const clip = capture.clip}
    {#if publishOpen && limits}
      <ReelPublishSheet {clip} {limits} deps={publishDeps} onclose={() => (publishOpen = false)} />
    {:else}
      <ReelReview
        {clip}
        ondiscard={() => send({ type: 'discard' })}
        onnext={() => (publishOpen = true)}
      />
    {/if}
  {/if}
</div>
