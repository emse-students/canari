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
   *
   * THE DESTINATION (user, 2026-10-11, D-camera: this camera is the ONLY capture path). On the tab
   * (`feed`) a take goes on to the publish step. In a composer (`post`, `chat`) it is handed back as
   * a FILE through `oncapture` and the camera closes, so the composer's ordinary attachment path - and
   * its retention class - carries it; see `destinationRules`. A chat takes PHOTOS ONLY until the reel
   * message exists (docs/wiki/frontend/modules/reels-in-chat.md): no hold, no 90 s cap to read.
   */
  import { onDestroy, onMount } from 'svelte';
  import { Images, RefreshCcw } from '@lucide/svelte';
  import CameraScreen from './CameraScreen.svelte';
  import ReelShutter from './ReelShutter.svelte';
  import ReelReview from './ReelReview.svelte';
  import ReelPublishSheet from './ReelPublishSheet.svelte';
  import { CameraSession, type CameraOpener } from '$lib/reels/cameraSession.svelte';
  import { openPhotoCamera, openReelCamera, postCameraOpener } from '$lib/reels/cameraAccess';
  import {
    captureFileFrom,
    captureReducer,
    classifyLimitsFault,
    destinationRules,
    formatTakeTime,
    shutterRingFraction,
    SHUTTER_HOLD_THRESHOLD_MS,
    type CaptureDestination,
    type DestinationRules,
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
  import { currentAttachRuntime, opensNatively } from '$lib/utils/chat/attachSources';
  import { pickNatively } from '$lib/utils/chat/nativeAttachPicker';
  import {
    abandonHistoryOverlay,
    closeHistoryOverlayFromUi,
    pushHistoryOverlay,
    type OverlayClose,
  } from '$lib/utils/historyOverlayStack';
  import { showToast } from '$lib/stores/toast.svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { m } from '$lib/paraglide/messages';
  import ReelEditor from './ReelEditor.svelte';

  interface Props {
    /** The session, injectable for tests. */
    session?: CameraSession;
    /** The publish step's services, injectable for tests. */
    publishDeps?: PublishReelDeps;
    /** Where the take goes; `feed` is the camera tab, unchanged. */
    destination?: CaptureDestination;
    /** A composer destination: the take, as a file for its attachment path. */
    oncapture?: (file: File) => void;
    /** The overlay's close (the X, and after a hand-back); absent on the tab. */
    onclose?: () => void;
  }

  let {
    destination = 'feed',
    // The microphone is asked as `destinationRules(destination).microphone` says (openerFor).
    session = new CameraSession(openerFor(destinationRules(destination).microphone)),
    publishDeps,
    oncapture,
    onclose,
  }: Props = $props();

  /** The opener for each way of asking the microphone (`DestinationRules.microphone`). */
  function openerFor(microphone: DestinationRules['microphone']): CameraOpener {
    if (microphone === 'separate') return postCameraOpener();
    if (microphone === 'never') return openPhotoCamera;
    return (lens) => openReelCamera(lens);
  }

  const rules = $derived(destinationRules(destination));
  /** A photo needs no ceiling: only a video take reads the server's cap. */
  const needsLimits = $derived(!rules.photoOnly);
  /** The open stream carries a LIVE microphone - a fact of the session, not of the destination. */
  const hasMicrophone = $derived(session.microphone);
  let capture = $state<CaptureState>({ kind: 'ready' });
  let limits = $state<ReelLimits | null>(null);
  /**
   * A HOLD MAY BECOME A VIDEO. A post camera whose microphone was refused keeps its photos
   * (`postCameraOpener`); a cap not read yet (offline) keeps them too - a photo needs neither.
   */
  const canFilm = $derived(!rules.photoOnly && hasMicrophone && limits !== null);
  /** Set by the teardown: an answer arriving after it (the discard question) acts on nothing. */
  let destroyed = false;
  /** The "photos only" notice was given for this session's microphone refusal. */
  let toldNoMicrophone = false;

  // A destination that films, on a camera live WITHOUT a microphone: said once, so a hold that takes
  // a photo is not a mystery.
  $effect(() => {
    if (session.phase !== 'live' || rules.photoOnly || hasMicrophone || toldNoMicrophone) return;
    toldNoMicrophone = true;
    console.warn(`[reel-capture] live with no microphone (${destination}): photos only`);
    showToast(m.reels_capture_no_microphone(), 'warning');
  });

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
  let takeEntry: OverlayClose | null = null;
  /** What the camera screen can capture, bound from it. */
  let camera = $state<CameraCapture>();
  let picker = $state<HTMLInputElement | null>(null);
  let editorOpen = $state(false);
  /** The open editor's handle: the system Back asks it to leave (it may have edits to protect). */
  let editor = $state<ReelEditor>();

  const ios = isIosTauriRuntime();
  /** The gallery is the native library (the iOS app), never a file input. */
  const nativeGallery = opensNatively(currentAttachRuntime(false), 'library');

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

  onMount(() => {
    console.debug(`[reel-capture] opened for ${destination}`);
    if (needsLimits) void loadLimits();
  });

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
    if (after.kind === 'pressing' && canFilm) {
      // The press becomes a video only by STAYING down; the timer only reports that it did. A camera
      // that cannot film (photo-only destination, no microphone, no cap) never arms it, so every
      // press is a tap, however long.
      holdTimer = setTimeout(() => send({ type: 'hold' }), SHUTTER_HOLD_THRESHOLD_MS);
    }
    if (before.kind === 'pressing' && after.kind === 'recording') beginTake();
    if (before.kind === 'pressing' && after.kind === 'photo') void takePhoto();
    if (before.kind === 'recording' && after.kind === 'finishing') void endTake();
    if ((before.kind === 'ready' || before.kind === 'photo') && after.kind === 'review') {
      holdTakeEntry();
    }
    if (after.kind === 'ready') {
      elapsedMs = 0;
      publishOpen = false;
      releaseTakeEntry();
    }
  }

  function holdTakeEntry() {
    if (takeEntry) return;
    takeEntry = (reason) => {
      // Back (or the X) while a take exists. The entry is spent by now, so what keeps the take
      // asks for it again.
      takeEntry = null;
      if (reason === 'navigation') {
        // The app is LEAVING this screen (a published reel lands on the feed, a tab was tapped):
        // asking now would put the question over the destination page. The take dies with the screen.
        console.debug(
          '[reel-capture] the screen is being left: the take is dropped, nothing asked'
        );
        editorOpen = false;
        dismissTake();
        return;
      }
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

  /**
   * A composer destination: the take leaves as a file for the composer's attachment path, and the
   * camera closes. `blob` is the edited media when the editor changed it.
   */
  function handBack(blob: Blob) {
    const file = captureFileFrom(blob);
    console.debug(
      `[reel-capture] handing back ${file.name} (${file.size} bytes) to ${destination}`
    );
    if (!oncapture) {
      console.error('[reel-capture] a composer destination has no oncapture: the take is lost');
      showToast(m.reels_capture_record_error(), 'error');
      return;
    }
    oncapture(file);
    editorOpen = false;
    // The take's entry leaves the stack NOW, by abandon: `closeHistoryOverlayFromUi` would leave it
    // on the stack until its traversal lands, the overlay's teardown below would pop it a SECOND
    // time, and that second traversal closed what the camera was opened over (the conversation).
    const entry = takeEntry;
    takeEntry = null;
    if (entry) abandonHistoryOverlay(entry);
    send({ type: 'discard' });
    // The owner unmounts the overlay, whose own entry is then on top and abandoned the same way.
    onclose?.();
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
    const discard = await confirmDiscardTake();
    if (destroyed) {
      // Back closed the camera while the question was up: there is no take left to keep, and an
      // entry pushed now would close nothing - the next Back spent on a dead page.
      console.debug('[reel-capture] the discard question was answered after the camera closed');
      return;
    }
    if (discard) dismissTake();
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
    elapsedMs = 0;
    recorder?.abort();
    recorder = null;
    stopFraming();
  }

  /** A video from the gallery, refused at once when it is over the cap. */
  async function onPicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) await takePickedVideo(file);
  }

  /**
   * THE GALLERY IN THE iOS APP IS THE NATIVE LIBRARY (`opensNatively`): a `video/*` input there is
   * answered by the sheet of WebKit, whose "Prendre une video" is the SYSTEM camera that D-camera
   * removed (PR #1859 review, 2026-10-15). PHPicker offers the library alone; its first pick is
   * checked as the pick of an input would be.
   */
  function openGallery() {
    if (!nativeGallery) {
      picker?.click();
      return;
    }
    console.debug('[reel-capture] gallery: the native library');
    pickNatively('library', { single: true })
      .then((files) => {
        console.debug(`[reel-capture] the native library handed ${files.length} file(s)`);
        if (files[0]) void takePickedVideo(files[0]);
      })
      .catch((error: unknown) => {
        console.error(`[reel-capture] the native library picker failed: ${String(error)}`);
        showToast(m.chat_attach_picker_failed(), 'error');
      });
  }

  async function takePickedVideo(file: File) {
    if (!limits) {
      console.warn('[reel-capture] a gallery pick arrived before the cap was read');
      return;
    }
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
    destroyed = true;
    clearHoldTimer();
    abandonRecording();
    const entry = takeEntry;
    takeEntry = null;
    if (!entry) return;
    if (onclose) {
      // AN OVERLAY TORN DOWN UNDER A TAKE (its composer unmounted): the take's entry leaves the stack
      // NOW, as in `handBack`. `closeHistoryOverlayFromUi` would leave it there until its traversal
      // lands, so the overlay's own abandon below it would splice without going back - one history
      // entry left behind, and the next Back spent on nothing.
      console.debug('[reel-capture] torn down under a take: its history entry is abandoned');
      abandonHistoryOverlay(entry);
      return;
    }
    closeHistoryOverlayFromUi(entry);
  });

  const recording = $derived(capture.kind === 'recording' || capture.kind === 'finishing');
  const fraction = $derived(
    limits ? shutterRingFraction(capture, elapsedMs, limits.maxDurationMs) : 0
  );
