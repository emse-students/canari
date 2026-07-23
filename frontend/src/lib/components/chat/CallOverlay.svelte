<script lang="ts">
  import { CallService, type CallParticipant } from '$lib/services/CallService';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import UserName from '$lib/components/shared/UserName.svelte';
  import {
    Mic,
    MicOff,
    PhoneOff,
    Video,
    VideoOff,
    Phone,
    Maximize,
    Minimize,
    Minimize2,
    Maximize2,
    PictureInPicture2,
    ShieldCheck,
    ShieldAlert,
    Speaker,
    Volume2,
  } from '@lucide/svelte';
  import { fade, scale, fly } from 'svelte/transition';
  import type { CallState } from '$lib/services/CallService';
  import { m } from '$lib/paraglide/messages';
  import { isMobileTauriRuntime } from '$lib/utils/appVersion';

  let {
    callService,
    currentUserId = '',
    participants = [],
  }: {
    callService: CallService;
    currentUserId?: string;
    participants?: CallParticipant[];
  } = $props();

  let localVideo: HTMLVideoElement | undefined = $state();
  let remoteVideo: HTMLVideoElement | undefined = $state();

  let callState = $state<CallState>('idle');
  let remoteStreamsMap = $state<Map<string, MediaStream>>(new Map());
  let remoteStreamVal = $state<MediaStream | null>(null);
  let localStreamVal = $state<MediaStream | null>(null);
  let isMuted = $state(false);
  let isVideoOff = $state(false);
  let e2eActive = $state(true);
  /** Whether audio is routed through the speaker (true) or earpiece (false). Mobile only. */
  let isSpeakerOn = $state(true);

  $effect(() => {
    const unsubs = [
      callService.callState.subscribe((v) => (callState = v)),
      callService.remoteStreams.subscribe((v) => (remoteStreamsMap = v)),
      callService.remoteStream.subscribe((v) => (remoteStreamVal = v)),
      callService.localStreamStore.subscribe((v) => (localStreamVal = v)),
      callService.isMuted.subscribe((v) => (isMuted = v)),
      callService.isVideoOff.subscribe((v) => (isVideoOff = v)),
      callService.e2eActive.subscribe((v) => (e2eActive = v)),
    ];
    return () => unsubs.forEach((u) => u());
  });

  let remoteEntries = $derived([...remoteStreamsMap.entries()]);

  /** Whether a remote stream currently carries a live video track. */
  function hasVideoForStream(stream: MediaStream): boolean {
    return !!pickActiveVideoTrack(stream);
  }

  /** Prefer a live, unmuted video track (renegotiation can leave older tracks in the stream). */
  function pickActiveVideoTrack(stream: MediaStream): MediaStreamTrack | undefined {
    const tracks = stream.getVideoTracks();
    return (
      tracks.find((t) => t.readyState === 'live' && !t.muted) ??
      tracks.find((t) => t.readyState === 'live') ??
      tracks[tracks.length - 1]
    );
  }

  let primaryRemoteStream = $derived.by(() => {
    for (const [, stream] of remoteStreamsMap) {
      if (pickActiveVideoTrack(stream)) return stream;
    }
    return remoteStreamVal;
  });
  /** True only when a remote peer is actually sending video (vs audio-only). */
  let remoteHasVideo = $derived.by(() => {
    for (const [, stream] of remoteStreamsMap) {
      if (pickActiveVideoTrack(stream)) return true;
    }
    return false;
  });
  /** Any remote stream, used to keep audio playing while showing an avatar (audio-only). */
  let anyRemoteStream = $derived.by(() => {
    if (primaryRemoteStream) return primaryRemoteStream;
    for (const [, stream] of remoteStreamsMap) return stream;
    return remoteStreamVal;
  });
  /** Connected audio-only call: a remote stream is flowing but carries no video. */
  let remoteAudioConnected = $derived(
    callState === 'incall' && !remoteHasVideo && !!anyRemoteStream
  );
  /** Any video in play (local sending or remote receiving). */
  let hasAnyVideo = $derived(remoteHasVideo || !isVideoOff);
  /** User explicitly collapsed the call to the docked widget. */
  let userMinimized = $state(false);
  /** Timestamp (ms) when the call connected (set on incall transition). */
  let callStartTime = $state<number | null>(null);
  /** Elapsed seconds since callStartTime, updated every second. */
  let callElapsedSec = $state(0);
  /**
   * Compact, non-blocking widget mode: used for audio-only calls (so the user can
   * keep navigating the app, a la Messenger/Discord) and whenever the user minimizes.
   * Incoming rings and the calling state always use the prominent expanded prompt.
   * Ended state also shows expanded briefly for the summary.
   */
  let compact = $derived(
    callState !== 'incoming' &&
      callState !== 'calling' &&
      callState !== 'ended' &&
      (userMinimized || !hasAnyVideo)
  );
  let primaryParticipant = $derived(participants[0]);
  let isGroupCall = $derived(participants.length > 1);
  /** Grid only for multi-party; audio+video from one peer stay on a single tile. */
  let showRemoteGrid = $derived(isGroupCall && remoteEntries.length > 1);

  /** Whether the platform supports speaker/earpiece toggling (mobile via setSinkId). */
  let speakerSupported = $derived(
    typeof navigator !== 'undefined' &&
      'mediaDevices' in navigator &&
      typeof AudioContext !== 'undefined'
  );
  /** True on mobile Tauri runtime (Android / iOS). */
  let isMobileRtc = $derived(isMobileTauriRuntime());

  /** Formats elapsed seconds as mm:ss. */
  function formatDuration(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /** Chronometer: starts when connected, persists through ended state, resets on idle. */
  let callDurationDisplay = $derived(formatDuration(callElapsedSec));

  $effect(() => {
    if (callState === 'incall' || callState === 'ended') {
      if (callStartTime === null) {
        callStartTime = Date.now();
        callElapsedSec = 0;
      }
      const timer = setInterval(() => {
        if (callStartTime !== null) {
          callElapsedSec = Math.floor((Date.now() - callStartTime) / 1000);
        }
      }, 1000);
      return () => clearInterval(timer);
    } else {
      callStartTime = null;
      callElapsedSec = 0;
    }
  });

  let pipEl: HTMLElement | undefined = $state();
  let pipOffsetX = $state(0);
  let pipOffsetY = $state(0);
  let isDragging = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;
  let initialOffsetX = 0;
  let initialOffsetY = 0;

  /** Builds a display stream with the newest live video track + live audio. */
  function streamForDisplay(stream: MediaStream): MediaStream {
    const out = new MediaStream();
    const video = pickActiveVideoTrack(stream);
    if (video) out.addTrack(video);
    for (const audio of stream.getAudioTracks()) {
      if (audio.readyState === 'live') out.addTrack(audio);
    }
    return out;
  }

  function bindRemoteVideo(stream: MediaStream, el: HTMLVideoElement) {
    const display = streamForDisplay(stream);
    el.srcObject = display;
    const play = () => void el.play().catch(() => {});
    play();
    for (const track of display.getTracks()) {
      track.onunmute = () => play();
    }
    return () => {
      for (const track of display.getTracks()) {
        track.onunmute = null;
      }
      el.srcObject = null;
    };
  }

  $effect(() => {
    if (remoteHasVideo && primaryRemoteStream && remoteVideo) {
      return bindRemoteVideo(primaryRemoteStream, remoteVideo);
    }
  });

  // Keep remote audio playing through a hidden sink whenever no on-screen video
  // element is carrying it: audio-only remote, or the compact (minimized) widget.
  let remoteAudioSink: HTMLAudioElement | undefined = $state();
  $effect(() => {
    if (anyRemoteStream && remoteAudioSink && (compact || !remoteHasVideo)) {
      remoteAudioSink.srcObject = anyRemoteStream;
      void remoteAudioSink.play().catch(() => {});
    }
  });

  /** Routes remote audio to speaker or earpiece on mobile. Best-effort. */
  async function applySpeakerRouting() {
    if (!remoteAudioSink || !speakerSupported) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const kind = isSpeakerOn ? 'speaker' : 'earpiece';
      const target = devices.find(
        (d) => d.kind === 'audiooutput' && d.label.toLowerCase().includes(kind)
      );
      if (target && 'setSinkId' in remoteAudioSink) {
        await (
          remoteAudioSink as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> }
        ).setSinkId(target.deviceId);
      }
    } catch {
      /* setSinkId not supported or permission denied - ignore */
    }
  }

  $effect(() => {
    if (isSpeakerOn !== undefined && remoteAudioSink) {
      void applySpeakerRouting();
    }
  });

  function toggleSpeaker() {
    isSpeakerOn = !isSpeakerOn;
  }

  $effect(() => {
    if (localStreamVal && localVideo && !isVideoOff) {
      localVideo.srcObject = localStreamVal;
      void localVideo.play().catch(() => {});
    }
  });

  function handlePipPointerDown(e: PointerEvent) {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    initialOffsetX = pipOffsetX;
    initialOffsetY = pipOffsetY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePipPointerMove(e: PointerEvent) {
    if (!isDragging) return;
    let nextX = initialOffsetX + (e.clientX - dragStartX);
    let nextY = initialOffsetY + (e.clientY - dragStartY);

    // Confine the self-view to its call container (8px inset) so it can't be
    // dragged off-screen or under the controls.
    const parent = pipEl?.offsetParent as HTMLElement | null;
    if (pipEl && parent) {
      const pr = pipEl.getBoundingClientRect();
      const cr = parent.getBoundingClientRect();
      const baseLeft = pr.left - pipOffsetX; // element box at offset 0
      const baseTop = pr.top - pipOffsetY;
      const minX = cr.left + 8 - baseLeft;
      const maxX = cr.right - 8 - (baseLeft + pr.width);
      const minY = cr.top + 8 - baseTop;
      const maxY = cr.bottom - 8 - (baseTop + pr.height);
      nextX = Math.min(Math.max(nextX, minX), maxX);
      nextY = Math.min(Math.max(nextY, minY), maxY);
    }
    pipOffsetX = nextX;
    pipOffsetY = nextY;
  }

  function handlePipPointerUp(e: PointerEvent) {
    isDragging = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  /** Native (out-of-browser) Picture-in-Picture for the remote video. */
  let pipSupported = $derived(
    typeof document !== 'undefined' && !!document.pictureInPictureEnabled
  );

  async function togglePictureInPicture() {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (remoteVideo) {
        await remoteVideo.requestPictureInPicture();
      }
    } catch {
      /* user gesture / unsupported - ignore */
    }
  }

  let isFullscreen = $state(false);

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      isFullscreen = true;
    } else {
      document.exitFullscreen().catch(() => {});
      isFullscreen = false;
    }
  }

  $effect(() => {
    const handleFullscreenChange = () => {
      isFullscreen = !!document.fullscreenElement;
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  });

  /** Binds a MediaStream to a video element (Svelte action). */
  function attachStream(node: HTMLVideoElement, stream: MediaStream) {
    node.srcObject = stream;
    return {
      update(next: MediaStream) {
        node.srcObject = next;
      },
      destroy() {
        node.srcObject = null;
      },
    };
  }

  function endCall() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    callService.endCall();
  }

  /** Participant for a remote video tile (by index; SFU does not expose user ids on tracks). */
  function participantForIndex(index: number): CallParticipant | undefined {
    return participants[index];
  }
