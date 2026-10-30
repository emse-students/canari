<script lang="ts">
  /**
   * THE CALL, FULL SCREEN - and the one place a call's sound plays.
   *
   * Messenger's model (user, 2026-10-19: *"soit ca fait toute l'interface, soit ca fait un bandeau en
   * haut, pas cette espece de modal qui en plus est sur ou sous le reste de l'interface"*): a call is
   * either the WHOLE screen - this component - or a slim bar in the root layout's banner column,
   * `CallBanner`, which pushes the page down instead of covering it. The old docked card sat
   * `fixed bottom-4 right-4`: on the iPhone it was UNDER the native glass tab bar, its hang-up glyph
   * showing through the glass and no tap reaching it (CALL-IOS-HANGUP), because no web layer can
   * cover a native view. Neither shape here can meet that: the full screen joins `coversScreen`, which
   * hides the native tab bar and the native glass pieces, and the banner is a row ABOVE the page, a
   * place no native chrome is drawn.
   *
   * Mounted by `ChatBackgroundService` for the whole life of a call, whichever shape is showing, so
   * the remote `<audio>` sink below is created ONCE per call. It used to live in each of the two
   * views of the old overlay, so minimising or expanding destroyed the element carrying the voice and
   * built another - a gap in the sound at every switch. Every `<video>` is muted for the same reason:
   * the sink is the one audio output, whatever is on screen.
   *
   * The full screen is portalled to the body (`.page-scroll-wrap` is a containing block for
   * `fixed`), takes `--z-call` (above a confirmation, see `app.css`), and answers the system Back by MINIMISING -
   * the call goes on in the banner, as on every phone.
   */
  import { coversScreen } from '$lib/actions/coversScreen.svelte';
  import { portal } from '$lib/actions/portal';
  import { focusTrap } from '$lib/actions/focusTrap.svelte';
  import type { CallService, CallParticipant } from '$lib/services/CallService';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import UserName from '$lib/components/shared/UserName.svelte';
  import {
    ChevronDown,
    Mic,
    MicOff,
    Phone,
    PhoneOff,
    PictureInPicture2,
    Shield,
    ShieldCheck,
    Speaker,
    SwitchCamera,
    Video,
    VideoOff,
    Volume2,
  } from '@lucide/svelte';
  import { fade } from 'svelte/transition';
  import type { Snippet } from 'svelte';
  import { m } from '$lib/paraglide/messages';
  import { isAndroidTauriRuntime, isIosTauriRuntime } from '$lib/utils/appVersion';
  import {
    nextSpeakerDefault,
    hasAndroidCallService,
    ongoingCallSpec,
    openAndroidCallSession,
  } from '$lib/mobile/androidCallService';
  import { callHoldsProximity, setIosProximityMonitoring } from '$lib/mobile/iosCallProximity';
  import { callVideoAvailable } from '$lib/utils/callsAvailability';
  import { serverCallsMode } from '$lib/stores/appVersionCheck.svelte';
  import { useCallModel } from '$lib/composables/useCallModel.svelte';
  import { callView } from '$lib/stores/callView.svelte';
  import { callMicNotice, callStatusText } from '$lib/utils/callStatusText';
  import { applyCallMediaSession, clearCallMediaSession } from '$lib/utils/callMediaSession';
  import { bindHistoryOverlay } from '$lib/utils/bindHistoryOverlay.svelte';
  import { appendLog } from '$lib/utils/sessionLog';
  import { startCallVoice } from '$lib/utils/callVoice';
  import { ScreenWakeLock } from '$lib/live/liveDevice';

  let {
    callService,
    participants = [],
  }: {
    callService: CallService;
    participants?: CallParticipant[];
  } = $props();

  const call = useCallModel(() => callService);
  const fullScreen = $derived(callView.showsFullScreen);

  // Back minimises; the call is never ended by a navigation gesture. The chevron and Escape go
  // through `dismissFromUi` too, so every way out of the full screen leaves the stack the same way
  // (its entry a ghost the next expand takes back, never a second one).
  const overlayEntry = bindHistoryOverlay(
    () => fullScreen,
    () => callView.minimise()
  );

  function minimise(how: string) {
    appendLog(`[Call] full screen minimised (${how})`);
    overlayEntry.dismissFromUi();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !fullScreen) return;
    e.stopPropagation();
    minimise('Escape');
  }

  // The next call opens full screen: this component lives exactly as long as one call.
  $effect(() => () => callView.reset());

  let primary = $derived(participants[0]);
  let isIncoming = $derived(call.callState === 'incoming');
  // The ring says WHICH call rings: a video call is answered with the camera on.
  let statusText = $derived(
    isIncoming && callService.incomingHasVideo
      ? m.call_incoming_video_label()
      : callStatusText(call.kind, call.duration)
  );
  let isEnded = $derived(call.callState === 'ended');

  /** The remote stream carrying the peer's picture (`call.remoteVideoTrack`), if any. */
  let remoteVideoStream = $derived.by(() => {
    const track = call.remoteVideoTrack;
    if (!track) return null;
    for (const [, stream] of call.remoteStreams) {
      if (stream.getVideoTracks().some((t) => t === track)) return stream;
    }
    return null;
  });
  /** Any remote stream: the one the audio sink plays (the same object whatever the video does). */
  let remoteAudioStream = $derived.by(() => {
    for (const [, stream] of call.remoteStreams) return stream;
    return call.remoteStream;
  });
  /** Whether this side is sending its camera: the self view shows, and the screen stays on. */
  let cameraOn = $derived(!call.isVideoOff && !!call.localVideoTrack);
  /** Either picture on screen makes this a video call for the OS and for the screen lock. */
  let videoShowing = $derived(cameraOn || !!call.remoteVideoTrack);

  // -- The one audio output of the call ------------------------------------------------------
  let remoteAudioSink: HTMLAudioElement | undefined = $state();

  /** Starts the voice and publishes whether the engine refused it for want of a gesture. */
  async function startVoice(why: string): Promise<void> {
    const sink = remoteAudioSink;
    if (!sink || !sink.srcObject) return;
    callView.setAudioBlocked((await startCallVoice(sink, why)) === 'blocked');
  }

  $effect(() => {
    const sink = remoteAudioSink;
    const stream = remoteAudioStream;
    if (!sink || !stream) return;
    sink.srcObject = stream;
    void startVoice('stream arrived');
    // Released when the stream goes: a sink bound to an old stream keeps an audio output for
    // nothing (`toneOutput.ts`).
    return () => {
      sink.pause();
      sink.srcObject = null;
    };
  });

  /**
   * THE TAP THAT STARTS THE VOICE. A WebView may refuse `play()` outside a user gesture, and the
   * stream arrives long after the tap that answered or dialled. So: the element is PRIMED inside a
   * gesture (the Accept tap, or this mount when it happens within the dial tap's activation), and
   * while a start was refused the next pointer-down anywhere - on the banner, in a page - retries.
   */
  function primeVoice(why: string) {
    const sink = remoteAudioSink;
    if (!sink) return;
    if (sink.srcObject) {
      void startVoice(why);
      return;
    }
    // No stream yet: an empty play() inside the gesture is what lets the later one through on
    // WebKit. Its own rejection (no source) is expected and only logged.
    sink.play().catch((e: unknown) => appendLog(`[Call] voice primed (${why}): ${String(e)}`));
  }

  $effect(() => {
    if (!remoteAudioSink) return;
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } })
      .userActivation;
    if (activation?.isActive) primeVoice('mounted within the dialling tap');
  });

  $effect(() => {
    // While ringing too: the Accept tap may land on the BANNER, which cannot reach this element.
    if (!callView.audioBlocked && !isIncoming) return;
    const retry = () => primeVoice(isIncoming ? 'tap while ringing' : 'tap after a refusal');
    window.addEventListener('pointerdown', retry, { capture: true });
    return () => window.removeEventListener('pointerdown', retry, { capture: true });
  });

  /**
   * Where the voice goes BY DEFAULT ({@link nextSpeakerDefault}): decided when the call first holds
   * the microphone - `CallService.hasVideo` is set before the stream is published - and moved to the
   * loudspeaker when video shows later. Null until the microphone is held.
   */
  let speakerDefault = $state<boolean | null>(null);
  /** The user's own choice on the toggle, which wins over the default for the rest of the call. */
  let speakerChoice = $state<boolean | null>(null);
  $effect(() => {
    if (!call.localStream) return;
    const video = callService.hasVideo || videoShowing;
    const next = nextSpeakerDefault(speakerDefault, video);
    if (next === speakerDefault) return;
    const first = speakerDefault === null;
    speakerDefault = next;
    appendLog(
      first
        ? `[Call] voice starts on the ${next ? 'loudspeaker' : 'earpiece or a headset'} (${video ? 'video' : 'audio'} call)`
        : `[Call] video showed - the default moves to the loudspeaker (user choice=${speakerChoice ?? 'none'})`
    );
  });
  /** Where the page ASKS the voice to go: the loudspeaker (true) or the earpiece (false). */
  let isSpeakerOn = $derived(speakerChoice ?? speakerDefault ?? false);
  /**
   * Android: the output the service APPLIED (true = loudspeaker), null until it says or when the
   * platform routes. A loudspeaker DEFAULT yields to a headset natively, so the asked route alone
   * would read "speaker on" over a headset and the first tap would change nothing audible.
   */
  let routedSpeaker = $state<boolean | null>(null);
  /** What the toggle shows and inverts: the applied route when known, else the asked one. */
  let speakerShown = $derived(
    androidRouteAvailable && routedSpeaker !== null ? routedSpeaker : isSpeakerOn
  );
  let speakerSupported = $derived(
    typeof navigator !== 'undefined' &&
      'mediaDevices' in navigator &&
      typeof AudioContext !== 'undefined'
  );
  /**
   * Whether the speaker toggle can route anything: on iOS the page's `setSinkId`; on Android the
   * ongoing-call service's output, so a build without the service shows no toggle that does nothing.
   */
  let speakerRoutable = $derived(
    isIosTauriRuntime() || (isAndroidTauriRuntime() && hasAndroidCallService(window))
  );
  /**
   * Android: whether the service can route the audio NOW - false while its start waits for the app
   * to come back on screen, and once it was refused or left for this call. The toggle is then shown
   * disabled and says why, rather than taking a tap that would do nothing.
   */
  let androidRouteAvailable = $state(true);
  let speakerDisabled = $derived(isAndroidTauriRuntime() && !androidRouteAvailable);

  /**
   * Routes remote audio to speaker or earpiece on iOS, by output-device LABEL. Best-effort and
   * unverified on hardware: a WebView may list no labelled outputs at all, and the real route is a
   * native call (`AVAudioSession`, WP-C-BG-I) - calls.md, "the call in the background". On Android
   * the route is the ongoing-call service's (`AudioManager.setCommunicationDevice`, below).
   */
  async function applySpeakerRouting(sink: HTMLAudioElement, speaker: boolean) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const kind = speaker ? 'speaker' : 'earpiece';
      const target = devices.find(
        (d) => d.kind === 'audiooutput' && d.label.toLowerCase().includes(kind)
      );
      if (!target || !('setSinkId' in sink)) {
        appendLog(`[Call] no '${kind}' output to route to on this engine - route unchanged`);
        return;
      }
      await (sink as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> }).setSinkId(
        target.deviceId
      );
      appendLog(`[Call] audio routed to ${kind}`);
    } catch (e) {
      appendLog(`[Call] audio routing failed: ${String(e)}`);
    }
  }

  $effect(() => {
    const sink = remoteAudioSink;
    if (!sink || !speakerSupported || !isIosTauriRuntime()) return;
    void applySpeakerRouting(sink, isSpeakerOn);
  });

  // -- The call in the background: told to the OS, and every transition logged ----------------
  $effect(() => {
    if (isIncoming || isEnded) return;
    const title = primary?.displayName || m.call_label();
    applyCallMediaSession(navigator, {
      title,
      artist: videoShowing ? m.chat_video_call_label() : m.call_audio_only_label(),
      muted: call.isMuted,
      onHangup: () => {
        appendLog('[Call] hang-up from the OS media controls');
        callService.endCall();
      },
      onToggleMicrophone: () => {
        appendLog('[Call] microphone toggled from the OS media controls');
        callService.toggleMute();
      },
    });
  });
  $effect(() => () => clearCallMediaSession(navigator));

  // -- Android: the ongoing-call foreground service (WP-C-BG-A) -------------------------------
  // It keeps the process's network and microphone while the app is off screen, draws the CallStyle
  // notification and owns the audio route. Opened once per call (this component lives exactly as
  // long as one call); its hang-up ends the call like the in-app button.
  const androidCall = isAndroidTauriRuntime()
    ? openAndroidCallSession(window, {
        onHangUp: () => callService.endCall(),
        onMute: () => callService.toggleMute(),
        onRoute: (available) => (androidRouteAvailable = available),
        onOutput: (speaker) => (routedSpeaker = speaker),
      })
    : null;
  $effect(() => () => androidCall?.dispose());
  $effect(() => {
    if (!androidCall) return;
    androidCall.publish(
      ongoingCallSpec(call.kind, !!call.localStream, {
        title: primary?.displayName || m.call_label(),
        peerUserId: primary?.userId ?? null,
        connectedAtMs: call.connectedAt,
        speaker: isSpeakerOn,
        // A default yields to a connected headset natively; the user's tap does not.
        speakerChosen: speakerChoice !== null,
        muted: call.isMuted,
      }),
      `kind=${call.kind}`
    );
  });

  // -- iOS: the screen goes dark against the cheek while the voice is on the receiver ---------
  // Android holds its proximity lock natively, from the output its service applied.
  $effect(() => {
    if (!isIosTauriRuntime()) return;
    const held = callHoldsProximity(call.kind, !!call.localStream, isSpeakerOn);
    setIosProximityMonitoring(held, `kind=${call.kind} speaker=${isSpeakerOn}`);
  });
  $effect(() => () => {
    if (isIosTauriRuntime()) setIosProximityMonitoring(false, 'the call surface closed');
  });

  /**
   * What a device reading needs to say what the background did to the call: whether the page was
   * hidden, whether the OS took the microphone (`mute` on the TRACK, which is not the user's mute) and
   * whether the voice was paused. A sink the OS paused while hidden is started again on return - the
   * primary path for that state, logged so its rate can be read.
   */
  $effect(() => {
    const onVisibility = () => {
      const mic = call.localStream?.getAudioTracks()[0];
      const micState = mic
        ? `${mic.readyState}${mic.muted ? '/os-muted' : ''}${mic.enabled ? '' : '/user-muted'}`
        : 'none';
      const sink = remoteAudioSink;
      appendLog(
        `[Call] app ${document.hidden ? 'hidden' : 'visible'} state=${call.callState} mic=${micState} voice=${sink ? (sink.paused ? 'paused' : 'playing') : 'none'}`
      );
      if (!document.hidden && sink?.paused && sink.srcObject) {
        appendLog('[Call] WARN the voice was paused while hidden - starting it again');
        void startVoice('back from the background');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });

  // The OS taking the microphone (`mute` on the track) is watched by the SERVICE, which tells the
  // other party over the relay - `CallService.watchSystemMicrophone`.

  /** Why a voice is not getting through, when an operating system is the reason (either side). */
  let micNotice = $derived(
    callMicNotice(call.kind, call.localMicSuspended, call.peerMicSuspended, primary?.displayName)
  );

  /**
   * What the live region says once a notice ENDS, so it never falls back to "connected" - a state
   * that did not change. The other party's microphone coming back is said ONCE; this device's is
   * said by the toast (`call_mic_was_suspended`), so the region says nothing new rather than say it
   * twice. `null` = no notice ended since the call was last live: the ordinary announcement.
   */
  let micRecovery = $state<string | null>(null);
  /** Whose notice was SHOWN last ('local', 'peer') - a notice never shown ends with no recovery. */
  let micShown: 'local' | 'peer' | null = null;
  $effect(() => {
    const live = call.kind === 'live';
    const shown = !live
      ? null
      : call.localMicSuspended
        ? 'local'
        : call.peerMicSuspended
          ? 'peer'
          : null;
    if (!live || shown) {
      // Leaving `live` is a new state with its own announcement; a notice up says itself.
      micRecovery = null;
    } else if (micShown === 'local') {
      micRecovery = '';
    } else if (micShown === 'peer') {
      const name = primary?.displayName;
      micRecovery = name ? m.call_mic_restored_peer({ name }) : m.call_mic_restored_peer_unnamed();
    }
    micShown = shown;
  });

  // -- Video (lot 2) --------------------------------------------------------------------------
  let remoteVideo: HTMLVideoElement | undefined = $state();
  let localVideo: HTMLVideoElement | undefined = $state();

  // Bound to the TRACK: a new remote track (renegotiation) or the peer's camera back after a mute
  // re-binds; the element never plays a stream whose picture is gone.
  $effect(() => {
    const el = remoteVideo;
    const track = call.remoteVideoTrack;
    if (!el || !track) return;
    el.srcObject = new MediaStream([track]);
    el.play().catch((e: unknown) => appendLog(`[Call] remote video did not start: ${String(e)}`));
    return () => {
      el.srcObject = null;
    };
  });

  // Video only in the self view: the microphone is never played back to its owner.
  $effect(() => {
    const el = localVideo;
    const track = call.localVideoTrack;
    if (!el || !track || call.isVideoOff) return;
    el.srcObject = new MediaStream([track]);
    el.play().catch((e: unknown) => appendLog(`[Call] self view did not start: ${String(e)}`));
    return () => {
      el.srcObject = null;
    };
  });

  /**
   * ORIENTATION. The peer's picture fills the screen (`cover`) when it is held the same way as this
   * screen, and is shown WHOLE (`contain`) when it is not - a landscape picture cropped to a
   * portrait screen loses two thirds of it. Read from the picture's own size (`resize` fires when
   * the peer turns its phone) against this screen's.
   */
  let remoteLandscape = $state<boolean | null>(null);
  let screenLandscape = $state(false);
  $effect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(orientation: landscape)');
    screenLandscape = query.matches;
    const onChange = () => (screenLandscape = query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  });
  function readRemoteShape() {
    const el = remoteVideo;
    if (!el || !el.videoWidth || !el.videoHeight) return;
    const landscape = el.videoWidth > el.videoHeight;
    if (landscape !== remoteLandscape) {
      appendLog(`[Call] remote picture ${el.videoWidth}x${el.videoHeight}`);
      remoteLandscape = landscape;
    }
  }
  let remoteFit = $derived(
    remoteLandscape === null || remoteLandscape === screenLandscape
      ? 'object-cover'
      : 'object-contain'
  );

  /**
   * The screen stays on while a picture is on it - a video call is watched, not held to the ear
   * (calls.md: an audio call takes no lock). Taken again when the app comes back: the system
   * releases it on every hide.
   */
  const wakeLock = new ScreenWakeLock(undefined, 'CALL-WAKE');
  $effect(() => {
    if (!videoShowing || isEnded) return;
    void wakeLock.hold();
    const again = () => {
      if (!document.hidden) void wakeLock.hold();
    };
    document.addEventListener('visibilitychange', again);
    return () => {
      document.removeEventListener('visibilitychange', again);
      wakeLock.release();
    };
  });

  let showSwitch = $derived(cameraOn && call.canSwitchCamera && !isEnded);

  function switchCamera() {
    appendLog('[Call] switch camera tapped');
    void callService.switchCamera();
  }

  let pipSupported = $derived(
    typeof document !== 'undefined' && !!document.pictureInPictureEnabled
  );
  let showPip = $derived(!!remoteVideoStream && pipSupported);

  async function togglePictureInPicture() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await remoteVideo?.requestPictureInPicture();
    } catch (e) {
      appendLog(`[Call] picture-in-picture refused: ${String(e)}`);
    }
  }

  function accept() {
    appendLog('[Call] accepted from the full-screen ring');
    primeVoice('accept tap');
    void callService.acceptCall(callService.currentGroupId ?? '', callService.currentCallId ?? '');
  }

  // The ring is an ALERT: focus lands on Accept, the one thing a keyboard or screen-reader user came
  // to do (`focusTrap` would pick the chevron, the first control in the tree).
  let screenEl: HTMLElement | undefined = $state();
  $effect(() => {
    if (!screenEl || !isIncoming) return;
    screenEl
      .querySelector<HTMLButtonElement>('[data-testid="call-accept"]')
      ?.focus({ preventScroll: true });
  });

  /** The live line: a change of STATE is announced, never the timer's every second. */
  let announcement = $derived(
    call.kind === 'live'
      ? (micNotice ?? micRecovery ?? m.call_live_announcement())
      : callStatusText(call.kind, call.duration)
  );

  function hangUp() {
    appendLog(`[Call] ${isIncoming ? 'declined' : 'hung up'} from the full screen`);
    callService.endCall();
  }
