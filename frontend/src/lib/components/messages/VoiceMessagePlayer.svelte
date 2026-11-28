<script lang="ts">
  import { Pause, Play, Download } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import { arbitratePlayback } from '$lib/actions/playbackArbiter';
  import { isAppOnScreen } from '$lib/utils/appForeground';
  import {
    loudnessAudio,
    VOICE_NOTE_LOUDNESS_LAW,
    type LoudnessHandle,
  } from '$lib/video/loudnessPlayback';
  import type { MediaLoudness } from '$lib/video/loudnessMeter';
  import { m } from '$lib/paraglide/messages';
  import {
    forgetVoicePosition,
    recallVoicePosition,
    rememberVoicePosition,
    scrubTimeAt,
    scrubTimeForKey,
  } from '$lib/utils/audio/scrub';
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
    /**
     * The type the message declares for these bytes. Only the refusal line reads it: asked of the
     * engine through `canPlayType`, it separates "this engine cannot play that format" from "the
     * bytes behind the URL are not what the message declares".
     */
    mimeType?: string;
    /**
     * The note's sound as its author's device measured it at send (`MediaRef.loudness`,
     * `recordingLoudness.ts`): brought toward one loudness through the voice-note law (-16 LUFS, +12 dB
     * at most, owner 2026-11-22) and the same route as a video's (`loudnessPlayback.ts`). Absent - every note sent before this,
     * an unmeasurable recording, the composer's own preview - plays exactly as it always did.
     */
    loudness?: MediaLoudness | null;
    /**
     * The attachment this note is (`MediaRef.mediaId`). Where the note stands is kept under it
     * (`rememberVoicePosition`), so a player rebuilt for the same attachment - whatever tore the
     * first down - picks up at the same second instead of starting over. Absent: nothing is kept
     * (the composer's own preview).
     */
    resumeKey?: string;
  }

  let { src, onDownload, mimeType = '', loudness = null, resumeKey = '' }: Props = $props();

  /** `MediaError.code` as a word, so a log line names its cause without a lookup table. */
  const MEDIA_ERROR_NAMES: Record<number, string> = {
    1: 'aborted',
    2: 'network',
    3: 'decode',
    4: 'src-not-supported',
  };

  /**
   * THE ONE BRANCH THAT DRAWS "FORMAT NON SUPPORTE", AND IT USED TO SAY NOTHING. The `<audio>`
   * element's `error` event is the only evidence of why a voice note is refused, and four causes
   * reach it - a revoked or unreadable blob URL, a decode failure, an unknown container, an abort.
   * Two voice notes showed the label on the Mi 9T while an iPhone listed them (2026-10-06), and no
   * line said which cause it was. This one carries what separates them: the code, the engine's own
   * message, the declared type and whether the engine says it can play that type at all.
   */
  function reportRefusal(element: HTMLAudioElement | null) {
    const error = element?.error ?? null;
    const code = error?.code ?? 0;
    console.warn('[voice] the audio element refused its source - shown as format unsupported', {
      code,
      cause: MEDIA_ERROR_NAMES[code] ?? 'unknown',
      message: error?.message ?? '',
      declaredType: mimeType || '(none)',
      canPlayType: mimeType && element ? element.canPlayType(mimeType) || 'no' : '(not asked)',
      source: src.slice(0, 48),
    });
  }

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

  // THE VIDEO'S ROUTE, NOT A SECOND ONE: the wiring lives as long as the ELEMENT (an element takes
  // one source node in its life), the measurement is applied keyed on its two NUMBERS. A voice note
  // is a decrypted BLOB, never a stream, so it is routed on WebKit too (`streamed: false`).
  let loudnessHandle: LoudnessHandle | null = null;
  $effect(() => {
    if (!audioEl) return;
    const handle = loudnessAudio.attach(audioEl, { streamed: false, law: VOICE_NOTE_LOUDNESS_LAW });
    loudnessHandle = handle;
    return () => {
      handle.destroy();
      if (loudnessHandle === handle) loudnessHandle = null;
    };
  });
  const loudnessLufs = $derived(loudness?.integratedLufs);
  const loudnessPeak = $derived(loudness?.samplePeakDbfs);
  $effect(() => {
    const integratedLufs = loudnessLufs;
    const samplePeakDbfs = loudnessPeak;
    if (!audioEl) return;
    untrack(() => loudnessHandle)?.setLoudness(
      integratedLufs === undefined || samplePeakDbfs === undefined
        ? null
        : { integratedLufs, samplePeakDbfs }
    );
  });

  function togglePlay() {
    if (!audioEl) return;
    if (isPlaying) {
      audioEl.pause();
    } else {
      // The play tap is the gesture WebKit honours a `resume()` in - made before `play()`. When one
      // was asked, `play()` waits for its answer: the route is then built at the note's gain on its
      // first `play`, and the first syllable is never heard at the uncorrected level (review of
      // #3394). Nothing asked (an old note, a context already running) or nothing worth waiting on
      // (a context `interrupted` or closed, which takes the volume fallback): played in this turn.
      const primed = loudnessHandle?.prime() ?? null;
      if (primed) {
        void primed.then(() => {
          // The resume answered after the app left the screen: nobody is there to hear the note,
          // and starting it would hold the output the leave just released.
          if (!isAppOnScreen()) {
            console.debug('[voice] the resume answered off screen - the note is not started');
            return;
          }
          startPlayback(audioEl);
        });
      } else startPlayback(audioEl);
    }
  }

  function startPlayback(element: HTMLAudioElement | null) {
    element?.play().catch((err: unknown) => {
      console.warn('[voice] play() refused', {
        name: err instanceof Error ? err.name : String(err),
      });
    });
  }

  /** The scrubber's own element: its box is what a press position is measured against. */
  let stripEl = $state<HTMLDivElement | null>(null);
  /** A finger or mouse is down on the strip: the element's own `timeupdate` must not fight it. */
  let scrubbing = false;

  /** Moves the playhead - playing or paused, the note carries on from there. */
  function seekTo(seconds: number) {
    if (!audioEl || !(duration > 0)) return;
    const next = Math.min(duration, Math.max(0, seconds));
    audioEl.currentTime = next;
    currentTime = next;
    if (resumeKey) rememberVoicePosition(resumeKey, { time: next, playing: !audioEl.paused });
  }

  function seekToPointer(clientX: number) {
    if (!stripEl) return;
    seekTo(scrubTimeAt(clientX, stripEl.getBoundingClientRect(), duration));
  }

  function onScrubDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    scrubbing = true;
    try {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    } catch (err) {
      console.debug('[voice] pointer capture refused', err);
    }
    seekToPointer(e.clientX);
  }

  function onScrubMove(e: PointerEvent) {
    if (scrubbing) seekToPointer(e.clientX);
  }

  function onScrubEnd(e: PointerEvent) {
    if (!scrubbing) return;
    scrubbing = false;
    try {
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    } catch (err) {
      console.debug('[voice] pointer release refused', err);
    }
  }

  function onScrubKey(e: KeyboardEvent) {
    const next = scrubTimeForKey(e.key, currentTime, duration);
    // The bubble toggles its info on Enter and Space: no key typed on the scrubber reaches it.
    e.stopPropagation();
    if (next === null) return;
    e.preventDefault();
    seekTo(next);
  }

  /**
   * WHERE THE NOTE WAS LEFT comes back once the element knows its length (a seek before the
   * metadata is refused by the engine), and only once per source. See `rememberVoicePosition`.
   */
  let restoredFor = '';
  function restoreRemembered(element: HTMLAudioElement) {
    if (!resumeKey || restoredFor === src) return;
    restoredFor = src;
    const left = recallVoicePosition(resumeKey);
    if (!left) return;
    console.debug(
      `[voice] ${resumeKey.slice(0, 8)} rebuilt - back to ${left.time.toFixed(1)}s${left.playing ? ', playing' : ''}`
    );
    element.currentTime = left.time;
    currentTime = left.time;
    if (left.playing) startPlayback(element);
  }

  // The element's last word goes to memory when it is torn down, whatever tore it down.
  $effect(() => {
    const element = audioEl;
    const key = resumeKey;
    if (!element || !key) return;
    return () => {
      if (element.ended) forgetVoicePosition(key);
      else rememberVoicePosition(key, { time: element.currentTime, playing: !element.paused });
    };
  });

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
      // AN OFFLINE CONTEXT, BECAUSE DECODING NEEDS NO SPEAKER. A realtime `AudioContext` opens a
      // platform output stream the moment it is built - one per voice note on screen, held until
      // `close()` - and the app holds no audio output while it is not playing something
      // (`toneOutput.ts`). An `OfflineAudioContext` renders to memory and never touches the device;
      // its 1-frame length is irrelevant, `decodeAudioData` returns the whole file at any length.
      if (typeof OfflineAudioContext === 'undefined') {
        console.warn(
          '[voice] no OfflineAudioContext - duration comes from the container, no waveform'
        );
        return;
      }
      const decoder = new OfflineAudioContext(1, 1, 48_000);
      const decoded = await decoder.decodeAudioData(buffer.slice(0));
      // A newer source has been requested while this decode ran; its own call owns the state.
      if (token !== lastDurationToken) return;
      if (Number.isFinite(decoded.duration) && decoded.duration > 0) {
        duration = decoded.duration;
        currentTime = Math.min(currentTime, decoded.duration);
      }
      peaks = computeWaveformPeaks(mixToMono(decoded), PEAK_RESOLUTION);
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
  class="relative flex w-full min-w-0 items-center gap-3.5 rounded-2xl border border-black/5 bg-black/5 px-3.5 py-3 transition-colors dark:border-white/10 dark:bg-white/10"
