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
  let playerWidth = $derived.by(() => {
    const seconds = Number.isFinite(duration) ? duration : 0;
    const clamped = Math.min(Math.max(seconds, 3), 75);
    const rem = 11 + clamped * 0.17;
    return `${Math.min(rem, 23)}rem`;
  });

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
      const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return;

      const audioContext = new AudioContextCtor();
      try {
        const decoded = await audioContext.decodeAudioData(buffer.slice(0));
        if (token === lastDurationToken && Number.isFinite(decoded.duration) && decoded.duration > 0) {
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
  class="rounded-2xl border border-black/10 bg-white/70 px-3 py-2 max-w-[min(80vw,23rem)]"
  style={`width:${playerWidth}`}
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

  <div class="flex items-center gap-2">
    <button
      type="button"
      onclick={(e) => {
        e.stopPropagation();
        togglePlay();
      }}
      class="w-8 h-8 rounded-full bg-cn-dark text-cn-yellow inline-flex items-center justify-center"
      aria-label={isPlaying ? 'Pause' : 'Lecture'}
    >
      {#if isPlaying}
        <Pause size={14} />
      {:else}
        <Play size={14} class="ml-0.5" />
      {/if}
    </button>

    <div class="flex-1 min-w-0">
      <input
        type="range"
        min="0"
        max={Math.max(duration, 1)}
        step="0.01"
        value={Math.min(currentTime, duration || 0)}
        onclick={(e) => e.stopPropagation()}
        oninput={(e) => seekTo((e.currentTarget as HTMLInputElement).value)}
        class="w-full accent-[var(--cn-yellow)]"
        aria-label="Position de lecture"
      />
      <div class="text-[0.68rem] opacity-70 flex items-center justify-between mt-0.5">
        <span>{formatTime(currentTime)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>

    <button
      type="button"
      onclick={(e) => {
        e.stopPropagation();
        cycleSpeed();
      }}
      class="px-2 py-1 rounded-lg bg-black/10 text-[0.65rem] font-semibold"
      aria-label="Vitesse de lecture"
    >
      x{speed}
    </button>

    <button
      type="button"
      onclick={(e) => {
        e.stopPropagation();
        onDownload?.();
      }}
      class="w-7 h-7 rounded-full bg-black/10 text-cn-dark inline-flex items-center justify-center"
      aria-label="Telecharger le vocal"
    >
      <Download size={13} />
    </button>
  </div>
</div>
