<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import { contrastColor } from '$lib/utils/color';
  import { apiAssetUrl } from '$lib/utils/apiUrl';

  interface Props {
    /**
     * Custom icon image (e.g. a partner brand's logo); falls back to `fallbackIcon` when null/unset.
     * An app-relative path is accepted and absolutized through `apiAssetUrl` - the backend stores
     * these as `/api/media/public/<id>`, which reaches no API from a Tauri origin.
     */
    iconUrl?: string | null;
    /** Lucide (or compatible) icon component rendered when no custom `iconUrl` is set. */
    fallbackIcon: Component;
    /**
     * Accent color (hex or HSL) tinting the card's top edge, its badge and its hover outline -
     * callers resolve this from the owning association's `color`, falling back to
     * `generateAvatarColor` when unset, so every card always gets a distinguishing hue.
     */
    accentColor?: string | null;
    /** Short decorative label (e.g. "Nouveau", "-20%") shown as a pill in the header row; omitted when empty. */
    badgeText?: string | null;
    /** Extra classes appended to the outer container. */
    class?: string;
    children: Snippet;
  }

  let {
    iconUrl,
    fallbackIcon: FallbackIcon,
    accentColor,
    badgeText,
    class: className = '',
    children,
  }: Props = $props();

  const trimmedBadge = $derived(badgeText?.trim() ?? '');
  /**
   * The icon path made fetchable from the runtime actually running.
   *
   * `setCardIcon` stores `iconUrl` as the app-relative `/api/media/public/<mediaId>?v=...`. On the
   * web that resolves against the shared origin and needs nothing. In a Tauri build the page is
   * served from `tauri://localhost` (iOS) or `http://tauri.localhost` (Android), where the same path
   * resolves against the SHELL and the request leaves for an origin serving no API: the image never
   * arrives, nothing throws and nothing is logged. Absolutizing here rather than at the five call
   * sites keeps every card - products, partnerships, shop - on one answer.
   */
  const resolvedIconUrl = $derived(iconUrl ? apiAssetUrl(iconUrl) : null);
  /**
   * The accent reaches the three places that need it through TWO variables rather than being
   * inlined per element: the hover outline lives in a scoped `:hover` rule, and a stylesheet
   * cannot reach a value that only exists in an element's inline `background-color`. Set on the
   * container, so every descendant rule and utility (`bg-(--tile-accent)`) reads the same hue.
   */
  const accentVars = $derived(
    accentColor
      ? `--tile-accent: ${accentColor}; --tile-accent-ink: ${contrastColor(accentColor)};`
      : '--tile-accent: var(--color-cn-yellow); --tile-accent-ink: var(--color-cn-ink);'
  );
</script>

<div
  class="card-tile relative flex flex-col overflow-hidden rounded-2xl bg-(--cn-surface) {className}"
  style={accentVars}
>
  <!--
    A bar of accent along the TOP edge, rather than the slab down the left edge this used to wear:
    the same identifying hue, but read as a rule heading the card instead of a stripe glued to its
    side, and it no longer competes with the content's own left margin.

    It can sit flush against the card's edge only because the 1px outline below is an inset
    box-shadow instead of a real `border`. A real border makes `overflow-hidden` clip descendants
    at the PADDING box - a smaller, differently-curved rectangle than the border box the container
    is rounded to - and an absolutely positioned child resolves `top: 0` against that same padding
    box, so this bar would be inset by 1px on three sides and clipped to a tighter radius than the
    corners it is supposed to follow (confirmed with `elementFromPoint` landing in the gap). A
    box-shadow consumes no box-model space, so padding box and border box coincide.
  -->
  <div class="pointer-events-none absolute inset-x-0 top-0 h-1 bg-(--tile-accent)"></div>

  <!--
    Header row: the badge as a pill, and the icon in a frame of its own. The icon used to be a
    64px watermark absolutely positioned in this corner at 40% opacity behind a radial mask, which
    cost a card nothing in height but two real things: an uploaded brand logo - the one piece of
    art here that carries identity - was unreadable, and it overlapped whatever the caller put in
    ITS top-right corner (the shop grid puts the price there). In normal flow it overlaps nothing
    by construction, at the price of the row's height, and a logo looks like a logo.
  -->
  <div class="flex items-start gap-3 px-4 pt-4">
    {#if trimmedBadge}
      <span
        class="rounded-full bg-(--tile-accent) px-2.5 py-0.5 text-[10px] font-bold tracking-wide text-(--tile-accent-ink) uppercase"
      >
        {trimmedBadge}
      </span>
    {/if}
    <div
      class="border-cn-border bg-cn-surface-alt ml-auto flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border p-1.5"
    >
      {#if resolvedIconUrl}
        <!-- Decorative: the caller renders the name this logo stands for as text in `children`,
             and an alt here could only be a literal, which Paraglide forbids. -->
        <img src={resolvedIconUrl} alt="" class="h-full w-full object-contain" />
      {:else}
        <FallbackIcon size={20} class="text-text-muted" />
      {/if}
    </div>
  </div>

  <!--
    `flex-1` (not `h-full`): the header above is a sibling taking real space in normal flow, not
    a percentage of the container. A height:100% here would compute against the WHOLE container
    (header included), so combined with the header's own height the content would overflow the
    bottom by exactly that much - confirmed by measuring real bounding rects, not by eye. flex-1
    fills only what's actually left, however tall the header renders.
  -->
  <div class="relative min-h-0 flex-1">
    {@render children()}
  </div>
</div>

<style>
  /*
    Elevation is here rather than on a Tailwind `shadow-*` utility because the 1px outline is an
    inset box-shadow (see the accent-bar comment): both live in the same property, so a utility
    and a rule would overwrite each other instead of stacking. There is no shadow token in
    `app.css` to reference, and `color-mix` against `black` keeps a raw hex out of the component.
  */
  .card-tile {
    --tile-lift: 0 1px 2px color-mix(in srgb, black 6%, transparent);
    --tile-lift-hover: 0 10px 24px color-mix(in srgb, black 10%, transparent);
    box-shadow:
      inset 0 0 0 1px var(--cn-border),
      var(--tile-lift);
    transition: box-shadow 180ms ease;
  }

  :global([data-theme='dark']) .card-tile {
    --tile-lift: 0 2px 8px color-mix(in srgb, black 35%, transparent);
    --tile-lift-hover: 0 12px 28px color-mix(in srgb, black 45%, transparent);
  }

  /*
    Gated on a real hover capability: on a touch screen `:hover` sticks to the last-tapped card
    until something else is tapped, which would leave one card in a grid permanently lit.
  */
  @media (hover: hover) {
    .card-tile:hover {
      box-shadow:
        inset 0 0 0 1px color-mix(in srgb, var(--tile-accent) 45%, var(--cn-border)),
        var(--tile-lift-hover);
    }
  }
</style>
