<script lang="ts">
  /**
   * The avatar for an anonymous post: always the icon, never a photo. There is nothing to fetch -
   * a regular reader never receives `authorId` for this post at all, and even when a moderator
   * does (to be able to act on it), the point of the flag is that nobody's photo is drawn from it.
   * Modeled on `GroupAvatar.svelte`'s icon-fallback branch, which is the same "no network, always
   * the same glyph" shape.
   */
  import { VenetianMask } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Avatar size preset. */
    size?: 'sm' | 'md' | 'lg';
    /** When true, stretches to fill its container. */
    fill?: boolean;
    /** Border-radius style. */
    shape?: 'soft' | 'circle';
  }

  let { size = 'md', fill = false, shape = 'circle' }: Props = $props();

  const sizeClasses = $derived(
    fill ? 'w-full h-full' : size === 'sm' ? 'w-6 h-6' : size === 'lg' ? 'w-12 h-12' : 'w-8 h-8'
  );
  const shapeClasses = $derived(shape === 'circle' ? 'rounded-full' : 'rounded-2xl');
  const iconSize = $derived(size === 'sm' ? 14 : size === 'lg' ? 22 : 18);
</script>

<div
  class="{shapeClasses} bg-cn-ink text-cn-yellow flex shrink-0 items-center justify-center shadow-sm select-none {sizeClasses}"
  title={m.post_anonymous_label()}
  aria-label={m.post_view_anonymous_label()}
>
  <VenetianMask size={iconSize} />
</div>
