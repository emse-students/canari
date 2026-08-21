<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import { contrastColor } from '$lib/utils/color';

  interface Props {
    /** Custom icon image (e.g. a partner brand's logo); falls back to `fallbackIcon` when null/unset. */
    iconUrl?: string | null;
    /** Lucide (or compatible) icon component rendered when no custom `iconUrl` is set. */
    fallbackIcon: Component;
    /**
     * Accent color (hex or HSL) tinting the card's left edge and, when set, the badge - callers
     * resolve this from the owning association's `color`, falling back to `generateAvatarColor`
     * when unset, so every card always gets a distinguishing hue.
     */
    accentColor?: string | null;
    /** Short decorative label (e.g. "Nouveau", "-20%") shown as a ribbon above the card content; omitted when empty. */
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
   * Drawn as an INSET box-shadow, not a real `border` property. A real border makes
   * `overflow-hidden` clip descendants at the padding box - a smaller, differently-curved
   * rectangle than the border-box the container itself is rounded to - so a full-bleed ribbon
   * meant to sit flush with the top edge gets its corners clipped a hair short no matter what
   * radius or negative margin it's given, revealing the container's own background underneath
   * (confirmed with `elementFromPoint` landing inside that gap). A box-shadow consumes no
   * box-model space at all, so padding-box and border-box coincide and the ribbon can just be a
   * normal-flow child with a matching `rounded-t-2xl` - no offset to reconcile, because there
   * isn't one anymore.
   */
  const outerStyle = $derived.by(() => {
    const shadows = ['inset 0 0 0 1px var(--cn-border)'];
    if (accentColor) shadows.unshift(`inset 4px 0 0 0 ${accentColor}`);
    return `box-shadow: ${shadows.join(', ')};`;
  });
</script>

<div
  class="relative flex flex-col overflow-hidden rounded-2xl bg-(--cn-surface) {className}"
  style={outerStyle}
>
  {#if trimmedBadge}
    <div
      class="rounded-t-2xl px-3 py-1 text-[10px] font-bold tracking-wide uppercase"
      style="background-color: {accentColor ?? 'var(--color-cn-yellow)'}; color: {accentColor
        ? contrastColor(accentColor)
        : 'var(--color-cn-ink)'};"
    >
      {trimmedBadge}
    </div>
  {/if}
  <!--
    `flex-1` (not `h-full`): the ribbon above is a sibling taking real space in normal flow, not
    a percentage of the container. A height:100% here would compute against the WHOLE container
    (ribbon included), so combined with the ribbon's own height the content would overflow the
    bottom by exactly the ribbon's height - confirmed by measuring real bounding rects, not by
    eye. flex-1 fills only what's actually left after the ribbon, however tall it renders.
  -->
  <div class="relative min-h-0 flex-1">
    <div
      class="pointer-events-none absolute top-3 right-3 h-16 w-16 opacity-40"
      style="mask-image: radial-gradient(circle at top right, black 10%, transparent 90%); -webkit-mask-image: radial-gradient(circle at top right, black 10%, transparent 90%);"
    >
      {#if iconUrl}
        <img src={iconUrl} alt="" class="h-full w-full object-contain" />
      {:else}
        <FallbackIcon size={64} class="h-full w-full" />
      {/if}
    </div>
    <div class="relative h-full">
      {@render children()}
    </div>
  </div>
</div>
