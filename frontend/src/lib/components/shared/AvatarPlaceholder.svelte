<script lang="ts">
  /**
   * THE ONE PLACEHOLDER every avatar without a photo or logo draws - a person, a group or community,
   * an association. It used to be three copies of "yellow initials on navy"; it is now a diagonal
   * gradient whose hue comes from `avatarHueIndex(seed)`.
   *
   * `seed` is the entity's ID (user id, conversation or group id, association id), never its display
   * name, so one person keeps one colour wherever they appear. The caller owns shape and size
   * through `class` (`rounded-full`, `squircle`, `w-8 h-8`, or `absolute inset-0` for an overlay that
   * waits for a photo); this component owns only the fill and the centring. Pass `children` to draw
   * a glyph instead of initials (a group with no name has an icon).
   */
  import type { Snippet } from 'svelte';
  import { avatarHueIndex } from '$lib/utils/avatar';

  interface Props {
    /** Stable id of the entity the placeholder stands for. */
    seed: string;
    /** Letters to draw. Ignored when `children` is given. */
    initials?: string;
    /** Classes for shape and size (and `absolute inset-0` when it overlays a loading image). */
    class?: string;
    title?: string;
    ariaLabel?: string;
    /** A glyph drawn in place of initials. */
    children?: Snippet;
  }

  let { seed, initials = '', class: className = '', title, ariaLabel, children }: Props = $props();

  const hue = $derived(avatarHueIndex(seed));
</script>

<div
  class="avatar-placeholder flex items-center justify-center font-bold select-none {className}"
  data-hue={hue}
  {title}
  aria-label={ariaLabel}
>
  {#if children}
    {@render children()}
  {:else}
    <span class="text-zoom-exempt">{initials}</span>
  {/if}
</div>
