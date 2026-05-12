<script lang="ts">
  import { CallService } from '$lib/services/CallService';
  import { Mic, MicOff, PhoneOff, Video, VideoOff, Phone, Maximize, Minimize } from 'lucide-svelte';
  import { fade, scale, fly } from 'svelte/transition';

  let {
    callService,
    remoteName = 'Utilisateur',
  }: {
    /** The active CallService instance managing the WebRTC call. */
    callService: CallService;
    /** Display name of the remote participant shown while waiting for video. */
    remoteName?: string;
  } = $props();

  let remoteVideo: HTMLVideoElement | undefined = $state();
  let localVideo: HTMLVideoElement | undefined = $state();

  let callState = $derived(callService.callState);
  let remoteStream = $derived(callService.remoteStream);
  let localStream = $derived(callService.localStreamStore);
  let isMuted = $derived(callService.isMuted);
  let isVideoOff = $derived(callService.isVideoOff);

  // --- Gestion du PIP Déplaçable (Drag & Drop) ---
  let pipOffsetX = $state(0);
  let pipOffsetY = $state(0);
  let isDragging = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;
  let initialOffsetX = 0;
  let initialOffsetY = 0;

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
  // -----------------------------------------------

  // --- Gestion du Plein Écran ---
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
    // S'assurer que l'état se met à jour si l'utilisateur quitte avec la touche "Échap"
    const handleFullscreenChange = () => {
      isFullscreen = !!document.fullscreenElement;
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  });
  // ------------------------------

  $effect(() => {
    if ($remoteStream && remoteVideo) {
      remoteVideo.srcObject = $remoteStream;
    }
  });

  $effect(() => {
    if ($localStream && localVideo) {
      localVideo.srcObject = $localStream;
    }
  });

  function toggleMute() {
    callService.isMuted.update((m) => !m);
    const stream = $localStream;
    if (stream) {
      stream.getAudioTracks().forEach((t) => (t.enabled = !t.enabled));
    }
  }

  function toggleVideo() {
    callService.isVideoOff.update((v) => !v);
    const stream = $localStream;
    if (stream) {
      stream.getVideoTracks().forEach((t) => (t.enabled = !t.enabled));
    }
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
  <!-- Conteneur principal (Remote Video) -->
  <div
    class="relative w-full h-full max-w-6xl max-h-[82vh] bg-[#0a0d14] rounded-[2rem] overflow-hidden shadow-2xl ring-1 ring-white/10 flex flex-col items-center justify-center transition-all duration-300"
  >
    {#if $remoteStream}
      <video bind:this={remoteVideo} autoplay playsinline class="w-full h-full object-cover"
      ></video>
    {:else}
      <!-- Placeholder Premium en attendant la connexion -->
      <div class="flex flex-col items-center justify-center gap-6 text-white/70">
        <div class="relative flex items-center justify-center">
          <!-- Animation d'onde (ping) -->
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
          <p class="text-xl font-bold text-white tracking-wide">
            {remoteName}
          </p>
          <p class="animate-pulse text-sm font-medium text-white/60 tracking-widest uppercase">
            {$callState === 'calling' ? 'Appel en cours...' : 'Connexion en cours...'}
          </p>
        </div>
      </div>
    {/if}

    <!-- Local Video (PIP) - Enveloppe séparée pour la transition d'apparition -->
    {#if $localStream}
      <div
        class="absolute bottom-6 right-6 z-20 pointer-events-none"
        transition:scale={{ duration: 400, start: 0.8, delay: 200 }}
      >
        <!-- Élément déplaçable avec Drag & Drop -->
        <div
          role="button"
          aria-label="Déplacer votre retour vidéo"
          tabindex="0"
          onpointerdown={handlePipPointerDown}
          onpointermove={handlePipPointerMove}
          onpointerup={handlePipPointerUp}
          onpointercancel={handlePipPointerUp}
          class="w-32 h-48 md:w-48 md:h-72 bg-black/60 rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/20 backdrop-blur-md transition-shadow hover:shadow-[0_8px_30px_rgba(0,0,0,0.4)] pointer-events-auto touch-none {isDragging
            ? 'cursor-grabbing scale-105'
            : 'cursor-grab hover:scale-[1.02]'}"
          style="transform: translate({pipOffsetX}px, {pipOffsetY}px); transition: transform {isDragging
            ? '0s'
            : '0.2s cubic-bezier(0.2, 0.8, 0.2, 1)'}, box-shadow 0.2s, scale 0.2s;"
        >
          <!-- Vidéo miroir -->
          <video
            bind:this={localVideo}
            autoplay
            playsinline
            muted
            class="w-full h-full object-cover -scale-x-100 {isDragging
              ? 'opacity-80'
              : 'opacity-100'} transition-opacity"
          ></video>

          <!-- Indicateur de micro coupé pour soi-même -->
          {#if $isMuted}
            <div
              class="absolute top-3 right-3 bg-red-500/80 backdrop-blur-md p-1.5 rounded-full text-white shadow-sm border border-white/20"
            >
              <MicOff size={14} strokeWidth={2.5} />
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Badge de statut en haut à gauche -->
    <div
      class="absolute top-6 left-6 bg-black/40 backdrop-blur-md px-4 py-2 rounded-full text-white/90 text-sm font-bold tracking-wide border border-white/10 flex items-center gap-3 shadow-lg z-10"
    >
      <span
        class="w-2.5 h-2.5 rounded-full {$callState === 'incall'
          ? 'bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.6)]'
          : 'bg-amber-400 animate-pulse shadow-[0_0_12px_rgba(251,191,36,0.6)]'}"
      ></span>
      {$callState === 'calling'
        ? 'Appel sortant'
        : $callState === 'incoming'
          ? 'Appel entrant'
          : 'En ligne'}
    </div>
  </div>

  <!-- Dock de Contrôles Flottant -->
  <div
    class="mt-6 flex items-center gap-3 sm:gap-4 bg-white/10 dark:bg-black/40 backdrop-blur-2xl px-6 sm:px-8 py-4 rounded-full border border-white/20 shadow-2xl"
    transition:fly={{ y: 40, duration: 500, delay: 100, easing: (t) => t * (2 - t) }}
  >
    {#if $callState === 'incoming'}
      <button
        class="p-4 sm:p-5 rounded-full bg-emerald-500 hover:bg-emerald-400 text-white transition-all hover:scale-110 active:scale-95 focus-visible:ring-4 focus-visible:ring-emerald-500/50 outline-none shadow-lg shadow-emerald-500/30"
        onclick={() =>
          callService.acceptCall(callService.currentGroupId ?? '', callService.currentCallId ?? '')}
        title="Accepter l'appel"
        aria-label="Accepter l'appel entrant"
      >
        <Phone size={28} class="fill-current" />
      </button>

      <button
        class="p-4 sm:p-5 rounded-full bg-red-500 hover:bg-red-400 text-white transition-all hover:scale-110 active:scale-95 focus-visible:ring-4 focus-visible:ring-red-500/50 outline-none shadow-lg shadow-red-500/30"
        onclick={endCall}
        title="Refuser"
        aria-label="Refuser l'appel"
      >
        <PhoneOff size={28} />
      </button>
    {:else}
      <!-- Bouton Micro -->
      <button
        class="p-4 rounded-full transition-all duration-200 outline-none focus-visible:ring-4 active:scale-95 {$isMuted
          ? 'bg-white text-[#151B2C] hover:bg-gray-200 shadow-lg'
          : 'bg-white/10 text-white hover:bg-white/20 hover:-translate-y-0.5'}"
        onclick={toggleMute}
        aria-label={$isMuted ? 'Activer le micro' : 'Couper le micro'}
        title={$isMuted ? 'Activer le micro' : 'Couper le micro'}
      >
        {#if $isMuted}<MicOff size={24} strokeWidth={2.5} />{:else}<Mic
            size={24}
            strokeWidth={2.5}
          />{/if}
      </button>

      <!-- Bouton Caméra -->
      <button
        class="p-4 rounded-full transition-all duration-200 outline-none focus-visible:ring-4 active:scale-95 {$isVideoOff
          ? 'bg-white text-[#151B2C] hover:bg-gray-200 shadow-lg'
          : 'bg-white/10 text-white hover:bg-white/20 hover:-translate-y-0.5'}"
        onclick={toggleVideo}
        aria-label={$isVideoOff ? 'Activer la caméra' : 'Couper la caméra'}
        title={$isVideoOff ? 'Activer la caméra' : 'Couper la caméra'}
      >
        {#if $isVideoOff}<VideoOff size={24} strokeWidth={2.5} />{:else}<Video
            size={24}
            strokeWidth={2.5}
          />{/if}
      </button>

      <!-- Bouton Plein Écran -->
      <button
        class="p-4 rounded-full transition-all duration-200 outline-none focus-visible:ring-4 active:scale-95 hidden sm:block {isFullscreen
          ? 'bg-white/20 text-white'
          : 'bg-white/10 text-white hover:bg-white/20 hover:-translate-y-0.5'}"
        onclick={toggleFullscreen}
        aria-label={isFullscreen ? 'Quitter le plein écran' : 'Plein écran'}
        title={isFullscreen ? 'Quitter le plein écran' : 'Plein écran'}
      >
        {#if isFullscreen}<Minimize size={24} strokeWidth={2.5} />{:else}<Maximize
            size={24}
            strokeWidth={2.5}
          />{/if}
      </button>

      <!-- Séparateur visuel -->
      <div class="w-px h-8 bg-white/20 mx-1"></div>

      <!-- Bouton Raccrocher (Rouge) -->
      <button
        class="p-4 sm:p-5 rounded-full bg-red-500 hover:bg-red-400 text-white transition-all hover:scale-110 active:scale-95 focus-visible:ring-4 focus-visible:ring-red-500/50 outline-none shadow-lg shadow-red-500/30"
        onclick={endCall}
        aria-label="Raccrocher"
        title="Raccrocher"
      >
        <PhoneOff size={28} />
      </button>
    {/if}
  </div>
</div>
