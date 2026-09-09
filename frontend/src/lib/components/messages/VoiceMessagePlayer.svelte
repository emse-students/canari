<script lang="ts">
  import { Pause, Play, Download } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import {
    barCountForWidth,
    computeWaveformPeaks,
    mixToMono,
    resampleBars,
  } from '$lib/utils/audio/waveform';

  interface Props {
    /** Audio source URL (object URL or remote URL) to load and play. */
    src: string;
    /** Called when the user clicks the download button. Omit to hide the button. */
    onDownload?: () => void;
  }

  let { src, onDownload }: Props = $props();

  let audioEl = $state<HTMLAudioElement | null>(null);
  let isPlaying = $state(false);
  let duration = $state(0);
  let currentTime = $state(0);
  let speed = $state(1);
  let lastDurationToken = 0;
  /** Set to true when the browser cannot decode the audio format (e.g. webm on iOS). */
  let cannotPlay = $state(false);

  /**
   * The resolution the peaks are STORED at, which is not the number of bars drawn.
   *
   * Decoding is expensive and happens once; the strip is re-bucketed from this array on every
   * resize, which is a loop over 64 numbers. It is the ceiling `barCountForWidth` can ask for, so a
   * very wide bubble draws every stored peak and never interpolates one it does not have.
   */
  const PEAK_RESOLUTION = 64;
  /**
   * The height a silent bar is still drawn at, as a fraction of the strip.
   *
   * It lives here and NOT in `computeWaveformPeaks`, because the peaks are data and this is
   * presentation: a pause between two sentences really is silence, and the strip shows a thin
   * continuous line through it rather than a gap that reads as the end of the message.
   */
  const BAR_FLOOR = 0.16;
  /** Bar heights in 0..1, or empty until the decode lands (or for ever, where it cannot run). */
  let peaks = $state<number[]>([]);
  /**
   * The strip's own width, which DECIDES the bar count - see `barCountForWidth` for the two
   * measurements that made a fixed count untenable. `clientWidth` is 0 before the first layout, and
   * the clamp inside that helper is what makes that first frame legal rather than empty.
   */
  let stripWidth = $state(0);
  const barCount = $derived(barCountForWidth(stripWidth));
  /**
   * The resting strip, drawn while the decode is in flight and wherever it cannot run at all.
   *
   * Flat and obviously flat: it must not be mistaken for a real waveform, which is why it is not a
   * plausible-looking generated shape. It keeps the control the same size and in the same place, so
   * nothing moves under the finger when the real peaks arrive.
   */
  const bars = $derived(
    peaks.length > 0 ? resampleBars(peaks, barCount) : Array.from({ length: barCount }, () => 0)
  );
  /** Fraction of the recording already played, 0..1 - the split between the two bar colours. */
  const playedFraction = $derived(duration > 0 ? Math.min(1, currentTime / duration) : 0);

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

  /**
   * ONE DECODE ANSWERS BOTH QUESTIONS. The decode was already here for the duration - a
   * `MediaRecorder` webm carries none in its header - and the samples it produces are exactly what
   * the waveform is drawn from, so the strip costs no second fetch and no second decode.
   */
  async function decodeSource(source: string, token: number) {
    try {
      const response = await fetch(source);
      const buffer = await response.arrayBuffer();
      const AudioContextCtor =
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) {
        console.warn('[voice] no AudioContext - duration comes from the container, no waveform');
        return;
      }

      const audioContext = new AudioContextCtor();
      try {
        const decoded = await audioContext.decodeAudioData(buffer.slice(0));
        // A newer source has been requested while this decode ran; its own call owns the state.
        if (token !== lastDurationToken) return;
        if (Number.isFinite(decoded.duration) && decoded.duration > 0) {
          duration = decoded.duration;
          currentTime = Math.min(currentTime, decoded.duration);
        }
        peaks = computeWaveformPeaks(mixToMono(decoded), PEAK_RESOLUTION);
      } finally {
        void audioContext.close();
      }
    } catch (e) {
      // NOT A FALLBACK, A CAPABILITY. Safari cannot decode opus-in-webm at all, so this branch is
      // the ordinary case on iOS rather than a failure to repair - the container's own duration
      // still drives the timer and the strip draws its resting shape. It is logged because it also
      // catches a genuinely corrupt blob, and those two must not be one silence.
      console.warn(`[voice] could not decode ${src.slice(0, 48)} - no waveform:`, e);
    }
  }

  $effect(() => {
    const source = src;
    lastDurationToken += 1;
    const token = lastDurationToken;
    duration = 0;
    currentTime = 0;
    isPlaying = false;
    cannotPlay = false;
    peaks = [];
    if (!source) return;
    void decodeSource(source, token);
  });