>
  <audio
    bind:this={audioEl}
    use:arbitratePlayback
    {src}
    preload="auto"
    onloadedmetadata={() => {
      const metadataDuration = audioEl?.duration ?? 0;
      if (Number.isFinite(metadataDuration) && metadataDuration > 0 && metadataDuration < 60 * 60) {
        duration = metadataDuration;
      }
      if (audioEl) restoreRemembered(audioEl);
    }}
    ontimeupdate={() => {
      if (!scrubbing) currentTime = audioEl?.currentTime ?? 0;
    }}
    onplay={() => {
      isPlaying = true;
    }}
    onpause={() => {
      isPlaying = false;
    }}
    onended={() => {
      isPlaying = false;
      if (resumeKey) forgetVoicePosition(resumeKey);
    }}
    onerror={() => {
      reportRefusal(audioEl);
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
      class="text-on-accent bg-accent hover:bg-accent-hover focus-visible:ring-accent/40 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full shadow-md transition-all outline-none hover:scale-105 focus-visible:ring-4 active:scale-95"
      aria-label={isPlaying ? m.msg_pause_voice_message_label() : m.msg_play_voice_message_label()}
    >
      {#if isPlaying}
        <Pause size={18} strokeWidth={2.5} />
      {:else}
        <Play size={18} strokeWidth={2.5} class="ml-1" />
      {/if}
    </button>

    <!--
      THE WAVEFORM IS THE SCRUBBER: a `role="slider"` on pointer events, touch and mouse alike.

      It used to be a transparent native `input[type=range]` over the bars, and inside a bubble that
      cannot work: the bubble reads every press as its own - held, it opens the actions sheet; dragged
      sideways, it is a reply swipe whose `touchmove` claim cancels the stroke - so a finger on the
      waveform moved the message, not the playhead (owner, 1.8.2). `data-scrub` tells the bubble the
      press is the scrubber's (`pressOwnedByScrub`), `touch-action: none` keeps the engine from
      scrolling under a horizontal drag, and pointer capture keeps the drag when the finger leaves
      the strip. Arrow keys, Home and End are handled here and the value is announced through the
      `aria-value*` attributes - the two things the native input gave for free.
    -->
    <div class="flex min-w-0 flex-1 flex-col justify-center gap-1.5 pt-1">
      <div
        bind:this={stripEl}
        bind:clientWidth={stripWidth}
        role="slider"
        tabindex="0"
        data-scrub
        aria-label={m.msg_playback_position_label()}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(Math.min(currentTime, duration || 0))}
        aria-valuetext={`${formatTime(currentTime)} / ${formatTime(duration)}`}
        onpointerdown={onScrubDown}
        onpointermove={onScrubMove}
        onpointerup={onScrubEnd}
        onpointercancel={onScrubEnd}
        onclick={(e) => e.stopPropagation()}
        onkeydown={onScrubKey}
        class="focus-visible:ring-accent/50 relative h-8 w-full cursor-pointer touch-none rounded-lg outline-none focus-visible:ring-2"
      >
        <div
          class="pointer-events-none flex h-full w-full items-center gap-[2px]"
          aria-hidden="true"
        >
          {#each bars as bar, index (index)}
            {@const played = (index + 1) / bars.length <= playedFraction}
            <div
              class="min-w-0 flex-1 rounded-full transition-colors duration-150 {played
                ? 'bg-accent'
                : 'bg-black/20 dark:bg-white/25'}"
              style="height: {Math.round((BAR_FLOOR + (1 - BAR_FLOOR) * bar) * 100)}%"
            ></div>
          {/each}
        </div>
      </div>
      <!--
        `gap-3` AND `shrink-0`, so the two stamps can never merge. `justify-between` alone pushes
        them apart when there is room and lets them meet when there is not, which is how "0:00" and
        "0:01" came to read as one number. The gap is a floor the flexbox must honour, and
        `tabular-nums` stops the elapsed side from twitching as its digits change width.
      -->
      <div
        class="text-2xs flex items-center justify-between gap-3 font-bold tabular-nums opacity-70"
      >
        <span class="shrink-0">{formatTime(currentTime)}</span>
        <span class="shrink-0">{formatTime(duration)}</span>
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
