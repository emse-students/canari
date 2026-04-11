<script lang="ts">
  import { Pause, Play, Download } from 'lucide-svelte';

  interface Props {
    src: string;
    onDownload?: () => void;
  }

  let { src, onDownload }: Props = $props();

  let audioEl = $state<HTMLAudioElement | null>(null);
  let isPlaying = $state(false);
  let duration = $state(0);
  let currentTime = $state(0);
  let speed = $state(1);
  let lastDurationToken = 0;

  function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60)
      .toString()
      .padStart(2, '0');
    return `${mins}:${secs}`;
  }

  function togglePlay() {
    if (!audioEl) return;
    if (isPlaying) {
      audioEl.pause();
    } else {
      void audioEl.play();
    }
  }

  function seekTo(value: string) {
    if (!audioEl) return;
    const next = Number(value);
    if (Number.isFinite(next)) {
      audioEl.currentTime = next;
      currentTime = next;
    }
  }

  function cycleSpeed() {
    if (!audioEl) return;
    const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
    speed = next;
    audioEl.playbackRate = next;
  }

  async function decodeDurationFromSource(source: string, token: number) {
    try {
      const response = await fetch(source);
      const buffer = await response.arrayBuffer();
      const AudioContextCtor =
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return;

      const audioContext = new AudioContextCtor();
      try {
        const decoded = await audioContext.decodeAudioData(buffer.slice(0));
        if (
          token === lastDurationToken &&
          Number.isFinite(decoded.duration) &&
          decoded.duration > 0
        ) {
          duration = decoded.duration;
          currentTime = Math.min(currentTime, decoded.duration);
        }
      } finally {
        void audioContext.close();
      }
    } catch {
      // Keep metadata duration if decode fails.
    }
  }

  $effect(() => {
    const source = src;
    lastDurationToken += 1;
    const token = lastDurationToken;
    duration = 0;
    currentTime = 0;
    isPlaying = false;
    if (!source) return;
    void decodeDurationFromSource(source, token);
  });
</script>

<div
  class="relative flex items-center gap-3.5 rounded-[1.25rem] border border-black/5 dark:border-white/10 bg-black/5 dark:bg-white/10 backdrop-blur-md px-3.5 py-3 w-full min-w-[200px] sm:min-w-[240px] transition-colors"
>
  <audio
    bind:this={audioEl}
    {src}
    preload="metadata"
    onloadedmetadata={() => {
      const metadataDuration = audioEl?.duration ?? 0;
      if (Number.isFinite(metadataDuration) && metadataDuration > 0 && metadataDuration < 60 * 60) {
        duration = metadataDuration;
      }
    }}
    ontimeupdate={() => {
      currentTime = audioEl?.currentTime ?? 0;
    }}
    onplay={() => {
      isPlaying = true;
    }}
    onpause={() => {
      isPlaying = false;
    }}
    onended={() => {
      isPlaying = false;
    }}
    class="hidden"
  ></audio>

  <!-- Bouton Play/Pause -->
  <button
    type="button"
    onclick={(e) => {
      e.stopPropagation();
      togglePlay();
    }}
    class="shrink-0 w-11 h-11 rounded-full bg-amber-500 text-[#151B2C] inline-flex items-center justify-center shadow-md hover:bg-amber-400 hover:scale-105 active:scale-95 transition-all outline-none focus-visible:ring-4 focus-visible:ring-amber-500/40"
    aria-label={isPlaying ? 'Mettre en pause' : 'Lire le message vocal'}
  >
    {#if isPlaying}
      <Pause size={18} strokeWidth={2.5} />
    {:else}
      <Play size={18} strokeWidth={2.5} class="ml-1" />
    {/if}
  </button>

  <!-- Section de la Timeline (Slider) -->
  <div class="flex-1 min-w-0 flex flex-col justify-center gap-1.5 pt-1">
    <input
      type="range"
      min="0"
      max={Math.max(duration, 1)}
      step="0.01"
      value={Math.min(currentTime, duration || 0)}
      onclick={(e) => e.stopPropagation()}
      oninput={(e) => seekTo((e.currentTarget as HTMLInputElement).value)}
      class="w-full h-1.5 rounded-full accent-amber-500 bg-black/10 dark:bg-white/20 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
      aria-label="Position de lecture"
    />
    <div class="text-[0.65rem] font-bold opacity-70 flex items-center justify-between">
      <span>{formatTime(currentTime)}</span>
      <span>{formatTime(duration)}</span>
    </div>
  </div>

  <!-- Actions (Vitesse et Téléchargement) -->
  <div class="flex items-center gap-0.5 shrink-0">
    <button
      type="button"
      onclick={(e) => {
        e.stopPropagation();
        cycleSpeed();
      }}
      class="w-9 h-9 rounded-full inline-flex items-center justify-center text-[0.7rem] font-bold opacity-70 hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10 transition-all outline-none focus-visible:ring-2 focus-visible:ring-current"
      aria-label={`Vitesse de lecture actuelle: x${speed}`}
      title="Changer la vitesse"
    >
      x{speed}
    </button>

    {#if onDownload}
      <button
        type="button"
        onclick={(e) => {
          e.stopPropagation();
          onDownload?.();
        }}
        class="w-9 h-9 rounded-full inline-flex items-center justify-center opacity-70 hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10 transition-all outline-none focus-visible:ring-2 focus-visible:ring-current"
        aria-label="Télécharger le message vocal"
        title="Télécharger"
      >
        <Download size={16} strokeWidth={2.5} />
      </button>
    {/if}
  </div>
</div>