</script>

<div
  class="relative flex w-full min-w-[200px] items-center gap-3.5 rounded-2xl border border-black/5 bg-black/5 px-3.5 py-3 transition-colors sm:min-w-[240px] dark:border-white/10 dark:bg-white/10"
>
  <audio
    bind:this={audioEl}
    {src}
    preload="auto"
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
    onerror={() => {
      isPlaying = false;
      cannotPlay = true;
    }}
    class="hidden"
  ></audio>

  {#if cannotPlay}
    <!-- Format audio non supporté (ex : webm sur iOS) -->
    <div class="flex min-w-0 flex-1 items-center gap-2 opacity-70">
      <span class="text-xs font-medium">{m.msg_audio_format_unsupported_label()}</span>
      {#if onDownload}
        <button
          type="button"
          onclick={(e) => {
            e.stopPropagation();
            onDownload?.();
          }}
          class="text-xs font-bold underline"
          aria-label={m.msg_download_voice_message_label()}>{m.common_download_label()}</button
        >
      {/if}
    </div>
  {:else}
    <!-- Bouton Play/Pause -->
    <button
      type="button"
      onclick={(e) => {
        e.stopPropagation();
        togglePlay();
      }}
      class="text-cn-ink inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-amber-500 shadow-md transition-all outline-none hover:scale-105 hover:bg-amber-400 focus-visible:ring-4 focus-visible:ring-amber-500/40 active:scale-95"
      aria-label={isPlaying ? m.msg_pause_voice_message_label() : m.msg_play_voice_message_label()}
    >
      {#if isPlaying}
        <Pause size={18} strokeWidth={2.5} />
      {:else}
        <Play size={18} strokeWidth={2.5} class="ml-1" />
      {/if}
    </button>

    <!--
      THE WAVEFORM, AND THE SLIDER IS STILL A REAL `input[type=range]` UNDERNEATH IT.

      The bars are the visual and carry no interaction at all (`pointer-events-none`); the control
      is a transparent native range stretched over them. That is not a trick to save code - it is
      what keeps dragging, tapping, arrow keys, Home/End, the screen-reader value announcement and
      the touch target correct without any of them being re-implemented, which is where a
      hand-rolled scrubber loses a user who cannot use a pointer. The input comes FIRST in the DOM
      so the bars can wear its focus ring as a `peer`.
    -->
    <div class="flex min-w-0 flex-1 flex-col justify-center gap-1.5 pt-1">
      <div class="relative h-8 w-full" bind:clientWidth={stripWidth}>
        <input
          type="range"
          min="0"
          max={Math.max(duration, 1)}
          step="0.01"
          value={Math.min(currentTime, duration || 0)}
          onclick={(e) => e.stopPropagation()}
          oninput={(e) => seekTo((e.currentTarget as HTMLInputElement).value)}
          class="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 outline-none"
          aria-label={m.msg_playback_position_label()}
        />
        <div
          class="pointer-events-none flex h-full w-full items-center gap-[2px] rounded-lg peer-focus-visible:ring-2 peer-focus-visible:ring-amber-500/50"
          aria-hidden="true"
        >
          {#each bars as bar, index (index)}
            {@const played = (index + 1) / bars.length <= playedFraction}
            <div
              class="min-w-0 flex-1 rounded-full transition-colors duration-150 {played
                ? 'bg-amber-500'
                : 'bg-black/20 dark:bg-white/25'}"
              style="height: {Math.round((BAR_FLOOR + (1 - BAR_FLOOR) * bar) * 100)}%"
            ></div>
          {/each}
        </div>
      </div>
      <div class="text-2xs flex items-center justify-between font-bold opacity-70">
        <span>{formatTime(currentTime)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  {/if}

  <!-- Actions (Vitesse et Téléchargement) - masquées si format non supporté -->
  <div class="flex shrink-0 items-center gap-0.5" class:hidden={cannotPlay}>
    <button
      type="button"
      onclick={(e) => {
        e.stopPropagation();
        cycleSpeed();
      }}
      class="text-2xs inline-flex h-9 w-9 items-center justify-center rounded-full font-bold opacity-70 transition-all outline-none hover:bg-black/10 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-current dark:hover:bg-white/10"
      aria-label={m.msg_playback_speed_label({ speed: String(speed) })}
      title={m.msg_change_speed_title()}
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
        class="inline-flex h-9 w-9 items-center justify-center rounded-full opacity-70 transition-all outline-none hover:bg-black/10 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-current dark:hover:bg-white/10"
        aria-label={m.msg_download_voice_message_label()}
        title={m.common_download_label()}
      >
        <Download size={16} strokeWidth={2.5} />
      </button>
    {/if}
  </div>
</div>
