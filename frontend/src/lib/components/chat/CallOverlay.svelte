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
   * `fixed`), takes `--z-critical` (the call UI's rung), and answers the system Back by MINIMISING -
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
    ShieldCheck,
    Speaker,
    Video,
    VideoOff,
    Volume2,
  } from '@lucide/svelte';
  import { fade } from 'svelte/transition';
  import type { Snippet } from 'svelte';
  import { m } from '$lib/paraglide/messages';
  import { isMobileTauriRuntime } from '$lib/utils/appVersion';
  import { CALLS_VIDEO_ENABLED } from '$lib/features';
  import { useCallModel } from '$lib/composables/useCallModel.svelte';
  import { callView } from '$lib/stores/callView.svelte';
  import { callStatusText } from '$lib/utils/callStatusText';
  import { applyCallMediaSession, clearCallMediaSession } from '$lib/utils/callMediaSession';
  import { bindHistoryOverlay } from '$lib/utils/bindHistoryOverlay.svelte';
  import { appendLog } from '$lib/utils/sessionLog';

  let {
    callService,
    participants = [],
  }: {
    callService: CallService;
    participants?: CallParticipant[];
  } = $props();

  const call = useCallModel(() => callService);
  const fullScreen = $derived(!callView.minimised);

  // Back minimises; the call is never ended by a navigation gesture.
  bindHistoryOverlay(
    () => fullScreen,
    () => callView.minimise()
  );

  // The next call opens full screen: this component lives exactly as long as one call.
  $effect(() => () => callView.reset());

  let primary = $derived(participants[0]);
  let statusText = $derived(callStatusText(call.kind, call.duration));
  let isIncoming = $derived(call.callState === 'incoming');
  let isEnded = $derived(call.callState === 'ended');

  /** Prefer a live, unmuted video track (renegotiation can leave older tracks in the stream). */
  function pickActiveVideoTrack(stream: MediaStream): MediaStreamTrack | undefined {
    const tracks = stream.getVideoTracks();
    return (
      tracks.find((t) => t.readyState === 'live' && !t.muted) ??
      tracks.find((t) => t.readyState === 'live') ??
      tracks[tracks.length - 1]
    );
  }

  /** The remote stream carrying a live video track, if any (video waits for WP-C3). */
  let remoteVideoStream = $derived.by(() => {
    for (const [, stream] of call.remoteStreams) {
      if (pickActiveVideoTrack(stream)) return stream;
    }
    return null;
  });
  /** Any remote stream: the one the audio sink plays. */
  let remoteAudioStream = $derived.by(() => {
    if (remoteVideoStream) return remoteVideoStream;
    for (const [, stream] of call.remoteStreams) return stream;
    return call.remoteStream;
  });

  // -- The one audio output of the call ------------------------------------------------------
  let remoteAudioSink: HTMLAudioElement | undefined = $state();
  $effect(() => {
    const sink = remoteAudioSink;
    const stream = remoteAudioStream;
    if (!sink || !stream) return;
    sink.srcObject = stream;
    sink.play().catch((e: unknown) => appendLog(`[Call] remote audio did not start: ${String(e)}`));
    // Released when the stream goes: a sink bound to an old stream keeps an audio output for
    // nothing (`toneOutput.ts`).
    return () => {
      sink.pause();
      sink.srcObject = null;
    };
  });

  /** Whether audio is routed through the speaker (true) or earpiece (false). Mobile only. */
  let isSpeakerOn = $state(true);
  let speakerSupported = $derived(
    typeof navigator !== 'undefined' &&
      'mediaDevices' in navigator &&
      typeof AudioContext !== 'undefined'
  );
  let isMobileRtc = $derived(isMobileTauriRuntime());

  /**
   * Routes remote audio to speaker or earpiece on mobile, by output-device LABEL. Best-effort and
   * unverified on hardware: a WebView may list no labelled outputs at all, and the real route is a
   * native call (`AudioManager` / `AVAudioSession`) - calls.md, "the call in the background".
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
    if (!sink || !speakerSupported || !isMobileRtc) return;
    void applySpeakerRouting(sink, isSpeakerOn);
  });

  // -- The call in the background: told to the OS, and every transition logged ----------------
  $effect(() => {
    if (isIncoming || isEnded) return;
    const title = primary?.displayName || m.call_label();
    applyCallMediaSession(navigator, {
      title,
      artist: m.call_audio_only_label(),
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
        sink
          .play()
          .catch((e: unknown) => appendLog(`[Call] restarting the voice failed: ${String(e)}`));
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });

  $effect(() => {
    const mic = call.localStream?.getAudioTracks()[0];
    if (!mic) return;
    const onMute = () => appendLog('[Call] WARN the system took the microphone (track muted)');
    const onUnmute = () => appendLog('[Call] the system gave the microphone back');
    const onEnded = () => appendLog('[Call] WARN the microphone track ended');
    mic.addEventListener('mute', onMute);
    mic.addEventListener('unmute', onUnmute);
    mic.addEventListener('ended', onEnded);
    return () => {
      mic.removeEventListener('mute', onMute);
      mic.removeEventListener('unmute', onUnmute);
      mic.removeEventListener('ended', onEnded);
    };
  });

  // -- Video (off until WP-C3; kept working so the switch does not reopen this file) -----------
  let remoteVideo: HTMLVideoElement | undefined = $state();
  let localVideo: HTMLVideoElement | undefined = $state();

  $effect(() => {
    const el = remoteVideo;
    const stream = remoteVideoStream;
    if (!el || !stream) return;
    const display = new MediaStream();
    const track = pickActiveVideoTrack(stream);
    if (track) display.addTrack(track);
    el.srcObject = display;
    el.play().catch((e: unknown) => appendLog(`[Call] remote video did not start: ${String(e)}`));
    return () => {
      el.srcObject = null;
    };
  });

  $effect(() => {
    const el = localVideo;
    if (!el || !call.localStream || call.isVideoOff) return;
    el.srcObject = call.localStream;
    el.play().catch((e: unknown) => appendLog(`[Call] self view did not start: ${String(e)}`));
  });

  let pipSupported = $derived(
    typeof document !== 'undefined' && !!document.pictureInPictureEnabled
  );

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
    void callService.acceptCall(callService.currentGroupId ?? '', callService.currentCallId ?? '');
  }

  function hangUp() {
    appendLog(`[Call] ${isIncoming ? 'declined' : 'hung up'} from the full screen`);
    callService.endCall();
  }
</script>

{#snippet control(
  label: string,
  caption: string,
  onclick: () => void,
  tone: 'neutral' | 'on' | 'danger' | 'accept',
  icon: Snippet
)}
  <div class="flex w-20 flex-col items-center gap-2">
    <button
      type="button"
      class="call-control flex size-16 items-center justify-center rounded-full transition-transform active:scale-95 {tone ===
      'danger'
        ? 'bg-red-500 text-white hover:bg-red-400'
        : tone === 'accept'
          ? 'bg-emerald-500 text-white hover:bg-emerald-400'
          : tone === 'on'
            ? 'text-cn-ink bg-white'
            : 'bg-white/15 text-white hover:bg-white/25'}"
      aria-label={label}
      {onclick}
    >
      {@render icon()}
    </button>
    <span class="text-center text-xs text-white/80" aria-hidden="true">{caption}</span>
  </div>
{/snippet}

<!-- The voice: hidden, mounted for the whole call, in either shape. -->
<audio bind:this={remoteAudioSink} autoplay class="hidden"></audio>

{#if fullScreen}
  <div
    use:portal
    use:coversScreen
    use:focusTrap
    role="dialog"
    aria-modal="true"
    aria-label={primary?.displayName || m.call_label()}
    data-testid="call-screen"
    class="bg-cn-scrim fixed inset-0 z-(--z-critical) flex flex-col overflow-hidden text-white select-none"
    style="padding: var(--safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) var(--safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);"
    transition:fade={{ duration: 150 }}
  >
    {#if remoteVideoStream}
      <video
        bind:this={remoteVideo}
        autoplay
        playsinline
        muted
        class="absolute inset-0 h-full w-full object-cover"
      ></video>
    {/if}

    <!-- Top row: back to the app (minimise), and the encryption fact. -->
    <div class="relative z-10 flex items-center justify-between gap-2 px-2 pt-2">
      <button
        type="button"
        class="ui-icon-button rounded-full text-white hover:bg-white/10"
        aria-label={m.call_minimize_label()}
        title={m.call_minimize_label()}
        onclick={() => callView.minimise()}
      >
        <ChevronDown size={26} />
      </button>
      <span
        class="inline-flex min-w-0 items-center gap-1.5 truncate text-xs text-white/70"
        title={m.call_e2e_encrypted_title()}
      >
        <ShieldCheck size={14} class="shrink-0" />
        <span class="truncate">{m.call_e2e_encrypted_title()}</span>
      </span>
      {#if remoteVideoStream && pipSupported}
        <button
          type="button"
          class="ui-icon-button rounded-full text-white hover:bg-white/10"
          aria-label={m.call_open_pip_label()}
          title={m.call_pip_label()}
          onclick={() => void togglePictureInPicture()}
        >
          <PictureInPicture2 size={22} />
        </button>
      {:else}
        <!-- Keeps the encryption line centred against the chevron. -->
        <span class="ui-icon-button" aria-hidden="true"></span>
      {/if}
    </div>

    <!-- Who, and where the call stands. -->
    <div
      class="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center"
    >
      {#if !remoteVideoStream}
        <div class="relative size-28 md:size-36">
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
            class="block max-w-full truncate text-2xl font-bold"
          />
        {:else}
          <p class="text-2xl font-bold">{m.call_label()}</p>
        {/if}
        <p
          class="text-base text-white/75 tabular-nums {call.kind === 'live' ? '' : 'animate-pulse'}"
          data-testid="call-status"
        >
          {statusText}
        </p>
      </div>
    </div>

    {#if call.localStream && !call.isVideoOff}
      <video
        bind:this={localVideo}
        autoplay
        playsinline
        muted
        class="absolute right-4 bottom-36 z-10 h-40 w-28 -scale-x-100 rounded-2xl object-cover shadow-xl ring-1 ring-white/20"
      ></video>
    {/if}

    <!-- The controls, under the thumb. -->
    <div class="relative z-10 flex justify-center px-4 pt-4 pb-8 md:pb-12">
      {#if isIncoming}
        <div class="flex w-full max-w-xs items-start justify-between">
          {#snippet declineIcon()}<PhoneOff size={28} />{/snippet}
          {#snippet acceptIcon()}<Phone size={28} class="fill-current" />{/snippet}
          {@render control(
            m.call_decline_incoming_label(),
            m.call_decline_label(),
            hangUp,
            'danger',
            declineIcon
          )}
          {@render control(
            m.call_accept_incoming_label(),
            m.call_accept_short_label(),
            accept,
            'accept',
            acceptIcon
          )}
        </div>
      {:else if !isEnded}
        <div class="flex items-start justify-center gap-4 sm:gap-6">
          {#if isMobileRtc && speakerSupported}
            {#snippet speakerIcon()}
              {#if isSpeakerOn}<Volume2 size={26} />{:else}<Speaker size={26} />{/if}
            {/snippet}
            {@render control(
              isSpeakerOn ? m.call_speaker_label() : m.call_earpiece_label(),
              isSpeakerOn ? m.call_speaker_label() : m.call_earpiece_label(),
              () => (isSpeakerOn = !isSpeakerOn),
              isSpeakerOn ? 'on' : 'neutral',
              speakerIcon
            )}
          {/if}
          {#if CALLS_VIDEO_ENABLED}
            {#snippet videoIcon()}
              {#if call.isVideoOff}<VideoOff size={26} />{:else}<Video size={26} />{/if}
            {/snippet}
            {@render control(
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
            call.isMuted ? m.call_unmute_label() : m.call_mute_label(),
            m.call_mute_short_label(),
            () => callService.toggleMute(),
            call.isMuted ? 'on' : 'neutral',
            micIcon
          )}
          {#snippet endIcon()}<PhoneOff size={28} />{/snippet}
          {@render control(
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
