<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import { videoGlass } from '$lib/utils/videoGlass';

  /**
   * THE VERTICAL VOLUME SLIDER that rises above the speaker under a mouse (owner, 2026-11-11, after
   * Instagram's web player): a slim rounded track in a dark glass pill. A REAL `<input type=range>`
   * - arrow keys, Home/End, `aria-valuetext` as a percentage - turned upright with `writing-mode`.
   *
   * It is never drawn on a touch screen (`VideoSoundButton` mounts it only under `(hover: hover) and
   * (pointer: fine)`). Every press, key and click on it stops here and carries `data-video-controls`,
   * so the player's tap (play/pause), the hold and the reel's swipe never see a drag of the thumb.
   */
  interface Props {
    /** 0 while muted, otherwise the level, both as a fraction in [0, 1]. */
    value: number;
    /** Called with a fraction in [0, 1] on every input; 0 is mute. */
    onChange: (value: number) => void;
    class?: string;
  }

  let { value, onChange, class: klass = '' }: Props = $props();

  const percent = $derived(Math.round(value * 100));

  /** The keys the player maps to a seek or a mute: they belong to the slider while it has focus. */
  const OWN_KEYS = new Set([
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ]);
</script>

<div
  class="glass-video flex items-center justify-center rounded-full px-2 py-3 {klass}"
  data-glass={videoGlass()}
  data-video-controls
  data-video-volume
  role="presentation"
  onpointerdown={(e) => e.stopPropagation()}
  onpointerup={(e) => e.stopPropagation()}
  ontouchstart={(e) => e.stopPropagation()}
  onclick={(e) => e.stopPropagation()}
  ondblclick={(e) => e.stopPropagation()}
>
  <input
    type="range"
    min="0"
    max="100"
    step="1"
    value={percent}
    aria-label={m.video_volume_label()}
    aria-orientation="vertical"
    aria-valuetext={m.video_volume_valuetext({ percent })}
    class="video-volume-range h-24 w-1"
    style="--video-volume-fill: {percent}%"
    oninput={(e) => onChange(Number(e.currentTarget.value) / 100)}
    onkeydown={(e) => {
      if (OWN_KEYS.has(e.key)) e.stopPropagation();
    }}
  />
</div>

<style>
  /* Upright: the minimum at the bottom, the thumb moving up as the value grows. */
  .video-volume-range {
    writing-mode: vertical-lr;
    direction: rtl;
    appearance: none;
    cursor: pointer;
    border-radius: 999px;
    outline-offset: 0.5rem;
    background: linear-gradient(
      to top,
      white var(--video-volume-fill),
      rgb(255 255 255 / 0.3) var(--video-volume-fill)
    );
  }
  .video-volume-range::-webkit-slider-thumb {
    appearance: none;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 999px;
    background: white;
    box-shadow: 0 0 0.25rem rgb(0 0 0 / 0.4);
  }
  .video-volume-range::-moz-range-thumb {
    width: 0.75rem;
    height: 0.75rem;
    border: 0;
    border-radius: 999px;
    background: white;
    box-shadow: 0 0 0.25rem rgb(0 0 0 / 0.4);
  }
  .video-volume-range::-moz-range-track {
    background: transparent;
  }
</style>