</script>

<div class="relative h-full w-full">
  <CameraScreen
    {session}
    bind:capture={camera}
    lensLocked={recording}
    paused={capture.kind === 'review'}
    {onBeforeRelease}
    {onclose}
  >
    {#snippet controls()}
      <div class="grid grid-cols-3 items-end px-6">
        <div class="flex justify-start pb-6">
          {#if !recording && rules.gallery}
            <button
              type="button"
              class="flex h-11 w-11 items-center justify-center rounded-lg border-2 border-white/80 bg-black/30 outline-none hover:bg-black/50 focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-40"
              aria-label={m.reels_capture_gallery()}
              title={m.reels_capture_gallery()}
              disabled={!limits}
              data-swipe-nav-ignore
              onclick={openGallery}
            >
              <Images size={22} strokeWidth={2} />
            </button>
            {#if !nativeGallery}
              <input
                bind:this={picker}
                type="file"
                accept="video/*"
                class="hidden"
                onchange={onPicked}
              />
            {/if}
          {/if}
        </div>
        <div class="flex flex-col items-center gap-3">
          <ReelShutter
            {recording}
            {fraction}
            timeLabel={formatTakeTime(elapsedMs)}
            disabled={(!rules.handsBackFile && !limits) ||
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
    {#if rules.handsBackFile}
      <ReelReview
        {clip}
        ondiscard={() => void discardFromReview()}
        onedit={() => (editorOpen = true)}
        soundRemoval={rules.soundRemoval}
        nextLabel={m.reels_review_add()}
        onnext={() => handBack(clip.blob)}
      />
    {:else if publishOpen && limits}
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
        if (rules.handsBackFile) {
          handBack(blob ?? capture.clip.blob);
          return;
        }
        if (blob) capture = { kind: 'review', clip: { ...capture.clip, blob } };
        editorOpen = false;
        publishOpen = true;
      }}
    />
  {/if}
</div>
