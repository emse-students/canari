<script module lang="ts">
  /**
   * KEYBOARD MODALITY, ONE FOR EVERY SPEAKER: true after a Tab, false after a press. A speaker focused
   * by a mouse click must NOT hold the volume pill open (it would stick after the pointer left); a Tab
   * onto it must. One pair of window listeners, installed once.
   */
  let keyboardModality = false;
  let modalityWatched = false;
  function watchModality() {
    if (modalityWatched || typeof window === 'undefined') return;
    modalityWatched = true;
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Tab') keyboardModality = true;
      },
      true
    );
    window.addEventListener('pointerdown', () => (keyboardModality = false), true);
  }
</script>

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
  /** The Escape handler hands focus back to the speaker: that focus must not reopen the pill. */
  let restoringFocus = false;
  let host: HTMLElement | null = $state(null);
  let popover: HTMLElement | null = $state(null);
  /** Where the pill hangs: the host's top-centre, in viewport coordinates (the pill is fixed). */
  let anchor = $state({ x: 0, y: 0 });
  onMount(() => {
    watchModality();
    return watchFineHover((v) => (fineHover = v));
  });
  const showSlider = $derived(fineHover && !!onLevel && !disabled);
  const open = $derived(hovering || focused);

  function place() {
    if (!host) return;
    const r = host.getBoundingClientRect();
    anchor = { x: r.left + r.width / 2, y: r.top };
  }

  // THE PILL IS IN THE TOP LAYER while open (Popover API), so no `overflow-hidden` ancestor - a short
  // card, a chat bubble - clips it and a transformed one does not move it. It stays a DOM child of the
  // host, which is what keeps `pointerenter`/`pointerleave` and focus continuous across the two.
  $effect(() => {
    const pill = popover;
    if (!pill || !open) return;
    place();
    try {
      pill.showPopover?.();
    } catch (err) {
      console.warn('[VIDEO] the volume pill could not enter the top layer', err);
    }
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      try {
        if (pill.hidePopover && pill.matches(':popover-open')) pill.hidePopover();
      } catch (err) {
        console.warn('[VIDEO] the volume pill could not leave the top layer', err);
      }
    };
  });

  /** A drag that leaves the pill keeps it open; its release re-reads whether the pointer is still on it. */
  function beginDrag() {
    dragging = true;
    const end = () => {
      window.removeEventListener('pointerup', end, true);
      dragging = false;
      hovering = host?.matches(':hover') ?? false;
    };
    window.addEventListener('pointerup', end, true);
  }

  function onHostKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !open) return;
    // Closes the pill only (not the lightbox or the viewer behind it) and hands focus back.
    e.preventDefault();
    e.stopPropagation();
    hovering = false;
    focused = false;
    restoringFocus = true;
    host?.querySelector<HTMLElement>('button')?.focus();
    restoringFocus = false;
  }

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

{#if showSlider}
  <!-- The caller's classes (its corner on the player) stay on the OUTER box alone; the INNER box is the
       pill's anchor, so there is never a second position class on one element. -->
  <span class="inline-flex {klass}">
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions: the hover and focus bookkeeping of the pill; every control inside is a real button or range -->
    <span
      class="relative inline-flex"
      role="group"
      bind:this={host}
      data-video-volume-host
      onpointerenter={(e) => {
        if (e.pointerType === 'mouse') hovering = true;
      }}
      onpointerleave={(e) => {
        if (e.pointerType === 'mouse' && !dragging) hovering = false;
      }}
      onfocusin={() => {
        if (keyboardModality && !restoringFocus) focused = true;
      }}
      onfocusout={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focused = false;
      }}
      onkeydown={onHostKeydown}
    >
      {@render speaker('')}
      <!-- THE HOVER BRIDGE: the pill's box ends flush on the speaker's 44px target (its bottom padding
           is the spacing), so the pointer crossing from one to the other never leaves the host. Closed:
           `inert` and hidden, so neither Tab nor a screen reader meets a control that is not there. -->
      <span
        bind:this={popover}
        popover="manual"
        role="presentation"
        inert={!open}
        class="video-volume-popover -translate-x-1/2 -translate-y-full {open
          ? 'visible'
          : 'invisible'}"
        style="left: {anchor.x}px; top: {anchor.y}px"
        onpointerdowncapture={beginDrag}
        data-video-volume-popover={open ? 'open' : 'closed'}
      >
        <VideoVolumeSlider
          value={muted ? 0 : videoSound.level}
          onChange={(v) => onLevel?.(v)}
          onCommit={() => videoSound.commitLevel()}
          flat={!glass}
        />
      </span>
    </span>
  </span>
{:else}
  {@render speaker(klass)}
{/if}

<style>
  /* The Popover API's defaults (a centred, bordered, scrolling box) undone: this is a fixed anchor. */
  .video-volume-popover {
    position: fixed;
    inset: auto;
    margin: 0;
    padding: 0 0 0.25rem;
    border: 0;
    background: transparent;
    color: inherit;
    overflow: visible;
  }
</style>
