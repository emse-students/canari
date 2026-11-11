<script lang="ts">
  import { Volume2, VolumeX } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { onMount } from 'svelte';
  import { watchFineHover } from '$lib/utils/pointerDevice';
  import { videoSound } from '$lib/stores/videoSound.svelte';
  import VideoChipButton from './VideoChipButton.svelte';
  import VideoVolumeSlider from './VideoVolumeSlider.svelte';

  /**
   * THE SPEAKER - the one sound button of every video surface (owner, 2026-11-09: the four copies of
   * the feed, the bar, the reel rail and the live corner are this one). Always visible on a playing
   * video, so the tap-for-sound gesture is discoverable: Instagram keeps the same small speaker on
   * the bottom-right of a feed video.
   *
   * The state is the SHAPE (speaker with waves, speaker struck through) and `aria-pressed`; the sound-on
   * glyph alone wears the brand yellow, the only accent the player allows itself besides the played
   * part of a scrubber.
   */
  interface Props {
    muted: boolean;
    onToggle: () => void;
    /** Its own glass chip; off inside a glass bar. */
    glass?: boolean;
    /** A video with no sound to give (`soundScope="silent"`). */
    disabled?: boolean;
    /**
     * `rail`: the reel rail's - a bare 26px glyph beside the heart and the comments, the same
     * button rather than a fourth copy of it. Otherwise 16px in a chip, 20px in a bar.
     */
    rail?: boolean;
    /**
     * `quiet`: the feed card's - a bare 18px white glyph with a drop shadow, no chip, no yellow
     * (owner, 2026-11-10: Instagram's and CanaReels' minimal corner); the 44px target stays.
     */
    quiet?: boolean;
    /**
     * The volume slider's answer (a fraction, 0 is mute): given, the slider rises above the speaker
     * on hover and focus - ONLY under a mouse (`(hover: hover) and (pointer: fine)`); a phone keeps
     * its hardware buttons. The level shown is the app's one (`videoSound.level`).
     */
    onLevel?: (value: number) => void;
    class?: string;
    /** `data-*` markers of the call site. */
    [data: `data-${string}`]: unknown;
  }

  let {
    muted,
    onToggle,
    glass = true,
    disabled = false,
    rail = false,
    quiet = false,
    onLevel,
    class: klass = '',
    ...markers
  }: Props = $props();

  const glyphSize = $derived(rail ? 26 : quiet ? 18 : glass ? 16 : 20);
  const shadow = $derived(rail || quiet ? 'drop-shadow-md' : 'drop-shadow');
  /** Mounted after the first paint: SSR and a test with no `matchMedia` answer "no hover". */
  let fineHover = $state(false);
  let hovering = $state(false);
  let focused = $state(false);
  /** A thumb drag that leaves the pill (the pointer is captured) keeps it open until the release. */
  let dragging = false;
  let host: HTMLElement | null = $state(null);
  onMount(() => watchFineHover((v) => (fineHover = v)));
  const showSlider = $derived(fineHover && !!onLevel && !disabled);
  const open = $derived(hovering || focused);
  const accent = $derived(quiet ? '' : 'text-accent ');
</script>

{#snippet speaker(buttonClass: string)}
  <VideoChipButton
    label={m.video_sound_label()}
    title={rail ? m.video_sound_label() : undefined}
    pressed={!muted}
    onclick={onToggle}
    glass={glass && !rail && !quiet}
    {disabled}
    class={buttonClass}
    {...markers}
  >
    {#if muted}
      <VolumeX
        size={glyphSize}
        strokeWidth={rail ? 2 : 2.25}
        class={shadow}
        data-video-sound="off"
      />
    {:else}
      <Volume2
        size={glyphSize}
        strokeWidth={rail ? 2 : 2.25}
        class="{accent}{shadow}"
        data-video-sound="on"
      />
    {/if}
  </VideoChipButton>
{/snippet}

<svelte:window
  onpointerupcapture={() => {
    if (!dragging) return;
    dragging = false;
    hovering = host?.matches(':hover') ?? false;
  }}
/>

{#if showSlider}
  <!-- THE HOVER BRIDGE: the pill is a CHILD of the wrapper, flush against the speaker (padding, not a
       gap), so the pointer moving from one to the other never leaves the wrapper and nothing closes. -->
  <span
    class="relative inline-flex {klass}"
    role="group"
    bind:this={host}
    data-video-volume-host
    onpointerenter={() => (hovering = true)}
    onpointerleave={() => {
      if (!dragging) hovering = false;
    }}
    onfocusin={() => (focused = true)}
    onfocusout={(e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focused = false;
    }}
  >
    {@render speaker('')}
    <span
      class="absolute bottom-full left-1/2 z-30 -translate-x-1/2 pb-1 transition-opacity duration-150 motion-reduce:transition-none {open
        ? 'opacity-100'
        : 'pointer-events-none opacity-0'}"
      onpointerdowncapture={() => (dragging = true)}
      data-video-volume-popover={open ? 'open' : 'closed'}
    >
      <VideoVolumeSlider value={muted ? 0 : videoSound.level} onChange={(v) => onLevel?.(v)} />
    </span>
  </span>
{:else}
  {@render speaker(klass)}
{/if}
