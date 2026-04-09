<script lang="ts">
  import { CallService } from '$lib/services/CallService';
  import { Mic, MicOff, PhoneOff, Video, VideoOff, Phone } from 'lucide-svelte';
  import { fade, scale } from 'svelte/transition';

  let {
    callService,
    remoteName = 'Utilisateur',
  }: {
    callService: CallService;
    remoteName?: string;
  } = $props();

  let remoteVideo: HTMLVideoElement | undefined = $state();
  let localVideo: HTMLVideoElement | undefined = $state();

  let callState = $derived(callService.callState);
  let remoteStream = $derived(callService.remoteStream);
  let localStream = $derived(callService.localStreamStore);
  let isMuted = $derived(callService.isMuted);
  let isVideoOff = $derived(callService.isVideoOff);

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
    callService.endCall();
  }
</script>

<div
  class="fixed inset-0 z-[100] bg-black/80 backdrop-blur-xl flex flex-col items-center justify-center p-4 sm:p-6"
  transition:fade={{ duration: 300 }}
>
  <!-- Remote Video (Main Container) -->
  <div
    class="relative w-full h-full max-w-5xl max-h-[85vh] bg-gray-900/80 rounded-3xl overflow-hidden shadow-2xl ring-1 ring-white/10 flex flex-col items-center justify-center"
  >
    {#if $remoteStream}
      <video
        bind:this={remoteVideo}
        autoplay
        playsinline
        class="w-full h-full object-cover"
      ></video>
    {:else}
      <!-- Placeholder Premium en attendant la connexion -->
      <div class="flex flex-col items-center justify-center gap-6 text-white/70">
        <div class="relative flex items-center justify-center">
          <!-- Animation d'onde (ping) en arrière-plan -->
          <div class="absolute inset-0 bg-white/10 rounded-full animate-ping opacity-75"></div>

          <div class="relative w-28 h-28 rounded-full bg-white/10 border border-white/20 flex items-center justify-center backdrop-blur-sm shadow-xl">
            <span class="text-4xl font-bold tracking-wider text-white">
              {remoteName.slice(0, 2).toUpperCase()}
            </span>
          </div>
        </div>
        <p class="animate-pulse text-lg font-medium tracking-wide">
          {$callState === 'calling' ? 'Appel en cours...' : 'Connexion en cours...'}
        </p>
      </div>
    {/if}

    <!-- Local Video (PIP - Picture in Picture) -->
    {#if $localStream}
      <div
        class="absolute bottom-6 right-6 w-32 h-48 md:w-48 md:h-72 bg-black/60 rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/20 backdrop-blur-md transition-transform hover:scale-[1.02]"
        transition:scale={{ duration: 400, start: 0.8 }}
      >
        <!-- L'attribut -scale-x-100 remplace la classe CSS .mirror -->
        <video
          bind:this={localVideo}
          autoplay
          playsinline
          muted
          class="w-full h-full object-cover -scale-x-100"
        ></video>
      </div>
    {/if}

    <!-- Status Badge -->
    <div
      class="absolute top-6 left-6 bg-black/40 backdrop-blur-md px-4 py-2 rounded-full text-white/90 text-sm font-medium border border-white/10 flex items-center gap-3 shadow-lg"
    >
      <span
        class="w-2.5 h-2.5 rounded-full {$callState === 'incall'
          ? 'bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]'
          : 'bg-amber-400 animate-pulse shadow-[0_0_8px_rgba(251,191,36,0.6)]'}"
      ></span>
      {$callState === 'calling'
        ? 'Appel en cours...'
        : $callState === 'incoming'
          ? 'Appel entrant...'
          : 'En ligne'}
    </div>
  </div>

  <!-- Floating Controls Dock -->
  <div class="mt-6 flex items-center gap-4 bg-black/40 backdrop-blur-xl px-8 py-4 rounded-[2rem] border border-white/10 shadow-2xl">
    {#if $callState === 'incoming'}
      <button
        class="p-4 rounded-full bg-green-500 hover:bg-green-400 text-white transition-all hover:scale-110 focus-visible:ring-4 focus-visible:ring-green-500/50 outline-none shadow-lg shadow-green-500/30"
        onclick={() =>
          callService.acceptCall(callService.currentGroupId ?? '', callService.currentCallId ?? '')}
        title="Accepter l'appel"
        aria-label="Accepter l'appel entrant"
      >
        <Phone size={28} class="fill-current" />
      </button>

      <button
        class="p-4 rounded-full bg-red-500 hover:bg-red-400 text-white transition-all hover:scale-110 focus-visible:ring-4 focus-visible:ring-red-500/50 outline-none shadow-lg shadow-red-500/30"
        onclick={endCall}
        title="Refuser"
        aria-label="Refuser l'appel"
      >
        <PhoneOff size={28} />
      </button>
    {:else}
      <button
        class="p-4 rounded-full transition-all duration-200 outline-none focus-visible:ring-4 {$isMuted
          ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 focus-visible:ring-red-500/50'
          : 'bg-white/10 text-white hover:bg-white/20 hover:-translate-y-1 focus-visible:ring-white/30'}"
        onclick={toggleMute}
        aria-label={$isMuted ? "Activer le micro" : "Couper le micro"}
      >
        {#if $isMuted}<MicOff size={26} />{:else}<Mic size={26} />{/if}
      </button>

      <!-- Bouton Raccrocher plus proéminent -->
      <button
        class="p-5 mx-2 rounded-full bg-red-500 hover:bg-red-400 text-white transition-all hover:scale-110 focus-visible:ring-4 focus-visible:ring-red-500/50 outline-none shadow-lg shadow-red-500/30"
        onclick={endCall}
        aria-label="Raccrocher"
      >
        <PhoneOff size={30} />
      </button>

      <button
        class="p-4 rounded-full transition-all duration-200 outline-none focus-visible:ring-4 {$isVideoOff
          ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 focus-visible:ring-red-500/50'
          : 'bg-white/10 text-white hover:bg-white/20 hover:-translate-y-1 focus-visible:ring-white/30'}"
        onclick={toggleVideo}
        aria-label={$isVideoOff ? "Activer la caméra" : "Couper la caméra"}
      >
        {#if $isVideoOff}<VideoOff size={26} />{:else}<Video size={26} />{/if}
      </button>
    {/if}
  </div>
</div>