</script>

{#snippet control(
  testid: string,
  label: string,
  caption: string,
  onclick: () => void,
  tone: 'neutral' | 'on' | 'danger' | 'accept',
  icon: Snippet,
  disabled: boolean = false
)}
  <div class="flex w-20 flex-col items-center gap-2">
    <button
      type="button"
      {disabled}
      class="call-control flex size-16 items-center justify-center rounded-full transition-transform active:scale-95 disabled:opacity-40 disabled:active:scale-100 {tone ===
      'danger'
        ? 'bg-call-decline text-white hover:brightness-110'
        : tone === 'accept'
          ? 'bg-call-accept text-white hover:brightness-110'
          : tone === 'on'
            ? 'text-cn-ink bg-white'
            : 'bg-white/15 text-white hover:bg-white/25'}"
      aria-label={label}
      data-testid={testid}
      {onclick}
    >
      {@render icon()}
    </button>
    <span class="text-center text-xs text-white/80" aria-hidden="true">{caption}</span>
  </div>
{/snippet}

<svelte:window onkeydown={onKeydown} />

<!-- The voice: hidden, mounted for the whole call, in either shape. -->
<audio bind:this={remoteAudioSink} autoplay class="hidden"></audio>
<!-- ONE live region for both shapes, so a minimised call still announces "Reconnexion...". -->
<span class="sr-only" role="status" data-testid="call-announcer">{announcement}</span>

