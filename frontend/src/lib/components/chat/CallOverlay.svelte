<script lang="ts">
  import { CallService } from '$lib/services/CallService';
  import {
    Mic,
    MicOff,
    PhoneOff,
    Video,
    VideoOff,
    Phone,
    Maximize,
    Minimize,
  } from '@lucide/svelte';
  import { fade, scale, fly } from 'svelte/transition';

  let {
    callService,
    remoteName = 'Utilisateur',
  }: {
    callService: CallService;
    remoteName?: string;
  } = $props();

  let localVideo: HTMLVideoElement | undefined = $state();
  let remoteVideo: HTMLVideoElement | undefined = $state();

  let callState = $derived(callService.callState);
  let remoteStreams = $derived(callService.remoteStreams);
  let remoteStream = $derived(callService.remoteStream);
  let localStream = $derived(callService.localStreamStore);
  let isMuted = $derived(callService.isMuted);
  let isVideoOff = $derived(callService.isVideoOff);

  let remoteEntries = $derived([...$remoteStreams.entries()]);
  let primaryRemoteStream = $derived(
    remoteEntries.length > 0 ? remoteEntries[0][1] : $remoteStream
  );

  let pipOffsetX = $state(0);
  let pipOffsetY = $state(0);
  let isDragging = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;
  let initialOffsetX = 0;
  let initialOffsetY = 0;

  $effect(() => {
    if (primaryRemoteStream && remoteVideo) {
      remoteVideo.srcObject = primaryRemoteStream;
    }
  });

  $effect(() => {
    if ($localStream && localVideo) {
      localVideo.srcObject = $localStream;
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
    pipOffsetX = initialOffsetX + (e.clientX - dragStartX);
    pipOffsetY = initialOffsetY + (e.clientY - dragStartY);
  }

  function handlePipPointerUp(e: PointerEvent) {
    isDragging = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
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
</script>

<div
  class="fixed inset-0 z-[100] bg-black/90 backdrop-blur-2xl flex flex-col items-center justify-center p-4 sm:p-6 select-none"
  transition:fade={{ duration: 300 }}
>
  <div
    class="relative w-full h-full max-w-6xl max-h-[82vh] bg-[#0a0d14] rounded-[2rem] overflow-hidden shadow-2xl ring-1 ring-white/10 flex flex-col transition-all duration-300"
  >
    {#if remoteEntries.length > 1}
      <div
        class="w-full h-full grid gap-1 p-1 {remoteEntries.length <= 4
          ? 'grid-cols-2'
          : 'grid-cols-3'}"
      >
        {#each remoteEntries as [key, stream] (key)}
          <video
            use:attachStream={stream}
            autoplay
            playsinline
            class="w-full h-full object-cover bg-black/40 rounded-xl min-h-[120px]"
          ></video>
        {/each}
      </div>
    {:else if primaryRemoteStream}
      <video
        bind:this={remoteVideo}
        autoplay
        playsinline
        class="w-full h-full object-cover"
      ></video>
    {:else}
      <div class="flex flex-col items-center justify-center gap-6 text-white/70 flex-1">
        <div class="relative flex items-center justify-center">
          <div class="absolute inset-0 bg-white/10 rounded-full animate-ping opacity-75"></div>
          <div
            class="relative w-28 h-28 rounded-full bg-white/10 border border-white/20 flex items-center justify-center backdrop-blur-sm shadow-xl"
          >
            <span class="text-4xl font-bold tracking-wider text-white">
              {remoteName.slice(0, 2).toUpperCase()}
            </span>
          </div>
        </div>
        <div class="flex flex-col items-center gap-2">
          <p class="text-xl font-bold text-white tracking-wide">{remoteName}</p>
          <p class="animate-pulse text-sm font-medium text-white/60 tracking-widest uppercase">
            {$callState === 'calling' ? 'Appel en cours...' : 'Connexion en cours...'}
          </p>
        </div>
      </div>
    {/if}

    {#if $localStream}
      <div
        class="absolute bottom-6 right-6 z-20 pointer-events-none"
        transition:scale={{ duration: 400, start: 0.8, delay: 200 }}
      >
        <div
          role="button"
          aria-label="Déplacer votre retour vidéo"
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
          <video
            bind:this={localVideo}
            autoplay
            playsinline
            muted
            class="w-full h-full object-cover -scale-x-100"
          ></video>
          {#if $isMuted}
            <div
              class="absolute top-3 right-3 bg-red-500/80 backdrop-blur-md p-1.5 rounded-full text-white"
            >
              <MicOff size={14} strokeWidth={2.5} />
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <div
      class="absolute top-6 left-6 bg-black/40 backdrop-blur-md px-4 py-2 rounded-full text-white/90 text-sm font-bold border border-white/10 flex items-center gap-3 z-10"
    >
      <span
        class="w-2.5 h-2.5 rounded-full {$callState === 'incall'
          ? 'bg-emerald-400'
          : 'bg-amber-400 animate-pulse'}"
      ></span>
      {$callState === 'calling'
        ? 'Appel sortant'
        : $callState === 'incoming'
          ? 'Appel entrant'
          : 'En ligne'}
      {#if remoteEntries.length > 1}
        <span class="text-white/60 font-normal">· {remoteEntries.length + 1} participants</span>
      {/if}
    </div>
  </div>

  <div
    class="mt-6 flex items-center gap-3 sm:gap-4 bg-white/10 backdrop-blur-2xl px-6 sm:px-8 py-4 rounded-full border border-white/20 shadow-2xl"
    transition:fly={{ y: 40, duration: 500, delay: 100 }}
  >
    {#if $callState === 'incoming'}
      <button
        class="p-4 sm:p-5 rounded-full bg-emerald-500 hover:bg-emerald-400 text-white transition-all hover:scale-110 active:scale-95"
        onclick={() =>
          callService.acceptCall(
            callService.currentGroupId ?? '',
            callService.currentCallId ?? ''
          )}
        title="Accepter l'appel"
        aria-label="Accepter l'appel entrant"
      >
        <Phone size={28} class="fill-current" />
      </button>
      <button
        class="p-4 sm:p-5 rounded-full bg-red-500 hover:bg-red-400 text-white transition-all hover:scale-110 active:scale-95"
        onclick={endCall}
        title="Refuser"
        aria-label="Refuser l'appel"
      >
        <PhoneOff size={28} />
      </button>
    {:else}
      <button
        class="p-4 rounded-full transition-all {$isMuted
          ? 'bg-white text-[#151B2C]'
          : 'bg-white/10 text-white hover:bg-white/20'}"
        onclick={() => callService.toggleMute()}
        aria-label={$isMuted ? 'Activer le micro' : 'Couper le micro'}
      >
        {#if $isMuted}<MicOff size={24} />{:else}<Mic size={24} />{/if}
      </button>
      <button
        class="p-4 rounded-full transition-all {$isVideoOff
          ? 'bg-white text-[#151B2C]'
          : 'bg-white/10 text-white hover:bg-white/20'}"
        onclick={() => callService.toggleVideo()}
        aria-label={$isVideoOff ? 'Activer la caméra' : 'Couper la caméra'}
      >
        {#if $isVideoOff}<VideoOff size={24} />{:else}<Video size={24} />{/if}
      </button>
      <button
        class="p-4 rounded-full hidden sm:block bg-white/10 text-white hover:bg-white/20"
        onclick={toggleFullscreen}
        aria-label="Plein écran"
      >
        {#if isFullscreen}<Minimize size={24} />{:else}<Maximize size={24} />{/if}
      </button>
      <div class="w-px h-8 bg-white/20 mx-1"></div>
      <button
        class="p-4 sm:p-5 rounded-full bg-red-500 hover:bg-red-400 text-white transition-all hover:scale-110"
        onclick={endCall}
        aria-label="Raccrocher"
      >
        <PhoneOff size={28} />
      </button>
    {/if}
  </div>
</div>
