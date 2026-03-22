<script lang="ts">
  import { CallService } from '$lib/services/CallService';
  import { Mic, MicOff, PhoneOff, Video, VideoOff, Phone } from 'lucide-svelte';
  import { fade, scale } from 'svelte/transition';

  export let callService: CallService;
  export let remoteName: string = 'Utilisateur';

  let remoteVideo: HTMLVideoElement;
  let localVideo: HTMLVideoElement;

  const callState = callService.callState;
  const remoteStream = callService.remoteStream;
  const localStream = callService.localStreamStore;
  const isMuted = callService.isMuted;
  const isVideoOff = callService.isVideoOff;

  $: if ($remoteStream && remoteVideo) {
    remoteVideo.srcObject = $remoteStream;
  }

  $: if ($localStream && localVideo) {
    localVideo.srcObject = $localStream;
  }

  function toggleMute() {
    callService.isMuted.update((m) => !m);
    // Apply to tracks
    const stream = $localStream;
    if (stream) {
      stream.getAudioTracks().forEach((t) => (t.enabled = !t.enabled));
    }
  }

  function toggleVideo() {
    callService.isVideoOff.update((v) => !v);
    // Apply to tracks
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
  class="fixed inset-0 z-[100] bg-black/90 flex flex-col items-center justify-center p-4"
  transition:fade={{ duration: 200 }}
>
  <!-- Remote Video (Main) -->
  <div
    class="relative w-full h-full max-w-4xl max-h-[80vh] bg-gray-900 rounded-2xl overflow-hidden shadow-2xl"
  >
    {#if $remoteStream}
      <video bind:this={remoteVideo} autoplay playsinline class="w-full h-full object-cover"
      ></video>
    {:else}
      <div class="w-full h-full flex items-center justify-center flex-col gap-4 text-white/50">
        <div
          class="w-24 h-24 rounded-full bg-white/10 flex items-center justify-center animate-pulse"
        >
          <span class="text-4xl font-bold">{remoteName.slice(0, 2).toUpperCase()}</span>
        </div>
        <p class="animate-pulse">Connexion en cours...</p>
      </div>
    {/if}

    <!-- Local Video (PIP) -->
    {#if $localStream}
      <div
        class="absolute bottom-4 right-4 w-32 h-48 md:w-48 md:h-72 bg-black/50 rounded-xl overflow-hidden shadow-lg border border-white/20"
        transition:scale
      >
        <video
          bind:this={localVideo}
          autoplay
          playsinline
          muted
          class="w-full h-full object-cover mirror"
        ></video>
      </div>
    {/if}

    <!-- Status Badge -->
    <div
      class="absolute top-4 left-4 bg-black/40 backdrop-blur-md px-3 py-1 rounded-full text-white/80 text-sm font-medium border border-white/10 flex items-center gap-2"
    >
      <span
        class="w-2 h-2 rounded-full {$callState === 'incall'
          ? 'bg-green-500'
          : 'bg-amber-500 animate-pulse'}"
      ></span>
      {$callState === 'calling'
        ? 'Appel en cours...'
        : $callState === 'incoming'
          ? 'Appel entrant...'
          : 'En ligne'}
    </div>
  </div>

  <!-- Controls -->
  <div class="mt-8 flex items-center gap-6">
    {#if $callState === 'incoming'}
      <button
        class="p-4 rounded-full bg-green-500 hover:bg-green-600 text-white transition-transform hover:scale-105 shadow-lg shadow-green-500/30"
        on:click={() =>
          callService.acceptCall(callService.currentGroupId ?? '', callService.currentCallId ?? '')}
        title="Accepter l'appel"
      >
        <Phone size={32} />
      </button>

      <button
        class="p-4 rounded-full bg-red-500 hover:bg-red-600 text-white transition-transform hover:scale-105 shadow-lg shadow-red-500/30"
        on:click={endCall}
        title="Refuser"
      >
        <PhoneOff size={32} />
      </button>
    {:else}
      <button
        class="p-4 rounded-full transition-colors {$isMuted
          ? 'bg-red-500/20 text-red-500'
          : 'bg-white/10 text-white hover:bg-white/20'}"
        on:click={toggleMute}
      >
        {#if $isMuted}<MicOff size={24} />{:else}<Mic size={24} />{/if}
      </button>

      <button
        class="p-4 rounded-full bg-red-500 hover:bg-red-600 text-white transition-transform hover:scale-105 shadow-lg shadow-red-500/30"
        on:click={endCall}
      >
        <PhoneOff size={32} />
      </button>

      <button
        class="p-4 rounded-full transition-colors {$isVideoOff
          ? 'bg-red-500/20 text-red-500'
          : 'bg-white/10 text-white hover:bg-white/20'}"
        on:click={toggleVideo}
      >
        {#if $isVideoOff}<VideoOff size={24} />{:else}<Video size={24} />{/if}
      </button>
    {/if}
  </div>
</div>

<style>
  .mirror {
    transform: scaleX(-1);
  }
</style>
