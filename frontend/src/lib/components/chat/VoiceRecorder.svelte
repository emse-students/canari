<script lang="ts">
  /**
   * A VOICE NOTE IS ONE GESTURE: HOLD, SLIDE, RELEASE.
   *
   * The first version was three taps - tap the microphone, tap a square to stop, tap a bin to throw
   * it away - and it left the composer's other controls beside it, so a recording looked like a
   * widget that had appeared in the row rather than something the bar had become. The user asked
   * for the reference's shape instead (2026-09-09): *"appuyer longtemps pour enregistrer, slide
   * vers la gauche pour annuler (afficher une corbeille), relacher envoie (on pourrait aussi lock
   * en swipant vers la droite, vers un cadenas pour ne pas avoir a tenir pendant toute la duree du
   * vocal), ca couvre toute la barre de saisie en faisant disparaitre le reste"*.
   *
   * So there are three phases, and each one is a place a finger can be:
   *
   * - `arming`  - down on the microphone, waiting for `getUserMedia`. Nothing is recorded yet.
   * - `holding` - recording, finger still down. Sliding LEFT arms the bin, RIGHT locks.
   * - `locked`  - recording with no finger on the glass; the bar grows explicit send / bin buttons.
   *
   * WHY POINTER EVENTS AND A CAPTURE, rather than touch handlers: the thumb has to keep receiving
   * moves after it has slid off the 44px button it started on, and the same code has to work for a
   * mouse in the desktop shell, where `MediaRecorder` also exists. `setPointerCapture` gives both.
   * It is also what makes the geometry safe - `dx` is measured from the pointer's own `clientX`, so
   * the button being re-laid-out mid-gesture (which it is: the row expands the moment recording
   * starts) cannot move the thresholds under the finger.
   *
   * WHAT COVERS THE BAR IS THE PARENT, NOT AN OVERLAY. `onActiveChange` tells the composer to stop
   * rendering its own controls, and this component's root takes the width. An absolutely-positioned
   * layer would have been fewer lines and a z-index to get wrong later; the row becomes the
   * recorder instead.
   */
  import { Lock, Mic, Send, Trash2 } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Callback fired with the recorded audio blob when the gesture ends in a send. */
    onRecordingComplete: (audioBlob: Blob) => void;
    /** Optional callback invoked when the recording is thrown away rather than sent. */
    onCancel?: () => void;
    /**
     * Reports whether a recording is in progress, so the composer can hide everything else. Fired
     * on every transition into and out of `idle`, teardown included.
     */
    onActiveChange?: (active: boolean) => void;
  }

  let { onRecordingComplete, onCancel, onActiveChange }: Props = $props();

  /**
   * HOW FAR THE THUMB TRAVELS BEFORE EACH DECISION.
   *
   * Both are CSS pixels and deliberately asymmetric. Cancel is the destructive one and is the
   * direction a thumb slides most easily, so it costs more distance; lock is a deliberate reach and
   * is confirmed the instant it is crossed, with no release needed, which is what makes it feel
   * like a switch rather than a second gesture to hold.
   */
  const CANCEL_SLIDE_PX = 96;
  const LOCK_SLIDE_PX = 72;
  /**
   * Below this, a press reads as a tap that meant something else - a mis-hit on the way to the
   * field, or someone finding out what the button does. Throwing it away with a hint is what the
   * reference does; sending 200ms of room tone is not.
   */
  const MIN_RECORDING_MS = 700;

  type Phase = 'idle' | 'arming' | 'holding' | 'locked';

  let phase = $state<Phase>('idle');
  /** Signed horizontal travel of the pointer since it went down. Negative is towards the bin. */
  let dx = $state(0);
  let elapsedMs = $state(0);

  /**
   * ONE RECORDING IS ONE OBJECT, AND THE COMPONENT HOLDS AT MOST ONE OF THEM.
   *
   * `MediaRecorder.stop()` is asynchronous: the final chunk and `onstop` arrive after the call, and
   * the tracks must stay open until they do or the tail is truncated. But the ROW has to come back
   * the instant the finger lifts - waiting for a device to close is a bar that hangs on cancel.
   *
   * So the two halves are separated, and the state each half needs travels with the recording
   * rather than in shared variables. `finish()` drops this reference immediately; the object it was
   * pointing at is handed to the close path as a local. A second press therefore builds a fresh
   * session while the first is still flushing, with nothing in common between them - rather than a
   * new recorder overwriting the field the old `onstop` was about to read.
   */
  interface Session {
    recorder: MediaRecorder;
    stream: MediaStream;
    chunks: Blob[];
    startedAt: number;
    /** Decided by the gesture, read once by `onstop`. */
    keep: boolean;
  }

  let session: Session | null = null;
  let tickId: number | null = null;
  let pointerId: number | null = null;
  let originX = 0;

  const isActive = $derived(phase !== 'idle');
  /** 0 to 1 as the thumb travels towards each decision; drives opacity and scale, never layout. */
  const cancelProgress = $derived(
    phase === 'holding' ? Math.min(1, Math.max(0, -dx / CANCEL_SLIDE_PX)) : 0
  );
  const lockProgress = $derived(
    phase === 'holding' ? Math.min(1, Math.max(0, dx / LOCK_SLIDE_PX)) : 0
  );
  const willCancel = $derived(cancelProgress >= 1);
  /** The thumb never runs past the decision it is heading for - overshoot says nothing more. */
  const thumbOffset = $derived(
    phase === 'holding' ? Math.max(-CANCEL_SLIDE_PX, Math.min(LOCK_SLIDE_PX, dx)) : 0
  );

  // audio/mp4 is supported on both Android WebView and iOS WKWebView (webm is iOS-incompatible).
  const MIME_CANDIDATES = [
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];

  function pickRecorderMimeType(): string | undefined {
    for (const mime of MIME_CANDIDATES) {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return undefined;
  }

  function setPhase(next: Phase) {
    const wasActive = phase !== 'idle';
    phase = next;
    const nowActive = next !== 'idle';
    if (wasActive !== nowActive) onActiveChange?.(nowActive);
  }

  /**
   * Opens the microphone and starts recording.
   *
   * `getUserMedia` is a permission prompt on first use and a device open every time, so a finger
   * can easily come back up before it resolves. The phase is re-read AFTER the await for exactly
   * that: whoever released has already put us back in `idle`, and the only thing left to do is give
   * the device back rather than start a recording nobody is waiting for.
   */
  async function beginRecording() {
    console.debug('[VoiceRecorder] arming');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      if (phase !== 'arming') {
        console.debug('[VoiceRecorder] released before the microphone opened - closing it again');
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const mimeType = pickRecorderMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      const started: Session = { recorder, stream, chunks: [], startedAt: 0, keep: false };

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) started.chunks.push(event.data);
      };

      recorder.onstop = () => {
        const keep = started.keep && started.chunks.length > 0;
        console.debug(`[VoiceRecorder] stopped - ${keep ? 'sending' : 'discarding'}`);
        if (keep) {
          const finalType = recorder.mimeType || started.chunks[0]?.type || 'audio/webm';
          onRecordingComplete(new Blob(started.chunks, { type: finalType }));
        }
        // The device goes back only once the last chunk has arrived; releasing it any earlier
        // truncates the tail of the very message this is about to send.
        releaseDevice(started);
      };

      recorder.start();
      started.startedAt = Date.now();
      session = started;
      elapsedMs = 0;
      setPhase('holding');
      // Read from the clock rather than counted up: a throttled interval would under-report the
      // duration of the very recording it is timing, and that number decides whether we send.
      tickId = window.setInterval(() => {
        elapsedMs = Date.now() - started.startedAt;
      }, 200);
    } catch (error) {
      console.error('[VoiceRecorder] microphone refused:', error);
      showToast(m.chat_mic_permission_error());
      stopClock();
      dx = 0;
      pointerId = null;
      elapsedMs = 0;
      setPhase('idle');
    }
  }

  /**
   * Ends the gesture: the row comes back NOW, the device closes when it is ready.
   *
   * `reason` is for the log only - the decision is already made by the time this is called.
   */
  function finish(keep: boolean, reason: string) {
    console.debug(`[VoiceRecorder] ${keep ? 'send' : 'discard'} (${reason}) after ${elapsedMs}ms`);
    const ending = session;
    session = null;
    stopClock();
    dx = 0;
    pointerId = null;
    elapsedMs = 0;
    setPhase('idle');

    if (ending) {
      ending.keep = keep;
      if (ending.recorder.state !== 'inactive') ending.recorder.stop();
      else releaseDevice(ending);
    }
    if (!keep) onCancel?.();
  }

  /** The one place a microphone is handed back, whichever way the recording ended. */
  function releaseDevice(ended: Session) {
    ended.stream.getTracks().forEach((track) => track.stop());
    ended.chunks = [];
  }

  function stopClock() {
    if (tickId !== null) {
      clearInterval(tickId);
      tickId = null;
    }
  }

  // -- The gesture -----------------------------------------------------------

  function handlePointerDown(e: PointerEvent) {
    if (phase !== 'idle') return;
    // Secondary buttons open context menus; only the primary one is a press.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    originX = e.clientX;
    dx = 0;
    pointerId = e.pointerId;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setPhase('arming');
    void beginRecording();
  }

  function handlePointerMove(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    if (phase !== 'holding' && phase !== 'arming') return;
    dx = e.clientX - originX;
    if (phase === 'holding' && dx >= LOCK_SLIDE_PX) lockRecording(e);
  }

  function handlePointerUp(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    // A lock already released the capture and moved on; the up that follows is not a decision.
    if (phase === 'locked') return;
    releaseCapture(e);

    if (phase === 'arming') {
      // The device never opened, so there is nothing to stop - `beginRecording` will find `idle`
      // after its await and hand the microphone straight back.
      console.debug('[VoiceRecorder] released while arming');
      setPhase('idle');
      dx = 0;
      return;
    }
    if (phase !== 'holding') return;

    if (dx <= -CANCEL_SLIDE_PX) {
      finish(false, 'slid past the bin');
    } else if (Date.now() - (session?.startedAt ?? 0) < MIN_RECORDING_MS) {
      showToast(m.chat_voice_hold_to_record());
      finish(false, 'too short to be a message');
    } else {
      finish(true, 'released on the microphone');
    }
  }

  function handlePointerCancel(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    if (phase === 'locked') return;
    releaseCapture(e);
    if (phase === 'holding') finish(false, 'pointer cancelled');
    else if (phase === 'arming') setPhase('idle');
  }

  function lockRecording(e: PointerEvent) {
    console.debug('[VoiceRecorder] locked - recording continues hands-free');
    releaseCapture(e);
    dx = 0;
    setPhase('locked');
  }

  function releaseCapture(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement | null;
    if (el?.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    pointerId = null;
  }

  /**
   * A KEYBOARD CANNOT HOLD, so it goes straight to the locked phase.
   *
   * Not an alternative affordance bolted on: `locked` is the phase that already has explicit send
   * and discard buttons, which is exactly what a keyboard needs. Space and Enter both start it, and
   * from there the two buttons are ordinary tab stops.
   */
  function handleKeydown(e: KeyboardEvent) {
    if (phase !== 'idle') return;
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    setPhase('arming');
    void beginRecording().then(() => {
      if (phase === 'holding') setPhase('locked');
    });
  }

  function formatDuration(ms: number): string {
    const total = Math.floor(ms / 1000);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  onDestroy(() => {
    // Leaving the conversation mid-recording throws it away: nobody released on the microphone, so
    // nobody asked for it to be sent.
    if (session || phase !== 'idle') finish(false, 'composer destroyed');
  });
</script>

<div class="voice-recorder {isActive ? 'is-active' : ''}" data-phase={phase}>
  {#if isActive}
    <!-- The bin is the destination of the leftward slide, so it sits where the thumb is going. -->
    <div
      class="voice-recorder-bin {willCancel ? 'is-armed' : ''}"
      style="opacity: {0.35 + 0.65 * cancelProgress}; transform: scale({1 + 0.25 * cancelProgress})"
      aria-hidden="true"
    >
      <Trash2 size={20} strokeWidth={2} />
    </div>

    <div class="voice-recorder-status" aria-live="polite">
      <span class="voice-recorder-dot" aria-hidden="true"></span>
      <span class="voice-recorder-timer">{formatDuration(elapsedMs)}</span>
    </div>

    {#if phase === 'locked'}
      <span class="voice-recorder-hint">{m.chat_voice_locked_hint()}</span>
      <button
        type="button"
        class="ui-icon-button chat-composer-icon-button"
        onclick={() => finish(false, 'bin pressed while locked')}
        aria-label={m.chat_cancel_recording_label()}
        title={m.chat_cancel_recording_label()}
      >
        <Trash2 size={20} strokeWidth={2} />
      </button>
      <button
        type="button"
        class="ui-icon-button chat-composer-send-button"
        onclick={() => finish(true, 'send pressed while locked')}
        aria-label={m.chat_stop_and_send_title()}
        title={m.chat_stop_and_send_title()}
      >
        <Send size={18} strokeWidth={2.5} class="mt-0.5 ml-0.5" />
      </button>
    {:else}
      <span class="voice-recorder-hint" style="opacity: {1 - cancelProgress}">
        {willCancel ? m.chat_voice_release_to_cancel() : m.chat_voice_slide_to_cancel()}
      </span>
      <!-- The padlock is the destination of the rightward slide, filling in as the thumb nears it. -->
      <div
        class="voice-recorder-lock"
        style="opacity: {0.25 + 0.75 * lockProgress}; transform: scale({0.9 + 0.2 * lockProgress})"
        aria-hidden="true"
      >
        <Lock size={16} strokeWidth={2.5} />
      </div>
    {/if}
  {/if}

  {#if phase !== 'locked'}
    <button
      type="button"
      class="voice-recorder-thumb {isActive ? 'is-recording' : ''} {willCancel
        ? 'is-cancelling'
        : ''}"
      style="transform: translateX({thumbOffset}px)"
      onpointerdown={handlePointerDown}
      onpointermove={handlePointerMove}
      onpointerup={handlePointerUp}
      onpointercancel={handlePointerCancel}
      onkeydown={handleKeydown}
      aria-label={m.chat_record_voice_message_label()}
      title={m.chat_record_voice_message_title()}
    >
      <Mic size={20} strokeWidth={2} />
    </button>
  {/if}
</div>
