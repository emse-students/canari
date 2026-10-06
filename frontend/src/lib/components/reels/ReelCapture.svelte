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
    SHUTTER_HOLD_THRESHOLD_MS,
    type CaptureEvent,
    type CaptureState,
    type LimitsFault,
  } from '$lib/reels/reelCapture';
  import { ReelRecorder, ReelRecorderError } from '$lib/reels/reelRecorder';
  import type { CameraCapture, FramedStream } from '$lib/reels/framedCapture';
  import { settings } from '$lib/stores/settingsStore.svelte';
  import { readVideoDurationMs } from '$lib/reels/videoDuration';
  import { getReelLimits, type ReelLimits } from '$lib/posts/api';
  import type { PublishReelDeps } from '$lib/reels/publishReel';
  import { refusalStatus } from '$lib/utils/apiRefusal';
  import { isIosTauriRuntime } from '$lib/utils/appVersion';
  import { closeHistoryOverlayFromUi, pushHistoryOverlay } from '$lib/utils/historyOverlayStack';
  import { showToast } from '$lib/stores/toast.svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { m } from '$lib/paraglide/messages';
  import ReelEditor from './ReelEditor.svelte';

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
  /** The preview's crop being drawn for the take in progress (framedCapture.ts). */
  let framed: FramedStream | null = null;
  /** Armed by a press; its firing makes the press a video (reelCapture.ts). */
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let limitTimer: ReturnType<typeof setTimeout> | null = null;
  let frame: number | null = null;
  /** The history entry a take holds; its close discards whatever the take has become. */
  let takeEntry: (() => void) | null = null;
  /** What the camera screen can capture, bound from it. */
  let camera = $state<CameraCapture>();
  let picker = $state<HTMLInputElement | null>(null);
  let editorOpen = $state(false);
  /** The open editor's handle: the system Back asks it to leave (it may have edits to protect). */
  let editor = $state<ReelEditor>();

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

  /** A short buzz where the member's finger meets a decision, when they have vibrations on. */
  function buzz(ms: number) {
    if (settings.vibrationsEnabled && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(ms);
    }
  }

  function clearHoldTimer() {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
  }

  /** Feeds one event to the reducer and carries out what the transition owes. */
  function send(event: CaptureEvent) {
    const before = capture;
    const after = captureReducer(before, event);
    if (after === before) return;
    console.debug(`[reel-capture] ${before.kind} -> ${after.kind} on ${event.type}`);
    capture = after;
    if (before.kind === 'pressing') clearHoldTimer();
    if (after.kind === 'pressing') {
      // The press becomes a video only by STAYING down; the timer only reports that it did.
      holdTimer = setTimeout(() => send({ type: 'hold' }), SHUTTER_HOLD_THRESHOLD_MS);
    }
    if (before.kind === 'pressing' && after.kind === 'recording') beginTake();
    if (before.kind === 'pressing' && after.kind === 'photo') void takePhoto();
    if (before.kind === 'recording' && after.kind === 'finishing') void endTake();
    if ((before.kind === 'ready' || before.kind === 'photo') && after.kind === 'review') {
      holdTakeEntry();
    }
    if (after.kind === 'ready') {
      publishOpen = false;
      releaseTakeEntry();
    }
  }

  function holdTakeEntry() {
    if (takeEntry) return;
    takeEntry = () => {
      // Back (or the X) while a take exists. The entry is spent by now, so what keeps the take
      // asks for it again.
      takeEntry = null;
      if (editorOpen) {
        // Back leaves the EDITOR (asking when it holds edits), never the whole take.
        console.debug('[reel-capture] Back with the editor open: the editor decides');
        holdTakeEntry();
        void editor?.requestLeave();
        return;
      }
      if (capture.kind === 'review') {
        void discardTakeAfterAsking();
        return;
      }
      dismissTake();
    };
    pushHistoryOverlay(takeEntry);
  }

  /** A recording is thrown away, a review discarded: the take is over. */
  function dismissTake() {
    console.debug('[reel-capture] the take was dismissed');
    abandonRecording();
    publishOpen = false;
    if (capture.kind !== 'ready') capture = { kind: 'ready' };
  }

  /**
   * A finished take cannot be re-shot, so losing it is asked about (the X and Back share this).
   * Keeping it re-arms the Back entry that asking spent.
   */
  async function discardTakeAfterAsking() {
    if (await confirmDiscardTake()) dismissTake();
    else if (capture.kind === 'review') holdTakeEntry();
  }

  async function confirmDiscardTake(): Promise<boolean> {
    const discard = await showConfirm(m.reels_discard_take_confirm(), {
      danger: true,
      confirmLabel: m.reels_discard_take_button(),
      cancelLabel: m.reels_discard_take_keep(),
    });
    console.debug(`[reel-capture] discarding the review: ${discard ? 'confirmed' : 'kept'}`);
    return discard;
  }

  /** The review's X: the same question as Back, then the ordinary discard. */
  async function discardFromReview() {
    if (await confirmDiscardTake()) send({ type: 'discard' });
  }

  function releaseTakeEntry() {
    const entry = takeEntry;
    if (entry) closeHistoryOverlayFromUi(entry);
  }

  /** A tap: the preview's crop of the current frame, kept as a photo. */
  async function takePhoto() {
    buzz(10);
    try {
      const blob = await camera?.photo();
      if (!blob) throw new Error('the camera gave no photo');
      send({ type: 'picked', clip: { blob, source: 'camera' } });
    } catch (err) {
      console.error('[reel-capture] the photo could not be kept', err);
      showToast(m.reels_capture_photo_error(), 'error');
      send({ type: 'failed' });
    }
  }

  function beginTake() {
    const stream = session.stream;
    if (!stream || !limits) {
      console.warn('[reel-capture] a take was asked for with no stream or no cap');
      send({ type: 'failed' });
      return;
    }
    framed = camera?.startFramedStream() ?? null;
    if (!framed) {
      showToast(m.reels_capture_record_error(), 'error');
      send({ type: 'failed' });
      return;
    }
    try {
      recorder = ReelRecorder.start(framed.stream, ios, framed.bitrate);
    } catch (err) {
      const fault = err instanceof ReelRecorderError ? err.fault : 'start';
      console.error(`[reel-capture] the take could not start (${fault})`, err);
      showToast(m.reels_capture_record_error(), 'error');
      recorder = null;
      framed.stop();
      framed = null;
      send({ type: 'failed' });
      return;
    }
    buzz(15);
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
    } finally {
      // Only now: the drawing feeds the recorder until its last chunk has arrived.
      stopFraming();
    }
  }

  function stopFraming() {
    framed?.stop();
    framed = null;
  }

  function abandonRecording() {
    stopClock();
    recorder?.abort();
    recorder = null;
    stopFraming();
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
    clearHoldTimer();
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
    bind:capture={camera}
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
        <div class="flex flex-col items-center gap-3">
          <ReelShutter
            {recording}
            {fraction}
            timeLabel={formatTakeTime(elapsedMs)}
            disabled={!limits ||
              !camera?.ready ||
              capture.kind === 'finishing' ||
              capture.kind === 'photo'}
            onpress={(at) => send({ type: 'press', at })}
            onrelease={(at) => send({ type: 'release', at })}
            oncancel={() => send({ type: 'cancel' })}
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
        ondiscard={() => void discardFromReview()}
        onedit={() => (editorOpen = true)}
        onsoundchange={(soundRemoved) => {
          if (capture.kind === 'review') {
            capture = { kind: 'review', clip: { ...capture.clip, soundRemoved } };
          }
        }}
        onnext={() => (publishOpen = true)}
      />
    {/if}
  {/if}

  {#if editorOpen && capture.kind === 'review'}
    <ReelEditor
      bind:this={editor}
      clip={capture.clip}
      oncancel={() => (editorOpen = false)}
      onnext={(blob) => {
        if (capture.kind !== 'review') return;
        // The edited media replaces the take (null: untouched), and the publish step opens at once.
        if (blob) capture = { kind: 'review', clip: { ...capture.clip, blob } };
        editorOpen = false;
        publishOpen = true;
      }}
    />
  {/if}
</div>
