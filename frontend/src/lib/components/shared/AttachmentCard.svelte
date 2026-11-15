<!--
  THE ONE CARD OF A POST'S ATTACHMENTS, AND OF A CHAT'S LINK (owner, 2026-11-15: "Une seule famille
  de cartes"). A link, an in-app link, a MiGallery album, an attached form, a file and a calendar
  event are all this frame: a 64 px tile, a type chip, a title, ONE subtitle line, one arrow,
  one border, one 12 px corner (`rounded-2xl`, the scale's larger card) and one inset. What differs
  is only what the caller puts in the slots. The chat's link card was already this shape and is the
  model ([posts](docs/wiki/frontend/modules/posts.md#the-card-zone-one-family-a-fixed-order-owner-2026-11-15)).

  HERO is the same card put forward, for a post whose only attachment it is (`planPostAttachments`):
  the `banner` (a link's picture, a PDF's first page) runs full width above the text in place of the
  tile; a card with no picture keeps its row and gains `heroAction`, a full-width call to action.

  ONE THING OPENS. The row, the banner and the call to action are the same destination: the row is
  the tab stop, the other two repeat it with `tabindex="-1"` and `aria-hidden`, so a screen reader
  meets the card once, and what the banner shows is `inert`. `trailing` is the one control that is
  NOT the destination (a reminder bell, a download): it sits beside the link, never inside it,
  because a button inside an `<a>` is invalid; the row keeps its arrow, so the row still reads as
  tappable.

  THE TILE IS ONE TREATMENT: the accent-tinted surface, a glyph or a picture on it. The Canari logo is
  kept for an in-app LINK only, where it is the identity of the destination.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ChevronRight, ExternalLink } from '@lucide/svelte';
  import { nearViewport } from '$lib/actions/nearViewport';

  interface Props {
    /** Where the card goes. Absent with `onclick` absent too, the card is not interactive. */
    href?: string;
    /** Opens in the system browser: `_blank`, `noopener`, and the external-link glyph. */
    external?: boolean;
    /** Taken over by a caller that routes the tap itself (in-app navigation, a viewer). */
    onclick?: (e: MouseEvent) => void;
    /** The row's accessible name, when the visible text does not say what a tap does. */
    ariaLabel?: string;
    /** The type chip: the host, "Formulaire", "PDF", "Événement", "MiGallery"... */
    chip: string;
    title: string;
    /** The ONE subtitle line. */
    subtitle?: string;
    /** Draws the subtitle as a pulsing bar: the card is waiting for its metadata. */
    pending?: boolean;
    /** The 64 px tile's content; the card owns the box (size, corner, border). */
    tile: Snippet;
    /** Drawn large: the banner on top, or the call to action below. */
    hero?: boolean;
    /** The hero's full-width picture; its box (ratio, background) is the snippet's. */
    banner?: Snippet;
    /** The hero's call to action, for a card with no picture to put forward. */
    heroAction?: string;
    /** A control of its own beside the link (bell, download); replaces the arrow. */
    trailing?: Snippet;
    /** Drawn under the row, inside the destination (a post preview's own picture). */
    below?: Snippet;
    /** Called once the card nears the viewport, so its owner fetches then and not on render. */
    onnear?: () => void;
    /** What the card stands for, for tests and the rig: `link`, `form`, `file`, `event`. */
    kind: string;
    /** The caller's spacing (a chat bubble's top margin). */
    class?: string;
  }

  let {
    href,
    external = false,
    onclick,
    ariaLabel,
    chip,
    title,
    subtitle,
    pending = false,
    tile,
    hero = false,
    banner,
    heroAction,
    trailing,
    below,
    onnear,
    kind,
    class: extra = '',
  }: Props = $props();

  const showsBanner = $derived(hero && Boolean(banner));
  const showsAction = $derived(hero && !showsBanner && Boolean(heroAction));

  /**
   * The chip names the TYPE; a title that only repeats it ("MiGallery" over "MiGallery", an album
   * that declared no title) says it once, as the title.
   */
  const showsChip = $derived(chip.trim().toLowerCase() !== title.trim().toLowerCase());

  /**
   * THE ARROW SAYS "THIS CARD OPENS SOMETHING", and which kind: out of the app (the exit glyph) or
   * inside it (a chevron - the up-right arrow it used to be read as "external" too). A card that
   * opens nothing (a file that is not a PDF) has none; a hero's call to action already says it.
   */
  const arrow = $derived(
    !(href || onclick) || showsAction ? null : external ? 'external' : 'in-app'
  );
</script>

<!-- One destination, drawn by whichever element the card has: a link, a button, or nothing. -->
{#snippet opener(content: Snippet, cls: string, decorative: boolean)}
  {#if href}
    <a
      {href}
      {onclick}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      tabindex={decorative ? -1 : undefined}
      aria-hidden={decorative ? 'true' : undefined}
      aria-label={decorative ? undefined : ariaLabel}
      class="focus-visible:ring-accent/50 outline-none focus-visible:ring-4 focus-visible:ring-inset {cls}"
    >
      {@render content()}
    </a>
  {:else if onclick}
    <button
      type="button"
      {onclick}
      tabindex={decorative ? -1 : undefined}
      aria-hidden={decorative ? 'true' : undefined}
      aria-label={decorative ? undefined : ariaLabel}
      class="focus-visible:ring-accent/50 cursor-pointer text-left outline-none focus-visible:ring-4 focus-visible:ring-inset {cls}"
    >
      {@render content()}
    </button>
  {:else}
    <div class={cls}>{@render content()}</div>
  {/if}
{/snippet}

<!-- The banner and the band below REPEAT the row's destination: what they show is a picture, never
     a control of its own - `inert` and no pointer events, so a media's zoom button inside (a post
     preview's photo) can neither take the focus nor the tap. -->
{#snippet bannerContent()}
  <div inert class="pointer-events-none" data-attachment-picture>{@render banner?.()}</div>
{/snippet}

{#snippet rowContent()}
  {#if !showsBanner}
    <div
      class="bg-accent/10 text-accent-text relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-black/5 dark:border-white/10"
      data-attachment-tile
    >
      {@render tile()}
    </div>
  {/if}
  <div class="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
    {#if showsChip}
      <span
        class="text-2xs bg-accent/12 text-accent-text inline-flex max-w-full items-center self-start truncate rounded-md px-2 py-0.5 font-bold"
        data-attachment-chip
      >
        {chip}
      </span>
    {/if}
    <p
      class="text-text-main group-hover/att:text-accent-text {hero
        ? 'text-base'
        : 'text-sm'} line-clamp-2 leading-snug font-bold transition-colors duration-300"
    >
      {title}
    </p>
    {#if pending}
      <div class="mt-1 h-3 w-4/5 animate-pulse rounded bg-black/6 dark:bg-white/8"></div>
    {:else if subtitle}
      <p class="text-text-muted truncate text-xs leading-snug">{subtitle}</p>
    {/if}
  </div>
  {#if arrow}
    <div
      class="text-text-muted group-hover/att:text-accent-text shrink-0 self-center opacity-50 transition-all duration-300 group-hover/att:translate-x-0.5 group-hover/att:opacity-100"
      aria-hidden="true"
      data-attachment-arrow={arrow}
    >
      {#if arrow === 'external'}
        <ExternalLink size={20} strokeWidth={2.25} />
      {:else}
        <ChevronRight size={22} strokeWidth={2.25} />
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet belowContent()}
  <div inert class="pointer-events-none" data-attachment-picture>{@render below?.()}</div>
{/snippet}

{#snippet actionContent()}
  {heroAction}
{/snippet}

<div
  use:nearViewport={{ onnear: () => onnear?.() }}
  class="group/att bg-cn-surface hover:border-accent/35 flex flex-col overflow-hidden rounded-2xl border border-black/5 transition-all duration-300 hover:shadow-md dark:border-white/10 {extra}"
  data-attachment-card={kind}
  data-hero={hero ? '' : undefined}
>
  {#if showsBanner}
    {@render opener(
      bannerContent,
      'block w-full border-b border-black/5 dark:border-white/10',
      true
    )}
  {/if}
  <div class="flex items-center">
    {@render opener(rowContent, 'flex min-w-0 flex-1 items-center gap-3.5 p-3', false)}
    {#if trailing}
      <div class="shrink-0 pr-3">{@render trailing()}</div>
    {/if}
  </div>
  {#if below}
    {@render opener(
      belowContent,
      'block w-full border-t border-black/5 dark:border-white/10',
      true
    )}
  {/if}
  {#if showsAction}
    {@render opener(
      actionContent,
      'bg-accent text-on-accent hover:bg-accent-hover mx-3 mb-3 block rounded-lg py-2.5 text-center text-sm font-bold transition-colors',
      true
    )}
  {/if}
</div>
