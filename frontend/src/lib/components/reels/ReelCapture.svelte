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
   * (`feed`) a take goes on to the publish step. In a composer (`post`, `post-edit`, `chat`) a take is
   * handed back as a FILE through `oncapture` and the camera closes, so the composer's ordinary
   * attachment path - and its retention class - carries it; EXCEPT a video filmed from the new-post
   * composer (`post`, user 2026-10-19: one camera, one behaviour), which goes to the reel publish step
   * like the tab's, offering to be kept as a post instead; see `destinationRules`. A chat takes
   * PHOTOS ONLY until the reel message exists (docs/wiki/frontend/modules/reels-in-chat.md): no
   * hold, no 90 s cap to read.
   */
  import { onDestroy, onMount } from 'svelte';
  import { afterNavigate, beforeNavigate } from '$app/navigation';
  import { navigating } from '$app/state';
  import { Images, RefreshCcw } from '@lucide/svelte';
  import CameraScreen from './CameraScreen.svelte';
  import ReelShutter from './ReelShutter.svelte';
  import ReelReview from './ReelReview.svelte';
  import ReelPublishSheet from './ReelPublishSheet.svelte';
  import ReelSendSheet from './ReelSendSheet.svelte';
  import { CameraSession, type CameraOpener } from '$lib/reels/cameraSession.svelte';
  import { openPhotoCamera, openReelCamera, postCameraOpener } from '$lib/reels/cameraAccess';
  import {
    captureFileFrom,
    captureReducer,
    classifyLimitsFault,
    destinationRules,
    handsBackTake,
    formatTakeTime,
    lensFlipAllowed,
    shutterRingFraction,
    SHUTTER_HOLD_THRESHOLD_MS,
    type CaptureDestination,
    type DestinationRules,
    type CaptureEvent,
    type CaptureState,
    type LimitsFault,
  } from '$lib/reels/reelCapture';
  import { ReelRecorder, ReelRecorderError } from '$lib/reels/reelRecorder';
  import { zoomFromDrag } from '$lib/reels/cameraZoom';
  import type { CameraCapture, FramedStream } from '$lib/reels/framedCapture';
  import { settings } from '$lib/stores/settingsStore.svelte';
  import { readVideoDurationMs } from '$lib/reels/videoDuration';
  import { attachCapturePoster } from '$lib/reels/capturePoster';
  import { getReelLimits, type ReelLimits } from '$lib/posts/api';
  import type { PublishReelDeps } from '$lib/reels/publishReel';
  import { refusalStatus } from '$lib/utils/apiRefusal';
  import { isIosTauriRuntime } from '$lib/utils/appVersion';
  import { currentAttachRuntime, opensNatively } from '$lib/utils/chat/attachSources';
  import { pickNatively } from '$lib/utils/chat/nativeAttachPicker';
  import { fileInputAnswersEveryClose } from '$lib/utils/fileInputCancel';
  import {
    abandonHistoryOverlay,
    pushHistoryOverlay,
    type OverlayClose,
  } from '$lib/utils/historyOverlayStack';
  import { showToast } from '$lib/stores/toast.svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { m } from '$lib/paraglide/messages';
  import ReelEditor from './ReelEditor.svelte';
  import {
    captureCapMs,
    chatReelAllowed,
    chatReelTargetCap,
    markChatReelTake,
    servedChatCapMs,
  } from '$lib/reels/chatReelWriter';
  import { reelSendPlan } from '$lib/reels/reelSendTargets';
  import { reelSendHost, type ReelSendHost } from '$lib/reels/reelSendBridge';

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
    /** The new-post composer's text and identity, the start of a reel filmed from it (`post`). */
    composerCaption?: string;
    composerIdentity?: string;
    /** A reel filmed from the composer was published (`post`), as `identity`. */
    onpublished?: (identity: string) => void;
    /** "Garder comme post" from the composer: the step's caption and identity, as they stand. */
    onkept?: (caption: string, identity: string) => void;
    /**
     * A `chat` destination that may FILM (the chat reel writer, `chatReelWriter.ts`): a hold records
     * a video, handed back marked as a reel message. Absent, the chat camera takes photos only.
     */
    chatFilms?: boolean;
  }

  let {
    destination = 'feed',
    chatFilms = false,
    // The microphone is asked as `destinationRules(destination).microphone` says (openerFor).
    session = new CameraSession(openerFor(destinationRules(destination, chatFilms).microphone)),
    publishDeps,
    oncapture,
    onclose,
    composerCaption = '',
    composerIdentity = '',
    onpublished,
    onkept,
  }: Props = $props();

  /** The opener for each way of asking the microphone (`DestinationRules.microphone`). */
  function openerFor(microphone: DestinationRules['microphone']): CameraOpener {
    if (microphone === 'separate') return postCameraOpener();
    if (microphone === 'never') return openPhotoCamera;
    return (lens) => openReelCamera(lens);
  }

  const rules = $derived(destinationRules(destination, chatFilms));
  /** A photo needs no ceiling: only a video take reads the server's cap. */
  const needsLimits = $derived(!rules.photoOnly);
  /** The open stream carries a LIVE microphone - a fact of the session, not of the destination. */
  const hasMicrophone = $derived(session.microphone);
  let capture = $state<CaptureState>({ kind: 'ready' });
  let limits = $state<ReelLimits | null>(null);
  /** The take's cap for THIS destination: the chat cap in a conversation (RC-3), the reel cap elsewhere. */
  const capMs = $derived(limits ? captureCapMs(limits, destination) : null);
  /**
   * "Envoyer a..." (RC-12) replaces "Suivant" on the TAB's review of a VIDEO - and only while the chat
   * writer is on AND the server served both its chat cap and its target count (never a guessed
   * number). Off, the review is byte-identical to before. A photo keeps publishing (see section 15.1
   * of reels-in-chat.md: its chat send is not built).
   */
  const sendTargetCap = $derived(limits ? chatReelTargetCap(limits) : null);
  const chatCapMs = $derived(limits ? servedChatCapMs(limits) : null);
  const sendToOffered = $derived(
    destination === 'feed' &&
      chatReelAllowed(false) &&
      sendTargetCap !== null &&
      chatCapMs !== null &&
      capture.kind === 'review' &&
      capture.clip.blob.type.startsWith('video/')
  );
  /**
   * A HOLD MAY BECOME A VIDEO. A post camera whose microphone was refused keeps its photos
   * (`postCameraOpener`); a cap not read yet (offline) keeps them too - a photo needs neither.
   */
  const canFilm = $derived(!rules.photoOnly && hasMicrophone && capMs !== null);
  /** Set by the teardown: an answer arriving after it (the discard question) acts on nothing. */
  let destroyed = false;
  /** The "photos only" notice was given for this session's microphone refusal. */
  let toldNoMicrophone = false;
  /**
   * THE SCREEN IS BEING LEFT (a navigation drained the take's entry, or the take went to a composer
   * that closes the camera). The take is dropped back to `ready`, and `ready` would open the camera:
   * after a publish it did, for 0.3-0.7 s on the destination page (Mi 9T, 2026-10-28). So the camera
   * is held off from here, and cleared only by a fact proving the screen is still the current one:
   * a navigation that ended with it MOUNTED (`afterNavigate`), a navigation that did not happen
   * (its `complete` refused with none other under way), or the page restored from the back-forward
   * cache (`pageshow` with `persisted`). Never by a clock.
   */
  let leaving = $state(false);
  /**
   * The gallery picker is open: its answer decides whether the camera is needed again (a pick goes
   * to the review, which needs none; a cancel or a refused pick returns to the preview). Until then
   * a stopped camera stays stopped (`CameraScreen.deferOpen`).
   */
  let picking = $state(false);

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
  /** The "Envoyer a..." sheet is open over the review (its own history entry, above the take's). */
  let sendOpen = $state(false);
  /** A press is writing the take's rows: a second press waits for it. */
  let sendingTake = $state(false);
  /**
   * The take already queued for conversations while the publish step is open over it (feed AND chats,
   * 15.5): that step uploads the file the take adopts, and its Back never withdraws the sends.
   */
  let chatTake = $state<{ id: string; host: ReelSendHost } | null>(null);
  /** The messaging layer read when the sheet was opened (`null`: no session, the sheet is not offered). */
  let sendHost = $state<ReelSendHost | null>(null);

  let recorder: ReelRecorder | null = null;
  /** The preview's crop being drawn for the take in progress (framedCapture.ts). */
  let framed: FramedStream | null = null;
  /**
   * Where the held finger's zoom slide is measured from: its travel and the zoom when the take began
   * zooming on this lens. Re-taken after a lens flip (whose zoom is back at 1x) and on every take.
   */
  let zoomBase: { upPx: number; level: number; facing: string } | null = null;
  /** The take in progress's first picture (`ReelClip.poster`), taken before the recorder starts. */
  let takePoster: Blob | null = null;
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
  /**
   * WHETHER THE GALLERY'S ANSWER IS CERTAIN. A file input on an engine that fires `cancel` answers
   * every close, so a deferred open always ends by itself and "Rouvrir la camera" is never needed -
   * offering it would only flash it in the ~200 ms between the page coming back and a pick's
   * `change` (Mi 9T, 2026-10-28). The native library and an older engine may never answer: there the
   * member's tap is the way back.
   */
  const galleryAlwaysAnswers =
    !nativeGallery &&
    typeof navigator !== 'undefined' &&
    fileInputAnswersEveryClose(navigator.userAgent);
  console.debug(
    `[reel-capture] the gallery ${galleryAlwaysAnswers ? 'answers every close' : 'may never answer: a reopen tap is offered'}`
  );

  async function loadLimits() {
    limitsFault = null;
    try {
      const read = await getReelLimits();
      if (captureCapMs(read, destination) === null) {
        // NO FALLBACK TO THE 90 s REEL CAP: an answer without the chat cap is a server this writer
        // cannot film for. Said at ERROR, and the camera keeps its photos.
        console.error(
          `[reel-capture] the server served no chat cap: a ${destination} take cannot film`
        );
        limitsFault = 'refused';
        return;
      }
      limits = read;
      console.debug(
        `[reel-capture] cap ${limits.maxDurationMs} ms, chat cap ${limits.chatMaxDurationMs} ms (${destination})`
      );
    } catch (err) {
      limitsFault = classifyLimitsFault(refusalStatus(err));
      console.error(`[reel-capture] the reel limits could not be read (${limitsFault})`, err);
    }
  }

  // A navigation that completed with this screen still mounted did not leave it: the camera is
  // wanted again. A navigation that left it unmounted this callback with the screen.
  afterNavigate(() => {
    if (!leaving) return;
    console.debug('[reel-capture] a navigation ended on this screen: the camera may open again');
    leaving = false;
  });

  // A navigation that drained the take may still not happen: a `beforeNavigate` cancels it (an
  // unsaved-changes guard), or a newer one aborts it. Its `complete` is refused either way; only when
  // NO navigation is under way is this screen still the one shown. An abort leaves the newer one in
  // `navigating`, and that one ends in `afterNavigate` or in the teardown.
  beforeNavigate(({ complete }) => {
    complete.catch(() => {
      if (destroyed || !leaving) return;
      if (navigating.to) {
        console.debug('[reel-capture] a navigation was refused, another is under way: it decides');
        return;
      }
      console.debug('[reel-capture] a navigation did not happen: the camera may open again');
      leaving = false;
    });
  });

  /**
   * The page came back from the back-forward cache with this screen on it: whatever was leaving it
   * (a navigation out of the app) is over, and the screen is the current one.
   */
  function onPageShow(event: PageTransitionEvent) {
    if (!event.persisted || !leaving) return;
    console.debug('[reel-capture] restored from the back-forward cache: the camera may open again');
    leaving = false;
  }

  /** From here the camera stays closed: the take is dropped because the screen is going. */
  function markLeaving(why: string) {
    console.debug(`[reel-capture] leaving (${why}) in ${capture.kind}: the camera stays closed`);
    leaving = true;
  }

  onMount(() => {
    console.debug(`[reel-capture] opened for ${destination}`);
    if (needsLimits) void loadLimits();
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
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
    if (after === before) {
      // A pick is the member's own act: one the state refuses is said, never lost in silence.
      if (event.type === 'picked') {
        console.warn(
          `[reel-capture] a picked ${event.clip.source} take was refused in ${before.kind}`
        );
        showToast(m.reels_capture_take_refused(), 'error');
      }
      return;
    }
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
      zoomBase = null;
      session.resetZoom();
      publishOpen = false;
      sendOpen = false;
      chatTake = null;
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
        markLeaving('navigation');
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
   * camera closes. `blob` is the edited media when the editor changed it. Returns whether the
   * composer received it (false: no `oncapture`, the take is lost and said so).
   */
  function handBack(blob: Blob, poster: Blob | null | undefined): boolean {
    const file = captureFileFrom(blob);
    if (poster && file.type.startsWith('video/')) attachCapturePoster(file, poster);
    // A video filmed in a chat IS the reel message: the composer reads the mark, nothing else tells it.
    if (destination === 'chat' && file.type.startsWith('video/')) markChatReelTake(file);
    console.debug(
      `[reel-capture] handing back ${file.name} (${file.size} bytes) to ${destination}`
    );
    if (!oncapture) {
      console.error('[reel-capture] a composer destination has no oncapture: the take is lost');
      showToast(m.reels_capture_record_error(), 'error');
      return false;
    }
    oncapture(file);
    leaveWithTake();
    return true;
  }

  /**
   * The take has left this screen (handed back, or published from a composer): its entry leaves the
   * stack NOW, by abandon - its close would ask about a take that is no longer here. The entry stays
   * as a ghost the next overlay takes over. The owner then unmounts the overlay, whose own entry is
   * on top and abandoned the same way.
   */
  function leaveWithTake() {
    markLeaving('the take left with the composer');
    editorOpen = false;
    const entry = takeEntry;
    takeEntry = null;
    if (entry) abandonHistoryOverlay(entry);
    send({ type: 'discard' });
    onclose?.();
  }

  /** A reel filmed from the new-post composer is published: the composer closes behind it. */
  function publishedFromComposer(identity: string) {
    console.debug(`[reel-capture] a reel filmed from the ${destination} composer was published`);
    onpublished?.(identity);
    leaveWithTake();
  }

  /**
   * The press of "Envoyer a..." (RC-12, 15.1). CanaReels alone is today's path byte for byte (the
   * publish step). Conversations write ONE take and N sends through the messaging layer and free the
   * camera at once; CanaReels AND conversations write them first, WAITING for the publish step's
   * upload (15.5), then open that step. A refusal leaves the sheet up: nothing was written.
   */
  async function sendTakeTo(choice: { feed: boolean; targetKeys: string[] }) {
    if (capture.kind !== 'review' || sendingTake) return;
    const clip = capture.clip;
    const plan = reelSendPlan(choice.feed, choice.targetKeys.length);
    console.debug(`[reel-capture] send-to: ${plan}, ${choice.targetKeys.length} conversation(s)`);
    if (plan === 'none') return;
    if (plan === 'feed') {
      sendOpen = false;
      publishOpen = true;
      return;
    }
    sendingTake = true;
    try {
      const file = captureFileFrom(clip.blob);
      if (clip.poster) attachCapturePoster(file, clip.poster);
      const takeId = plan === 'both' ? crypto.randomUUID() : undefined;
      const host = sendHost;
      if (!host) {
        showToast(m.reel_sendto_sheet_unavailable(), 'warning');
        return;
      }
      const queued = await host.send(file, choice.targetKeys, {
        takeId,
        awaitsPublish: plan === 'both',
      });
      if (queued === null) {
        showToast(m.reel_sendto_failed(), 'error');
        return;
      }
      showToast(m.reel_sendto_sending({ count: queued.queued }), 'info');
      sendOpen = false;
      if (plan === 'both') {
        chatTake = { id: queued.takeId, host };
        publishOpen = true;
      } else {
        // Chats only: the camera is free at once, every target shows its own bubble.
        dismissTake();
      }
    } finally {
      sendingTake = false;
    }
  }

  /**
   * Opens "Envoyer a..." - or, with no messaging layer registered (no session), says so and leaves
   * the review as it is: the take is never sent into a void.
   */
  function openSendSheet() {
    sendHost = reelSendHost();
    if (!sendHost) {
      console.warn('[reel-capture] send-to: no messaging layer is registered');
      showToast(m.reel_sendto_sheet_unavailable(), 'warning');
      return;
    }
    sendOpen = true;
  }

  /** The publish step was left (Back): with sends already queued the take is over, else the review returns. */
  function closePublish() {
    publishOpen = false;
    if (chatTake) {
      console.debug(
        '[reel-capture] the publish step was left: the queued sends go on, the take ends'
      );
      dismissTake();
    }
  }

  /** A recording is thrown away, a review discarded: the take is over. */
  function dismissTake() {
    console.debug('[reel-capture] the take was dismissed');
    abandonRecording();
    publishOpen = false;
    sendOpen = false;
    chatTake = null;
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

  /** The take is over (back to `ready`): its entry leaves the stack, with nothing left to ask. */
  function releaseTakeEntry() {
    const entry = takeEntry;
    takeEntry = null;
    if (entry) abandonHistoryOverlay(entry);
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
    if (!stream || capMs === null) {
      console.warn('[reel-capture] a take was asked for with no stream or no cap');
      send({ type: 'failed' });
      return;
    }
    // The take's thumbnail for a composer (`ReelClip.poster`), taken NOW: before the drawing loop and
    // the recorder exist, so its encode costs the take no frame. Only a video that may go back to a
    // composer needs it ("Garder comme post" included); the tab's reel publish step needs none.
    takePoster = rules.videoHandsBack || rules.fromComposer ? (camera?.thumbnail() ?? null) : null;
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
    // EVERY TAKE STARTS AT 1x (user, 2026-10-22); the held finger's slide zooms it from there.
    zoomBase = null;
    session.resetZoom();
    holdTakeEntry();
    elapsedMs = 0;
    // THE CAP IS THE PRODUCT'S RULE (C4), so it is a deadline by definition: the ring is full when
    // the take is as long as the server allows, and that ends it exactly as a second tap would.
    limitTimer = setTimeout(() => send({ type: 'limit' }), capMs);
    const tick = () => {
      if (!recorder) return;
      elapsedMs = Math.min(recorder.elapsedMs, capMs ?? recorder.elapsedMs);
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
    const poster = takePoster;
    takePoster = null;
    try {
      const blob = await ending.stop();
      send({
        type: 'stopped',
        clip: { blob, source: 'camera', poster, durationMs: elapsedMs },
      });
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
    takePoster = null;
    stopFraming();
  }

  /** A video from the gallery, refused at once when it is over the cap. */
  async function onPicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      console.debug('[reel-capture] the gallery answered with no file');
      endPicking('no file');
      return;
    }
    console.debug(`[reel-capture] gallery picked ${file.type || 'typeless'} (${file.size} bytes)`);
    try {
      await takePickedVideo(file);
    } finally {
      endPicking('a file');
    }
  }

  /** The picker was closed with nothing picked: the preview comes back. */
  function onPickCancelled() {
    console.debug('[reel-capture] the gallery was closed with nothing picked');
    endPicking('cancelled');
  }

  /**
   * The picker has answered and the answer has been taken (a review) or refused: a stopped camera
   * may open again, unless the review now holds it off (`paused`).
   */
  function endPicking(answer: string) {
    if (!picking) return;
    console.debug(`[reel-capture] the gallery answered (${answer}), now in ${capture.kind}`);
    picking = false;
  }

  /**
   * THE GALLERY IN THE iOS APP IS THE NATIVE LIBRARY (`opensNatively`): a `video/*` input there is
   * answered by the sheet of WebKit, whose "Prendre une video" is the SYSTEM camera that D-camera
   * removed (PR #1859 review, 2026-10-15). PHPicker offers the library alone; its first pick is
   * checked as the pick of an input would be.
   */
  function openGallery() {
    // The picker may background the app (Android): its return must not reopen the camera before
    // the answer is known (`CameraScreen.deferOpen`).
    picking = true;
    if (!nativeGallery) {
      picker?.click();
      return;
    }
    console.debug('[reel-capture] gallery: the native library');
    pickNatively('library', { single: true })
      .then(async (files) => {
        console.debug(`[reel-capture] the native library handed ${files.length} file(s)`);
        if (files[0]) await takePickedVideo(files[0]);
      })
      .catch((error: unknown) => {
        console.error(`[reel-capture] the native library picker failed: ${String(error)}`);
        showToast(m.chat_attach_picker_failed(), 'error');
      })
      .finally(() => endPicking('native library'));
  }

  async function takePickedVideo(file: File) {
    if (capMs === null) {
      // The gallery button waits for the cap, so this is a pick the member made and cannot see
      // taken: it is said, never dropped.
      console.warn('[reel-capture] a gallery pick arrived before the cap was read');
      showToast(m.reels_capture_pick_before_limits(), 'error');
      return;
    }
    if (!file.type.startsWith('video/')) {
      console.warn(`[reel-capture] picked a ${file.type || 'typeless'} file, not a video`);
      showToast(m.reels_capture_not_a_video(), 'error');
      return;
    }
    const durationMs = await readVideoDurationMs(file);
    if (durationMs !== null && durationMs > capMs) {
      console.warn(`[reel-capture] picked ${durationMs} ms, over ${capMs}`);
      showToast(m.reels_capture_too_long({ seconds: Math.round(capMs / 1000) }), 'error');
      return;
    }
    send({
      type: 'picked',
      clip: { blob: file, source: 'gallery', ...(durationMs !== null ? { durationMs } : {}) },
    });
  }

  /**
   * The held finger slid (`ReelShutter.onmove`): while a take is filmed, UP zooms in and DOWN zooms
   * out, from the level and the travel of the first slide on this lens (`zoomFromDrag`). Outside a
   * take a press is still deciding between a photo and a video, and nothing zooms.
   */
  function onShutterMove(upPx: number) {
    // Mid-flip there is no lens to zoom; the new one rests at 1x and the next slide re-bases on it.
    if (capture.kind !== 'recording' || session.flipping) return;
    if (!zoomBase || zoomBase.facing !== session.facing) {
      zoomBase = { upPx, level: session.zoom, facing: session.facing };
    }
    session.setZoom(zoomFromDrag(zoomBase.level, upPx - zoomBase.upPx, session.zoomRange));
  }

  // A LENS THAT CANNOT BE REOPENED DURING A TAKE (a flip refused, the OS taking the camera) leaves the
  // take with no picture: it is ended and KEPT, as the cap or a release would end it.
  $effect(() => {
    if (session.phase === 'error' && capture.kind === 'recording') {
      console.warn('[reel-capture] the camera failed during a take: the take is ended and kept');
      send({ type: 'limit' });
    }
  });

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
    // TORN DOWN UNDER A TAKE: the take's entry leaves the stack, and its close is NOT run - it would
    // ask about a take whose screen is gone, over whatever page is now showing.
    console.debug('[reel-capture] torn down under a take: its history entry is abandoned');
    abandonHistoryOverlay(entry);
  });

  const recording = $derived(capture.kind === 'recording' || capture.kind === 'finishing');
  const fraction = $derived(capMs !== null ? shutterRingFraction(capture, elapsedMs, capMs) : 0);
</script>

<!-- No Back swipe while the editor owns the strokes or a take is being filmed (`swipeBack`): a
     recording ends by its own shutter, never by an edge swipe that would drop it unasked. -->
<div class="relative h-full w-full" data-swipe-back-off={editorOpen || recording ? '' : undefined}>
  <CameraScreen
    {session}
    bind:capture={camera}
    {recording}
    flipAllowed={lensFlipAllowed(capture)}
    paused={capture.kind === 'review' || leaving}
    deferOpen={picking}
    onreopen={galleryAlwaysAnswers
      ? undefined
      : () => endPicking('none, the member reopened the camera')}
    {onBeforeRelease}
    {onclose}
    microphoneAsked={rules.microphone === 'with-lens'}
  >
    {#snippet faultActions()}
      <!-- A REFUSED CAMERA KEEPS THE GALLERY: a pick needs no camera, and the input is always
           mounted, so the member who said no to the camera can still publish a video. -->
      {#if rules.gallery}
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-full bg-white/15 px-5 py-2.5 text-sm font-semibold outline-none hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-40"
          disabled={!limits}
          data-reel-fault-gallery
          onclick={openGallery}
        >
          <Images size={16} strokeWidth={2.5} />
          {m.reels_capture_gallery()}
        </button>
      {/if}
    {/snippet}
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
          {/if}
        </div>
        <div class="flex flex-col items-center gap-3">
          <ReelShutter
            {recording}
            {fraction}
            timeLabel={formatTakeTime(elapsedMs)}
            disabled={(!rules.photoHandsBack && !limits) ||
              // A take in progress keeps its shutter through a lens flip (no frame for a moment):
              // a disabled button under the held finger could swallow the release that ends it.
              (!recording && !camera?.ready) ||
              capture.kind === 'finishing' ||
              capture.kind === 'photo'}
            onpress={(at) => send({ type: 'press', at })}
            onrelease={(at) => send({ type: 'release', at })}
            oncancel={() => send({ type: 'cancel' })}
            onmove={onShutterMove}
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

  <!-- THE GALLERY'S INPUT LIVES HERE, NEVER IN `controls`. The picker backgrounds the app, the camera
       is released, and CameraScreen drops its controls with the phase: an input inside them was
       detached when the picker answered, and Svelte's root-delegated `onchange` never reached it - a
       picked video vanished with no review, no error and no line (Mi 9T, v1.2.9-alpha.4, 3 of 3).
       Here it lives as long as the screen does, whatever the camera is doing. -->
  {#if rules.gallery && !nativeGallery}
    <input
      bind:this={picker}
      type="file"
      accept="video/*"
      class="hidden"
      data-reel-gallery-input
      onchange={onPicked}
      oncancel={onPickCancelled}
    />
  {/if}

  {#if capture.kind === 'review'}
    {@const clip = capture.clip}
    {#if handsBackTake(rules, clip.blob)}
      <ReelReview
        {clip}
        ondiscard={() => void discardFromReview()}
        onedit={() => (editorOpen = true)}
        soundRemoval={rules.soundRemoval}
        nextLabel={destination === 'chat' && clip.blob.type.startsWith('video/')
          ? m.reel_chat_send()
          : m.reels_review_add()}
        onnext={() => handBack(clip.blob, clip.poster)}
      />
    {:else if sendOpen && sendHost && sendTargetCap !== null && chatCapMs !== null}
      <ReelSendSheet
        {clip}
        host={sendHost}
        cap={sendTargetCap}
        {chatCapMs}
        onclose={() => (sendOpen = false)}
        onsend={(choice) => void sendTakeTo(choice)}
      />
    {:else if publishOpen && limits}
      <ReelPublishSheet
        {clip}
        {limits}
        deps={publishDeps}
        chatTake={chatTake
          ? { id: chatTake.id, adopt: chatTake.host.adopt, endWait: chatTake.host.endWait }
          : null}
        onclose={closePublish}
        composer={rules.fromComposer
          ? {
              caption: composerCaption,
              identity: composerIdentity,
              onkeep: (caption, identity) => {
                // The take first: the step's caption and identity follow only a take the
                // composer actually received, never one lost to a missing `oncapture`.
                if (handBack(clip.blob, clip.poster)) onkept?.(caption, identity);
              },
              onpublished: publishedFromComposer,
            }
          : undefined}
      />
    {:else}
      <ReelReview
        {clip}
        ondiscard={() => void discardFromReview()}
        onedit={() => (editorOpen = true)}
        soundRemoval={rules.soundRemoval}
        onsoundchange={(soundRemoved) => {
          if (capture.kind === 'review') {
            capture = { kind: 'review', clip: { ...capture.clip, soundRemoved } };
          }
        }}
        nextLabel={sendToOffered ? m.reel_sendto_action() : undefined}
        onnext={() => (sendToOffered ? openSendSheet() : (publishOpen = true))}
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
        if (handsBackTake(rules, blob ?? capture.clip.blob)) {
          // The poster is the take as filmed: the editor's drawings are not on the thumbnail.
          handBack(blob ?? capture.clip.blob, capture.clip.poster);
          return;
        }
        if (blob) capture = { kind: 'review', clip: { ...capture.clip, blob } };
        editorOpen = false;
        if (sendToOffered) openSendSheet();
        else publishOpen = true;
      }}
    />
  {/if}
</div>