</script>

{#snippet callAvatar(userId: string, displayName: string, sizeClass: string)}
  <div class="relative flex items-center justify-center {sizeClass}">
    <div class="absolute inset-0 bg-white/10 rounded-full animate-ping opacity-60"></div>
    <div
      class="relative rounded-full overflow-hidden ring-2 ring-white/25 shadow-xl bg-black/30 w-full h-full"
    >
      <Avatar {userId} fill shape="circle" fallbackLabel={displayName} />
    </div>
  </div>
{/snippet}

{#snippet participantLabel(participant: CallParticipant)}
  <div
    class="flex items-center gap-2 bg-black/50 backdrop-blur-md px-2.5 py-1.5 rounded-full border border-white/10 text-white text-sm font-semibold max-w-full"
  >
    <div class="w-7 h-7 rounded-full overflow-hidden shrink-0 ring-1 ring-white/20">
      <Avatar
        userId={participant.userId}
        fill
        shape="circle"
        fallbackLabel={participant.displayName}
      />
    </div>
    <UserName
      userId={participant.userId}
      fallback={participant.displayName}
      link={false}
      class="truncate"
    />
  </div>
{/snippet}

{#snippet e2eBadge(small: boolean)}
  {#if e2eActive}
    <span
      class="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 font-bold text-emerald-300 {small
        ? 'px-1.5 py-0.5 text-[10px]'
        : 'px-2 py-1 text-xs'}"
      title={m.call_e2e_encrypted_title()}
    >
      <ShieldCheck size={small ? 12 : 14} strokeWidth={2.5} />
      {#if !small}{m.call_encrypted_label()}{/if}
    </span>
  {:else}
    <span
      class="inline-flex items-center gap-1 rounded-full bg-amber-500/20 font-bold text-amber-300 {small
        ? 'px-1.5 py-0.5 text-[10px]'
        : 'px-2 py-1 text-xs'}"
      title={m.call_not_e2e_encrypted_title()}
    >
      <ShieldAlert size={small ? 12 : 14} strokeWidth={2.5} />
      {m.call_not_e2e_encrypted_label()}
    </span>
  {/if}
{/snippet}

{#if compact}
  <!-- Docked, non-blocking widget: the rest of the app stays interactive. -->
  <div
    class="fixed bottom-4 right-4 z-[300] w-[min(20rem,calc(100vw-2rem))] rounded-3xl bg-[#0a0d14]/95 backdrop-blur-2xl shadow-2xl ring-1 ring-white/10 p-4 select-none"
    transition:fly={{ y: 30, duration: 250 }}
  >
    <audio bind:this={remoteAudioSink} autoplay class="hidden"></audio>

    <!-- Compact self-view PiP when camera is active (P8) -->
    {#if localStreamVal && !isVideoOff}
      <div
        class="absolute -top-2 -right-2 z-20 w-16 h-20 rounded-xl overflow-hidden shadow-lg ring-1 ring-white/20 bg-black/60"
        transition:scale={{ duration: 300, start: 0.8 }}
      >
        <video
          autoplay
          playsinline
          muted
          class="w-full h-full object-cover -scale-x-100"
          srcObject={localStreamVal}
        ></video>
        {#if isMuted}
          <div
            class="absolute top-1 right-1 bg-red-500/80 backdrop-blur-md p-0.5 rounded-full text-white"
          >
            <MicOff size={10} strokeWidth={2.5} />
          </div>
        {/if}
      </div>
    {/if}

    <div class="flex items-center gap-3">
      <div class="relative h-12 w-12 shrink-0">
        <span
          class="absolute -right-0.5 -top-0.5 z-10 h-3 w-3 rounded-full ring-2 ring-[#0a0d14] {callState ===
          'incall'
            ? 'bg-emerald-400'
            : 'bg-amber-400 animate-pulse'}"
        ></span>
        <div class="h-full w-full overflow-hidden rounded-full ring-1 ring-white/20">
          {#if isGroupCall}
            <div
              class="flex h-full w-full items-center justify-center bg-white/10 text-white font-bold"
            >
              {participants.length}
            </div>
          {:else if primaryParticipant}
            <Avatar
              userId={primaryParticipant.userId}
              fill
              shape="circle"
              fallbackLabel={primaryParticipant.displayName}
            />
          {/if}
        </div>
      </div>
      <div class="min-w-0 flex-1">
        {#if isGroupCall}
          <p class="truncate text-sm font-bold text-white">
            {m.call_participants_count({ participants: participants.length })}
          </p>
        {:else if primaryParticipant}
          <UserName
            userId={primaryParticipant.userId}
            fallback={primaryParticipant.displayName}
            link={false}
            class="block truncate text-sm font-bold text-white"
          />
        {:else}
          <p class="truncate text-sm font-bold text-white">{m.call_label()}</p>
        {/if}
        <p class="truncate text-xs font-medium text-white/55">
          {#if callState === 'ended'}
            <span class="text-red-300">{m.call_ended_label()}</span> · {callDurationDisplay}
          {:else if remoteAudioConnected}
            {m.call_audio_only_label()}
          {:else if callState === 'calling'}
            {m.call_calling_label()}
          {:else if callState === 'incall'}
            {m.call_connected_label()}
          {:else}
            {m.call_connecting_label()}
          {/if}
        </p>
      </div>
      <div class="shrink-0">{@render e2eBadge(true)}</div>
      <button
        class="rounded-full p-2 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
        onclick={() => (userMinimized = false)}
        title={m.call_expand_label()}
        aria-label={m.call_expand_call_label()}
      >
        <Maximize2 size={18} />
      </button>
    </div>

    <div class="mt-3 flex items-center justify-center gap-2">
      <button
        class="rounded-full p-3 transition-all {isMuted
          ? 'bg-white text-[#151B2C]'
          : 'bg-white/10 text-white hover:bg-white/20'}"
        onclick={() => callService.toggleMute()}
        aria-label={isMuted ? m.call_unmute_label() : m.call_mute_label()}
      >
        {#if isMuted}<MicOff size={20} />{:else}<Mic size={20} />{/if}
      </button>
      {#if isMobileRtc && speakerSupported}
        <button
          class="rounded-full p-3 transition-all {isSpeakerOn
            ? 'bg-white/10 text-white hover:bg-white/20'
            : 'bg-white text-[#151B2C]'}"
          onclick={toggleSpeaker}
          aria-label={isSpeakerOn ? m.call_speaker_label() : m.call_earpiece_label()}
        >
          {#if isSpeakerOn}<Speaker size={20} />{:else}<Volume2 size={20} />{/if}
        </button>
      {/if}
      <button
        class="rounded-full bg-white/10 p-3 text-white transition-all hover:bg-white/20"
        onclick={() => {
          userMinimized = false;
          void callService.toggleVideo();
        }}
        title={m.call_enable_video_label()}
        aria-label={m.call_enable_camera_label()}
      >
        <Video size={20} />
      </button>
      <button
        class="rounded-full bg-red-500 p-3 text-white transition-all hover:bg-red-400 hover:scale-105"
        onclick={endCall}
        aria-label={m.call_hang_up_label()}
      >
        <PhoneOff size={20} />
      </button>
    </div>
  </div>
{:else}
  <!-- Expanded / full-screen call view -->
  <div
    class="fixed inset-0 z-[300] bg-black/90 backdrop-blur-2xl flex flex-col items-center justify-center select-none {isMobileRtc
      ? 'p-0'
      : 'p-4 sm:p-6'}"
    transition:fade={{ duration: 300 }}
  >
    <div
      class="relative w-full h-full {isMobileRtc
        ? 'max-w-full max-h-full rounded-none'
        : 'max-w-6xl max-h-[82vh] rounded-[2rem]'} bg-[#0a0d14] overflow-hidden shadow-2xl ring-1 ring-white/10 flex flex-col transition-all duration-300"
      style={isMobileRtc
        ? 'padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px);'
        : ''}
    >
      {#if callState === 'ended'}
        <!-- Ended summary: brief overlay showing the call result (P4) -->
        <div class="flex flex-col items-center justify-center gap-6 text-white/70 flex-1 px-6">
          <div
            class="w-20 h-20 rounded-full bg-red-500/20 flex items-center justify-center ring-4 ring-red-500/30"
          >
            <PhoneOff size={36} class="text-red-400" />
          </div>
          <div class="flex flex-col items-center gap-2 text-center">
            <p class="text-xl font-bold text-white">{m.call_ended_label()}</p>
            <p class="text-sm font-mono tabular-nums text-white/60">{callDurationDisplay}</p>
          </div>
          {#if primaryParticipant}
            <div class="flex flex-col items-center gap-2">
              <p class="text-xs text-white/40 uppercase tracking-widest">
                {m.call_with_label()}
              </p>
              <UserName
                userId={primaryParticipant.userId}
                fallback={primaryParticipant.displayName}
                link={false}
                class="text-white font-semibold"
              />
            </div>
          {/if}
        </div>
      {:else if showRemoteGrid}
        <div
          class="w-full h-full grid gap-1 p-1 {remoteEntries.length <= 4
            ? 'grid-cols-2'
            : 'grid-cols-3'}"
        >
          {#each remoteEntries as [key, stream], index (key)}
            {@const participant = participantForIndex(index)}
            {@const tileHasVideo = hasVideoForStream(stream)}
            <div
              class="relative w-full h-full min-h-[120px] bg-black/40 rounded-xl overflow-hidden"
            >
              <!-- Kept mounted even without video so the tile's audio keeps playing;
                 hidden behind the avatar when the member is audio-only. -->
              <video
                use:attachStream={stream}
                autoplay
                playsinline
                class="w-full h-full object-cover {tileHasVideo ? '' : 'opacity-0'}"
              ></video>
              {#if !tileHasVideo && participant}
                <div class="absolute inset-0 flex items-center justify-center">
                  {@render callAvatar(participant.userId, participant.displayName, 'w-20 h-20')}
                </div>
              {/if}
              {#if participant}
                <div class="absolute bottom-2 left-2 right-2 z-10">
                  {@render participantLabel(participant)}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {:else if remoteHasVideo && primaryRemoteStream}
        <div class="relative w-full h-full flex-1 min-h-0">
          <video bind:this={remoteVideo} autoplay playsinline class="w-full h-full object-cover"
          ></video>
          {#if primaryParticipant}
            <!-- Bottom-left to avoid the top-left status badge and the bottom-right self PiP. -->
            <div class="absolute bottom-4 left-4 z-10 max-w-[60%]">
              {@render participantLabel(primaryParticipant)}
            </div>
          {/if}
        </div>
      {:else if participants.length > 0}
        <!-- Audio-only remote or calling state: hidden sink keeps the voice playing behind the avatar. -->
        <audio bind:this={remoteAudioSink} autoplay class="hidden"></audio>
        <div class="flex flex-col items-center justify-center gap-8 text-white/70 flex-1 px-6">
          {#if isGroupCall}
            <div
              class="grid gap-8 w-full max-w-lg {participants.length === 2
                ? 'grid-cols-2'
                : participants.length <= 4
                  ? 'grid-cols-2'
                  : 'grid-cols-3'}"
            >
              {#each participants as participant (participant.userId)}
                <div class="flex flex-col items-center gap-3">
                  {@render callAvatar(
                    participant.userId,
                    participant.displayName,
                    'w-24 h-24 sm:w-28 sm:h-28'
                  )}
                  <UserName
                    userId={participant.userId}
                    fallback={participant.displayName}
                    link={false}
                    class="text-white font-bold text-center text-sm sm:text-base"
                  />
                </div>
              {/each}
            </div>
          {:else if primaryParticipant}
            {@render callAvatar(
              primaryParticipant.userId,
              primaryParticipant.displayName,
              'w-28 h-28 sm:w-32 sm:h-32'
            )}
            <div class="flex flex-col items-center gap-2 text-center">
              <UserName
                userId={primaryParticipant.userId}
                fallback={primaryParticipant.displayName}
                link={false}
                class="text-xl font-bold text-white tracking-wide"
              />
            </div>
          {/if}
          <p
            class="text-sm font-medium text-white/60 tracking-widest uppercase text-center {remoteAudioConnected
              ? ''
              : 'animate-pulse'}"
          >
            {#if remoteAudioConnected}
              {m.call_audio_only_label()}
            {:else if callState === 'calling'}
              {m.call_calling_label()}
            {:else if callState === 'incall'}
              {m.call_waiting_for_remote_label()}
            {:else}
              {m.call_connecting_label()}
            {/if}
          </p>
        </div>
      {:else}
        <!-- No participants yet: show calling/connecting with call type indicator (P1) -->
        <div class="flex flex-col items-center justify-center gap-6 text-white/70 flex-1 px-6">
          {#if callState === 'calling'}
            <div
              class="w-20 h-20 rounded-full bg-white/10 flex items-center justify-center ring-4 ring-white/10 animate-pulse"
            >
              <Phone size={36} class="text-white/60" />
            </div>
            <p class="text-lg font-bold text-white">{m.call_outgoing_label()}</p>
          {/if}
          <p class="animate-pulse text-sm font-medium text-white/60 tracking-widest uppercase">
            {callState === 'calling' ? m.call_calling_label() : m.call_connecting_label()}
          </p>
        </div>
      {/if}

      {#if localStreamVal || currentUserId}
        <div
          class="absolute bottom-6 right-6 z-20 pointer-events-none"
          transition:scale={{ duration: 400, start: 0.8, delay: 200 }}
        >
          <div
            bind:this={pipEl}
            role="button"
            aria-label={m.call_move_pip_label()}
            tabindex="0"
            onpointerdown={handlePipPointerDown}
            onpointermove={handlePipPointerMove}
            onpointerup={handlePipPointerUp}
            onpointercancel={handlePipPointerUp}
            class="w-32 h-48 md:w-48 md:h-72 bg-black/60 rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/20 backdrop-blur-md pointer-events-auto touch-none {isDragging
              ? 'cursor-grabbing scale-105'
              : 'cursor-grab hover:scale-[1.02]'}"
            style="transform: translate({pipOffsetX}px, {pipOffsetY}px);"
          >
            {#if localStreamVal && !isVideoOff}
              <video
                bind:this={localVideo}
                autoplay
                playsinline
                muted
                class="w-full h-full object-cover -scale-x-100"
              ></video>
            {:else if currentUserId}
              <div class="w-full h-full flex items-center justify-center bg-[#0a0d14]">
                <div
                  class="w-20 h-20 md:w-28 md:h-28 rounded-full overflow-hidden ring-2 ring-white/20"
                >
                  <Avatar
                    userId={currentUserId}
                    fill
                    shape="circle"
                    fallbackLabel={m.call_you_label()}
                  />
                </div>
              </div>
            {/if}
            {#if isMuted}
              <div
                class="absolute top-3 right-3 bg-red-500/80 backdrop-blur-md p-1.5 rounded-full text-white"
              >
                <MicOff size={14} strokeWidth={2.5} />
              </div>
            {/if}
            <div class="absolute bottom-2 left-2 right-2 flex justify-center pointer-events-none">
              <span
                class="text-[10px] font-bold uppercase tracking-wider text-white/80 bg-black/40 px-2 py-0.5 rounded-full"
                >{m.call_you_label()}</span
              >
            </div>
          </div>
        </div>
      {/if}

      <!-- Top-left status badge -->
      <div
        class="absolute top-6 left-6 bg-black/40 backdrop-blur-md px-4 py-2 rounded-full text-white/90 text-sm font-bold border border-white/10 flex items-center gap-3 z-10"
      >
        <span
          class="w-2.5 h-2.5 rounded-full {callState === 'incall'
            ? 'bg-emerald-400'
            : callState === 'ended'
              ? 'bg-red-400'
              : 'bg-amber-400 animate-pulse'}"
        ></span>
        {#if currentUserId}
          <div class="w-8 h-8 rounded-full overflow-hidden shrink-0 ring-1 ring-white/20">
            <Avatar userId={currentUserId} fill shape="circle" fallbackLabel={m.call_you_label()} />
          </div>
        {/if}
        {callState === 'calling'
          ? m.call_outgoing_label()
          : callState === 'incoming'
            ? m.call_incoming_label()
            : callState === 'ended'
              ? m.call_ended_label()
              : m.call_online_label()}
        {#if callState === 'incall' || callState === 'ended'}
          <span class="text-white/70 font-mono tabular-nums ml-1">{callDurationDisplay}</span>
        {/if}
        {#if remoteEntries.length > 1}
          <span class="text-white/60 font-normal"
            >· {m.call_participants_count({ participants: remoteEntries.length + 1 })}</span
          >
        {:else if primaryParticipant}
          <UserName
            userId={primaryParticipant.userId}
            fallback={primaryParticipant.displayName}
            link={false}
            class="text-white/90 font-bold truncate max-w-[10rem] sm:max-w-xs"
          />
        {/if}
      </div>

      <!-- End-to-end encryption status (top-right, clear of the caller name and self PiP). -->
      <div class="absolute top-6 right-6 z-10">
        {@render e2eBadge(false)}
      </div>
    </div>

    <!-- Bottom control bar -->
    <div
      class="{isMobileRtc
        ? 'mb-[env(safe-area-inset-bottom,12px)]'
        : 'mt-6'} flex items-center gap-3 sm:gap-4 bg-white/10 backdrop-blur-2xl px-6 sm:px-8 py-4 rounded-full border border-white/20 shadow-2xl"
      transition:fly={{ y: 40, duration: 500, delay: 100 }}
    >
      {#if callState === 'incoming'}
        <div class="flex flex-col items-center gap-1">
          <button
            class="p-4 sm:p-5 rounded-full bg-emerald-500 hover:bg-emerald-400 text-white transition-all hover:scale-110 active:scale-95"
            onclick={() =>
              callService.acceptCall(
                callService.currentGroupId ?? '',
                callService.currentCallId ?? ''
              )}
            title={m.call_accept_label()}
            aria-label={m.call_accept_incoming_label()}
          >
            <Phone size={28} class="fill-current" />
          </button>
          <span class="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider"
            >{m.call_accept_label()}</span
          >
        </div>
        <div class="flex flex-col items-center gap-1">
          <button
            class="p-4 sm:p-5 rounded-full bg-red-500 hover:bg-red-400 text-white transition-all hover:scale-110 active:scale-95"
            onclick={endCall}
            title={m.call_decline_label()}
            aria-label={m.call_decline_incoming_label()}
          >
            <PhoneOff size={28} />
          </button>
          <span class="text-[10px] font-semibold text-red-400 uppercase tracking-wider"
            >{m.call_decline_label()}</span
          >
        </div>
      {:else if callState === 'ended'}
        <!-- Ended state: only a dismiss button (P4) -->
        <button
          class="p-4 sm:p-5 rounded-full bg-white/10 text-white transition-all hover:bg-white/20 hover:scale-105"
          onclick={() => callService.endCall()}
          aria-label={m.call_close_label()}
        >
          <PhoneOff size={28} />
        </button>
      {:else}
        <button
          class="p-4 rounded-full transition-all {isMuted
            ? 'bg-white text-[#151B2C]'
            : 'bg-white/10 text-white hover:bg-white/20'}"
          onclick={() => callService.toggleMute()}
          aria-label={isMuted ? m.call_unmute_label() : m.call_mute_label()}
        >
          {#if isMuted}<MicOff size={24} />{:else}<Mic size={24} />{/if}
        </button>
        {#if isMobileRtc && speakerSupported}
          <button
            class="p-4 rounded-full transition-all {isSpeakerOn
              ? 'bg-white/10 text-white hover:bg-white/20'
              : 'bg-white text-[#151B2C]'}"
            onclick={toggleSpeaker}
            aria-label={isSpeakerOn ? m.call_speaker_label() : m.call_earpiece_label()}
          >
            {#if isSpeakerOn}<Speaker size={24} />{:else}<Volume2 size={24} />{/if}
          </button>
        {/if}
        <button
          class="p-4 rounded-full transition-all {isVideoOff
            ? 'bg-white text-[#151B2C]'
            : 'bg-white/10 text-white hover:bg-white/20'}"
          onclick={() => void callService.toggleVideo()}
          aria-label={isVideoOff ? m.call_enable_camera_label() : m.call_disable_camera_label()}
        >
          {#if isVideoOff}<VideoOff size={24} />{:else}<Video size={24} />{/if}
        </button>
        {#if remoteHasVideo && pipSupported}
          <button
            class="p-4 rounded-full hidden sm:block bg-white/10 text-white hover:bg-white/20"
            onclick={() => void togglePictureInPicture()}
            title={m.call_pip_label()}
            aria-label={m.call_open_pip_label()}
          >
            <PictureInPicture2 size={24} />
          </button>
        {/if}
        <button
          class="p-4 rounded-full bg-white/10 text-white hover:bg-white/20"
          onclick={() => (userMinimized = true)}
          title={m.call_minimize_label()}
          aria-label={m.call_minimize_call_label()}
        >
          <Minimize2 size={24} />
        </button>
        <button
          class="p-4 rounded-full hidden sm:block bg-white/10 text-white hover:bg-white/20"
          onclick={toggleFullscreen}
          aria-label={m.call_fullscreen_label()}
        >
          {#if isFullscreen}<Minimize size={24} />{:else}<Maximize size={24} />{/if}
        </button>
        <div class="w-px h-8 bg-white/20 mx-1"></div>
        <button
          class="p-4 sm:p-5 rounded-full bg-red-500 hover:bg-red-400 text-white transition-all hover:scale-110"
          onclick={endCall}
          aria-label={m.call_hang_up_label()}
        >
          <PhoneOff size={28} />
        </button>
      {/if}
    </div>
  </div>
{/if}