{#if fullScreen}
  <div
    use:portal
    use:coversScreen
    use:focusTrap
    bind:this={screenEl}
    role={isIncoming ? 'alertdialog' : 'dialog'}
    aria-modal="true"
    aria-label={primary?.displayName || m.call_label()}
    data-testid="call-screen"
    class="bg-cn-scrim fixed inset-0 z-(--z-call) flex flex-col overflow-hidden text-white select-none"
    style="padding: var(--safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) var(--safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);"
    transition:fade={{ duration: 150 }}
  >
    {#if !videoShowing && primary}
      <!-- Messenger's and WhatsApp's backdrop: the other person's own photo, blown up, blurred and
           dimmed behind the call. The SAME Avatar component (one cache, one fallback), never a
           second fetch path; decorative, so hidden from assistive tech. A reader without a photo
           gets the blurred initials tile, which is just a colour field. -->
      <div
        class="pointer-events-none absolute inset-0 overflow-hidden"
        aria-hidden="true"
        data-testid="call-backdrop"
      >
        <div class="absolute inset-0 scale-150 opacity-60 blur-3xl">
          <Avatar userId={primary.userId} fill shape="soft" fallbackLabel={primary.displayName} />
        </div>
        <div class="bg-cn-scrim/55 absolute inset-0"></div>
      </div>
    {/if}
    {#if remoteVideoStream}
      <video
        bind:this={remoteVideo}
        autoplay
        playsinline
        muted
        onresize={readRemoteShape}
        onloadedmetadata={readRemoteShape}
        data-testid="call-remote-video"
        class="absolute inset-0 h-full w-full bg-black {remoteFit}"
      ></video>
    {/if}
    {#if cameraOn}
      <!-- The self view: the whole screen while there is no picture of the peer (ringing, or the
           peer's camera off), a corner once there is. ONE element, so the move is a class change
           and not a new binding. Mirrored for the front camera only, as every phone does. -->
      <video
        bind:this={localVideo}
        autoplay
        playsinline
        muted
        data-testid="call-self-view"
        data-mirrored={call.cameraFacing === 'user'}
        class="{call.cameraFacing === 'user' ? '-scale-x-100' : ''} {remoteVideoStream
          ? 'absolute right-4 bottom-36 z-10 h-40 w-28 rounded-2xl shadow-xl ring-1 ring-white/20 landscape:bottom-28 landscape:h-28 landscape:w-40'
          : 'absolute inset-0 h-full w-full'} object-cover"
      ></video>
    {/if}

    <!-- Top row: back to the app (minimise), and the encryption fact. -->
    <div class="relative z-10 flex items-center justify-between gap-2 px-2 pt-2">
      <button
        type="button"
        class="ui-icon-button rounded-full text-white hover:bg-white/10"
        aria-label={m.call_minimize_label()}
        title={m.call_minimize_label()}
        onclick={() => minimise('chevron')}
      >
        <ChevronDown size={26} />
      </button>
      <!-- Claimed on EVIDENCE only (CallService.e2eProven): a frame encrypted and one decrypted
           by this call's worker. A transform merely attached proved nothing on Chromium. -->
      <span
        class="inline-flex min-w-0 items-center gap-1.5 truncate text-xs text-white/70"
        title={call.e2eProven ? m.call_e2e_encrypted_title() : m.call_e2e_verifying()}
        data-testid="call-e2e-line"
      >
        {#if call.e2eProven}
          <ShieldCheck size={14} class="shrink-0" />
          <span class="truncate">{m.call_e2e_encrypted_title()}</span>
        {:else}
          <Shield size={14} class="shrink-0" />
          <span class="truncate">{m.call_e2e_verifying()}</span>
        {/if}
      </span>
      <div class="flex shrink-0 items-center">
        {#if showSwitch}
          <button
            type="button"
            class="ui-icon-button rounded-full text-white hover:bg-white/10"
            aria-label={m.call_switch_camera_label()}
            title={m.call_switch_camera_label()}
            data-testid="call-switch-camera"
            onclick={switchCamera}
          >
            <SwitchCamera size={22} />
          </button>
        {/if}
        {#if showPip}
          <button
            type="button"
            class="ui-icon-button rounded-full text-white hover:bg-white/10"
            aria-label={m.call_open_pip_label()}
            title={m.call_pip_label()}
            onclick={() => void togglePictureInPicture()}
          >
            <PictureInPicture2 size={22} />
          </button>
        {/if}
        {#if !showSwitch && !showPip}
          <!-- Keeps the encryption line centred against the chevron. -->
          <span class="ui-icon-button" aria-hidden="true"></span>
        {/if}
      </div>
    </div>

    <!-- Who, and where the call stands. -->
    <!-- Over a picture the name moves to the top and gets smaller: the picture is the call. -->
    <div
      class="relative z-10 flex min-h-0 flex-1 flex-col items-center gap-4 px-6 text-center {videoShowing
        ? 'justify-start pt-2 drop-shadow-md'
        : 'justify-center'}"
    >
      {#if !videoShowing}
        <div class="relative size-32 md:size-44">
          {#if isIncoming || call.kind === 'ringing'}
            <!-- The ring: a halo that breathes while the call rings, on either side. -->
            <div class="absolute inset-0 rounded-full bg-white/15 motion-safe:animate-ping"></div>
          {/if}
          <div
            class="relative h-full w-full overflow-hidden rounded-full shadow-xl ring-4 ring-white/10"
          >
            {#if primary}
              <Avatar
                userId={primary.userId}
                fill
                shape="circle"
                fallbackLabel={primary.displayName}
              />
            {/if}
          </div>
        </div>
      {/if}
      <div class="flex max-w-full flex-col items-center gap-1">
        {#if primary}
          <UserName
            userId={primary.userId}
            fallback={primary.displayName}
            link={false}
            class="block max-w-full truncate font-bold {videoShowing ? 'text-lg' : 'text-3xl'}"
          />
        {:else}
          <p class="font-bold {videoShowing ? 'text-lg' : 'text-3xl'}">{m.call_label()}</p>
        {/if}
        <p
          class="text-white/75 tabular-nums {videoShowing ? 'text-sm' : 'text-base'} {call.kind ===
          'live'
            ? ''
            : 'animate-pulse'}"
          data-testid="call-status"
        >
          {statusText}
        </p>
        {#if micNotice}
          <p
            class="mt-1 inline-flex max-w-full items-center gap-2 text-sm text-amber-200"
            data-testid="call-mic-notice"
          >
            <MicOff size={16} class="shrink-0" />
            <span>{micNotice}</span>
          </p>
        {/if}
        {#if call.kind === 'live' && !call.isVideoOff && call.videoSendReduced}
          <!-- The quality ladder had to shrink THIS side's picture (CallService.videoSendReduced). -->
          <p
            class="mt-1 inline-flex max-w-full items-center gap-2 text-sm text-amber-200"
            data-testid="call-video-reduced"
          >
            <Video size={16} class="shrink-0" />
            <span>{m.call_video_reduced_notice()}</span>
          </p>
        {/if}
        {#if callView.audioBlocked}
          <button
            type="button"
            class="text-cn-ink mt-2 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold"
            data-testid="call-tap-to-hear"
            onclick={() => primeVoice('tap-to-hear button')}
          >
            <Volume2 size={18} />
            {m.call_tap_to_hear()}
          </button>
        {/if}
      </div>
    </div>

    <!-- The controls, under the thumb. -->
    <div class="relative z-10 flex justify-center px-4 pt-4 pb-8 md:pb-12">
      {#if isIncoming}
        <div class="flex w-full max-w-xs items-start justify-between">
          {#snippet declineIcon()}<PhoneOff size={28} />{/snippet}
          {#snippet acceptIcon()}<Phone size={28} class="fill-current" />{/snippet}
          {@render control(
            'call-decline',
            m.call_decline_incoming_label(),
            m.call_decline_label(),
            hangUp,
            'danger',
            declineIcon
          )}
          {@render control(
            'call-accept',
            m.call_accept_incoming_label(),
            m.call_accept_short_label(),
            accept,
            'accept',
            acceptIcon
          )}
        </div>
      {:else if !isEnded}
        <!-- Four controls at 390 px: 4 x 80 + 3 x 8 fits the 358 px between the gutters. -->
        <div class="flex items-start justify-center gap-2 sm:gap-6">
          {#if speakerRoutable && speakerSupported}
            {#snippet speakerIcon()}
              {#if speakerShown}<Volume2 size={26} />{:else}<Speaker size={26} />{/if}
            {/snippet}
            {@render control(
              'call-speaker',
              speakerDisabled
                ? m.call_route_unavailable_label()
                : speakerShown
                  ? m.call_speaker_label()
                  : m.call_earpiece_label(),
              speakerShown ? m.call_speaker_label() : m.call_earpiece_label(),
              () => (speakerChoice = !speakerShown),
              speakerShown ? 'on' : 'neutral',
              speakerIcon,
              speakerDisabled
            )}
          {/if}
          <!-- The switch gates turning the camera ON, never OFF: the mode can drop to audio mid-call,
               and a control that vanished then would leave a running camera nobody can stop. -->
          {#if callVideoAvailable(serverCallsMode()) || !call.isVideoOff}
            {#snippet videoIcon()}
              {#if call.isVideoOff}<VideoOff size={26} />{:else}<Video size={26} />{/if}
            {/snippet}
            {@render control(
              'call-camera',
              call.isVideoOff ? m.call_enable_camera_label() : m.call_disable_camera_label(),
              m.call_camera_short_label(),
              () => void callService.toggleVideo(),
              call.isVideoOff ? 'neutral' : 'on',
              videoIcon
            )}
          {/if}
          {#snippet micIcon()}
            {#if call.isMuted}<MicOff size={26} />{:else}<Mic size={26} />{/if}
          {/snippet}
          {@render control(
            'call-mute',
            call.isMuted ? m.call_unmute_label() : m.call_mute_label(),
            m.call_mute_short_label(),
            () => callService.toggleMute(),
            call.isMuted ? 'on' : 'neutral',
            micIcon
          )}
          {#snippet endIcon()}<PhoneOff size={28} />{/snippet}
          {@render control(
            'call-hang-up',
            m.call_hang_up_label(),
            m.call_hang_up_label(),
            hangUp,
            'danger',
            endIcon
          )}
        </div>
      {/if}
    </div>
  </div>
{/if}
