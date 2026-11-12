<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import { videoGlass } from '$lib/utils/videoGlass';

  /**
   * THE VERTICAL VOLUME SLIDER that rises above the speaker under a mouse (owner, 2026-11-11, after
   * Instagram's web player): a slim rounded track in a dark glass pill. A REAL `<input type=range>`
   * - arrow keys, Home/End, `aria-valuetext` as a percentage - turned upright with `writing-mode`.
   *
   * It is never drawn on a touch screen (`VideoSoundButton` mounts it only under `(hover: hover) and
   * (pointer: fine)`). Every press, key and wheel turn on it stops here and carries
   * `data-video-controls`, so the player's tap (play/pause), its keyboard map, the reel's page turn
   * and the lightbox's zoom never see a gesture meant for the volume.
   */
  interface Props {
    /** 0 while muted, otherwise the level, both as a fraction in [0, 1]. */
    value: number;
    /** Called with a fraction in [0, 1] on every input tick; 0 is mute. */
    onChange: (value: number) => void;
    /** A gesture ended (release, a key step, a wheel notch): the moment to remember the level. */
    onCommit?: () => void;
    /**
     * Inside a glass bar: NO blur of its own (design-reference section 3, never two), the flat dark
     * tint instead.
     */
    flat?: boolean;
    class?: string;
  }

  let { value, onChange, onCommit, flat = false, class: klass = '' }: Props = $props();

  const percent = $derived(Math.round(value * 100));

  /** One wheel notch, as a fraction of the whole range. */
  const WHEEL_STEP = 0.05;

  /**
   * The wheel over the pill is the volume's: NON-PASSIVE and stopped HERE, so it neither pages the
   * reel, zooms the lightbox nor scrolls the feed behind it.
   */
  function wheelVolume(node: HTMLElement) {
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY === 0) return;
      onChange(Math.min(1, Math.max(0, value + (e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP))));
      onCommit?.();
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return { destroy: () => node.removeEventListener('wheel', onWheel) };
  }
</script>

<div
  class="flex items-center justify-center rounded-full px-2 py-3 {flat
    ? 'video-volume-flat'
    : 'glass-video'} {klass}"
  data-glass={flat ? 'flat' : videoGlass()}
  data-video-controls
  data-video-volume
  role="presentation"
  use:wheelVolume
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
    class="video-volume-range h-24 w-3"
    style="--video-volume-fill: {percent}%"
    oninput={(e) => onChange(Number(e.currentTarget.value) / 100)}
    onchange={() => onCommit?.()}
    onkeydown={(e) => {
      // EVERY key the range handles stays here (arrows, Home/End, digits, Space, m, f, k ...): the
      // player's keyboard map would otherwise seek, mute or pause behind it. Tab leaves, Escape
      // closes the pill (the speaker's wrapper handles it).
      if (e.key !== 'Tab' && e.key !== 'Escape') e.stopPropagation();
    }}
  />
</div>

<style>
  /* The flat pair of the glass (`--glass-video-flat-bg`): an opaque-ish dark pill, no blur. */
  .video-volume-flat {
    background: var(--glass-video-flat-bg);
    border: 1px solid var(--glass-video-edge);
  }
  /* Upright: the minimum at the bottom, the thumb moving up as the value grows. The input is as wide
     as the thumb so the thumb is never clipped; the 4px track is drawn on the track pseudo-element
     (WebKit, Firefox), which both centre in it. */
  .video-volume-range {
    writing-mode: vertical-lr;
    direction: rtl;
    appearance: none;
    background: transparent;
    cursor: pointer;
    margin: 0;
    outline-offset: 0.5rem;
  }
  .video-volume-range::-webkit-slider-runnable-track {
    width: 0.25rem;
    border-radius: 999px;
    background: linear-gradient(
      to top,
      white var(--video-volume-fill),
      rgb(255 255 255 / 0.3) var(--video-volume-fill)
    );
  }
  .video-volume-range::-moz-range-track {
    width: 0.25rem;
    border-radius: 999px;
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
    margin-left: -0.25rem;
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
</style>
